import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  migrateRelayDatabase,
  RELAY_SCHEMA_VERSION,
} from "./migrations.mjs";
import { validAssetManifest } from "./assets.mjs";
import { validRelayDatabase } from "./store.mjs";

const BACKUP_VERSION = 1;

function maintenanceError(message, code) {
  return Object.assign(new Error(message), { code });
}

function timestamp(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, "-");
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("base64url");
}

async function filesUnder(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(root, absolute)));
    } else if (entry.isFile()) {
      result.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
    } else {
      throw maintenanceError(
        `Backup source contains an unsupported entry: ${absolute}`,
        "UNSUPPORTED_BACKUP_ENTRY",
      );
    }
  }
  return result.sort();
}

async function inventory(root) {
  const files = await filesUnder(root);
  const records = [];
  for (const relative of files) {
    if (relative === "backup.json") continue;
    const absolute = path.join(root, ...relative.split("/"));
    const metadata = await stat(absolute);
    records.push({
      path: relative,
      bytes: metadata.size,
      sha256: await sha256(absolute),
    });
  }
  return records;
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeInventoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/).includes("..")
  );
}

async function validateRelayState(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw maintenanceError(
      "Relay state is not valid JSON",
      "INVALID_RELAY_BACKUP",
    );
  }
  const migrated = migrateRelayDatabase(parsed);
  if (!validRelayDatabase(migrated)) {
    throw maintenanceError(
      "Relay state failed schema validation",
      "INVALID_RELAY_BACKUP",
    );
  }
  return migrated;
}

async function validateAssets(root) {
  const manifestFile = path.join(root, "assets.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  } catch {
    throw maintenanceError(
      "Asset manifest is not valid JSON",
      "INVALID_ASSET_BACKUP",
    );
  }
  if (!validAssetManifest(manifest)) {
    throw maintenanceError(
      "Asset manifest failed schema validation",
      "INVALID_ASSET_BACKUP",
    );
  }
  for (const asset of manifest.assets) {
    const file = path.join(root, "files", `${asset.id}.bin`);
    let content;
    try {
      content = await readFile(file);
    } catch {
      throw maintenanceError(
        `Asset bytes are missing for ${asset.id}`,
        "INVALID_ASSET_BACKUP",
      );
    }
    if (
      content.length !== asset.byteLength ||
      createHash("sha256").update(content).digest("base64url") !== asset.sha256
    ) {
      throw maintenanceError(
        `Asset bytes failed integrity validation for ${asset.id}`,
        "INVALID_ASSET_BACKUP",
      );
    }
  }
  return manifest;
}

export async function createRelayBackup({
  stateFile,
  assetDir,
  destinationRoot,
  now = () => new Date(),
}) {
  const relay = await validateRelayState(stateFile);
  const assets = await validateAssets(assetDir);
  const createdAt = now();
  const backupDir = path.join(
    path.resolve(destinationRoot),
    `relay-backup-${timestamp(createdAt)}`,
  );
  if (await exists(backupDir)) {
    throw maintenanceError("Backup destination already exists", "BACKUP_EXISTS");
  }
  await mkdir(path.dirname(backupDir), { recursive: true });
  await mkdir(backupDir, { recursive: false });
  try {
    await cp(stateFile, path.join(backupDir, "relay.json"));
    await cp(assetDir, path.join(backupDir, "assets"), { recursive: true });
    await validateRelayState(path.join(backupDir, "relay.json"));
    await validateAssets(path.join(backupDir, "assets"));
    const files = await inventory(backupDir);
    await writePrivateJson(path.join(backupDir, "backup.json"), {
      backupVersion: BACKUP_VERSION,
      createdAt: createdAt.toISOString(),
      relaySchemaVersion: relay.schemaVersion,
      assetSchemaVersion: assets.schemaVersion,
      files,
    });
    return { backupDir, files: files.length };
  } catch (error) {
    await rm(backupDir, { recursive: true, force: true });
    throw error;
  }
}

export async function validateRelayBackup(backupDir) {
  const root = path.resolve(backupDir);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(root, "backup.json"), "utf8"),
    );
  } catch {
    throw maintenanceError(
      "Backup manifest is not valid JSON",
      "INVALID_BACKUP_MANIFEST",
    );
  }
  if (
    manifest.backupVersion !== BACKUP_VERSION ||
    typeof manifest.createdAt !== "string" ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every(
      (entry) =>
        safeInventoryPath(entry.path) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        typeof entry.sha256 === "string",
    )
  ) {
    throw maintenanceError(
      "Backup manifest failed validation",
      "INVALID_BACKUP_MANIFEST",
    );
  }
  const listedPaths = manifest.files.map((entry) => entry.path);
  if (new Set(listedPaths).size !== listedPaths.length) {
    throw maintenanceError(
      "Backup manifest contains duplicate file paths",
      "INVALID_BACKUP_MANIFEST",
    );
  }
  const actualPaths = await filesUnder(root);
  const expectedPaths = ["backup.json", ...listedPaths].sort();
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((entry, index) => entry !== expectedPaths[index])
  ) {
    throw maintenanceError(
      "Backup inventory does not match the manifest",
      "BACKUP_INVENTORY_MISMATCH",
    );
  }
  for (const entry of manifest.files) {
    const file = path.join(root, ...entry.path.split("/"));
    let metadata;
    try {
      metadata = await stat(file);
    } catch {
      throw maintenanceError(
        `Backup file is missing: ${entry.path}`,
        "BACKUP_FILE_MISSING",
      );
    }
    if (
      !metadata.isFile() ||
      metadata.size !== entry.bytes ||
      (await sha256(file)) !== entry.sha256
    ) {
      throw maintenanceError(
        `Backup file failed integrity validation: ${entry.path}`,
        "BACKUP_INTEGRITY_FAILED",
      );
    }
  }
  const relay = await validateRelayState(path.join(root, "relay.json"));
  const assets = await validateAssets(path.join(root, "assets"));
  if (
    manifest.relaySchemaVersion !== relay.schemaVersion ||
    manifest.assetSchemaVersion !== assets.schemaVersion
  ) {
    throw maintenanceError(
      "Backup schema versions do not match the manifest",
      "BACKUP_SCHEMA_MISMATCH",
    );
  }
  return {
    backupVersion: manifest.backupVersion,
    createdAt: manifest.createdAt,
    files: manifest.files.length,
    relaySchemaVersion: relay.schemaVersion,
    assetSchemaVersion: assets.schemaVersion,
  };
}

export async function restoreRelayBackup({
  backupDir,
  stateFile,
  assetDir,
  confirmation,
  now = () => new Date(),
}) {
  if (confirmation !== "RESTORE") {
    throw maintenanceError(
      "Restore requires RELAY_RESTORE_CONFIRM=RESTORE",
      "RESTORE_CONFIRMATION_REQUIRED",
    );
  }
  await validateRelayBackup(backupDir);
  const backupRoot = path.resolve(backupDir);
  const suffix = timestamp(now());
  const stateTarget = path.resolve(stateFile);
  const assetTarget = path.resolve(assetDir);
  const stateStage = `${stateTarget}.restore-${suffix}.tmp`;
  const assetStage = `${assetTarget}.restore-${suffix}.tmp`;
  const stateRollback = `${stateTarget}.pre-restore-${suffix}`;
  const assetRollback = `${assetTarget}.pre-restore-${suffix}`;
  for (const target of [
    stateStage,
    assetStage,
    stateRollback,
    assetRollback,
  ]) {
    if (await exists(target)) {
      throw maintenanceError(
        `Restore working path already exists: ${target}`,
        "RESTORE_PATH_EXISTS",
      );
    }
  }
  await mkdir(path.dirname(stateTarget), { recursive: true });
  await mkdir(path.dirname(assetTarget), { recursive: true });
  await cp(path.join(backupRoot, "relay.json"), stateStage);
  await cp(path.join(backupRoot, "assets"), assetStage, { recursive: true });

  const hadState = await exists(stateTarget);
  const hadAssets = await exists(assetTarget);
  let stateMoved = false;
  let assetsMoved = false;
  let stateInstalled = false;
  let assetsInstalled = false;
  try {
    if (hadState) {
      await rename(stateTarget, stateRollback);
      stateMoved = true;
    }
    if (hadAssets) {
      await rename(assetTarget, assetRollback);
      assetsMoved = true;
    }
    await rename(stateStage, stateTarget);
    stateInstalled = true;
    await rename(assetStage, assetTarget);
    assetsInstalled = true;
    await validateRelayState(stateTarget);
    await validateAssets(assetTarget);
  } catch (error) {
    await rm(stateStage, { recursive: true, force: true });
    await rm(assetStage, { recursive: true, force: true });
    if (stateInstalled) {
      await rm(stateTarget, { recursive: true, force: true });
    }
    if (assetsInstalled) {
      await rm(assetTarget, { recursive: true, force: true });
    }
    if (stateMoved) {
      await rename(stateRollback, stateTarget).catch(() => {});
    }
    if (assetsMoved) {
      await rename(assetRollback, assetTarget).catch(() => {});
    }
    throw error;
  }
  return {
    stateFile: stateTarget,
    assetDir: assetTarget,
    stateRollback: hadState ? stateRollback : null,
    assetRollback: hadAssets ? assetRollback : null,
  };
}

export async function rehearseRelayMigration({ stateFile, assetDir }) {
  const relay = await validateRelayState(stateFile);
  const assets = await validateAssets(assetDir);
  return {
    supportedRelaySchemaVersion: RELAY_SCHEMA_VERSION,
    relaySchemaVersion: relay.schemaVersion,
    assetSchemaVersion: assets.schemaVersion,
    records: {
      accounts: relay.accounts.length,
      devices: relay.devices.length,
      rooms: relay.rooms.length,
      memberships: relay.memberships.length,
      assets: assets.assets.length,
    },
  };
}
