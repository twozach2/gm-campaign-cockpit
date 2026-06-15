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

async function waitFor(check, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for hosted relay state");
}

async function startRelay(t, serviceOptions = {}, storeOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-hosted-relay-"));
  const store = new RelayStore({
    file: path.join(root, "relay.json"),
    logger: silentLogger,
    ...storeOptions,
  });
  const service = new HostedRelayService({
    store,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
    ...serviceOptions,
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

test("hosted relay rate limits public credentials and protects metrics", async (t) => {
  const metricsToken = "private-monitoring-token-with-length";
  const auditEvents = [];
  const relay = await startRelay(t, {
    metricsToken,
    logger: {
      info(event, details) {
        if (event === "relay_audit") auditEvents.push(details);
      },
      warn() {},
      error() {},
    },
    rateLimits: {
      loginPerIp: { capacity: 1, windowMs: 60_000 },
      invitePerIp: { capacity: 1, windowMs: 60_000 },
      invitePerToken: { capacity: 1, windowMs: 60_000 },
    },
  });
  const created = await relay.store.bootstrap({
    email: "limited@example.test",
    passphrase: "a long account passphrase",
    deviceName: "Campaign laptop",
    roomName: "Limited table",
  });

  const firstLogin = await adminRequest(relay, "/v1/admin/login", {
    method: "POST",
    body: {
      email: "limited@example.test",
      passphrase: "a long account passphrase",
    },
  });
  assert.equal(firstLogin.response.status, 200);
  const secondLogin = await adminRequest(relay, "/v1/admin/login", {
    method: "POST",
    body: {
      email: "limited@example.test",
      passphrase: "a long account passphrase",
    },
  });
  assert.equal(secondLogin.response.status, 429);
  assert.equal(secondLogin.data.code, "RATE_LIMITED");
  assert.ok(Number(secondLogin.response.headers.get("retry-after")) >= 1);
  const thirdLogin = await adminRequest(relay, "/v1/admin/login", {
    method: "POST",
    body: {
      email: "limited@example.test",
      passphrase: "a long account passphrase",
    },
  });
  assert.equal(thirdLogin.response.status, 429);

  assert.equal(
    (await redeem(relay.baseUrl, created.invite.token, "Aria")).room.id,
    created.room.id,
  );
  const secondJoin = await fetch(`${relay.baseUrl}/v1/invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inviteToken: created.invite.token,
      displayName: "Bram",
    }),
  });
  assert.equal(secondJoin.status, 429);

  assert.equal((await fetch(`${relay.baseUrl}/metrics`)).status, 404);
  const metrics = await fetch(`${relay.baseUrl}/metrics`, {
    headers: { Authorization: `Bearer ${metricsToken}` },
  });
  assert.equal(metrics.status, 200);
  const body = await metrics.json();
  assert.ok(body.requests.rateLimited >= 2);
  assert.equal(body.records.accounts, 1);
  assert.equal(body.records.activeRooms, 1);
  assert.ok(body.requests.auditEvents >= 3);
  assert.doesNotMatch(JSON.stringify(body), /limited@example|tokenHash|passphrase/);
  assert.ok(
    auditEvents.some(
      (event) =>
        event.action === "admin.login" && event.result === "accepted",
    ),
  );
  assert.ok(
    auditEvents.some((event) => event.action === "rate_limit.exceeded"),
  );
  assert.equal(
    auditEvents.filter(
      (event) =>
        event.action === "rate_limit.exceeded" &&
        event.bucket === "login-ip",
    ).length,
    1,
  );
  assert.doesNotMatch(JSON.stringify(auditEvents), /passphrase|inviteToken/i);
});

test("admin login locks an account after repeated failures", async (t) => {
  const relay = await startRelay(
    t,
    {
      rateLimits: {
        loginPerIp: { capacity: 50, windowMs: 60_000 },
        loginPerAccount: { capacity: 50, windowMs: 60_000 },
      },
    },
    { lockout: { threshold: 3, baseMs: 60_000, maxMs: 60_000 } },
  );
  await relay.store.createAccount({
    email: "dm@example.test",
    passphrase: "correct horse battery staple",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const bad = await adminRequest(relay, "/v1/admin/login", {
      method: "POST",
      body: { email: "dm@example.test", passphrase: "an incorrect passphrase" },
    });
    assert.equal(bad.response.status, 401);
  }
  const locked = await adminRequest(relay, "/v1/admin/login", {
    method: "POST",
    body: {
      email: "dm@example.test",
      passphrase: "correct horse battery staple",
    },
  });
  assert.equal(locked.response.status, 423);
  assert.ok(Number(locked.response.headers.get("retry-after")) >= 1);
});

test("admin sessions survive a relay restart on the same data directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-relay-session-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "relay.json");

  const firstStore = new RelayStore({ file, logger: silentLogger });
  const firstService = new HostedRelayService({
    store: firstStore,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  const firstAddress = await firstService.start();
  let firstStopped = false;
  t.after(async () => {
    if (!firstStopped) await firstService.stop();
  });
  const firstOrigin = `http://127.0.0.1:${firstAddress.port}`;
  await firstStore.createAccount({
    email: "dm@example.test",
    passphrase: "correct horse battery staple",
  });
  const login = await fetch(`${firstOrigin}/v1/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: firstOrigin },
    body: JSON.stringify({
      email: "dm@example.test",
      passphrase: "correct horse battery staple",
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await firstService.stop();
  firstStopped = true;

  const secondStore = new RelayStore({ file, logger: silentLogger });
  const secondService = new HostedRelayService({
    store: secondStore,
    host: "127.0.0.1",
    port: 0,
    heartbeatMs: 60_000,
    logger: silentLogger,
  });
  const secondAddress = await secondService.start();
  t.after(async () => {
    await secondService.stop();
  });
  const session = await fetch(
    `http://127.0.0.1:${secondAddress.port}/v1/admin/session`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.email, "dm@example.test");
});

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
  const playerPage = await fetch(`${relay.baseUrl}/player/`);
  assert.equal(playerPage.status, 200);
  assert.match(await playerPage.text(), /Join the table/);
  const playerScript = await fetch(`${relay.baseUrl}/player/player.js`);
  assert.equal(playerScript.status, 200);
  const playerScriptSource = await playerScript.text();
  assert.match(playerScriptSource, /gm-campaign-cockpit-player-v1/);
  assert.match(playerScriptSource, /\/v1\/assets\//);
  assert.match(playerScriptSource, /Authorization.*Bearer/);
  assert.doesNotMatch(playerScriptSource, /\?token=|searchParams.*token/i);
  const renderer = await fetch(`${relay.baseUrl}/player/render.mjs`);
  assert.equal(renderer.status, 200);
  assert.match(await renderer.text(), /export function escapeHtml/);

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

  player.sendJson({
    protocol: PLAYER_PROTOCOL_NAME,
    version: PLAYER_PROTOCOL_VERSION,
    id: "player-heartbeat-1",
    type: "heartbeat",
    roomId,
    sentAt: Date.now(),
    payload: { nonce: "heartbeat-response" },
  });
  await player.expectNoJson((message) => message.type === "heartbeat");

  player.close();
  agent.sendJson(
    agentMessage(
      "room.event",
      {
        revision: 2,
        eventType: "presence.set",
        audience: { kind: "all" },
        data: {
          players: [
            {
              playerId: joined.membership.playerId,
              displayName: "Aria",
            },
          ],
        },
      },
      roomId,
    ),
  );
  await waitFor(() => relay.store.roomState(roomId).revision === 2);
  const reconnected = relay.track(
    await connectWebSocket({
      port: relay.port,
      pathname: `/v1/player/${encodeURIComponent(roomId)}`,
      protocols: [
        "gm-campaign-cockpit-player-v1",
        `auth.${joined.token}`,
      ],
    }),
  );
  const resumed = await reconnected.nextJson(
    (message) => message.type === "snapshot",
  );
  assert.equal(resumed.payload.revision, 2);
  assert.equal(resumed.payload.state.players[0].displayName, "Aria");
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

test("same-name remote players keep distinct room identities", async (t) => {
  const relay = await startRelay(t);
  const created = await bootstrap(relay.store);
  const first = await redeem(relay.baseUrl, created.invite.token, "Echo");
  const second = await redeem(relay.baseUrl, created.invite.token, "Echo");
  assert.notEqual(first.membership.id, second.membership.id);
  assert.notEqual(first.membership.playerId, second.membership.playerId);
  assert.notEqual(first.token, second.token);
  assert.equal(
    relay.store.memberships(created.room.id).filter(
      (membership) => membership.displayName === "Echo",
    ).length,
    2,
  );
});

test("remote rename and leave commands update and revoke the room membership", async (t) => {
  const relay = await startRelay(t);
  const created = await bootstrap(relay.store);
  const joined = await redeem(relay.baseUrl, created.invite.token, "Aria");
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
      capabilities: [],
    }),
  );
  await agent.nextJson((message) => message.type === "relay.hello");
  await agent.nextJson((message) => message.type === "room.membership");

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
  await player.nextJson((message) => message.type === "snapshot");

  player.sendJson(
    playerCommand(roomId, "rename-1", "player.rename", {
      displayName: "Nova",
    }),
  );
  const rename = await agent.nextJson(
    (message) =>
      message.type === "room.command" &&
      message.payload.commandType === "player.rename",
  );
  agent.sendJson(
    agentMessage(
      "room.command-result",
      {
        commandId: rename.payload.commandId,
        accepted: true,
      },
      roomId,
    ),
  );
  const renameResult = await player.nextJson(
    (message) => message.type === "command-result" && message.id === "rename-1",
  );
  assert.equal(renameResult.payload.accepted, true);
  assert.equal(relay.store.memberships(roomId)[0].displayName, "Nova");
  const renamedMembership = await agent.nextJson(
    (message) =>
      message.type === "room.membership" &&
      message.payload.players[0]?.displayName === "Nova",
  );
  assert.equal(renamedMembership.payload.players[0].playerId, joined.membership.playerId);

  player.sendJson(playerCommand(roomId, "leave-1", "player.leave", {}));
  const leave = await agent.nextJson(
    (message) =>
      message.type === "room.command" &&
      message.payload.commandType === "player.leave",
  );
  const leaveResultPromise = player.nextJson(
    (message) => message.type === "command-result" && message.id === "leave-1",
  );
  agent.sendJson(
    agentMessage(
      "room.command-result",
      {
        commandId: leave.payload.commandId,
        accepted: true,
      },
      roomId,
    ),
  );
  const leaveResult = await leaveResultPromise;
  assert.equal(leaveResult.payload.accepted, true);
  assert.equal(relay.store.authenticateMembership(joined.token), null);
  const leftMembership = await agent.nextJson(
    (message) =>
      message.type === "room.membership" &&
      message.payload.players.length === 0,
  );
  assert.deepEqual(leftMembership.payload.players, []);
});
