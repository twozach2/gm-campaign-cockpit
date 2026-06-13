import { escapeHtml, feedEntryHtml, trackerHtml, rollHtml } from "/render.mjs";
import { openTicketedEventSource } from "/stream-connection.mjs";

const NAME_KEY = "gm-cockpit:player-name";
const SESSION_KEY = "gm-cockpit:player-session";

const elements = {
  nav: document.querySelector("#player-nav"),
  panels: {
    shared: document.querySelector("#panel-shared"),
    chat: document.querySelector("#panel-chat"),
    status: document.querySelector("#panel-status"),
  },
  feed: document.querySelector("#feed"),
  holding: document.querySelector("#holding"),
  statusList: document.querySelector("#status-list"),
  chatLog: document.querySelector("#chat-log"),
  chatForm: document.querySelector("#chat-form"),
  chatInput: document.querySelector("#chat-input"),
  whisperToggle: document.querySelector("#whisper-toggle"),
  identity: document.querySelector("#player-identity"),
  rename: document.querySelector("#player-rename"),
  overlay: document.querySelector("#name-overlay"),
  nameForm: document.querySelector("#name-form"),
  nameInput: document.querySelector("#name-input"),
  toast: document.querySelector("#player-toast"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImg: document.querySelector("#lightbox-img"),
  connection: document.querySelector("#player-connection"),
};

let name = "";
try { name = localStorage.getItem(NAME_KEY) || ""; } catch { name = ""; }
let token = "";
try { token = localStorage.getItem(SESSION_KEY) || ""; } catch { token = ""; }
let player = null;
let eventSource = null;
let reconnectTimer = null;
let connecting = false;
let connectionStatus = "connecting";
const renderedIds = new Set();
const feedNodes = new Map();
let activeTab = "shared";
let statusSignature = null;
let syncing = false;
let whisperMode = false;
const unread = { shared: 0, chat: 0, status: 0 };

const imageUrlFor = (item) => `/api/player/image?id=${item.id}`;
const playerFileUrl = () => "";

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function renderBadges() {
  for (const tab of Object.keys(unread)) {
    const badge = elements.nav.querySelector(`[data-badge="${tab}"]`);
    if (!badge) continue;
    badge.textContent = unread[tab] > 9 ? "9+" : String(unread[tab]);
    badge.classList.toggle("hidden", unread[tab] === 0);
  }
}

function bumpUnread(tab) {
  if (tab === activeTab || syncing) return;
  unread[tab] += 1;
  renderBadges();
}

function setTab(tab) {
  activeTab = tab;
  unread[tab] = 0;
  elements.nav.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  for (const [key, panel] of Object.entries(elements.panels)) {
    panel.classList.toggle("active", key === tab);
  }
  renderBadges();
  if (tab === "chat") elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  if (tab === "shared") elements.feed.scrollTop = elements.feed.scrollHeight;
}

elements.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) setTab(button.dataset.tab);
});

function buildFeedEntry(item) {
  const template = document.createElement("template");
  template.innerHTML = feedEntryHtml(item, { imageUrl: imageUrlFor, fileUrl: playerFileUrl });
  return template.content.firstElementChild;
}

function applyPresentation(presentation) {
  const items = (presentation && presentation.items) || [];
  const ids = new Set(items.map((i) => i.id));
  for (const [id, node] of feedNodes) {
    if (!ids.has(id)) {
      node.remove();
      feedNodes.delete(id);
    }
  }
  let added = false;
  for (const item of items) {
    if (feedNodes.has(item.id)) continue;
    feedNodes.set(item.id, elements.feed.appendChild(buildFeedEntry(item)));
    added = true;
  }
  elements.holding.classList.toggle("hidden", feedNodes.size > 0);
  if (added) {
    elements.feed.scrollTop = elements.feed.scrollHeight;
    bumpUnread("shared");
  }
}

function applyStatus(status) {
  const trackers = (status && status.trackers) || [];
  const signature = JSON.stringify(
    trackers.map((t) => [t.id, t.type, t.name, t.max, t.value, t.turn, t.entries]),
  );
  elements.statusList.innerHTML = trackers.length
    ? trackers.map(trackerHtml).join("")
    : '<div class="status-empty">Nothing tracked right now.</div>';
  if (statusSignature !== null && signature !== statusSignature) bumpUnread("status");
  statusSignature = signature;
}

elements.feed.addEventListener("click", (event) => {
  const image = event.target.closest(".feed-image");
  if (!image) return;
  elements.lightboxImg.src = image.src;
  elements.lightbox.classList.remove("hidden");
});

elements.lightbox.addEventListener("click", () => {
  elements.lightbox.classList.add("hidden");
  elements.lightboxImg.src = "";
});

function messageLabel(message) {
  if (message.scope !== "whisper") return escapeHtml(message.from || "Anon");
  if (message.fromPlayerId === player?.playerId) return "You whisper to the DM";
  if (message.toPlayerId === player?.playerId && message.from === "DM") {
    return "DM whispers to you";
  }
  if (message.from === "DM") return `DM whispers to ${escapeHtml(message.to || "")}`;
  return `${escapeHtml(message.from || "Anon")} whispers to the DM`;
}

function appendMessage(message) {
  if (!message || renderedIds.has(message.id)) return;
  renderedIds.add(message.id);
  const isWhisper = message.scope === "whisper";
  const isRoll = message.type === "roll";
  const node = document.createElement("div");
  node.className = `chat-msg${isWhisper ? " whisper" : ""}${isRoll ? " roll" : ""}`;
  const body = isRoll ? rollHtml(message.roll) : escapeHtml(message.text || "");
  node.innerHTML = `<span class="chat-from">${messageLabel(message)}</span><span class="chat-text">${body}</span>`;
  elements.chatLog.appendChild(node);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  bumpUnread("chat");
}

async function playerRequest(url, options = {}, authenticate = true) {
  const headers = { ...(options.headers || {}) };
  if (authenticate && token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function applyPlayer(nextPlayer) {
  player = nextPlayer;
  name = nextPlayer.displayName;
  try {
    localStorage.setItem(NAME_KEY, name);
    if (token) localStorage.setItem(SESSION_KEY, token);
  } catch {}
  elements.identity.textContent = name;
}

function clearSession() {
  token = "";
  player = null;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  if (eventSource) eventSource.close();
  eventSource = null;
  clearTimeout(reconnectTimer);
  setConnectionStatus("disconnected");
}

async function sync() {
  const { player: currentPlayer, presentation, chat, status } =
    await playerRequest("/api/player/state");
  applyPlayer(currentPlayer);
  syncing = true;
  applyPresentation(presentation);
  applyStatus(status);
  elements.chatLog.innerHTML = "";
  renderedIds.clear();
  chat.forEach(appendMessage);
  syncing = false;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  setConnectionStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    connect();
  }, 1000);
}

function setConnectionStatus(nextState) {
  const previous = connectionStatus;
  connectionStatus = nextState;
  if (elements.connection) {
    elements.connection.dataset.state = nextState;
    elements.connection.textContent =
      nextState === "connected"
        ? "Live"
        : nextState === "reconnecting"
          ? "Reconnecting"
          : nextState === "disconnected"
            ? "Offline"
            : "Connecting";
  }
  if (nextState === "reconnecting" && previous === "connected") {
    showToast("Connection lost - reconnecting");
  }
}

async function connect() {
  if (!token || connecting) return;
  connecting = true;
  if (eventSource) eventSource.close();
  setConnectionStatus(connectionStatus === "connected" ? "reconnecting" : "connecting");
  try {
    const es = await openTicketedEventSource({
      issueTicket: () =>
        playerRequest("/api/player/stream-ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      buildUrl: (ticket) =>
        `/api/stream?ticket=${encodeURIComponent(ticket)}`,
    });
    eventSource = es;
    es.addEventListener("open", () => setConnectionStatus("connected"));
    es.addEventListener("hello", (event) => {
      const data = JSON.parse(event.data);
      if (data.player) applyPlayer(data.player);
    });
    es.addEventListener("reveal-set", (event) =>
      applyPresentation(JSON.parse(event.data)),
    );
    es.addEventListener("status-set", (event) =>
      applyStatus(JSON.parse(event.data)),
    );
    es.addEventListener("chat", (event) =>
      appendMessage(JSON.parse(event.data)),
    );
    es.addEventListener("whisper", (event) =>
      appendMessage(JSON.parse(event.data)),
    );
    es.onerror = () => {
      if (eventSource !== es) return;
      es.close();
      eventSource = null;
      scheduleReconnect();
    };
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      promptForName();
    } else {
      showToast(error.message);
      scheduleReconnect();
    }
  } finally {
    connecting = false;
  }
}

async function sendChat(text) {
  if (!text.trim()) return;
  try {
    await playerRequest("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, whisper: whisperMode }),
    });
  } catch (error) {
    if (error.status === 401) {
      clearSession();
      promptForName();
    }
    showToast(error.message);
  }
}

async function setName(value) {
  const displayName = value.trim().slice(0, 60);
  try {
    let data;
    if (token) {
      data = await playerRequest("/api/player/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName }),
      });
    } else {
      data = await playerRequest(
        "/api/player/join",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName }),
        },
        false,
      );
      token = data.token;
    }
    applyPlayer(data.player);
    elements.overlay.classList.add("hidden");
    await sync();
    connect();
  } catch (error) {
    if (error.status === 401 && token) {
      clearSession();
      return setName(displayName);
    }
    showToast(error.message);
  }
}

function promptForName() {
  setConnectionStatus("disconnected");
  elements.overlay.classList.remove("hidden");
  elements.nameInput.value = name;
  elements.nameInput.focus();
}

elements.nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = elements.nameInput.value.trim();
  if (!value) return;
  if (/^dm$/i.test(value)) {
    showToast("That name is reserved for the DM");
    return;
  }
  await setName(value);
});

elements.rename.addEventListener("click", promptForName);

elements.whisperToggle.addEventListener("click", () => {
  whisperMode = !whisperMode;
  elements.whisperToggle.classList.toggle("active", whisperMode);
  elements.whisperToggle.setAttribute("aria-pressed", String(whisperMode));
  elements.chatForm.classList.toggle("whispering", whisperMode);
  elements.chatInput.placeholder = whisperMode
    ? "Whisper to the DM..."
    : "Message the table... (/roll 2d6+3)";
  elements.chatInput.focus();
});

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatInput.value;
  elements.chatInput.value = "";
  sendChat(text);
});

async function start() {
  if (/^dm$/i.test(name.trim())) name = "";
  if (!token) {
    promptForName();
    return;
  }
  try {
    await sync();
    elements.overlay.classList.add("hidden");
    connect();
  } catch (error) {
    clearSession();
    if (error.status !== 401) showToast(error.message);
    promptForName();
  }
}

start();
