import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { createLogger } from "../lib/logger.mjs";
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
const store = new RelayStore({ file: stateFile, logger });
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
