import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { randomInt } from "node:crypto";
import { Vault } from "./lib/vault.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(process.env.VAULT_ROOT || path.join(appRoot, ".."));
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4173);
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

const TABLE_PIN = process.env.TABLE_PIN || String(randomInt(1000, 1_000_000)).padStart(4, "0");
const CHAT_LIMIT = 200;

const presentation = {
  items: [],
  updatedAt: Date.now(),
};
const chat = [];
const clients = new Set();
let messageSeq = 0;
let itemSeq = 0;

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
  if (message.scope === "table") return true;
  if (client.role === "dm") return true;
  return client.role === "player" && client.name === message.to;
}

function broadcast(eventName, payload, message) {
  for (const client of clients) {
    if (message && !visibleToClient(client, message)) continue;
    writeEvent(client, eventName, payload);
  }
}

function pushChat(message) {
  message.id = ++messageSeq;
  message.ts = Date.now();
  chat.push(message);
  if (chat.length > CHAT_LIMIT) chat.splice(0, chat.length - CHAT_LIMIT);
  broadcast(message.scope === "whisper" ? "whisper" : "chat", message, message);
  return message;
}

function connectedPlayerNames() {
  return [...new Set([...clients].filter((c) => c.role === "player" && c.name).map((c) => c.name))];
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

function isDmAuthorized(request, url) {
  if (isLoopback(request)) return true;
  const pin = request.headers["x-table-pin"] || url.searchParams.get("pin");
  return Boolean(pin) && pin === TABLE_PIN;
}

const DM_API = new Set([
  "/api/campaigns",
  "/api/sessions",
  "/api/session",
  "/api/document",
  "/api/documents",
  "/api/file",
  "/api/validate",
  "/api/notes",
  "/api/player-guide",
  "/api/reveal/card",
  "/api/reveal/image",
  "/api/reveal/text",
  "/api/reveal/clear",
  "/api/reveal/remove",
  "/api/whisper",
]);

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 150_000) {
      throw Object.assign(new Error("Request body is too large"), { status: 413 });
    }
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

async function api(request, response, url) {
  if (DM_API.has(url.pathname) && !isDmAuthorized(request, url)) {
    return sendJson(response, 401, { error: "PIN required" });
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, vaultRoot });
  }

  if (request.method === "GET" && url.pathname === "/api/stream") {
    const role = url.searchParams.get("role") === "dm" ? "dm" : "player";
    if (role === "dm" && !isDmAuthorized(request, url)) {
      return sendJson(response, 401, { error: "PIN required" });
    }
    const name = (url.searchParams.get("name") || "").slice(0, 60);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write(`event: hello\ndata: ${JSON.stringify({ role, name })}\n\n`);
    const client = { response, role, name };
    clients.add(client);
    broadcast("presence", { players: connectedPlayerNames() });
    request.on("close", () => {
      clients.delete(client);
      broadcast("presence", { players: connectedPlayerNames() });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/player/state") {
    const name = url.searchParams.get("name") || "";
    const messages = chat.filter((m) => m.scope === "table" || m.to === name);
    return sendJson(response, 200, { presentation, chat: messages });
  }

  if (request.method === "GET" && url.pathname === "/api/player/image") {
    const id = Number(url.searchParams.get("id"));
    const item = presentation.items.find((i) => i.id === id && i.type === "image");
    if (!item) return sendJson(response, 404, { error: "Image is not currently revealed" });
    const filePath = await vault.resolveFilePath(item.campaign, item.file);
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    return response.end(content);
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJson(request);
    const from = String(body.from || "Anon").slice(0, 60);
    const text = String(body.text || "").slice(0, 2000);
    if (!text.trim()) return sendJson(response, 400, { error: "Empty message" });
    const message = pushChat({ scope: "table", from, text });
    return sendJson(response, 200, { message });
  }

  if (request.method === "GET" && url.pathname === "/api/player-guide") {
    const guideData = await vault.playerGuide(url.searchParams.get("campaign"));
    if (!guideData) return sendJson(response, 404, { error: "No Player's Guide.md in this campaign" });
    return sendJson(response, 200, {
      title: guideData.title,
      intro: guideData.intro,
      cards: guideData.cards.map(({ id, title }) => ({ id, title })),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/card") {
    const body = await readJson(request);
    const guideData = await vault.playerGuide(body.campaign);
    const card = guideData?.cards.find((c) => c.id === body.cardId);
    if (!card) return sendJson(response, 404, { error: "Card not found" });
    const item = makeItem("card", {
      campaign: body.campaign,
      cardId: card.id,
      title: card.title,
      markdown: card.markdown,
    });
    presentation.items.push(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/image") {
    const body = await readJson(request);
    await vault.resolveFilePath(body.campaign, body.file);
    const basename = String(body.file).split("/").pop();
    const item = makeItem("image", {
      campaign: body.campaign,
      file: body.file,
      title: String(body.title || basename || "Image").slice(0, 120),
    });
    presentation.items.push(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/text") {
    const body = await readJson(request);
    const text = String(body.text || "").slice(0, 4000);
    if (!text.trim()) return sendJson(response, 400, { error: "Empty note" });
    const derived = text.replace(/\s+/g, " ").trim().slice(0, 40) || "Note";
    const title = String(body.title || derived).slice(0, 80);
    const item = makeItem("text", { title, text });
    presentation.items.push(item);
    emitPresentation();
    return sendJson(response, 200, { ok: true, item });
  }

  if (request.method === "POST" && url.pathname === "/api/reveal/remove") {
    const body = await readJson(request);
    const id = Number(body.id);
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
    const body = await readJson(request);
    const to = String(body.to || "").slice(0, 60);
    const text = String(body.text || "").slice(0, 2000);
    if (!to || !text.trim()) return sendJson(response, 400, { error: "to and text required" });
    const message = pushChat({ scope: "whisper", from: "DM", to, text });
    return sendJson(response, 200, { message });
  }

  if (request.method === "GET" && url.pathname === "/api/campaigns") {
    return sendJson(response, 200, { campaigns: await vault.campaigns() });
  }
  if (request.method === "GET" && url.pathname === "/api/sessions") {
    return sendJson(response, 200, {
      sessions: await vault.sessions(url.searchParams.get("campaign")),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    return sendJson(
      response,
      200,
      await vault.session(
        url.searchParams.get("campaign"),
        Number(url.searchParams.get("number")),
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/document") {
    return sendJson(
      response,
      200,
      await vault.resolveDocument(
        url.searchParams.get("campaign"),
        url.searchParams.get("file"),
        url.searchParams.get("heading") || "",
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/documents") {
    return sendJson(response, 200, {
      documents: await vault.listDocuments(url.searchParams.get("campaign")),
    });
  }
  if (request.method === "GET" && url.pathname === "/api/file") {
    const filePath = await vault.resolveFilePath(
      url.searchParams.get("campaign"),
      url.searchParams.get("file"),
    );
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    return response.end(content);
  }
  if (request.method === "GET" && url.pathname === "/api/validate") {
    const campaign = url.searchParams.get("campaign");
    if (campaign) {
      return sendJson(response, 200, { reports: [await vault.validateCampaign(campaign)], skipped: [] });
    }
    return sendJson(response, 200, await vault.validateAll());
  }
  if (request.method === "POST" && url.pathname === "/api/notes") {
    const body = await readJson(request);
    return sendJson(
      response,
      200,
      await vault.saveNotes(body.campaign, Number(body.session), body.notes),
    );
  }
  return sendJson(response, 404, { error: "API route not found" });
}

async function staticFile(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if ((requested === "index.html" || requested === "app.js") && !isDmAuthorized(request, url)) {
    return sendJson(response, 401, { error: "PIN required" });
  }
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
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      await api(request, response, url);
    } else {
      await staticFile(request, response, url);
    }
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    if (!response.headersSent) {
      sendJson(response, status, { error: error.message || "Unexpected server error" });
    }
  }
});

function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) return i.address;
    }
  }
  return host;
}

server.listen(port, host, () => {
  const lan = lanAddress();
  console.log(`GM Campaign Cockpit (DM): http://${host}:${port}`);
  console.log(`Player screen (LAN):      http://${lan}:${port}/player.html`);
  console.log(`Vault: ${vaultRoot}`);
  console.log(`Table PIN (DM access off-localhost): ${TABLE_PIN}`);
});
