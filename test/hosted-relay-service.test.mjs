import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  encodeRelayEnvelope,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
} from "../lib/relay-protocol.mjs";
import {
  PLAYER_PROTOCOL_NAME,
  PLAYER_PROTOCOL_VERSION,
} from "../relay/lib/player-protocol.mjs";
import { HostedRelayService } from "../relay/lib/service.mjs";
import { RelayStore } from "../relay/lib/store.mjs";
import { connectWebSocket } from "../test-support/raw-websocket.mjs";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
};

async function startRelay(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-hosted-relay-"));
  const store = new RelayStore({
    file: path.join(root, "relay.json"),
    logger: silentLogger,
  });
  const service = new HostedRelayService({
    store,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  const address = await service.start();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return {
    service,
    store,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    track(socket) {
      sockets.push(socket);
      return socket;
    },
  };
}

async function bootstrap(store, email = "dm@example.test") {
  return store.bootstrap({
    email,
    deviceName: "Campaign laptop",
    roomName: "Tuesday table",
  });
}

function agentMessage(type, payload, roomId) {
  return JSON.parse(
    encodeRelayEnvelope(
      {
        protocol: RELAY_PROTOCOL_NAME,
        version: RELAY_PROTOCOL_VERSION,
        id: `agent-${type}-${Date.now()}`,
        type,
        ...(roomId ? { roomId } : {}),
        sentAt: Date.now(),
        payload,
      },
      { direction: "agent-to-relay" },
    ),
  );
}

function playerCommand(roomId, id, commandType, data) {
  return {
    protocol: PLAYER_PROTOCOL_NAME,
    version: PLAYER_PROTOCOL_VERSION,
    id,
    type: "command",
    roomId,
    sentAt: Date.now(),
    payload: { commandType, data },
  };
}

async function redeem(baseUrl, inviteToken, displayName) {
  const response = await fetch(`${baseUrl}/v1/invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inviteToken, displayName }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function adminRequest(
  relay,
  pathname,
  { method = "GET", body, cookie, csrf } = {},
) {
  const headers = { Origin: relay.baseUrl };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-GM-Relay-CSRF"] = csrf;
  const response = await fetch(`${relay.baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

async function loginAdmin(relay, email, passphrase) {
  const { response, data } = await adminRequest(relay, "/v1/admin/login", {
    method: "POST",
    body: { email, passphrase },
  });
  assert.equal(response.status, 200);
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    csrf: data.csrfToken,
    account: data.account,
  };
}

test("hosted relay exposes bounded health, readiness, and player session routes", async (t) => {
  const relay = await startRelay(t);
  const created = await bootstrap(relay.store);

  const page = await fetch(relay.baseUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Hosted Relay/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const script = await fetch(`${relay.baseUrl}/admin.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);

  const health = await fetch(`${relay.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.match(
    health.headers.get("content-security-policy"),
    /default-src 'none'/,
  );

  const readiness = await fetch(`${relay.baseUrl}/readiness`);
  assert.equal(readiness.status, 200);
  assert.equal((await readiness.json()).checks.persistence, "ready");

  const joined = await redeem(
    relay.baseUrl,
    created.invite.token,
    "Aria",
  );
  const unauthorized = await fetch(`${relay.baseUrl}/v1/player/session`);
  assert.equal(unauthorized.status, 401);

  const session = await fetch(`${relay.baseUrl}/v1/player/session`, {
    headers: { Authorization: `Bearer ${joined.token}` },
  });
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.membership.playerId, joined.membership.playerId);
  assert.equal(body.room.id, created.room.id);
  assert.equal(body.revision, 0);
  assert.deepEqual(body.state.chat, []);
});

test("agent and player WebSockets exchange authenticated room commands and events", async (t) => {
  const relay = await startRelay(t);
  const created = await bootstrap(relay.store);
  const joined = await redeem(
    relay.baseUrl,
    created.invite.token,
    "Aria",
  );
  const roomId = created.room.id;

  const agent = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/agent/${encodeURIComponent(roomId)}`,
      protocols: [
        "gm-campaign-cockpit-v1",
        `auth.${created.device.token}`,
      ],
    }),
  );
  agent.sendJson(
    agentMessage("agent.hello", {
      agentId: created.device.device.id,
      appVersion: "0.1.0",
      capabilities: [
        "room.snapshot",
        "room.event",
        "room.command-result",
      ],
    }),
  );
  const hello = await agent.nextJson((message) => message.type === "relay.hello");
  assert.equal(hello.payload.acceptedRevision, 0);
  const membership = await agent.nextJson(
    (message) => message.type === "room.membership",
  );
  assert.equal(membership.payload.players[0].displayName, "Aria");

  const player = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/player/${encodeURIComponent(roomId)}`,
      protocols: [
        "gm-campaign-cockpit-player-v1",
        `auth.${joined.token}`,
      ],
    }),
  );
  const snapshot = await player.nextJson(
    (message) => message.type === "snapshot",
  );
  assert.equal(snapshot.payload.membership.playerId, joined.membership.playerId);
  assert.equal(snapshot.payload.revision, 0);

  player.sendJson(
    playerCommand(roomId, "player-command-1", "chat.send", {
      text: "Hello from afar",
      whisper: false,
    }),
  );
  const command = await agent.nextJson(
    (message) => message.type === "room.command",
  );
  assert.equal(command.payload.playerId, joined.membership.playerId);
  assert.equal(command.payload.data.text, "Hello from afar");

  agent.sendJson(
    agentMessage(
      "room.event",
      {
        revision: 1,
        eventType: "chat.append",
        audience: { kind: "all" },
        data: {
          message: {
            id: 1,
            ts: Date.now(),
            scope: "table",
            from: "Aria",
            fromPlayerId: joined.membership.playerId,
            text: "Hello from afar",
          },
        },
      },
      roomId,
    ),
  );
  agent.sendJson(
    agentMessage(
      "room.command-result",
      {
        commandId: command.payload.commandId,
        accepted: true,
        revision: 1,
      },
      roomId,
    ),
  );

  const event = await player.nextJson((message) => message.type === "event");
  assert.equal(event.payload.eventType, "chat.append");
  const result = await player.nextJson(
    (message) => message.type === "command-result",
  );
  assert.equal(result.id, "player-command-1");
  assert.equal(result.payload.accepted, true);
  assert.equal(relay.store.roomState(roomId).revision, 1);
});

test("WebSocket authorization and fanout remain isolated by room", async (t) => {
  const relay = await startRelay(t);
  const first = await bootstrap(relay.store, "one@example.test");
  const second = await bootstrap(relay.store, "two@example.test");
  const firstPlayer = await redeem(
    relay.baseUrl,
    first.invite.token,
    "Aria",
  );
  const secondPlayer = await redeem(
    relay.baseUrl,
    second.invite.token,
    "Bram",
  );

  await assert.rejects(
    connectWebSocket({
      port: relay.port,
      pathname: `/v1/agent/${encodeURIComponent(second.room.id)}`,
      protocols: [
        "gm-campaign-cockpit-v1",
        `auth.${first.device.token}`,
      ],
    }),
    (error) => error.statusCode === 401,
  );
  await assert.rejects(
    connectWebSocket({
      port: relay.port,
      pathname: `/v1/player/${encodeURIComponent(second.room.id)}`,
      protocols: [
        "gm-campaign-cockpit-player-v1",
        `auth.${firstPlayer.token}`,
      ],
    }),
    (error) => error.statusCode === 401,
  );

  const firstAgent = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/agent/${encodeURIComponent(first.room.id)}`,
      protocols: [
        "gm-campaign-cockpit-v1",
        `auth.${first.device.token}`,
      ],
    }),
  );
  firstAgent.sendJson(
    agentMessage("agent.hello", {
      agentId: first.device.device.id,
      appVersion: "0.1.0",
      capabilities: [],
    }),
  );
  await firstAgent.nextJson((message) => message.type === "relay.hello");

  const firstSocket = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/player/${encodeURIComponent(first.room.id)}`,
      protocols: [
        "gm-campaign-cockpit-player-v1",
        `auth.${firstPlayer.token}`,
      ],
    }),
  );
  const secondSocket = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/player/${encodeURIComponent(second.room.id)}`,
      protocols: [
        "gm-campaign-cockpit-player-v1",
        `auth.${secondPlayer.token}`,
      ],
    }),
  );
  await firstSocket.nextJson((message) => message.type === "snapshot");
  await secondSocket.nextJson((message) => message.type === "snapshot");

  firstAgent.sendJson(
    agentMessage(
      "room.event",
      {
        revision: 1,
        eventType: "presence.set",
        audience: { kind: "all" },
        data: {
          players: [
            {
              playerId: firstPlayer.membership.playerId,
              displayName: "Aria",
            },
          ],
        },
      },
      first.room.id,
    ),
  );
  const firstEvent = await firstSocket.nextJson(
    (message) => message.type === "event",
  );
  assert.equal(firstEvent.payload.eventType, "presence.set");
  await secondSocket.expectNoJson((message) => message.type === "event");
});

test("account sessions protect pairing and room lifecycle controls", async (t) => {
  const relay = await startRelay(t);
  const account = await relay.store.createAccount({
    email: "admin@example.test",
    passphrase: "correct horse battery staple",
  });
  const admin = await loginAdmin(
    relay,
    "admin@example.test",
    "correct horse battery staple",
  );
  assert.equal(admin.account.id, account.id);

  const denied = await adminRequest(relay, "/v1/admin/pairings", {
    method: "POST",
    body: {},
    cookie: admin.cookie,
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.data.code, "CSRF_REJECTED");

  const pairingResult = await adminRequest(relay, "/v1/admin/pairings", {
    method: "POST",
    body: {},
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(pairingResult.response.status, 201);
  assert.ok(pairingResult.data.token);

  const pairedResponse = await fetch(`${relay.baseUrl}/v1/devices/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken: pairingResult.data.token,
      deviceName: "Campaign MacBook",
    }),
  });
  assert.equal(pairedResponse.status, 201);
  const paired = await pairedResponse.json();

  const duplicatePairing = await fetch(`${relay.baseUrl}/v1/devices/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairingToken: pairingResult.data.token,
      deviceName: "Another laptop",
    }),
  });
  assert.equal(duplicatePairing.status, 401);

  const roomResult = await adminRequest(relay, "/v1/admin/rooms", {
    method: "POST",
    body: {
      deviceId: paired.device.id,
      name: "Worldwide Tuesday Game",
    },
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(roomResult.response.status, 201);
  assert.ok(roomResult.data.invite.token);

  const deviceState = await fetch(`${relay.baseUrl}/v1/device/state`, {
    headers: { Authorization: `Bearer ${paired.token}` },
  });
  assert.equal(deviceState.status, 200);
  const deviceData = await deviceState.json();
  assert.equal(deviceData.rooms[0].id, roomResult.data.room.id);

  const adminState = await adminRequest(relay, "/v1/admin/state", {
    cookie: admin.cookie,
  });
  assert.equal(adminState.response.status, 200);
  const serializedAdminState = JSON.stringify(adminState.data);
  assert.doesNotMatch(serializedAdminState, /tokenHash|passwordHash|passwordSalt/);
  assert.doesNotMatch(serializedAdminState, new RegExp(paired.token));

  const closed = await adminRequest(relay, "/v1/admin/rooms/joins", {
    method: "POST",
    body: { roomId: roomResult.data.room.id, joinsOpen: false },
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.data.room.joinsOpen, false);
  const closedJoin = await fetch(`${relay.baseUrl}/v1/invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteToken: roomResult.data.invite.token,
      displayName: "Aria",
    }),
  });
  assert.equal(closedJoin.status, 403);

  const reopened = await adminRequest(relay, "/v1/admin/rooms/joins", {
    method: "POST",
    body: { roomId: roomResult.data.room.id, joinsOpen: true },
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(reopened.response.status, 200);
  const joined = await redeem(
    relay.baseUrl,
    roomResult.data.invite.token,
    "Aria",
  );

  const removed = await adminRequest(
    relay,
    "/v1/admin/memberships/remove",
    {
      method: "POST",
      body: {
        roomId: roomResult.data.room.id,
        membershipId: joined.membership.id,
      },
      cookie: admin.cookie,
      csrf: admin.csrf,
    },
  );
  assert.equal(removed.response.status, 200);
  assert.equal(relay.store.authenticateMembership(joined.token), null);

  const rotated = await adminRequest(relay, "/v1/admin/invites/rotate", {
    method: "POST",
    body: { roomId: roomResult.data.room.id },
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(rotated.response.status, 201);
  assert.notEqual(rotated.data.token, roomResult.data.invite.token);

  const revoked = await adminRequest(relay, "/v1/admin/devices/revoke", {
    method: "POST",
    body: { deviceId: paired.device.id },
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(revoked.response.status, 200);
  assert.ok(revoked.data.device.revokedAt);
  const revokedState = await fetch(`${relay.baseUrl}/v1/device/state`, {
    headers: { Authorization: `Bearer ${paired.token}` },
  });
  assert.equal(revokedState.status, 401);
  assert.equal(relay.store.room(roomResult.data.room.id).status, "ended");
});

test("admin login rejects cross-origin requests and supports logout", async (t) => {
  const relay = await startRelay(t);
  await relay.store.createAccount({
    email: "admin@example.test",
    passphrase: "correct horse battery staple",
  });
  const crossOrigin = await fetch(`${relay.baseUrl}/v1/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://malicious.example",
    },
    body: JSON.stringify({
      email: "admin@example.test",
      passphrase: "correct horse battery staple",
    }),
  });
  assert.equal(crossOrigin.status, 403);

  const admin = await loginAdmin(
    relay,
    "admin@example.test",
    "correct horse battery staple",
  );
  const session = await adminRequest(relay, "/v1/admin/session", {
    cookie: admin.cookie,
  });
  assert.equal(session.response.status, 200);
  const logout = await adminRequest(relay, "/v1/admin/logout", {
    method: "POST",
    body: {},
    cookie: admin.cookie,
    csrf: admin.csrf,
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0/i);
  const expired = await adminRequest(relay, "/v1/admin/session", {
    cookie: admin.cookie,
  });
  assert.equal(expired.response.status, 401);
});
