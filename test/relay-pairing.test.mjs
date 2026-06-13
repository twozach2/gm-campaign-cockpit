import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HostedRelayService } from "../relay/lib/service.mjs";
import { RelayStore } from "../relay/lib/store.mjs";
import {
  api,
  localDmSession,
  startTestServer,
  stopTestServer,
} from "../test-support/server.mjs";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

async function waitFor(check, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for relay state");
}

test("local cockpit pairs, discovers a room, and opens its outbound relay connection", async (t) => {
  const relayRoot = await mkdtemp(path.join(os.tmpdir(), "gm-relay-pairing-"));
  const relayStore = new RelayStore({
    file: path.join(relayRoot, "relay.json"),
    logger: silentLogger,
  });
  const relayService = new HostedRelayService({
    store: relayStore,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  const relayAddress = await relayService.start();
  const relayBase = `http://127.0.0.1:${relayAddress.port}`;
  t.after(async () => {
    await relayService.stop();
    await rm(relayRoot, { recursive: true, force: true });
  });

  const account = await relayStore.createAccount({
    email: "pairing@example.test",
    passphrase: "a long pairing passphrase",
  });
  const pairing = await relayStore.createPairing({ accountId: account.id });

  const localRoot = await mkdtemp(path.join(os.tmpdir(), "gm-local-pairing-"));
  const local = await startTestServer(t, {
    root: localRoot,
    env: {
      RELAY_CONTROL_URL: relayBase,
      STATE_DIR: localRoot,
    },
  });
  t.after(async () => {
    await stopTestServer(local.child);
    await rm(localRoot, { recursive: true, force: true });
  });
  const dm = await localDmSession(local.base);
  const dmHeaders = {
    Cookie: dm.cookie,
    "X-GM-Cockpit-CSRF": dm.csrfToken,
  };

  const initial = await api(local.base, "GET", "/api/relay/state", undefined, {
    headers: { Cookie: dm.cookie },
  });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.configured, true);
  assert.equal(initial.data.paired, false);

  const paired = await api(
    local.base,
    "POST",
    "/api/relay/pair",
    {
      pairingToken: pairing.token,
      deviceName: "Campaign MacBook",
    },
    { headers: dmHeaders },
  );
  assert.equal(paired.status, 201);
  assert.equal(paired.data.paired, true);
  assert.equal(paired.data.device.name, "Campaign MacBook");
  assert.equal(paired.data.device.token, undefined);

  const device = relayStore.devices(account.id)[0];
  const room = await relayStore.createRoom({
    accountId: account.id,
    agentDeviceId: device.id,
    name: "Tuesday Worldwide",
  });

  const refreshed = await api(
    local.base,
    "POST",
    "/api/relay/refresh",
    {},
    { headers: dmHeaders },
  );
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.rooms[0].id, room.id);

  const connected = await api(
    local.base,
    "POST",
    "/api/relay/connect",
    { roomId: room.id },
    { headers: dmHeaders },
  );
  assert.equal(connected.status, 200);
  assert.equal(connected.data.roomId, room.id);

  const live = await waitFor(async () => {
    const result = await api(
      local.base,
      "GET",
      "/api/relay/state",
      undefined,
      { headers: { Cookie: dm.cookie } },
    );
    return result.data.connection.state === "connected" ? result.data : null;
  });
  assert.equal(live.connection.state, "connected");
  assert.equal(relayService.agents.get(room.id)?.hello, true);

  const persisted = JSON.parse(
    await readFile(path.join(localRoot, "relay-device.json"), "utf8"),
  );
  assert.equal(persisted.roomId, room.id);
  assert.ok(persisted.deviceToken);

  const unpaired = await api(
    local.base,
    "POST",
    "/api/relay/unpair",
    {},
    { headers: dmHeaders },
  );
  assert.equal(unpaired.status, 200);
  assert.equal(unpaired.data.paired, false);
  assert.equal(unpaired.data.connection.state, "unpaired");
});
