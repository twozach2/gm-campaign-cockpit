import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { AtomicJsonStore } from "../../lib/atomic-json-store.mjs";
import {
  PLAYER_IMAGE_CONTENT_TYPES,
  verifyPlayerImageBytes,
} from "../../lib/file-policy.mjs";

const ASSET_SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1_000;
const MAX_RECORDS = 10_000;

function emptyManifest() {
  return {
    schemaVersion: ASSET_SCHEMA_VERSION,
    grants: [],
    assets: [],
  };
}

function hash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function digest(content) {
  return createHash("sha256").update(content).digest("base64url");
}

function equalHash(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function identifier(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function secret() {
  return randomBytes(32).toString("base64url");
}

function assetError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function validId(value, prefix) {
  return (
    typeof value === "string" &&
    value.startsWith(`${prefix}_`) &&
    /^[A-Za-z0-9_-]+$/.test(value) &&
    value.length <= 128
  );
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== ASSET_SCHEMA_VERSION ||
    !Array.isArray(value.grants) ||
    !Array.isArray(value.assets) ||
    value.grants.length > MAX_RECORDS ||
    value.assets.length > MAX_RECORDS
  ) {
    return false;
  }
  if (
    new Set(value.grants.map((entry) => entry.assetId)).size !==
      value.grants.length ||
    new Set(value.assets.map((entry) => entry.id)).size !== value.assets.length
  ) {
    return false;
  }
  const validMetadata = (entry, idKey) =>
    validId(entry[idKey], "asset") &&
    validId(entry.roomId, "room") &&
    validId(entry.deviceId, "dev") &&
    PLAYER_IMAGE_CONTENT_TYPES.includes(entry.contentType) &&
    Number.isSafeInteger(entry.byteLength) &&
    entry.byteLength > 0 &&
    typeof entry.sha256 === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(entry.sha256) &&
    validTimestamp(entry.createdAt) &&
    validTimestamp(entry.expiresAt);
  return (
    value.grants.every(
      (grant) =>
        validMetadata(grant, "assetId") &&
        typeof grant.tokenHash === "string" &&
        grant.tokenHash.length >= 32,
    ) &&
    value.assets.every((asset) => validMetadata(asset, "id"))
  );
}

function clone(value) {
  return structuredClone(value);
}

export class RelayAssetStore {
  constructor({
    root,
    maxBytes = DEFAULT_MAX_BYTES,
    retentionMs = DEFAULT_RETENTION_MS,
    grantTtlMs = DEFAULT_GRANT_TTL_MS,
    now = () => Date.now(),
    randomId = identifier,
    randomSecret = secret,
    logger,
  }) {
    if (!root) throw new Error("Relay asset storage requires a root directory");
    this.root = path.resolve(root);
    this.filesRoot = path.join(this.root, "files");
    this.maxBytes = maxBytes;
    this.retentionMs = retentionMs;
    this.grantTtlMs = grantTtlMs;
    this.now = now;
    this.randomId = randomId;
    this.randomSecret = randomSecret;
    this.logger = logger;
    this.manifest = emptyManifest();
    this.tail = Promise.resolve();
    this.store = new AtomicJsonStore({
      file: path.join(this.root, "assets.json"),
      validate: validManifest,
      onWarning: (_message, details = {}) => {
        this.logger?.warn("relay_asset_recovery", {
          action: details.code || "RECOVERY_WARNING",
        });
      },
    });
  }

  async init() {
    await mkdir(this.filesRoot, { recursive: true });
    this.manifest = await this.store.load(emptyManifest());
    await this.prune();
    return this;
  }

  transact(mutator) {
    const operation = this.tail.then(async () => {
      const draft = clone(this.manifest);
      const result = await mutator(draft);
      if (!validManifest(draft)) {
        throw new Error("Relay asset transaction produced invalid state");
      }
      await this.store.write(draft);
      this.manifest = draft;
      return clone(result);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  assetPath(assetId) {
    if (!validId(assetId, "asset")) {
      throw assetError("Asset ID is invalid", "INVALID_ASSET_ID");
    }
    return path.join(this.filesRoot, `${assetId}.bin`);
  }

  createGrant({ roomId, deviceId, contentType, byteLength, sha256 }) {
    if (!validId(roomId, "room") || !validId(deviceId, "dev")) {
      throw assetError("Asset room or device is invalid", "INVALID_ASSET_SCOPE");
    }
    if (!PLAYER_IMAGE_CONTENT_TYPES.includes(contentType)) {
      throw assetError("Asset image type is not supported", "INVALID_ASSET_TYPE");
    }
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > this.maxBytes
    ) {
      throw assetError("Asset size is invalid", "INVALID_ASSET_SIZE", 413);
    }
    if (typeof sha256 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sha256)) {
      throw assetError("Asset digest is invalid", "INVALID_ASSET_DIGEST");
    }
    const assetId = this.randomId("asset");
    const uploadToken = this.randomSecret();
    const now = this.now();
    const grant = {
      assetId,
      roomId,
      deviceId,
      contentType,
      byteLength,
      sha256,
      tokenHash: hash(uploadToken),
      createdAt: now,
      expiresAt: now + this.grantTtlMs,
    };
    return this.transact((draft) => {
      if (draft.grants.length >= MAX_RECORDS) {
        throw assetError(
          "Asset upload grant capacity reached",
          "ASSET_GRANT_CAPACITY",
          429,
        );
      }
      draft.grants.push(grant);
      return {
        assetId,
        uploadToken,
        uploadExpiresAt: grant.expiresAt,
        assetExpiresAt: now + this.retentionMs,
      };
    });
  }

  uploadGrant(assetId, uploadToken) {
    const tokenHash = hash(uploadToken);
    const grant = this.manifest.grants.find(
      (entry) =>
        entry.assetId === assetId &&
        entry.expiresAt > this.now() &&
        equalHash(entry.tokenHash, tokenHash),
    );
    return grant ? clone(grant) : null;
  }

  completeUpload({ assetId, uploadToken, contentType, content }) {
    if (!Buffer.isBuffer(content)) {
      throw assetError("Asset upload body is invalid", "INVALID_ASSET_BODY");
    }
    const operation = this.tail.then(async () => {
      const draft = clone(this.manifest);
      const tokenHash = hash(uploadToken);
      const grantIndex = draft.grants.findIndex(
        (entry) =>
          entry.assetId === assetId &&
          entry.expiresAt > this.now() &&
          equalHash(entry.tokenHash, tokenHash),
      );
      if (grantIndex === -1) {
        throw assetError(
          "Asset upload grant is invalid or expired",
          "UPLOAD_GRANT_INVALID",
          401,
        );
      }
      const grant = draft.grants[grantIndex];
      if (
        contentType !== grant.contentType ||
        content.length !== grant.byteLength
      ) {
        throw assetError(
          "Asset upload does not match its grant",
          "UPLOAD_GRANT_MISMATCH",
          409,
        );
      }
      verifyPlayerImageBytes(content, contentType);
      if (digest(content) !== grant.sha256) {
        throw assetError(
          "Asset upload digest does not match its grant",
          "ASSET_DIGEST_MISMATCH",
          409,
        );
      }

      const target = this.assetPath(assetId);
      const temporary = `${target}.${Date.now()}.tmp`;
      let handle;
      let committed = false;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, target);
        const asset = {
          id: grant.assetId,
          roomId: grant.roomId,
          deviceId: grant.deviceId,
          contentType: grant.contentType,
          byteLength: grant.byteLength,
          sha256: grant.sha256,
          createdAt: this.now(),
          expiresAt: this.now() + this.retentionMs,
        };
        draft.grants.splice(grantIndex, 1);
        draft.assets.push(asset);
        if (!validManifest(draft)) {
          throw new Error("Relay asset upload produced invalid state");
        }
        await this.store.write(draft);
        this.manifest = draft;
        committed = true;
        return clone(asset);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        if (!committed) await unlink(target).catch(() => {});
        throw error;
      }
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  asset(assetId) {
    const asset = this.manifest.assets.find(
      (entry) => entry.id === assetId && entry.expiresAt > this.now(),
    );
    return asset ? clone(asset) : null;
  }

  async readAsset(assetId, roomId) {
    const asset = this.asset(assetId);
    if (!asset || asset.roomId !== roomId) return null;
    try {
      return {
        asset,
        content: await readFile(this.assetPath(assetId)),
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  deleteAsset({ assetId, deviceId }) {
    let target;
    return this.transact((draft) => {
      const index = draft.assets.findIndex(
        (entry) => entry.id === assetId && entry.deviceId === deviceId,
      );
      if (index === -1) {
        throw assetError("Asset not found", "ASSET_NOT_FOUND", 404);
      }
      target = this.assetPath(assetId);
      const [asset] = draft.assets.splice(index, 1);
      return asset;
    }).then(async (asset) => {
      await unlink(target).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return asset;
    });
  }

  deleteRoomAssets(roomId) {
    const targets = [];
    return this.transact((draft) => {
      const removed = draft.assets.filter((entry) => entry.roomId === roomId);
      draft.assets = draft.assets.filter((entry) => entry.roomId !== roomId);
      draft.grants = draft.grants.filter((entry) => entry.roomId !== roomId);
      targets.push(...removed.map((entry) => this.assetPath(entry.id)));
      return removed;
    }).then(async (removed) => {
      await Promise.all(
        targets.map((target) =>
          unlink(target).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          }),
        ),
      );
      return removed;
    });
  }

  prune() {
    const targets = [];
    return this.transact((draft) => {
      const now = this.now();
      const expired = draft.assets.filter((entry) => entry.expiresAt <= now);
      draft.assets = draft.assets.filter((entry) => entry.expiresAt > now);
      draft.grants = draft.grants.filter((entry) => entry.expiresAt > now);
      targets.push(...expired.map((entry) => this.assetPath(entry.id)));
      return expired.length;
    }).then(async (count) => {
      await Promise.all(
        targets.map((target) =>
          unlink(target).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          }),
        ),
      );
      return count;
    });
  }

  async close() {
    await this.tail;
    await this.store.close();
  }
}
