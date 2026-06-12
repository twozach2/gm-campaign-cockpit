import { escapeHtml, feedEntryHtml, trackerHtml, rollHtml } from "/render.mjs";

const NAME_KEY = "gm-cockpit:player-name";

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
};

let name = "";
try { name = localStorage.getItem(NAME_KEY) || ""; } catch { name = ""; }
let eventSource = null;
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
  if (message.from === name) return "You whisper to the DM";
  if (message.to === name && message.from === "DM") return "DM whispers to you";
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

async function sync() {
  try {
    const res = await fetch(`/api/player/state?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    const { presentation, chat, status } = await res.json();
    syncing = true;
    applyPresentation(presentation);
    applyStatus(status);
    elements.chatLog.innerHTML = "";
    renderedIds.clear();
    chat.forEach(appendMessage);
    syncing = false;
  } catch (error) {
    syncing = false;
    showToast(error.message);
  }
}

function connect() {
  if (eventSource) eventSource.close();
  const es = new EventSource(`/api/stream?role=player&name=${encodeURIComponent(name)}`);
  eventSource = es;
  es.addEventListener("reveal-set", (e) => applyPresentation(JSON.parse(e.data)));
  es.addEventListener("status-set", (e) => applyStatus(JSON.parse(e.data)));
  es.addEventListener("chat", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("whisper", (e) => appendMessage(JSON.parse(e.data)));
}

async function sendChat(text) {
  if (!text.trim()) return;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: name, text, whisper: whisperMode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Send failed (${res.status})`);
    }
  } catch (error) {
    showToast(error.message);
  }
}

function setName(value) {
  name = value.trim().slice(0, 60);
  try { localStorage.setItem(NAME_KEY, name); } catch {}
  elements.identity.textContent = name || "Player";
  elements.overlay.classList.add("hidden");
  sync();
  connect();
}

function promptForName() {
  elements.overlay.classList.remove("hidden");
  elements.nameInput.value = name;
  elements.nameInput.focus();
}

elements.nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = elements.nameInput.value.trim();
  if (!value) return;
  if (/^dm$/i.test(value)) {
    showToast("That name is reserved for the DM");
    return;
  }
  setName(value);
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

if (/^dm$/i.test(name.trim())) name = "";
if (name) {
  elements.identity.textContent = name;
  elements.overlay.classList.add("hidden");
  sync();
  connect();
} else {
  promptForName();
}
