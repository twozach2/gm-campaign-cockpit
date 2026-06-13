import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash, randomInt } from "node:crypto";
import { AtomicJsonStore } from "./lib/atomic-json-store.mjs";
import { loadLocalEnvironment } from "./lib/config.mjs";
import {
  apiRoute,
  parseRouteBody,
  parseRouteQuery,
} from "./lib/api-policy.mjs";
import { DmAuth } from "./lib/dm-auth.mjs";
import {
  contentDisposition,
  dmFileDisposition,
  verifyPlayerImage,
} from "./lib/file-policy.mjs";
import {
  createLogger,
  operationalError,
} from "./lib/logger.mjs";
import { TokenBucketRateLimiter } from "./lib/rate-limit.mjs";
import { SessionRegistry } from "./lib/session-registry.mjs";
import {
  messageVisibleToAudience,
  trackerStateForAudience,
} from "./lib/room-projection.mjs";
import { Vault } from "./lib/vault.mjs";
import { acknowledgeNoteOperation } from "./lib/note-operation.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
await loadLocalEnvironment(appRoot);
const vaultRoot = path.resolve(process.env.VAULT_ROOT || path.join(appRoot, ".."));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const logger = createLogger();

function positiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

const vault = new Vault({ root: vaultRoot, appRoot });
const publicRoot = path.join(appRoot, "public");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

const CONFIGURED_TABLE_PIN = process.env.TABLE_PIN;
const TABLE_PIN =
  CONFIGURED_TABLE_PIN || String(randomInt(100_000, 1_000_000));
const ALLOW_LOCAL_DM = process.env.ALLOW_LOCAL_DM !== "false";
const ALLOW_REMOTE_DM = process.env.ALLOW_REMOTE_DM === "true";
const REMOTE_BINDING = !["127.0.0.1", "::1", "localhost"].includes(host);
const DM_COOKIE = "gm-cockpit-dm";
const CHAT_LIMIT = positiveIntegerEnv("MAX_CHAT_MESSAGES", 200);
const MAX_CLIENTS = positiveIntegerEnv("MAX_CLIENTS", 200);
const MAX_STREAMS_PER_IP = positiveIntegerEnv("MAX_STREAMS_PER_IP", 40);
const MAX_STREAMS_PER_IDENTITY = positiveIntegerEnv(
  "MAX_STREAMS_PER_IDENTITY",
  4,
);
const MAX_PLAYERS = positiveIntegerEnv("MAX_PLAYERS", 100);
const MAX_DM_SESSIONS = positiveIntegerEnv("MAX_DM_SESSIONS", 32);
const MAX_STREAM_TICKETS = positiveIntegerEnv("MAX_STREAM_TICKETS", 256);
const MAX_PRESENTATION_ITEMS = positiveIntegerEnv(
  "MAX_PRESENTATION_ITEMS",
  100,
);
const MAX_TRACKERS = positiveIntegerEnv("MAX_TRACKERS", 100);
const MAX_RETAINED_TEXT = positiveIntegerEnv("MAX_RETAINED_TEXT", 600_000);
const MAX_FILE_BYTES = positiveIntegerEnv(
  "MAX_FILE_BYTES",
  25 * 1024 * 1024,
);
const MAX_LIMITER_KEYS = positiveIntegerEnv("MAX_LIMITER_KEYS", 2_000);
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const EXPLICIT_ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).origin;
      } catch {
        throw new Error(`Invalid ALLOWED_ORIGINS entry: ${origin}`);
      }
    }),
);
const LOCAL_ORIGIN_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  os.hostname().toLowerCase(),
]);
if (!["0.0.0.0", "::"].includes(host)) {
  LOCAL_ORIGIN_HOSTS.add(host.toLowerCase());
}
for (const interfaces of Object.values(os.networkInterfaces())) {
  for (const address of interfaces || []) {
    if (address.family === "IPv4" || address.family === "IPv6") {
      LOCAL_ORIGIN_HOSTS.add(address.address.toLowerCase());
    }
  }
}

if (REMOTE_BINDING && !ALLOW_REMOTE_DM) {
  throw new Error(
    "Remote binding requires ALLOW_REMOTE_DM=true. Keep HOST=127.0.0.1 for local-only use.",
  );
}
if (REMOTE_BINDING && !CONFIGURED_TABLE_PIN) {
  throw new Error(
    "TABLE_PIN must be configured when remote DM access is enabled.",
  );
}
if (REMOTE_BINDING && TABLE_PIN.length < 6) {
  throw new Error(
    "TABLE_PIN must be at least 6 characters when remote DM access is enabled.",
  );
}

const presentation = {
  items: [],
  updatedAt: Date.now(),
};
const chat = [];
const clients = new Set();
const playerSessions = new SessionRegistry({
  maxPlayers: MAX_PLAYERS,
  maxTickets: MAX_STREAM_TICKETS,
});
const dmAuth = new DmAuth({
  pin: TABLE_PIN,
  maxSessions: MAX_DM_SESSIONS,
  maxTickets: MAX_STREAM_TICKETS,
});
const rateLimiter = new TokenBucketRateLimiter({
  maxKeys: MAX_LIMITER_KEYS,
});
let messageSeq = 0;
let itemSeq = 0;

const stateDir = path.resolve(
  process.env.STATE_DIR || path.join(appRoot, "data"),
);
const TRACKERS_FILE =
  process.env.TRACKERS_FILE || path.join(stateDir, "trackers.json");
const status = {
  trackers: [],
  updatedAt: Date.now(),
};
let trackerSeq = 0;
let shuttingDown = false;
const readiness = {
  persistence: false,
  vault: false,
};

function isTracker(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 80 ||
    typeof value.hidden !== "boolean"
  ) {
    return false;
  }
  if (value.type === "initiative") {
    return (
      Array.isArray(value.entries) &&
      value.entries.length <= 40 &&
      value.entries.every(
        (entry) =>
          typeof entry === "string" &&
          Boolean(entry.trim()) &&
          entry.length <= 60,
      ) &&
      Number.isSafeInteger(value.turn) &&
      value.turn >= 0 &&
      value.turn <= Math.max(0, value.entries.length - 1)
    );
  }
  return (
    (value.type === "clock" || value.type === "meter") &&
    Number.isSafeInteger(value.max) &&
    value.max >= 1 &&
    value.max <= 1000 &&
    Number.isSafeInteger(value.value) &&
    value.value >= 0 &&
    value.value <= value.max
  );
}

function isTrackerState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.trackers) ||
    value.trackers.length > MAX_TRACKERS ||
    !value.trackers.every(isTracker)
  ) {
    return false;
  }
  const ids = new Set(value.trackers.map((tracker) => tracker.id));
  return ids.size === value.trackers.length;
}

const trackerStore = new AtomicJsonStore({
  file: TRACKERS_FILE,
  validate: isTrackerState,
  onWarning: (_message, details = {}) => {
    logger.warn("persistence_recovery", {
      store: "trackers",
      action: details.code || "RECOVERY_WARNING",
    });
  },
});

async function loadTrackers() {
  const saved = await trackerStore.load({ trackers: [] });
  status.trackers = saved.trackers;
  trackerSeq = status.trackers.reduce(
    (max, tracker) => Math.max(max, tracker.id),
    0,
  );
}

function statusFor(role) {
  return trackerStateForAudience(status, { role });
}

async function emitStatus() {
  status.updatedAt = Date.now();
  try {
    await trackerStore.write({ trackers: status.trackers });
  } catch (error) {
    logger.error("persistence_failure", {
      store: "trackers",
      operation: "write",
      error,
    });
    throw operationalError(
      "Tracker changes could not be saved",
      "TRACKER_WRITE_FAILED",
    );
  }
  for (const client of clients) {
    writeEvent(client, "status-set", statusFor(client.role));
  }
}

function emitPresentation() {
  presentation.updatedAt = Date.now();
  broadcast("reveal-set", presentation);
}

function makeItem(type, fields) {
  return { id: ++itemSeq, type, ts: Date.now(), ...fields };
}

function writeEvent(client, eventName, payload) {
  try {
    client.response.write(`event: ${eventName}\n`);
    client.response.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function visibleToClient(client, message) {
  return messageVisibleToAudience(message, client);
}

function chatVisibleToPlayer(message, playerId) {
  return messageVisibleToAudience(message, { role: "player", playerId });
}

const MAX_ROLL_TERMS = 10;
const MAX_DICE = 100;
const MAX_SIDES = 1000;

function parseRoll(expression) {
  const cleaned = String(expression || "").replace(/\s+/g, "").toLowerCase();
  if (!cleaned) return null;
  const tokens = cleaned.match(/[+-]?[^+-]+/g);
  if (!tokens || tokens.length > MAX_ROLL_TERMS) return null;
  const parts = [];
  for (const token of tokens) {
    const sign = token.startsWith("-") ? -1 : 1;
    const body = token.replace(/^[+-]/, "");
    const dice = body.match(/^(\d*)d(\d+)$/);
    if (dice) {
      const count = dice[1] ? Number(dice[1]) : 1;
      const sides = Number(dice[2]);
      if (count < 1 || count > MAX_DICE || sides < 2 || sides > MAX_SIDES) return null;
      parts.push({ kind: "dice", sign, count, sides });
    } else if (/^\d+$/.test(body)) {
      parts.push({ kind: "mod", sign, value: Number(body) });
    } else {
      return null;
    }
  }
  if (!parts.some((part) => part.kind === "dice")) return null;
  return parts;
}

function executeRoll(parts) {
  let total = 0;
  const rolled = parts.map((part) => {
    if (part.kind === "dice") {
      const rolls = Array.from({ length: part.count }, () => 1 + Math.floor(Math.random() * part.sides));
      total += part.sign * rolls.reduce((sum, value) => sum + value, 0);
      return { ...part, rolls };
    }
    total += part.sign * part.value;
    return { ...part };
  });
  const expr = rolled
    .map((part, index) => {
      const sign = index === 0 ? (part.sign < 0 ? "-" : "") : part.sign < 0 ? "-" : "+";
      return part.kind === "dice" ? `${sign}${part.count}d${part.sides}` : `${sign}${part.value}`;
    })
    .join("");
  return { expr, parts: rolled, total };
}

function broadcast(eventName, payload, message) {
  for (const client of clients) {
    if (message && !visibleToClient(client, message)) continue;
    writeEvent(client, eventName, payload);
  }
}

function textSize(value) {
  return typeof value === "string" ? value.length : 0;
}

function presentationTextSize() {
  return presentation.items.reduce(
    (total, item) =>
      total +
      textSize(item.title) +
      textSize(item.text) +
      textSize(item.markdown),
    0,
  );
}

function messageTextSize(message) {
  return (
    textSize(message.from) +
    textSize(message.to) +
    textSize(message.text) +
    textSize(message.roll ? JSON.stringify(message.roll) : "")
  );
}

function chatTextSize() {
  return chat.reduce((total, message) => total + messageTextSize(message), 0);
}

function pushChat(message) {
  const incomingSize = messageTextSize(message);
  while (
    chat.length &&
    (chat.length >= CHAT_LIMIT ||
      presentationTextSize() + chatTextSize() + incomingSize >
        MAX_RETAINED_TEXT)
  ) {
    chat.shift();
  }
  if (
    presentationTextSize() + chatTextSize() + incomingSize >
    MAX_RETAINED_TEXT
  ) {
    throw Object.assign(new Error("Retained text limit reached"), {
      status: 409,
    });
  }
  message.id = ++messageSeq;
  message.ts = Date.now();
  chat.push(message);
  broadcast(message.scope === "whisper" ? "whisper" : "chat", message, message);
  return message;
}

function connectedPlayers() {
  const players = new Map();
  for (const client of clients) {
    if (client.role !== "player" || !client.playerId) continue;
    const player = playerSessions.get(client.playerId);
    if (player) players.set(player.playerId, player);
  }
  return [...players.values()];
}

setInterval(() => {
  for (const client of clients) {
    try { client.response.write(": ping\n\n"); } catch { clients.delete(client); }
  }
}, 25_000).unref();

function isLoopback(request) {
  const ip = request.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function cookies(request) {
  const result = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie values and treat the request as unauthenticated.
    }
  }
  return result;
}

function dmToken(request) {
  return cookies(request)[DM_COOKIE] || "";
}

function dmCookie(request, token, maxAgeSeconds = 24 * 60 * 60) {
  const secure = request.socket.encrypted ? "; Secure" : "";
  return `${DM_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearDmCookie(request) {
  return dmCookie(request, "", 0);
}

function bearerToken(request) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function clientIp(request) {
  return String(request.socket.remoteAddress || "unknown").replace(
    /^::ffff:/,
    "",
  );
}

function hashedLimiterKey(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function sendJson(response, status, data, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(data));
}

function sendRateLimited(response, retryAfterSeconds, message = "Too many requests") {
  sendJson(
    response,
    429,
    { error: message },
    { "Retry-After": String(retryAfterSeconds) },
  );
}

async function readJson(request, maxBodyBytes) {
  const chunks = [];
  let bodyBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function assertBoundedFile(filePath) {
  const metadata = await stat(filePath);
  if (!metadata.isFile()) reject(400, "Requested path is not a file");
  if (metadata.size > MAX_FILE_BYTES) {
    reject(413, `File exceeds the ${MAX_FILE_BYTES}-byte limit`);
  }
  return metadata;
}

async function readBoundedFile(filePath) {
  await assertBoundedFile(filePath);
  return readFile(filePath);
}

function addPresentationItem(item) {
  if (presentation.items.length >= MAX_PRESENTATION_ITEMS) {
    reject(409, "Presentation item limit reached");
  }
  const incomingSize =
    textSize(item.title) + textSize(item.text) + textSize(item.markdown);
  if (
    presentationTextSize() + chatTextSize() + incomingSize >
    MAX_RETAINED_TEXT
  ) {
    reject(409, "Retained text limit reached");
  }
  presentation.items.push(item);
}

function isAllowedOrigin(request, origin) {
  if (EXPLICIT_ALLOWED_ORIGINS.has(origin)) return true;
  const parsed = new URL(origin);
  const expectedProtocol = request.socket.encrypted ? "https:" : "http:";
  const originPort = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const originHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    parsed.protocol === expectedProtocol &&
    originPort === String(port) &&
    LOCAL_ORIGIN_HOSTS.has(originHost)
  );
}

function enforceWriteRequest(request, route) {
  if (!STATE_CHANGING_METHODS.has(request.method)) return;

  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    logger.warn("authorization_denied", {
      route,
      reason: "cross_origin_fetch",
    });
    reject(403, "Cross-origin requests are not allowed");
  }

  const origin = request.headers.origin;
  if (origin) {
    let normalized;
    try {
      normalized = new URL(origin).origin;
    } catch {
      logger.warn("authorization_denied", {
        route,
        reason: "invalid_origin",
      });
      reject(403, "Invalid request origin");
    }
    if (!isAllowedOrigin(request, normalized)) {
      logger.warn("authorization_denied", {
        route,
        reason: "cross_origin_request",
      });
      reject(403, "Cross-origin requests are not allowed");
    }
  } else if (!isLoopback(request)) {
    logger.warn("authorization_denied", {
      route,
      reason: "missing_origin",
    });
    reject(403, "An Origin header is required");
  }

  const contentType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    reject(415, "State-changing requests require application/json");
  }
}

function requireDmCsrf(request, route) {
  if (
    !dmAuth.verifyCsrf(
      dmToken(request),
      request.headers["x-gm-cockpit-csrf"],
    )
  ) {
    logger.warn("authorization_denied", {
      route,
      requiredRole: "dm",
      reason: "invalid_csrf",
    });
    reject(403, "Invalid CSRF token");
  }
}

function authorizeRequest(request, policy, route) {
  if (policy.role === "dm") {
    const token = dmToken(request);
    const session = dmAuth.authenticate(token);
    if (!session) {
      logger.warn("authorization_denied", {
        route,
        requiredRole: "dm",
        reason: "invalid_session",
      });
      reject(401, "DM login required");
    }
    if (policy.mutates) requireDmCsrf(request, route);
    return { role: "dm", token, session };
  }

  if (policy.role === "player") {
    const token = bearerToken(request);
    const player = playerSessions.authenticate(token);
    if (!player) {
      logger.warn("authorization_denied", {
        route,
        requiredRole: "player",
        reason: "invalid_session",
      });
      reject(401, "Player session required");
    }
    return { role: "player", token, player };
  }

  if (policy.role === "dm-or-player") {
    const playerToken = bearerToken(request);
    const player = playerSessions.authenticate(playerToken);
    if (player) return { role: "player", token: playerToken, player };

    const dmSessionToken = dmToken(request);
    const session = dmAuth.authenticate(dmSessionToken);
    if (!session) {
      logger.warn("authorization_denied", {
        route,
        requiredRole: "dm_or_player",
        reason: "invalid_session",
      });
      reject(401, "Player or DM session required");
    }
    requireDmCsrf(request, route);
    return { role: "dm", token: dmSessionToken, session };
  }

  return { role: policy.role };
}

function rateLimitIdentity(request, authorization) {
  if (authorization.role === "player" && authorization.player) {
    return `player:${authorization.player.playerId}`;
  }
  if (authorization.role === "dm" && authorization.token) {
    return `dm:${hashedLimiterKey(authorization.token)}`;
  }
  return `ip:${clientIp(request)}`;
}

function enforceRateLimits(request, response, policy, authorization, route) {
  for (const rule of policy.rateLimits) {
    const key =
      rule.scope === "identity"
        ? rateLimitIdentity(request, authorization)
        : `ip:${clientIp(request)}`;
    const result = rateLimiter.consume(rule.bucket, key, rule);
    if (!result.allowed) {
      logger.warn("rate_limit_exceeded", {
        route,
        bucket: rule.bucket,
        scope: rule.scope,
      });
      sendRateLimited(response, result.retryAfterSeconds);
      return false;
    }
  }
  return true;
}

async function api(request, response, url) {
  const policy = apiRoute(url.pathname);
  if (!policy) {
    return sendJson(response, 404, { error: "API route not found" });
  }
  if (request.method !== policy.method) {
    return sendJson(
      response,
      405,
      { error: "Method not allowed" },
      { Allow: policy.method },
    );
  }
  if (policy.mutates) enforceWriteRequest(request, url.pathname);
  const authorization = authorizeRequest(request, policy, url.pathname);
  if (!enforceRateLimits(request, response, policy, authorization, url.pathname)) return;
  const query = parseRouteQuery(policy, url.searchParams);
  const body = policy.parseBody
    ? parseRouteBody(
        policy,
        await readJson(request, policy.maxBodyBytes),
      )
    : null;

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/readiness") {
    const ready = readiness.persistence && readiness.vault;
    return sendJson(response, ready ? 200 : 503, {
      ready,
      checks: {
        persistence: readiness.persistence ? "ready" : "unavailable",
        vault: readiness.vault ? "ready" : "unavailable",
      },
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dm/session") {
    const existing = dmAuth.authenticate(dmToken(request));
    if (existing) {
      return sendJson(response, 200, {
        session: existing,
        csrfToken: dmAuth.csrfToken(dmToken(request)),
      });
    }
    if (!ALLOW_LOCAL_DM || !isLoopback(request)) {
      return sendJson(response, 401, { error: "DM login required" });
    }
    const created = dmAuth.createSession();
    logger.info("dm_session_created", { source: "loopback" });
    return sendJson(
      response,
      200,
      { session: created.session, csrfToken: created.csrfToken },
      { "Set-Cookie": dmCookie(request, created.token) },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/dm/login") {
    const authenticated = dmAuth.login(body.pin);
    if (!authenticated) {
      logger.warn("dm_login", { outcome: "denied" });
      return sendJson(response, 401, { error: "Invalid table PIN" });
    }
    logger.info("dm_login", { outcome: "accepted" });
    return sendJson(
      response,
      200,
      {
        session: authenticated.session,
        csrfToken: authenticated.csrfToken,
      },
      { "Set-Cookie": dmCookie(request, authenticated.token) },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/dm/logout") {
    dmAuth.revoke(authorization.token);
    return sendJson(
      response,
      200,
      { ok: true },
      { "Set-Cookie": clearDmCookie(request) },
    );
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/dm/stream-ticket"
  ) {
    const ticket = dmAuth.issueStreamTicket(authorization.token);
    return sendJson(response, 200, ticket);
  }

  if (request.method === "POST" && url.pathname === "/api/player/join") {
    const joined = playerSessions.join(body.displayName);
    logger.info("player_joined", {
      registeredPlayers: playerSessions.players.size,
    });
    return sendJson(
      response,
      200,
      joined,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/player/rename") {
    const player = playerSessions.rename(
      authorization.token,
      body.displayName,
    );
    broadcast("presence", { players: connectedPlayers() });
    return sendJson(response, 200, { player });
  }

  if (request.method === "POST" && url.pathname === "/api/player/leave") {
    const player = playerSessions.revoke(authorization.token);
    for (const client of clients) {
      if (client.role === "player" && client.playerId === player.playerId) {
        client.response.end();
        clients.delete(client);
      }
    }
    broadcast("presence", { players: connectedPlayers() });
    logger.info("player_left", {
      registeredPlayers: playerSessions.players.size,
    });
    return sendJson(response, 200, { ok: true });
  }

  if (
    request.method === "POST" &&
    url.pathname === "/api/player/stream-ticket"
  ) {
    return sendJson(
      response,
      200,
      playerSessions.issueStreamTicket(authorization.token),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/stream") {
    let client;
    if (query.role === "dm") {
      const session = dmAuth.consumeStreamTicket(query.ticket);
      if (!session) {
        return sendJson(response, 401, {
          error: "Invalid or expired DM stream ticket",
        });
      }
      client = {
        response,
        role: "dm",
        identityKey: `dm:${session.sessionKey}`,
      };
    } else {
      const player = playerSessions.consumeStreamTicket(
        query.ticket,
      );
      if (!player) {
        return sendJson(response, 401, {
          error: "Invalid or expired stream ticket",
        });
      }
      client = {
        response,
        role: "player",
        playerId: player.playerId,
        identityKey: `player:${player.playerId}`,
      };
    }
    client.ip = clientIp(request);
    const streamsFromIp = [...clients].filter(
      (entry) => entry.ip === client.ip,
    ).length;
    const streamsForIdentity = [...clients].filter(
      (entry) => entry.identityKey === client.identityKey,
    ).length;
    if (
      clients.size >= MAX_CLIENTS ||
      streamsFromIp >= MAX_STREAMS_PER_IP ||
      streamsForIdentity >= MAX_STREAMS_PER_IDENTITY
    ) {
      return sendRateLimited(response, 60, "Stream connection limit reached");
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const hello =
      client.role === "player"
        ? { role: "player", player: playerSessions.get(client.playerId) }
        : { role: "dm" };
    response.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    clients.add(client);
    logger.info("stream_connected", {
      role: client.role,
      activeStreams: clients.size,
    });
    writeEvent(client, "reveal-set", presentation);
    writeEvent(client, "status-set", statusFor(client.role));
    broadcast("presence", { players: connectedPlayers() });
    request.on("close", () => {
      clients.delete(client);
      logger.info("stream_disconnected", {
        role: client.role,
        activeStreams: clients.size,
      });
      broadcast("presence", { players: connectedPlayers() });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/player/state") {
    const player = authorization.player;
    const messages = chat.filter((message) =>
      chatVisibleToPlayer(message, player.playerId),
    );
    return sendJson(response, 200, {
      player,
      presentation,
      chat: messages,
      status: statusFor("player"),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/dm/state") {
    return sendJson(response, 200, {
      presentation,
      chat,
      status: statusFor("dm"),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/player/image") {
    const item = presentation.items.find(
      (entry) => entry.id === query.id && entry.type === "image",
    );
    if (!item) return sendJson(response, 404, { error: "Image is not currently revealed" });
    const filePath = await vault.resolveFilePath(item.campaign, item.file);
    const contentType = await verifyPlayerImage(filePath);
    const content = await readBoundedFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition("inline", filePath),
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    return response.end(content);
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const text = body.text;
    const player = authorization.player;
    const isDm = authorization.role === "dm";
    const from = isDm ? "DM" : player.displayName;
    const identity = player ? { fromPlayerId: player.playerId } : {};
    const whisper = Boolean(body.whisper) && !isDm;
    const command = text.trim().match(/^\/(s?roll|r)(?:\s+(.*))?$/i);
    if (command) {
      const secret = command[1].toLowerCase() === "sroll";
      if (secret && !isDm) {
        return sendJson(response, 403, { error: "Only the DM can make secret rolls" });
      }
      const parts = parseRoll(command[2]);
      if (!parts) {
        return sendJson(response, 400, { error: "Could not read that roll — try /roll 2d6+3" });
      }
      const roll = executeRoll(parts);
      const scope = secret ? "secret" : whisper ? "whisper" : "table";
      const message = pushChat({
        scope,
        from,
        ...identity,
        ...(scope === "whisper" ? { to: "DM" } : {}),
        type: "roll",
        roll,
      });
      return sendJson(response, 200, { message });
    }
    const message = whisper
      ? pushChat({ scope: "whisper", from, ...identity, to: "DM", text })
      : pushChat({ scope: "table", from, ...identity, text });
    return sendJson(response, 200, { message });
  }

  if (request.method === "GET" && url.pathname === "/api/player-guide") {
    const guideData = await vault.playerGuide(query.campaign);
    if (!guideData) return sendJson(response, 404, { error: "No Player's Guide.md in this campaign" });
    return sendJson(response, 200, {
      title: guideData.title,
      intro: guideData.intro,
      cards: guideData.cards.map(({ id, title }) => ({ id, title })),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/card") {
    const guideData = await vault.playerGuide(body.campaign);
    const card = guideData?.cards.find((c) => c.id === body.cardId);
    if (!card) return sendJson(response, 404, { error: "Card not found" });
    const item = makeItem("card", {
      campaign: body.campaign,
      cardId: card.id,
      title: card.title,
      markdown: card.markdown,
    });
    addPresentationItem(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/image") {
    const filePath = await vault.resolveFilePath(body.campaign, body.file);
    await assertBoundedFile(filePath);
    await verifyPlayerImage(filePath);
    const { folder } = await vault.campaignFolder(body.campaign);
    const relativeFile = path.relative(folder, filePath).replaceAll(path.sep, "/");
    const basename = String(body.file).split("/").pop();
    const item = makeItem("image", {
      campaign: body.campaign,
      file: relativeFile,
      title: String(body.title || basename || "Image").slice(0, 120),
    });
    addPresentationItem(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/text") {
    const text = body.text;
    const derived = text.replace(/\s+/g, " ").trim().slice(0, 40) || "Note";
    const title = String(body.title || derived).slice(0, 80);
    const item = makeItem("text", { title, text });
    addPresentationItem(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/remove") {
    const id = body.id;
    const before = presentation.items.length;
    presentation.items = presentation.items.filter((i) => i.id !== id);
    if (presentation.items.length === before) {
      return sendJson(response, 404, { error: "Item not found" });
    }
    emitPresentation();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/clear") {
    presentation.items = [];
    emitPresentation();
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/whisper") {
    const player = playerSessions.get(body.toPlayerId);
    const text = body.text;
    if (!player) {
      return sendJson(response, 404, { error: "Player not found" });
    }
    const message = pushChat({
      scope: "whisper",
      from: "DM",
      to: player.displayName,
      toPlayerId: player.playerId,
      text,
    });
    return sendJson(response, 200, { message });
  }

  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, { status });
  }

  if (request.method === "POST" && url.pathname === "/api/status/upsert") {
    const previousTrackers = structuredClone(status.trackers);
    const previousTrackerSeq = trackerSeq;
    const previousUpdatedAt = status.updatedAt;
    const id = body.id === undefined ? null : body.id;
    let tracker = id === null ? null : status.trackers.find((t) => t.id === id);
    if (id !== null && !tracker) {
      return sendJson(response, 404, { error: "Tracker not found" });
    }
    if (!tracker) {
      if (status.trackers.length >= MAX_TRACKERS) {
        return sendJson(response, 409, { error: "Tracker limit reached" });
      }
      const name = body.name;
      const type = body.type || "clock";
      tracker =
        type === "initiative"
          ? { id: ++trackerSeq, type, name, entries: [], turn: 0, hidden: false }
          : { id: ++trackerSeq, type, name, max: type === "meter" ? 10 : 4, value: 0, hidden: false };
      status.trackers.push(tracker);
    } else if (body.name !== undefined) {
      tracker.name = body.name || tracker.name;
    }
    if (body.hidden !== undefined) tracker.hidden = body.hidden;
    if (tracker.type === "initiative") {
      if (body.entries !== undefined) {
        tracker.entries = body.entries;
      }
      if (body.turn !== undefined) {
        const turn = body.turn;
        const count = tracker.entries.length;
        tracker.turn = count ? ((turn % count) + count) % count : 0;
      }
      tracker.turn = Math.max(0, Math.min(tracker.turn, Math.max(0, tracker.entries.length - 1)));
    } else {
      if (body.max !== undefined) {
        tracker.max = body.max;
      }
      if (body.value !== undefined) {
        tracker.value = body.value;
      }
      tracker.value = Math.max(0, Math.min(tracker.max, tracker.value));
    }
    try {
      await emitStatus();
    } catch (error) {
      status.trackers = previousTrackers;
      trackerSeq = previousTrackerSeq;
      status.updatedAt = previousUpdatedAt;
      throw error;
    }
    return sendJson(response, 200, { ok: true, tracker });
  }

  if (request.method === "POST" && url.pathname === "/api/status/remove") {
    const previousTrackers = structuredClone(status.trackers);
    const previousUpdatedAt = status.updatedAt;
    const id = body.id;
    const before = status.trackers.length;
    status.trackers = status.trackers.filter((t) => t.id !== id);
    if (status.trackers.length === before) {
      return sendJson(response, 404, { error: "Tracker not found" });
    }
    try {
      await emitStatus();
    } catch (error) {
      status.trackers = previousTrackers;
      status.updatedAt = previousUpdatedAt;
      throw error;
    }
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/campaigns") {
    return sendJson(response, 200, { campaigns: await vault.campaigns() });
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return sendJson(response, 200, {
      sessions: await vault.sessions(query.campaign),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    return sendJson(
      response,
      200,
      await vault.session(
        query.campaign,
        query.number,
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/document") {
    return sendJson(
      response,
      200,
      await vault.resolveDocument(
        query.campaign,
        query.file,
        query.heading,
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/documents") {
    return sendJson(response, 200, {
      documents: await vault.listDocuments(query.campaign),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/file") {
    const filePath = await vault.resolveFilePath(
      query.campaign,
      query.file,
    );
    const content = await readBoundedFile(filePath);
    const disposition = dmFileDisposition(filePath);
    const contentType =
      disposition === "inline"
        ? mimeTypes[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream"
        : "application/octet-stream";
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(disposition, filePath),
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
    return response.end(content);
  }
  if (request.method === "GET" && url.pathname === "/api/validate") {
    const campaign = query.campaign;
    if (campaign) {
      return sendJson(response, 200, { reports: [await vault.validateCampaign(campaign)], skipped: [] });
    }
    return sendJson(response, 200, await vault.validateAll());
  }
  if (request.method === "POST" && url.pathname === "/api/notes") {
    const operation = body;
    let result;
    try {
      result = await vault.saveNotes(
        operation.campaign,
        operation.session,
        operation.notes,
      );
    } catch (error) {
      logger.error("persistence_failure", {
        store: "session_notes",
        operation: "write",
        error,
      });
      throw error;
    }
    return sendJson(
      response,
      200,
      acknowledgeNoteOperation(operation, result),
    );
  }
  return sendJson(response, 404, { error: "API route not found" });
}

async function staticFile(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = path.resolve(publicRoot, requested);
  const relative = path.relative(publicRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendJson(response, 403, { error: "Forbidden" });
  }
  try {
    const content = await readFile(candidate);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(candidate).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found" });
    throw error;
  }
}

const server = createServer(async (request, response) => {
  let url = null;
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.setHeader(name, value);
    }
    if (shuttingDown) {
      return sendJson(response, 503, { error: "Server is shutting down" });
    }
    url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      await api(request, response, url);
    } else {
      await staticFile(request, response, url);
    }
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      logger.error("request_failed", {
        method: request.method,
        route: url?.pathname || "unparsed",
        status,
        error,
      });
    }
    if (!response.headersSent) {
      const message =
        status >= 500 && error.expose !== true
          ? "Internal server error"
          : error.message || "Unexpected server error";
      sendJson(response, status, { error: message });
    }
  }
});

function closeStreams() {
  for (const client of clients) {
    try {
      client.response.end();
    } catch {
      // The stream is already closed.
    }
  }
  clients.clear();
}

function closeHttpServer() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_started", { signal });
  const timeout = setTimeout(() => {
    logger.error("shutdown_timeout", {});
    server.closeAllConnections?.();
    process.exit(1);
  }, 5_000);

  try {
    closeStreams();
    await closeHttpServer();
    await Promise.all([trackerStore.close(), vault.flushWrites()]);
    clearTimeout(timeout);
    logger.info("shutdown_complete", {});
    if (process.connected) process.disconnect();
  } catch (error) {
    clearTimeout(timeout);
    logger.error("shutdown_failed", { error });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("message", (message) => {
  if (message?.type === "shutdown") void shutdown("parent request");
});

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return host;
}

try {
  await loadTrackers();
  readiness.persistence = true;
} catch (error) {
  logger.error("startup_dependency_failed", {
    dependency: "persistence",
    error,
  });
}
try {
  await vault.campaigns();
  readiness.vault = true;
} catch (error) {
  logger.error("startup_dependency_failed", {
    dependency: "vault",
    error,
  });
}

server.listen(port, host, () => {
  const lan = lanAddress();
  if (REMOTE_BINDING) {
    logger.warn("remote_dm_enabled", { network: "trusted_lan_only" });
  }
  logger.info("startup", {
    host,
    port,
    mode: REMOTE_BINDING ? "lan" : "local",
    localDmAccess: ALLOW_LOCAL_DM,
    remoteDmAccess: ALLOW_REMOTE_DM,
    ready: readiness.persistence && readiness.vault,
    dmUrl: `http://${host}:${port}`,
    playerUrl: `http://${lan}:${port}/player.html`,
  });
});
