import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { createLogger } from "../lib/logger.mjs";
import { RelayAssetStore } from "./lib/assets.mjs";
import { HostedRelayService } from "./lib/service.mjs";
import { RelayStore } from "./lib/store.mjs";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(relayRoot);
await loadLocalEnvironment(appRoot);

const host = process.env.RELAY_HOST || "127.0.0.1";
const port = Number(process.env.RELAY_PORT || 8787);
if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("RELAY_PORT must be a valid TCP port");
}
const stateFile = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(relayRoot, "data", "relay.json"),
);
function positiveInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
const assetRoot = path.resolve(
  process.env.RELAY_ASSET_DIR ||
    path.join(path.dirname(stateFile), "assets"),
);
const maxAssetBytes = positiveInteger(
  "RELAY_MAX_ASSET_BYTES",
  25 * 1024 * 1024,
);
const assetRetentionMs = positiveInteger(
  "RELAY_ASSET_RETENTION_MS",
  7 * 24 * 60 * 60 * 1_000,
);
const assetGrantTtlMs = positiveInteger(
  "RELAY_ASSET_GRANT_TTL_MS",
  5 * 60 * 1_000,
);
const maxLimiterKeys = positiveInteger("RELAY_MAX_LIMITER_KEYS", 10_000);
const storeCapacity = {
  accounts: positiveInteger("RELAY_MAX_ACCOUNTS", 1_000),
  devicesPerAccount: positiveInteger(
    "RELAY_MAX_DEVICES_PER_ACCOUNT",
    20,
  ),
  activeRoomsPerAccount: positiveInteger(
    "RELAY_MAX_ACTIVE_ROOMS_PER_ACCOUNT",
    20,
  ),
  activeInvitesPerRoom: positiveInteger(
    "RELAY_MAX_ACTIVE_INVITES_PER_ROOM",
    5,
  ),
  activeMembershipsPerRoom: positiveInteger(
    "RELAY_MAX_PLAYERS_PER_ROOM",
    200,
  ),
  pendingPairingsPerAccount: positiveInteger(
    "RELAY_MAX_PENDING_PAIRINGS_PER_ACCOUNT",
    10,
  ),
};
const assetCapacity = {
  assetsPerRoom: positiveInteger("RELAY_MAX_ASSETS_PER_ROOM", 100),
  pendingGrantsPerDevice: positiveInteger(
    "RELAY_MAX_PENDING_ASSET_GRANTS_PER_DEVICE",
    20,
  ),
};
const trustProxy = process.env.RELAY_TRUST_PROXY === "true";
if (
  process.env.RELAY_TRUST_PROXY !== undefined &&
  !["true", "false"].includes(process.env.RELAY_TRUST_PROXY)
) {
  throw new Error("RELAY_TRUST_PROXY must be true or false");
}
const metricsToken = String(process.env.RELAY_METRICS_TOKEN || "").trim();
if (metricsToken && metricsToken.length < 24) {
  throw new Error("RELAY_METRICS_TOKEN must contain at least 24 characters");
}
const certFile = process.env.RELAY_TLS_CERT_FILE;
const keyFile = process.env.RELAY_TLS_KEY_FILE;
if (Boolean(certFile) !== Boolean(keyFile)) {
  throw new Error(
    "RELAY_TLS_CERT_FILE and RELAY_TLS_KEY_FILE must be configured together",
  );
}
const tls =
  certFile && keyFile
    ? {
        cert: await readFile(path.resolve(certFile)),
        key: await readFile(path.resolve(keyFile)),
      }
    : null;
const logger = createLogger();
const store = new RelayStore({
  file: stateFile,
  logger,
  capacity: storeCapacity,
});
const assetStore = new RelayAssetStore({
  root: assetRoot,
  maxBytes: maxAssetBytes,
  retentionMs: assetRetentionMs,
  grantTtlMs: assetGrantTtlMs,
  capacity: assetCapacity,
  logger,
});
const publicOrigin = process.env.RELAY_PUBLIC_ORIGIN || undefined;
if (publicOrigin) {
  const parsed = new URL(publicOrigin);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    parsed.origin !== publicOrigin.replace(/\/$/, "") ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "RELAY_PUBLIC_ORIGIN must be an HTTPS origin, except for loopback development",
    );
  }
}
const service = new HostedRelayService({
  store,
  assetStore,
  maxAssetBytes,
  maxLimiterKeys,
  trustProxy,
  metricsToken,
  host,
  port,
  tls,
  logger,
  publicOrigin,
});
const address = await service.start();
logger.info("hosted_relay_listening", {
  host: address.host,
  port: address.port,
  tls: Boolean(tls),
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info("hosted_relay_shutdown_started", { signal });
  try {
    await service.stop();
  } catch (error) {
    logger.error("hosted_relay_shutdown_failed", { error });
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
