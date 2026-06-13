import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RelayAssetStore } from "../relay/lib/assets.mjs";
import { HostedRelayService } from "../relay/lib/service.mjs";
import { RelayStore } from "../relay/lib/store.mjs";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlXgAAAAASUVORK5CYII=",
  "base64",
);
const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

function sha256(content) {
  return createHash("sha256").update(content).digest("base64url");
}

async function startRelay(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-relay-assets-"));
  const store = new RelayStore({
    file: path.join(root, "relay.json"),
    logger: silentLogger,
  });
  const assetStore = new RelayAssetStore({
    root: path.join(root, "assets"),
    logger: silentLogger,
  });
  const service = new HostedRelayService({
    store,
    assetStore,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  const address = await service.start();
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    assetStore,
    service,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function bootstrap(store, email) {
  return store.bootstrap({
    email,
    passphrase: "a sufficiently long passphrase",
    deviceName: "Campaign laptop",
    roomName: "Tuesday table",
  });
}

async function createGrant(relay, created, content = PNG, contentType = "image/png") {
  const response = await fetch(`${relay.baseUrl}/v1/device/assets/grants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${created.device.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomId: created.room.id,
      contentType,
      byteLength: content.length,
      sha256: sha256(content),
    }),
  });
  return { response, data: await response.json() };
}

async function upload(relay, grant, content = PNG, contentType = "image/png") {
  return fetch(
    `${relay.baseUrl}/v1/assets/upload/${encodeURIComponent(grant.assetId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${grant.uploadToken}`,
        "Content-Type": contentType,
        "Content-Length": String(content.length),
      },
      body: content,
    },
  );
}

async function join(relay, created, displayName) {
  const response = await fetch(`${relay.baseUrl}/v1/invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteToken: created.invite.token,
      displayName,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("hosted assets use one-time grants and membership-authorized downloads", async (t) => {
  const relay = await startRelay(t);
  const first = await bootstrap(relay.store, "first@example.test");
  const second = await bootstrap(relay.store, "second@example.test");

  const granted = await createGrant(relay, first);
  assert.equal(granted.response.status, 201);
  assert.match(granted.data.assetId, /^asset_/);
  assert.ok(granted.data.uploadToken);

  const manifestBeforeUpload = await readFile(
    path.join(relay.root, "assets", "assets.json"),
    "utf8",
  );
  assert.doesNotMatch(
    manifestBeforeUpload,
    new RegExp(granted.data.uploadToken),
  );

  const uploaded = await upload(relay, granted.data);
  assert.equal(uploaded.status, 201);
  assert.equal((await uploaded.json()).asset.id, granted.data.assetId);

  const replayed = await upload(relay, granted.data);
  assert.equal(replayed.status, 401);

  const firstPlayer = await join(relay, first, "Aria");
  const secondPlayer = await join(relay, second, "Bram");
  const unauthorized = await fetch(
    `${relay.baseUrl}/v1/assets/${granted.data.assetId}`,
  );
  assert.equal(unauthorized.status, 401);

  const wrongRoom = await fetch(
    `${relay.baseUrl}/v1/assets/${granted.data.assetId}`,
    {
      headers: { Authorization: `Bearer ${secondPlayer.token}` },
    },
  );
  assert.equal(wrongRoom.status, 404);

  const image = await fetch(
    `${relay.baseUrl}/v1/assets/${granted.data.assetId}`,
    {
      headers: { Authorization: `Bearer ${firstPlayer.token}` },
    },
  );
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const removed = await fetch(
    `${relay.baseUrl}/v1/device/assets/${granted.data.assetId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${first.device.token}` },
    },
  );
  assert.equal(removed.status, 200);

  const gone = await fetch(
    `${relay.baseUrl}/v1/assets/${granted.data.assetId}`,
    {
      headers: { Authorization: `Bearer ${firstPlayer.token}` },
    },
  );
  assert.equal(gone.status, 404);

  const secondGrant = await createGrant(relay, first);
  assert.equal(secondGrant.response.status, 201);
  assert.equal((await upload(relay, secondGrant.data)).status, 201);

  const login = await fetch(`${relay.baseUrl}/v1/admin/login`, {
    method: "POST",
    headers: {
      Origin: relay.baseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: "first@example.test",
      passphrase: "a sufficiently long passphrase",
    }),
  });
  assert.equal(login.status, 200);
  const loginData = await login.json();
  const ended = await fetch(`${relay.baseUrl}/v1/admin/rooms/end`, {
    method: "POST",
    headers: {
      Origin: relay.baseUrl,
      Cookie: login.headers.get("set-cookie").split(";")[0],
      "X-GM-Relay-CSRF": loginData.csrfToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roomId: first.room.id }),
  });
  assert.equal(ended.status, 200);
  assert.equal(relay.assetStore.asset(secondGrant.data.assetId), null);
});

test("hosted assets reject spoofed bytes and cross-room device grants", async (t) => {
  const relay = await startRelay(t);
  const first = await bootstrap(relay.store, "first@example.test");
  const second = await bootstrap(relay.store, "second@example.test");
  const spoofed = Buffer.from("<script>alert(1)</script>", "utf8");

  const wrongRoom = await fetch(`${relay.baseUrl}/v1/device/assets/grants`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${first.device.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomId: second.room.id,
      contentType: "image/png",
      byteLength: PNG.length,
      sha256: sha256(PNG),
    }),
  });
  assert.equal(wrongRoom.status, 403);

  const granted = await createGrant(relay, first, spoofed);
  assert.equal(granted.response.status, 201);
  const rejected = await upload(relay, granted.data, spoofed);
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /do not match/i);
  assert.equal(relay.assetStore.asset(granted.data.assetId), null);
});

test("asset pruning removes expired bytes and room cleanup removes active assets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-asset-prune-"));
  let now = 1_000;
  let sequence = 0;
  const assetStore = new RelayAssetStore({
    root,
    now: () => now,
    retentionMs: 100,
    grantTtlMs: 50,
    randomId: (prefix) => `${prefix}_test_${++sequence}`,
    randomSecret: () => `upload-secret-${++sequence}-with-sufficient-length`,
  });
  await assetStore.init();
  t.after(async () => {
    await assetStore.close();
    await rm(root, { recursive: true, force: true });
  });

  const grant = await assetStore.createGrant({
    roomId: "room_test",
    deviceId: "dev_test",
    contentType: "image/png",
    byteLength: PNG.length,
    sha256: sha256(PNG),
  });
  await assetStore.completeUpload({
    assetId: grant.assetId,
    uploadToken: grant.uploadToken,
    contentType: "image/png",
    content: PNG,
  });
  assert.ok(assetStore.asset(grant.assetId));

  now += 101;
  assert.equal(await assetStore.prune(), 1);
  assert.equal(assetStore.asset(grant.assetId), null);

  const second = await assetStore.createGrant({
    roomId: "room_test",
    deviceId: "dev_test",
    contentType: "image/png",
    byteLength: PNG.length,
    sha256: sha256(PNG),
  });
  await assetStore.completeUpload({
    assetId: second.assetId,
    uploadToken: second.uploadToken,
    contentType: "image/png",
    content: PNG,
  });
  assert.equal((await assetStore.deleteRoomAssets("room_test")).length, 1);
  assert.equal(assetStore.asset(second.assetId), null);
});
