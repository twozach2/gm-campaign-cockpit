import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { RelayStore } from "./lib/store.mjs";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(relayRoot);
await loadLocalEnvironment(appRoot);

const [email, deviceName = "GM Cockpit", roomName = "Campaign Room"] =
  process.argv.slice(2);
if (!email) {
  throw new Error(
    'Usage: npm run relay:bootstrap -- "dm@example.com" "Device name" "Room name"',
  );
}
const stateFile = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(relayRoot, "data", "relay.json"),
);
const store = new RelayStore({ file: stateFile });
await store.init();
try {
  const created = await store.bootstrap({ email, deviceName, roomName });
  process.stdout.write(
    `${JSON.stringify(
      {
        accountId: created.account.id,
        deviceId: created.device.device.id,
        deviceToken: created.device.token,
        roomId: created.room.id,
        inviteToken: created.invite.token,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store.close();
}
