import { randomBytes } from "node:crypto";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
} from "./relay-protocol.mjs";

const BASE_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 10_000;
const MAX_COMMAND_RESULTS = 512;

function noOp() {}

function defaultLogger() {
  return { info: noOp, warn: noOp, error: noOp };
}

function messageId() {
  return randomBytes(18).toString("base64url");
}

function transportError(message) {
  return Object.assign(new Error(message), { code: "RELAY_TRANSPORT_ERROR" });
}

export function createWebSocketTransport({
  url,
  token,
  WebSocketImpl = globalThis.WebSocket,
}) {
  if (typeof WebSocketImpl !== "function") {
    throw transportError(
      "Hosted relay connections require a Node.js release with WebSocket support",
    );
  }
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) {
    throw transportError("Relay device token has an unsupported format");
  }

  const socket = new WebSocketImpl(url, [
    "gm-campaign-cockpit-v1",
    `auth.${token}`,
  ]);
  return {
    onOpen(listener) {
      socket.addEventListener("open", listener);
    },
    onMessage(listener) {
      socket.addEventListener("message", (event) => listener(event.data));
    },
    onClose(listener) {
      socket.addEventListener("close", listener);
    },
    onError(listener) {
      socket.addEventListener("error", listener);
    },
    send(encoded) {
      if (socket.readyState !== 1) {
        throw transportError("Relay WebSocket is not open");
      }
      socket.send(encoded);
    },
    close(code = 1000, reason = "Connector stopped") {
      if (socket.readyState < 2) socket.close(code, reason);
    },
  };
}

export class RelayConnector {
  constructor({
    enabled = true,
    url,
    token,
    agentId,
    roomId,
    appVersion,
    capabilities = [
      "room.snapshot",
      "room.event",
      "room.command-result",
    ],
    createTransport = createWebSocketTransport,
    getSnapshot,
    handleCommand,
    handleMembership = noOp,
    logger = defaultLogger(),
    now = () => Date.now(),
    randomId = messageId,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    baseReconnectMs = BASE_RECONNECT_MS,
    maxReconnectMs = MAX_RECONNECT_MS,
    onStateChange = noOp,
  } = {}) {
    this.enabled = enabled;
    this.url = url;
    this.token = token;
    this.agentId = agentId;
    this.roomId = roomId;
    this.appVersion = appVersion;
    this.capabilities = [...capabilities];
    this.createTransport = createTransport;
    this.getSnapshot = getSnapshot;
    this.handleCommand = handleCommand;
    this.handleMembership = handleMembership;
    this.logger = logger;
    this.now = now;
    this.randomId = randomId;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.baseReconnectMs = baseReconnectMs;
    this.maxReconnectMs = maxReconnectMs;
    this.onStateChange = onStateChange;

    this.state = enabled ? "idle" : "disabled";
    this.transport = null;
    this.generation = 0;
    this.revision = 0;
    this.acceptedRevision = 0;
    this.heartbeatMs = 30_000;
    this.maxMessageBytes = Number.MAX_SAFE_INTEGER;
    this.lastInboundAt = 0;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.stopped = false;
    this.commandQueue = Promise.resolve();
    this.commandResults = new Map();

    if (!enabled) return;
    for (const [name, value] of Object.entries({
      url,
      token,
      agentId,
      roomId,
      appVersion,
    })) {
      if (typeof value !== "string" || !value) {
        throw new Error(`Relay connector requires ${name}`);
      }
    }
    if (typeof createTransport !== "function") {
      throw new Error("Relay connector requires a transport factory");
    }
    if (typeof getSnapshot !== "function") {
      throw new Error("Relay connector requires a snapshot provider");
    }
    if (typeof handleCommand !== "function") {
      throw new Error("Relay connector requires a command handler");
    }
  }

  status() {
    return {
      enabled: this.enabled,
      state: this.state,
      revision: this.revision,
      acceptedRevision: this.acceptedRevision,
    };
  }

  setState(nextState) {
    if (this.state === nextState) return;
    this.state = nextState;
    this.onStateChange(this.status());
  }

  start() {
    if (!this.enabled || this.stopped || this.transport) return;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    const transport = this.transport;
    this.transport = null;
    this.generation += 1;
    if (transport) {
      try {
        transport.close(1000, "Connector stopped");
      } catch {
        // The transport is already unavailable.
      }
    }
    this.setState(this.enabled ? "stopped" : "disabled");
  }

  clearTimers() {
    if (this.reconnectTimer) this.clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) this.clearTimeout(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
  }

  connect() {
    if (this.stopped || !this.enabled || this.transport) return;
    this.clearTimers();
    this.setState(this.reconnectAttempt ? "reconnecting" : "connecting");
    const generation = ++this.generation;
    let transport;
    try {
      transport = this.createTransport({
        url: this.url,
        token: this.token,
      });
    } catch (error) {
      this.logger.warn("relay_connect_failed", {
        reason: error.code || "TRANSPORT_CREATE_FAILED",
      });
      this.scheduleReconnect();
      return;
    }
    this.transport = transport;
    transport.onOpen(() => {
      if (!this.isCurrent(transport, generation)) return;
      this.setState("handshaking");
      try {
        this.send("agent.hello", {
          agentId: this.agentId,
          appVersion: this.appVersion,
          capabilities: this.capabilities,
        });
      } catch (error) {
        this.failConnection(error);
      }
    });
    transport.onMessage((encoded) => {
      if (!this.isCurrent(transport, generation)) return;
      void this.receive(encoded).catch((error) => {
        this.failConnection(error);
      });
    });
    transport.onClose(() => {
      if (!this.isCurrent(transport, generation)) return;
      this.transport = null;
      this.clearHeartbeat();
      this.scheduleReconnect();
    });
    transport.onError(() => {
      if (!this.isCurrent(transport, generation)) return;
      this.failConnection(transportError("Relay transport reported an error"));
    });
  }

  isCurrent(transport, generation) {
    return this.transport === transport && this.generation === generation;
  }

  clearHeartbeat() {
    if (this.heartbeatTimer) this.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    if (this.stopped || !this.enabled || this.reconnectTimer) return;
    this.transport = null;
    this.clearHeartbeat();
    this.setState("reconnecting");
    const delay = Math.min(
      this.baseReconnectMs * 2 ** this.reconnectAttempt,
      this.maxReconnectMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  failConnection(error) {
    this.logger.warn("relay_connection_lost", {
      reason: error.code || "INVALID_RELAY_MESSAGE",
    });
    const transport = this.transport;
    this.transport = null;
    this.generation += 1;
    if (transport) {
      try {
        transport.close(1008, "Relay protocol error");
      } catch {
        // The transport is already unavailable.
      }
    }
    this.scheduleReconnect();
  }

  envelope(type, payload, { room = false } = {}) {
    return {
      protocol: RELAY_PROTOCOL_NAME,
      version: RELAY_PROTOCOL_VERSION,
      id: this.randomId(),
      type,
      ...(room ? { roomId: this.roomId } : {}),
      sentAt: this.now(),
      payload,
    };
  }

  send(type, payload, options) {
    if (!this.transport) throw transportError("Relay transport is unavailable");
    const encoded = encodeRelayEnvelope(
      this.envelope(type, payload, options),
      { direction: "agent-to-relay" },
    );
    if (Buffer.byteLength(encoded, "utf8") > this.maxMessageBytes) {
      throw transportError("Relay message exceeds the negotiated size limit");
    }
    this.transport.send(encoded);
    return encoded;
  }

  async receive(encoded) {
    if (typeof encoded !== "string") {
      throw transportError("Relay transport delivered a non-text frame");
    }
    const message = decodeRelayEnvelope(encoded, {
      direction: "relay-to-agent",
    });
    if (message.roomId !== undefined && message.roomId !== this.roomId) {
      throw transportError("Relay message belongs to another room");
    }
    this.lastInboundAt = this.now();

    if (message.type === "relay.hello") {
      this.heartbeatMs = message.payload.heartbeatMs;
      this.maxMessageBytes = message.payload.maxMessageBytes;
      this.acceptedRevision = message.payload.acceptedRevision;
      this.revision = Math.max(this.revision, this.acceptedRevision);
      this.reconnectAttempt = 0;
      this.setState("connected");
      this.scheduleHeartbeat();
      await this.sendSnapshot();
      return;
    }
    if (message.type === "heartbeat") {
      this.send("heartbeat", { nonce: message.payload.nonce });
      return;
    }
    if (message.type === "room.membership") {
      await this.handleMembership(structuredClone(message.payload));
      return;
    }
    if (message.type === "room.command") {
      this.commandQueue = this.commandQueue
        .then(() => this.processCommand(message.payload))
        .catch((error) => {
          this.logger.error("relay_command_failed", {
            reason: error.code || "COMMAND_HANDLER_FAILED",
          });
        });
      await this.commandQueue;
    }
  }

  scheduleHeartbeat() {
    this.clearHeartbeat();
    if (this.stopped || this.state !== "connected") return;
    this.heartbeatTimer = this.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.now() - this.lastInboundAt > this.heartbeatMs * 2) {
        this.failConnection(transportError("Relay heartbeat timed out"));
        return;
      }
      try {
        this.send("heartbeat", { nonce: this.randomId() });
        this.scheduleHeartbeat();
      } catch (error) {
        this.failConnection(error);
      }
    }, this.heartbeatMs);
  }

  async sendSnapshot() {
    const state = await this.getSnapshot();
    this.send(
      "room.snapshot",
      { revision: this.revision, state },
      { room: true },
    );
  }

  publishEvent(eventType, audience, data) {
    const nextRevision = this.revision + 1;
    const envelope = this.envelope(
      "room.event",
      { revision: nextRevision, eventType, audience, data },
      { room: true },
    );
    const encoded = encodeRelayEnvelope(envelope, {
      direction: "agent-to-relay",
    });
    if (this.state === "connected" && this.transport) {
      if (Buffer.byteLength(encoded, "utf8") > this.maxMessageBytes) {
        throw transportError("Relay message exceeds the negotiated size limit");
      }
    }
    this.revision = nextRevision;
    if (this.state === "connected" && this.transport) {
      this.transport.send(encoded);
    }
    return this.revision;
  }

  rememberCommandResult(commandId, result) {
    this.commandResults.set(commandId, result);
    while (this.commandResults.size > MAX_COMMAND_RESULTS) {
      this.commandResults.delete(this.commandResults.keys().next().value);
    }
  }

  async processCommand(command) {
    let result = this.commandResults.get(command.commandId);
    if (!result) {
      try {
        const handled =
          (await this.handleCommand(structuredClone(command))) || {};
        result = {
          commandId: command.commandId,
          accepted: handled.accepted !== false,
          ...(handled.code ? { code: handled.code } : {}),
          revision: this.revision,
        };
      } catch (error) {
        result = {
          commandId: command.commandId,
          accepted: false,
          code: error.code || "COMMAND_REJECTED",
          revision: this.revision,
        };
      }
      this.rememberCommandResult(command.commandId, result);
    }
    if (this.state === "connected" && this.transport) {
      this.send("room.command-result", result, { room: true });
    }
    return result;
  }
}
