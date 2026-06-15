import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayAssetStore } from "../relay/lib/assets.mjs";
import {
  createRelayBackup,
  rehearseRelayMigration,
  restoreRelayBackup,
  validateRelayBackup,
} from "../relay/lib/maintenance.mjs";
import { RelayStore } from "../relay/lib/store.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlXgAAAAASUVORK5CYII=",
  "base64",
);

function digest(content) {
  return createHash("sha256").update(content).digest("base64url");
}

test("relay backup validates, rehearses, and restores state and assets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-relay-maintenance-"));
  const stateFile = path.join(root, "live", "relay.json");
  const assetDir = path.join(root, "live", "assets");
  const backupRoot = path.join(root, "backups");
  let sequence = 0;
  const values = {
    randomId(prefix) {
      sequence += 1;
      return `${prefix}_maintenance_${sequence}`;
    },
    randomSecret() {
      sequence += 1;
      return `maintenance-secret-${sequence}-with-sufficient-length`;
    },
  };
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RelayStore({ file: stateFile, ...values });
  const assets = new RelayAssetStore({ root: assetDir, ...values });
  await store.init();
  await assets.init();
  const created = await store.bootstrap({
    email: "dm@example.test",
    passphrase: "a sufficiently long passphrase",
    deviceName: "Campaign laptop",
    roomName: "Tuesday table",
  });
  const grant = await assets.createGrant({
    roomId: created.room.id,
    deviceId: created.device.device.id,
    contentType: "image/png",
    byteLength: PNG.length,
    sha256: digest(PNG),
  });
  await assets.completeUpload({
    assetId: grant.assetId,
    uploadToken: grant.uploadToken,
    contentType: "image/png",
    content: PNG,
  });
  await assets.close();
  await store.close();

  const backup = await createRelayBackup({
    stateFile,
    assetDir,
    destinationRoot: backupRoot,
    now: () => new Date("2026-06-13T12:00:00.000Z"),
  });
  assert.match(backup.backupDir, /relay-backup-2026-06-13T12-00-00-000Z$/);
  const verified = await validateRelayBackup(backup.backupDir);
  assert.equal(verified.relaySchemaVersion, 2);
  assert.equal(verified.assetSchemaVersion, 1);

  const rehearsal = await rehearseRelayMigration({ stateFile, assetDir });
  assert.equal(rehearsal.records.accounts, 1);
  assert.equal(rehearsal.records.assets, 1);

  await writeFile(stateFile, '{"schemaVersion":0,"accounts":[]}', "utf8");
  await rm(path.join(assetDir, "files", `${grant.assetId}.bin`));
  await assert.rejects(
    restoreRelayBackup({
      backupDir: backup.backupDir,
      stateFile,
      assetDir,
      confirmation: "no",
    }),
    (error) => error.code === "RESTORE_CONFIRMATION_REQUIRED",
  );

  const restored = await restoreRelayBackup({
    backupDir: backup.backupDir,
    stateFile,
    assetDir,
    confirmation: "RESTORE",
    now: () => new Date("2026-06-13T12:30:00.000Z"),
  });
  assert.ok(restored.stateRollback);
  assert.ok(restored.assetRollback);

  const restoredStore = new RelayStore({ file: stateFile });
  const restoredAssets = new RelayAssetStore({ root: assetDir });
  await restoredStore.init();
  await restoredAssets.init();
  assert.equal(restoredStore.stats().accounts, 1);
  assert.deepEqual(
    (await restoredAssets.readAsset(grant.assetId, created.room.id)).content,
    PNG,
  );
  await restoredAssets.close();
  await restoredStore.close();
});

test("relay backup rejects tampered and unlisted files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-relay-tamper-"));
  const stateFile = path.join(root, "live", "relay.json");
  const assetDir = path.join(root, "live", "assets");
  t.after(() => rm(root, { recursive: true, force: true }));

  const store = new RelayStore({ file: stateFile });
  const assets = new RelayAssetStore({ root: assetDir });
  await store.init();
  await assets.init();
  await store.createAccount({ email: "dm@example.test" });
  await assets.close();
  await store.close();

  const first = await createRelayBackup({
    stateFile,
    assetDir,
    destinationRoot: path.join(root, "first"),
  });
  await writeFile(path.join(first.backupDir, "unexpected.txt"), "extra", "utf8");
  await assert.rejects(
    validateRelayBackup(first.backupDir),
    (error) => error.code === "BACKUP_INVENTORY_MISMATCH",
  );

  const second = await createRelayBackup({
    stateFile,
    assetDir,
    destinationRoot: path.join(root, "second"),
  });
  const relayFile = path.join(second.backupDir, "relay.json");
  await writeFile(
    relayFile,
    `${await readFile(relayFile, "utf8")} `,
    "utf8",
  );
  await assert.rejects(
    validateRelayBackup(second.backupDir),
    (error) => error.code === "BACKUP_INTEGRITY_FAILED",
  );
});
