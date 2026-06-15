import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { createRelayBackup } from "./lib/maintenance.mjs";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(relayRoot);
await loadLocalEnvironment(appRoot);
const stateFile = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(relayRoot, "data", "relay.json"),
);
const assetDir = path.resolve(
  process.env.RELAY_ASSET_DIR ||
    path.join(path.dirname(stateFile), "assets"),
);
const destinationRoot = path.resolve(
  process.argv[2] ||
    process.env.RELAY_BACKUP_DIR ||
    path.join(relayRoot, "backups"),
);

const result = await createRelayBackup({
  stateFile,
  assetDir,
  destinationRoot,
});
console.log(`Relay backup created at:\n  ${result.backupDir}`);
console.log(`Verified files: ${result.files}`);
