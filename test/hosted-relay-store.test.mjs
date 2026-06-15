import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayStore } from "../relay/lib/store.mjs";

function deterministicValues() {
  let sequence = 0;
  return {
    randomId(prefix) {
      sequence += 1;
      return `${prefix}_test_${sequence}`;
    },
    randomSecret() {
      sequence += 1;
      return `secret-value-${sequence}-with-sufficient-length`;
    },
  };
}

async function createStore(t, { legacy, capacity } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-relay-store-"));
  const file = path.join(root, "relay-state.json");
  if (legacy) await writeFile(file, JSON.stringify(legacy), "utf8");
  const values = deterministicValues();
  const store = new RelayStore({
    file,
    now: () => 1_000,
    capacity,
    ...values,
  });
  await store.init();
  t.after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { file, store };
}

test("relay store enforces account, device, room, invite, pairing, and player capacity", async (t) => {
  const { store } = await createStore(t, {
    capacity: {
      accounts: 1,
      devicesPerAccount: 1,
      activeRoomsPerAccount: 1,
      activeInvitesPerRoom: 1,
      activeMembershipsPerRoom: 1,
      pendingPairingsPerAccount: 1,
    },
  });
  const created = await bootstrap(store);

  await assert.rejects(
    store.createAccount({ email: "second@example.test" }),
    (error) => error.code === "ACCOUNT_CAPACITY",
  );
  await assert.rejects(
    store.createDevice({ accountId: created.account.id, name: "Second device" }),
    (error) => error.code === "DEVICE_CAPACITY",
  );
  await assert.rejects(
    store.createRoom({
      accountId: created.account.id,
      agentDeviceId: created.device.device.id,
      name: "Second room",
    }),
    (error) => error.code === "ROOM_CAPACITY",
  );
  await assert.rejects(
    store.createInvite({ roomId: created.room.id }),
    (error) => error.code === "INVITE_CAPACITY",
  );
  await store.createPairing({ accountId: created.account.id });
  await assert.rejects(
    store.createPairing({ accountId: created.account.id }),
    (error) => error.code === "PAIRING_CAPACITY",
  );
  await store.redeemInvite({
    token: created.invite.token,
    displayName: "Aria",
  });
  await assert.rejects(
    store.redeemInvite({
      token: created.invite.token,
      displayName: "Bram",
    }),
    (error) => error.code === "MEMBERSHIP_CAPACITY",
  );
});

async function bootstrap(store, email = "dm@example.test") {
  return store.bootstrap({
    email,
    deviceName: "Home table",
    roomName: "Tuesday Game",
  });
}

test("relay store migrates schema zero before becoming ready", async (t) => {
  const { file, store } = await createStore(t, {
    legacy: {
      schemaVersion: 0,
      accounts: [],
    },
  });
  assert.equal(store.snapshot().schemaVersion, 2);
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.devices, []);
  assert.deepEqual(persisted.roomStates, []);
  assert.deepEqual(persisted.pairings, []);
});

test("bootstrap persists accounts, devices, rooms, and invites without secrets", async (t) => {
  const { file, store } = await createStore(t);
  const created = await bootstrap(store);
  assert.equal(created.account.email, "dm@example.test");
  assert.ok(created.device.token);
  assert.ok(created.invite.token);
  assert.equal(
    store.authorizeDeviceRoom(
      created.device.device.id,
      created.room.id,
    )?.id,
    created.room.id,
  );

  const persisted = await readFile(file, "utf8");
  assert.doesNotMatch(persisted, new RegExp(created.device.token));
  assert.doesNotMatch(persisted, new RegExp(created.invite.token));
  assert.doesNotMatch(persisted, /vaultRoot|sessionNotes|workbook|campaign/i);
  assert.match(persisted, /tokenHash/);
});

test("invite redemption creates room-scoped memberships", async (t) => {
  const { store } = await createStore(t);
  const created = await bootstrap(store);
  const joined = await store.redeemInvite({
    token: created.invite.token,
    displayName: "Aria",
  });
  assert.equal(joined.membership.roomId, created.room.id);
  assert.equal(joined.membership.displayName, "Aria");
  assert.deepEqual(
    store.authenticateMembership(joined.token),
    joined.membership,
  );
  assert.equal(store.memberships(created.room.id).length, 1);

  await assert.rejects(
    store.redeemInvite({
      token: "wrong-invite-token-with-sufficient-length",
      displayName: "Bram",
    }),
    (error) => error.code === "INVITE_INVALID" && error.status === 401,
  );
});

test("device authorization is isolated by account and assigned room", async (t) => {
  const { store } = await createStore(t);
  const first = await bootstrap(store, "first@example.test");
  const second = await bootstrap(store, "second@example.test");

  assert.equal(
    store.authorizeDeviceRoom(
      first.device.device.id,
      second.room.id,
    ),
    null,
  );
  await assert.rejects(
    store.applySnapshot({
      deviceId: first.device.device.id,
      roomId: second.room.id,
      revision: 1,
      state: store.roomState(second.room.id).state,
    }),
    (error) => error.code === "ROOM_FORBIDDEN" && error.status === 403,
  );
});

test("snapshots and events enforce monotonic room revisions", async (t) => {
  const { store } = await createStore(t);
  const created = await bootstrap(store);
  const deviceId = created.device.device.id;
  const roomId = created.room.id;
  const initial = store.roomState(roomId).state;

  await store.applySnapshot({
    deviceId,
    roomId,
    revision: 5,
    state: initial,
  });
  assert.equal(store.roomState(roomId).revision, 5);

  await store.applyEvent({
    deviceId,
    roomId,
    revision: 6,
    eventType: "presence.set",
    audience: { kind: "all" },
    data: {
      players: [{ playerId: "player_remote_1", displayName: "Aria" }],
    },
  });
  assert.equal(store.roomState(roomId).revision, 6);
  assert.equal(store.roomState(roomId).state.players[0].displayName, "Aria");

  await assert.rejects(
    store.applyEvent({
      deviceId,
      roomId,
      revision: 8,
      eventType: "presence.set",
      audience: { kind: "all" },
      data: { players: [] },
    }),
    (error) => error.code === "REVISION_GAP" && error.status === 409,
  );
  await assert.rejects(
    store.applySnapshot({
      deviceId,
      roomId,
      revision: 4,
      state: initial,
    }),
    (error) => error.code === "STALE_REVISION" && error.status === 409,
  );
});

test("room state remains isolated and chat retention is bounded", async (t) => {
  const { store } = await createStore(t);
  const first = await bootstrap(store, "one@example.test");
  const second = await bootstrap(store, "two@example.test");

  for (let index = 1; index <= 205; index += 1) {
    await store.applyEvent({
      deviceId: first.device.device.id,
      roomId: first.room.id,
      revision: index,
      eventType: "chat.append",
      audience: { kind: "all" },
      data: {
        message: {
          id: index,
          ts: 1_000 + index,
          scope: "table",
          from: "Aria",
          fromPlayerId: "player_remote_1",
          text: `Message ${index}`,
        },
      },
    });
  }

  const firstState = store.roomState(first.room.id);
  const secondState = store.roomState(second.room.id);
  assert.equal(firstState.state.chat.length, 200);
  assert.equal(firstState.state.chat[0].id, 6);
  assert.equal(secondState.state.chat.length, 0);
});

test("account passwords authenticate without exposing password material", async (t) => {
  const { file, store } = await createStore(t);
  const account = await store.createAccount({
    email: "secure@example.test",
    passphrase: "a sufficiently long passphrase",
  });
  assert.deepEqual(
    store.authenticateAccount(
      "SECURE@example.test",
      "a sufficiently long passphrase",
    ),
    account,
  );
  assert.equal(
    store.authenticateAccount("secure@example.test", "wrong passphrase"),
    null,
  );
  const persisted = await readFile(file, "utf8");
  assert.doesNotMatch(persisted, /a sufficiently long passphrase/);
  assert.match(persisted, /passwordHash/);
});

test("pairing capabilities are expiring and single-use", async (t) => {
  const { store } = await createStore(t);
  const account = await store.createAccount({
    email: "pair@example.test",
    passphrase: "pairing passphrase",
  });
  const pairing = await store.createPairing({ accountId: account.id });
  const paired = await store.redeemPairing({
    token: pairing.token,
    name: "MacBook",
  });
  assert.equal(paired.account.id, account.id);
  assert.equal(paired.device.name, "MacBook");
  assert.deepEqual(store.authenticateDevice(paired.token), paired.device);
  await assert.rejects(
    store.redeemPairing({ token: pairing.token, name: "Another device" }),
    (error) => error.code === "PAIRING_INVALID" && error.status === 401,
  );
});

test("account lifecycle controls revoke devices, invites, rooms, and memberships", async (t) => {
  const { store } = await createStore(t);
  const created = await bootstrap(store);
  const joined = await store.redeemInvite({
    token: created.invite.token,
    displayName: "Aria",
  });

  const closed = await store.setRoomJoins(
    created.account.id,
    created.room.id,
    false,
  );
  assert.equal(closed.joinsOpen, false);
  const rotated = await store.rotateInvite(
    created.account.id,
    created.room.id,
  );
  assert.ok(rotated.token);
  assert.equal(
    store.invites(created.room.id).filter((invite) => invite.revokedAt === null)
      .length,
    1,
  );
  const removed = await store.removeMembership(
    created.account.id,
    created.room.id,
    joined.membership.id,
  );
  assert.ok(removed.revokedAt);
  assert.equal(store.authenticateMembership(joined.token), null);

  const ended = await store.endRoom(created.account.id, created.room.id);
  assert.equal(ended.status, "ended");
  assert.equal(ended.joinsOpen, false);
  const revokedDevice = await store.revokeDevice(
    created.account.id,
    created.device.device.id,
  );
  assert.ok(revokedDevice.revokedAt);
  assert.equal(store.authenticateDevice(created.device.token), null);
});
