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

test("hosted relay exposes bounded health, readiness, and player session routes", async (t) => {
  const relay = await startRelay(t);
  const created = await bootstrap(relay.store);

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
