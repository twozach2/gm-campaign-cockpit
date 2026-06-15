import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { restoreRelayBackup } from "./lib/maintenance.mjs";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(relayRoot);
await loadLocalEnvironment(appRoot);
const backupDir = process.argv[2];
if (!backupDir) {
  throw new Error("Usage: npm run relay:restore -- /path/to/relay-backup");
}
const stateFile = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(relayRoot, "data", "relay.json"),
);
const assetDir = path.resolve(
  process.env.RELAY_ASSET_DIR ||
    path.join(path.dirname(stateFile), "assets"),
);
const result = await restoreRelayBackup({
  backupDir: path.resolve(backupDir),
  stateFile,
  assetDir,
  confirmation: process.env.RELAY_RESTORE_CONFIRM,
});
console.log(`Relay backup restored to:\n  ${result.stateFile}\n  ${result.assetDir}`);
if (result.stateRollback || result.assetRollback) {
  console.log("Pre-restore rollback copies were preserved.");
}
