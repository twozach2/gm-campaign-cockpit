import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebSocketTransport,
  RelayConnector,
} from "../lib/relay-connector.mjs";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
} from "../lib/relay-protocol.mjs";

function relayEnvelope(type, payload, overrides = {}) {
  return {
    protocol: RELAY_PROTOCOL_NAME,
    version: RELAY_PROTOCOL_VERSION,
    id: `relay-${type}`,
    type,
    ...(type.startsWith("room.") ? { roomId: "room-1" } : {}),
    sentAt: 10,
    payload,
    ...overrides,
  };
}

class FakeTransport {
  constructor() {
    this.listeners = { open: [], message: [], close: [], error: [] };
    this.sent = [];
    this.closed = [];
  }

  onOpen(listener) {
    this.listeners.open.push(listener);
  }

  onMessage(listener) {
    this.listeners.message.push(listener);
  }

  onClose(listener) {
    this.listeners.close.push(listener);
  }

  onError(listener) {
    this.listeners.error.push(listener);
  }

  send(encoded) {
    this.sent.push(encoded);
  }

  close(code, reason) {
    this.closed.push({ code, reason });
  }

  open() {
    this.listeners.open.forEach((listener) => listener());
  }

  message(message) {
    const encoded =
      typeof message === "string"
        ? message
        : encodeRelayEnvelope(message, { direction: "relay-to-agent" });
    this.listeners.message.forEach((listener) => listener(encoded));
  }

  disconnect() {
    this.listeners.close.forEach((listener) => listener());
  }

  decoded() {
    return this.sent.map((encoded) =>
      decodeRelayEnvelope(encoded, { direction: "agent-to-relay" }),
    );
  }
}

function fakeScheduler() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    runNext() {
      const timer = timers
        .filter((entry) => !entry.cleared)
        .sort((left, right) => left.delay - right.delay)[0];
      assert.ok(timer, "Expected a scheduled timer");
      timer.cleared = true;
      timer.fn();
      return timer.delay;
    },
  };
}

function snapshot() {
  return {
    presentation: { items: [], updatedAt: 1 },
    status: { trackers: [], updatedAt: 1 },
    chat: [],
    players: [],
  };
}

function connectorOptions(overrides = {}) {
  const transports = [];
  const scheduler = fakeScheduler();
  let id = 0;
  return {
    transports,
    scheduler,
    options: {
      url: "wss://relay.example.test/agent",
      token: "relay-device-token-123456",
      agentId: "agent-1",
      roomId: "room-1",
      appVersion: "0.1.0",
      getSnapshot: async () => snapshot(),
      handleCommand: async () => ({ accepted: true }),
      createTransport: () => {
        const transport = new FakeTransport();
        transports.push(transport);
        return transport;
      },
      now: () => 10,
      randomId: () => `id-${++id}`,
      setTimeoutFn: scheduler.setTimeout,
      clearTimeoutFn: scheduler.clearTimeout,
      baseReconnectMs: 10,
      maxReconnectMs: 40,
      ...overrides,
    },
  };
}

async function connect(connector, transport, acceptedRevision = 0) {
  transport.open();
  assert.equal(transport.decoded()[0].type, "agent.hello");
  transport.message(
    relayEnvelope("relay.hello", {
      connectionId: "connection-1",
      heartbeatMs: 5_000,
      maxMessageBytes: RELAY_MAX_MESSAGE_BYTES,
      acceptedRevision,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
}

test("disabled connector never creates a transport", () => {
  let created = false;
  const connector = new RelayConnector({
    enabled: false,
    createTransport: () => {
      created = true;
    },
  });
  connector.start();
  assert.equal(created, false);
  assert.deepEqual(connector.status(), {
    enabled: false,
    state: "disabled",
    revision: 0,
    acceptedRevision: 0,
  });
});

test("connector handshakes and sends a player-safe snapshot", async () => {
  const { options, transports } = connectorOptions();
  const connector = new RelayConnector(options);
  connector.start();
  assert.equal(connector.status().state, "connecting");
  await connect(connector, transports[0], 4);

  const sent = transports[0].decoded();
  assert.equal(sent[0].type, "agent.hello");
  assert.equal(sent[1].type, "room.snapshot");
  assert.equal(sent[1].payload.revision, 4);
  assert.deepEqual(sent[1].payload.state, snapshot());
  assert.equal(connector.status().state, "connected");
  assert.equal(connector.status().acceptedRevision, 4);
});

test("events advance revisions and reconnect resumes from a snapshot", async () => {
  const { options, transports, scheduler } = connectorOptions();
  const connector = new RelayConnector(options);
  connector.start();
  await connect(connector, transports[0]);

  assert.equal(
    connector.publishEvent(
      "presence.set",
      { kind: "all" },
      { players: [] },
    ),
    1,
  );
  assert.equal(transports[0].decoded().at(-1).payload.revision, 1);

  transports[0].disconnect();
  assert.equal(connector.status().state, "reconnecting");
  assert.equal(scheduler.runNext(), 10);
  assert.equal(transports.length, 2);
  await connect(connector, transports[1], 1);
  const snapshotMessage = transports[1]
    .decoded()
    .find((message) => message.type === "room.snapshot");
  assert.equal(snapshotMessage.payload.revision, 1);
});

test("heartbeats are answered and stale connections reconnect", async () => {
  let currentTime = 10;
  const { options, transports, scheduler } = connectorOptions({
    now: () => currentTime,
  });
  const connector = new RelayConnector(options);
  connector.start();
  await connect(connector, transports[0]);

  transports[0].message(relayEnvelope("heartbeat", { nonce: "relay-ping" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transports[0].decoded().at(-1).payload.nonce, "relay-ping");

  currentTime = 10_011;
  assert.equal(scheduler.runNext(), 5_000);
  assert.equal(transports[0].closed[0].code, 1008);
  assert.equal(connector.status().state, "reconnecting");
});

test("duplicate commands execute once and return the cached result", async () => {
  let handled = 0;
  const { options, transports } = connectorOptions({
    handleCommand: async () => {
      handled += 1;
      return { accepted: true };
    },
  });
  const connector = new RelayConnector(options);
  connector.start();
  await connect(connector, transports[0]);

  const command = relayEnvelope("room.command", {
    commandId: "command-1",
    playerId: "player-1",
    commandType: "chat.send",
    data: { text: "Hello", whisper: false },
  });
  transports[0].message(command);
  transports[0].message(command);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const results = transports[0]
    .decoded()
    .filter((message) => message.type === "room.command-result");
  assert.equal(handled, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0].payload, results[1].payload);
});

test("membership updates are delivered without credentials", async () => {
  const memberships = [];
  const { options, transports } = connectorOptions({
    handleMembership: async (membership) => memberships.push(membership),
  });
  const connector = new RelayConnector(options);
  connector.start();
  await connect(connector, transports[0]);
  transports[0].message(
    relayEnvelope("room.membership", {
      players: [{ playerId: "player-1", displayName: "Aria" }],
      joinsOpen: true,
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(memberships, [
    {
      players: [{ playerId: "player-1", displayName: "Aria" }],
      joinsOpen: true,
    },
  ]);
});

test("messages for another room fail the connection", async () => {
  const { options, transports } = connectorOptions();
  const connector = new RelayConnector(options);
  connector.start();
  await connect(connector, transports[0]);
  transports[0].message(
    relayEnvelope(
      "room.membership",
      { players: [], joinsOpen: false },
      { roomId: "room-2" },
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transports[0].closed[0].code, 1008);
  assert.equal(connector.status().state, "reconnecting");
});

test("WebSocket transport authenticates in subprotocol headers, not the URL", () => {
  const created = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 1;
      created.push(this);
    }

    addEventListener() {}

    send() {}

    close() {}
  }

  createWebSocketTransport({
    url: "wss://relay.example.test/agent",
    token: "relay-device-token-123456",
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(created[0].url, "wss://relay.example.test/agent");
  assert.deepEqual(created[0].protocols, [
    "gm-campaign-cockpit-v1",
    "auth.relay-device-token-123456",
  ]);
  assert.doesNotMatch(created[0].url, /token|relay-device-token/);
});
