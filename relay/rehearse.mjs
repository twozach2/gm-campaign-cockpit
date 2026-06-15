import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { rehearseRelayMigration } from "./lib/maintenance.mjs";

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
const result = await rehearseRelayMigration({ stateFile, assetDir });
console.log(JSON.stringify(result, null, 2));
