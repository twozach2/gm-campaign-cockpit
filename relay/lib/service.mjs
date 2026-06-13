import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import {
  encodeRelayEnvelope,
  decodeRelayEnvelope,
  RELAY_MAX_MESSAGE_BYTES,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
} from "../../lib/relay-protocol.mjs";
import { createLogger } from "../../lib/logger.mjs";
import {
  decodePlayerEnvelope,
  playerEnvelope,
} from "./player-protocol.mjs";
import {
  acceptWebSocket,
  offeredProtocols,
  rejectUpgrade,
} from "./websocket.mjs";

const AGENT_PROTOCOL = "gm-campaign-cockpit-v1";
const PLAYER_PROTOCOL = "gm-campaign-cockpit-player-v1";
const MAX_HTTP_BODY = 8_192;
const MAX_CONNECTIONS = 1_000;
const MAX_PENDING_COMMANDS = 2_000;
const COMMAND_TIMEOUT_MS = 15_000;

function identifier(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function clone(value) {
  return structuredClone(value);
}

function json(response, status, value, headers = {}) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function requestError(message, status = 400, code = "BAD_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}

async function readJson(request) {
  const contentType = String(request.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw requestError("Content-Type must be application/json", 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY) {
      throw requestError("Request body is too large", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError("Request body is not valid JSON");
  }
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(`${label} must be an object`);
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw requestError(`${label} contains unknown field ${key}`);
    }
  }
  return value;
}

function bearer(request) {
  const match = String(request.headers.authorization || "").match(
    /^Bearer\s+(.+)$/i,
  );
  return match?.[1] || "";
}

function protocolToken(request) {
  const protocol = offeredProtocols(request).find((value) =>
    value.startsWith("auth."),
  );
  return protocol ? protocol.slice(5) : "";
}

function routeId(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return null;
  const value = pathname.slice(prefix.length);
  if (!value || value.includes("/")) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function roomStateForPlayer(roomState, membership) {
  const state = clone(roomState.state);
  state.chat = state.chat.filter(
    (message) =>
      message.scope === "table" ||
      (message.scope === "whisper" &&
        (message.fromPlayerId === membership.playerId ||
          message.toPlayerId === membership.playerId)),
  );
  return {
    revision: roomState.revision,
    state,
  };
}

function audienceIncludes(audience, playerId) {
  if (audience.kind === "all") return true;
  if (audience.kind === "player") return audience.playerId === playerId;
  if (audience.kind === "players") return audience.playerIds.includes(playerId);
  return false;
}

function securityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

export class HostedRelayService {
  constructor({
    store,
    host = "127.0.0.1",
    port = 8787,
    tls,
    logger = createLogger(),
    heartbeatMs = 25_000,
    commandTimeoutMs = COMMAND_TIMEOUT_MS,
    maxMessageBytes = RELAY_MAX_MESSAGE_BYTES,
    now = () => Date.now(),
    randomId = identifier,
  }) {
    this.store = store;
    this.host = host;
    this.port = port;
    this.tls = tls;
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.maxMessageBytes = maxMessageBytes;
    this.now = now;
    this.randomId = randomId;
    this.ready = false;
    this.server = null;
    this.agents = new Map();
    this.players = new Map();
    this.pendingCommands = new Map();
    this.commandReceipts = new Map();
    this.heartbeatTimer = null;
  }

  async start() {
    await this.store.init();
    this.server = this.tls
      ? createHttpsServer(this.tls, (request, response) =>
          this.handleHttp(request, response),
        )
      : createHttpServer((request, response) =>
          this.handleHttp(request, response),
        );
    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.ready = true;
    this.heartbeatTimer = setInterval(
      () => this.heartbeatSweep(),
      this.heartbeatMs,
    );
    this.heartbeatTimer.unref();
    const address = this.address();
    this.logger.info("hosted_relay_started", {
      host: address.host,
      port: address.port,
      tls: Boolean(this.tls),
    });
    return address;
  }

  address() {
    const address = this.server?.address();
    return {
      host:
        address && typeof address === "object" ? address.address : this.host,
      port:
        address && typeof address === "object" ? address.port : this.port,
      protocol: this.tls ? "https" : "http",
    };
  }

  async stop() {
    this.ready = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const agent of this.agents.values()) {
      agent.connection.close(1001, "Relay shutting down");
    }
    for (const roomPlayers of this.players.values()) {
      for (const session of roomPlayers) {
        session.connection.close(1001, "Relay shutting down");
      }
    }
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingCommands.clear();
    if (this.server?.listening) {
      await new Promise((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await this.store.close();
    this.logger.info("hosted_relay_stopped", {});
  }

  async handleHttp(request, response) {
    securityHeaders(response);
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || "relay"}`);
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { ok: true });
      }
      if (request.method === "GET" && url.pathname === "/readiness") {
        return json(response, this.ready ? 200 : 503, {
          ready: this.ready,
          checks: { persistence: this.ready ? "ready" : "unavailable" },
        });
      }
      if (request.method === "POST" && url.pathname === "/v1/invites/redeem") {
        const body = exactObject(
          await readJson(request),
          ["inviteToken", "displayName"],
          "Invite redemption",
        );
        const joined = await this.store.redeemInvite({
          token: body.inviteToken,
          displayName: body.displayName,
        });
        this.sendMembership(joined.room.id);
        return json(response, 200, joined);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/v1/player/session"
      ) {
        const membership = this.store.authenticateMembership(bearer(request));
        if (!membership) {
          return json(response, 401, { error: "Player session required" });
        }
        const room = this.store.room(membership.roomId);
        const state = this.store.roomState(membership.roomId);
        if (!room || room.status !== "active" || !state) {
          return json(response, 404, { error: "Room not found" });
        }
        return json(response, 200, {
          membership,
          room,
          ...roomStateForPlayer(state, membership),
        });
      }
      if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/admin/")) {
        return json(response, 404, { error: "Route not found" });
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) {
        this.logger.error("hosted_relay_request_failed", {
          route: url?.pathname || "unparsed",
          error,
        });
      }
      return json(response, status, {
        error: status >= 500 ? "Internal server error" : error.message,
        ...(status < 500 && error.code ? { code: error.code } : {}),
      });
    }
  }

  handleUpgrade(request, socket, head) {
    if (!this.ready || this.connectionCount() >= MAX_CONNECTIONS) {
      rejectUpgrade(socket, 503, "Relay unavailable");
      return;
    }
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || "relay"}`);
    } catch {
      rejectUpgrade(socket, 400, "Invalid request URL");
      return;
    }
    if (url.search) {
      rejectUpgrade(socket, 400, "WebSocket URLs may not contain query data");
      return;
    }
    const agentRoomId = routeId(url.pathname, "/v1/agent/");
    if (agentRoomId) {
      this.upgradeAgent(request, socket, head, agentRoomId);
      return;
    }
    const playerRoomId = routeId(url.pathname, "/v1/player/");
    if (playerRoomId) {
      this.upgradePlayer(request, socket, head, playerRoomId);
      return;
    }
    rejectUpgrade(socket, 404, "WebSocket route not found");
  }

  connectionCount() {
    let count = this.agents.size;
    for (const roomPlayers of this.players.values()) count += roomPlayers.size;
    return count;
  }

  upgradeAgent(request, socket, head, roomId) {
    const device = this.store.authenticateDevice(protocolToken(request));
    const room = device
      ? this.store.authorizeDeviceRoom(device.id, roomId)
      : null;
    if (!device || !room) {
      rejectUpgrade(socket, 401, "Agent authorization failed");
      return;
    }
    const connection = acceptWebSocket(request, socket, head, {
      protocol: AGENT_PROTOCOL,
      maxMessageBytes: this.maxMessageBytes,
    });
    if (!connection) return;
    const existing = this.agents.get(roomId);
    if (existing) existing.connection.close(4001, "Agent replaced");
    const session = {
      connection,
      device,
      room,
      hello: false,
      lastSeenAt: this.now(),
    };
    this.agents.set(roomId, session);
    connection.on("message", (encoded) => {
      session.lastSeenAt = this.now();
      void this.handleAgentMessage(session, encoded).catch((error) => {
        this.logger.warn("hosted_relay_agent_rejected", {
          reason: error.code || "INVALID_AGENT_MESSAGE",
        });
        connection.close(1008, "Agent message rejected");
      });
    });
    connection.on("close", () => {
      if (this.agents.get(roomId) === session) this.agents.delete(roomId);
    });
    connection.on("error", () => {
      connection.close(1011, "Agent transport error");
    });
  }

  async handleAgentMessage(session, encoded) {
    const message = decodeRelayEnvelope(encoded, {
      direction: "agent-to-relay",
    });
    if (message.roomId !== undefined && message.roomId !== session.room.id) {
      throw requestError("Agent message belongs to another room", 403, "ROOM_FORBIDDEN");
    }
    if (message.type === "agent.hello") {
      if (session.hello || message.payload.agentId !== session.device.id) {
        throw requestError("Agent identity mismatch", 403, "AGENT_MISMATCH");
      }
      session.hello = true;
      const roomState = this.store.roomState(session.room.id);
      this.sendAgent(session, "relay.hello", {
        connectionId: this.randomId("connection"),
        heartbeatMs: this.heartbeatMs,
        maxMessageBytes: this.maxMessageBytes,
        acceptedRevision: roomState?.revision || 0,
      });
      this.sendMembership(session.room.id);
      return;
    }
    if (!session.hello) {
      throw requestError("Agent hello is required", 400, "HELLO_REQUIRED");
    }
    if (message.type === "heartbeat") {
      this.sendAgent(session, "heartbeat", {
        nonce: message.payload.nonce,
      });
      return;
    }
    if (message.type === "room.snapshot") {
      const state = await this.store.applySnapshot({
        deviceId: session.device.id,
        roomId: session.room.id,
        revision: message.payload.revision,
        state: message.payload.state,
      });
      this.broadcastSnapshots(session.room.id, state);
      return;
    }
    if (message.type === "room.event") {
      await this.store.applyEvent({
        deviceId: session.device.id,
        roomId: session.room.id,
        ...message.payload,
      });
      this.broadcastEvent(session.room.id, message.payload);
      return;
    }
    if (message.type === "room.command-result") {
      await this.completeCommand(session.room.id, message.payload);
    }
  }

  sendAgent(session, type, payload, { room = false } = {}) {
    session.connection.sendText(
      encodeRelayEnvelope(
        {
          protocol: RELAY_PROTOCOL_NAME,
          version: RELAY_PROTOCOL_VERSION,
          id: this.randomId("message"),
          type,
          ...(room ? { roomId: session.room.id } : {}),
          sentAt: this.now(),
          payload,
        },
        { direction: "relay-to-agent" },
      ),
    );
  }

  sendMembership(roomId) {
    const agent = this.agents.get(roomId);
    if (!agent?.hello) return;
    const room = this.store.room(roomId);
    this.sendAgent(
      agent,
      "room.membership",
      {
        players: this.store.memberships(roomId).map((membership) => ({
          playerId: membership.playerId,
          displayName: membership.displayName,
        })),
        joinsOpen: Boolean(room?.joinsOpen && room.status === "active"),
      },
      { room: true },
    );
  }

  upgradePlayer(request, socket, head, roomId) {
    const membership = this.store.authenticateMembership(protocolToken(request));
    const room = membership ? this.store.room(membership.roomId) : null;
    if (
      !membership ||
      membership.roomId !== roomId ||
      !room ||
      room.status !== "active"
    ) {
      rejectUpgrade(socket, 401, "Player authorization failed");
      return;
    }
    const connection = acceptWebSocket(request, socket, head, {
      protocol: PLAYER_PROTOCOL,
      maxMessageBytes: 16_384,
    });
    if (!connection) return;
    const session = {
      connection,
      membership,
      room,
      lastSeenAt: this.now(),
    };
    if (!this.players.has(roomId)) this.players.set(roomId, new Set());
    this.players.get(roomId).add(session);
    connection.on("message", (encoded) => {
      session.lastSeenAt = this.now();
      void this.handlePlayerMessage(session, encoded).catch((error) => {
        this.sendPlayer(session, "error", {
          code: error.code || "PLAYER_MESSAGE_REJECTED",
        });
      });
    });
    connection.on("close", () => {
      const roomPlayers = this.players.get(roomId);
      roomPlayers?.delete(session);
      if (!roomPlayers?.size) this.players.delete(roomId);
    });
    connection.on("error", () => {
      connection.close(1011, "Player transport error");
    });
    this.sendPlayerSnapshot(session);
  }

  async handlePlayerMessage(session, encoded) {
    const message = decodePlayerEnvelope(encoded);
    if (message.roomId !== session.room.id) {
      throw requestError("Player message belongs to another room", 403, "ROOM_FORBIDDEN");
    }
    if (message.type === "heartbeat") {
      this.sendPlayer(session, "heartbeat", {
        nonce: message.payload.nonce,
      });
      return;
    }
    const receiptKey = `${session.membership.id}:${message.id}`;
    const receipt = this.commandReceipts.get(receiptKey);
    if (receipt?.result) {
      session.connection.sendJson(receipt.result);
      return;
    }
    if (receipt) return;

    const agent = this.agents.get(session.room.id);
    if (!agent?.hello) {
      const result = this.playerResult(session, message.id, {
        accepted: false,
        code: "AGENT_OFFLINE",
      });
      this.rememberReceipt(receiptKey, { result });
      session.connection.sendJson(result);
      return;
    }
    if (this.pendingCommands.size >= MAX_PENDING_COMMANDS) {
      throw requestError("Relay command capacity reached", 503, "COMMAND_CAPACITY");
    }
    const commandId = this.randomId("command");
    const timer = setTimeout(() => {
      const pending = this.pendingCommands.get(commandId);
      if (!pending) return;
      this.pendingCommands.delete(commandId);
      const result = this.playerResult(pending.session, pending.clientId, {
        accepted: false,
        code: "COMMAND_TIMEOUT",
      });
      this.rememberReceipt(pending.receiptKey, { result });
      this.sendPlayerEnvelope(pending.session, result);
    }, this.commandTimeoutMs);
    timer.unref();
    this.pendingCommands.set(commandId, {
      session,
      clientId: message.id,
      receiptKey,
      commandType: message.payload.commandType,
      data: clone(message.payload.data),
      timer,
    });
    this.rememberReceipt(receiptKey, { commandId });
    this.sendAgent(
      agent,
      "room.command",
      {
        commandId,
        playerId: session.membership.playerId,
        commandType: message.payload.commandType,
        data: message.payload.data,
      },
      { room: true },
    );
  }

  rememberReceipt(key, value) {
    this.commandReceipts.set(key, value);
    while (this.commandReceipts.size > MAX_PENDING_COMMANDS) {
      this.commandReceipts.delete(this.commandReceipts.keys().next().value);
    }
  }

  async completeCommand(roomId, result) {
    const pending = this.pendingCommands.get(result.commandId);
    if (!pending || pending.session.room.id !== roomId) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(result.commandId);
    if (result.accepted && pending.commandType === "player.rename") {
      pending.session.membership = await this.store.renameMembership(
        pending.session.membership.id,
        pending.data.displayName,
      );
      this.sendMembership(roomId);
    } else if (result.accepted && pending.commandType === "player.leave") {
      await this.store.revokeMembership(pending.session.membership.id);
      this.sendMembership(roomId);
    }
    const playerResult = this.playerResult(
      pending.session,
      pending.clientId,
      {
        accepted: result.accepted,
        ...(result.code ? { code: result.code } : {}),
        ...(result.revision !== undefined
          ? { revision: result.revision }
          : {}),
      },
    );
    this.rememberReceipt(pending.receiptKey, { result: playerResult });
    this.sendPlayerEnvelope(pending.session, playerResult);
    if (result.accepted && pending.commandType === "player.leave") {
      pending.session.connection.close(1000, "Player left room");
    }
  }

  playerResult(session, id, payload) {
    return playerEnvelope({
      id,
      type: "command-result",
      roomId: session.room.id,
      sentAt: this.now(),
      payload,
    });
  }

  sendPlayer(session, type, payload) {
    this.sendPlayerEnvelope(
      session,
      playerEnvelope({
        id: this.randomId("message"),
        type,
        roomId: session.room.id,
        sentAt: this.now(),
        payload,
      }),
    );
  }

  sendPlayerEnvelope(session, envelope) {
    if (session.connection.closed) return false;
    try {
      session.connection.sendJson(envelope);
      return true;
    } catch {
      session.connection.close(1011, "Player transport unavailable");
      return false;
    }
  }

  sendPlayerSnapshot(session, roomState = this.store.roomState(session.room.id)) {
    if (!roomState) return;
    this.sendPlayer(session, "snapshot", {
      membership: session.membership,
      ...roomStateForPlayer(roomState, session.membership),
    });
  }

  broadcastSnapshots(roomId, roomState) {
    for (const session of this.players.get(roomId) || []) {
      this.sendPlayerSnapshot(session, roomState);
    }
  }

  broadcastEvent(roomId, event) {
    for (const session of this.players.get(roomId) || []) {
      if (!audienceIncludes(event.audience, session.membership.playerId)) {
        continue;
      }
      this.sendPlayer(session, "event", {
        revision: event.revision,
        eventType: event.eventType,
        data: event.data,
      });
    }
  }

  heartbeatSweep() {
    const now = this.now();
    for (const session of this.agents.values()) {
      if (now - session.lastSeenAt > this.heartbeatMs * 2) {
        session.connection.close(1001, "Agent heartbeat timeout");
        continue;
      }
      if (session.hello) {
        this.sendAgent(session, "heartbeat", {
          nonce: this.randomId("heartbeat"),
        });
      } else {
        session.connection.ping("hello");
      }
    }
    for (const roomPlayers of this.players.values()) {
      for (const session of roomPlayers) {
        if (now - session.lastSeenAt > this.heartbeatMs * 2) {
          session.connection.close(1001, "Player heartbeat timeout");
          continue;
        }
        this.sendPlayer(session, "heartbeat", {
          nonce: this.randomId("heartbeat"),
        });
      }
    }
  }
}
