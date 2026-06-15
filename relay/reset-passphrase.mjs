import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnvironment } from "../lib/config.mjs";
import { RelayStore } from "./lib/store.mjs";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(relayRoot);
await loadLocalEnvironment(appRoot);

const [email] = process.argv.slice(2);
if (!email) {
  throw new Error(
    'Usage: npm run relay:reset-passphrase -- "dm@example.com"',
  );
}
const passphrase = process.env.RELAY_RESET_PASSPHRASE;
if (!passphrase) {
  throw new Error(
    "RELAY_RESET_PASSPHRASE is required to set the new account passphrase",
  );
}
const stateFile = path.resolve(
  process.env.RELAY_STATE_FILE || path.join(relayRoot, "data", "relay.json"),
);
const store = new RelayStore({ file: stateFile });
await store.init();
try {
  const account = store.accountByEmail(email);
  if (!account) {
    throw new Error(`No active account found for ${email}`);
  }
  const updated = await store.setAccountPassword(account.id, passphrase);
  process.stdout.write(
    `${JSON.stringify(
      {
        accountId: updated.id,
        email: updated.email,
        reset: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await store.close();
}
