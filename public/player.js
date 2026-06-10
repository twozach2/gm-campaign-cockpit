import { renderMarkdown, escapeHtml } from "/render.mjs";

const NAME_KEY = "gm-cockpit:player-name";

const elements = {
  holding: document.querySelector("#holding"),
  deck: document.querySelector("#player-deck"),
  tabs: document.querySelector("#player-tabs"),
  stage: document.querySelector("#stage"),
  chatLog: document.querySelector("#chat-log"),
  chatForm: document.querySelector("#chat-form"),
  chatInput: document.querySelector("#chat-input"),
  identity: document.querySelector("#player-identity"),
  rename: document.querySelector("#player-rename"),
  overlay: document.querySelector("#name-overlay"),
  nameForm: document.querySelector("#name-form"),
  nameInput: document.querySelector("#name-input"),
  toast: document.querySelector("#player-toast"),
};

let name = "";
try { name = localStorage.getItem(NAME_KEY) || ""; } catch { name = ""; }
let eventSource = null;
const renderedIds = new Set();
let items = [];
let activeItemId = null;
let maxSeenItemId = 0;

const imageUrlFor = (item) => `/api/player/image?id=${item.id}`;
const playerFileUrl = () => "";

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function showHolding() {
  elements.holding.classList.remove("hidden");
  elements.deck.classList.add("hidden");
  elements.stage.innerHTML = "";
  elements.tabs.innerHTML = "";
}

function showStage(html, extraClass = "") {
  elements.holding.classList.add("hidden");
  elements.deck.classList.remove("hidden");
  elements.stage.className = `player-stage markdown-body${extraClass ? ` ${extraClass}` : ""}`;
  elements.stage.innerHTML = html;
}

function renderItem(item) {
  if (!item) return showHolding();
  if (item.type === "card") {
    showStage(renderMarkdown(item.markdown || "", { fileUrl: playerFileUrl }), "stage-card");
  } else if (item.type === "image") {
    const src = imageUrlFor(item);
    const alt = escapeHtml(item.title || "Shared image");
    showStage(`<img class="stage-image" src="${escapeHtml(src)}" alt="${alt}">`, "stage-image-wrap");
  } else if (item.type === "text") {
    showStage(`<div class="stage-text">${escapeHtml(item.text || "")}</div>`, "stage-text-wrap");
  } else {
    showHolding();
  }
}

function renderTabs() {
  if (!items.length) {
    elements.tabs.innerHTML = "";
    return;
  }
  elements.tabs.innerHTML = items
    .map((item) => {
      const isActive = item.id === activeItemId;
      const icon = item.type === "image" ? "🖼" : item.type === "text" ? "✎" : "✦";
      return `<button class="player-tab${isActive ? " active" : ""}" type="button" data-item-id="${item.id}" title="${escapeHtml(item.title || "Untitled")}"><span class="player-tab-icon">${icon}</span><span class="player-tab-title">${escapeHtml(item.title || "Untitled")}</span></button>`;
    })
    .join("");
  const activeButton = elements.tabs.querySelector(".player-tab.active");
  if (activeButton) activeButton.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
}

function setActive(id, options = {}) {
  const item = items.find((i) => i.id === id);
  activeItemId = item ? item.id : null;
  renderTabs();
  renderItem(item);
  if (options.scrollIntoView !== false && item) {
    const button = elements.tabs.querySelector(`.player-tab[data-item-id="${item.id}"]`);
    button?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }
}

function applyPresentation(presentation) {
  items = (presentation && presentation.items) || [];
  if (!items.length) {
    activeItemId = null;
    return showHolding();
  }
  const newMaxId = items.reduce((m, i) => Math.max(m, i.id), 0);
  const newItem = items.find((i) => i.id > maxSeenItemId);
  const stillActive = items.some((i) => i.id === activeItemId);
  let target;
  if (newItem) target = items[items.length - 1];
  else if (stillActive) target = items.find((i) => i.id === activeItemId);
  else target = items[items.length - 1];
  maxSeenItemId = Math.max(maxSeenItemId, newMaxId);
  setActive(target.id);
}

function appendMessage(message) {
  if (!message || renderedIds.has(message.id)) return;
  renderedIds.add(message.id);
  const isWhisper = message.scope === "whisper";
  const cssClass = `chat-msg${isWhisper ? " whisper" : ""}`;
  const label = isWhisper
    ? `DM whispers to ${escapeHtml(message.to || "")}`
    : escapeHtml(message.from || "Anon");
  const node = document.createElement("div");
  node.className = cssClass;
  node.innerHTML = `<span class="chat-from">${label}</span><span class="chat-text">${escapeHtml(message.text || "")}</span>`;
  elements.chatLog.appendChild(node);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
}

async function sync() {
  try {
    const res = await fetch(`/api/player/state?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Sync failed (${res.status})`);
    const { presentation, chat } = await res.json();
    applyPresentation(presentation);
    elements.chatLog.innerHTML = "";
    renderedIds.clear();
    chat.forEach(appendMessage);
  } catch (error) {
    showToast(error.message);
  }
}

function connect() {
  if (eventSource) eventSource.close();
  const es = new EventSource(`/api/stream?role=player&name=${encodeURIComponent(name)}`);
  eventSource = es;
  es.addEventListener("reveal-set", (e) => applyPresentation(JSON.parse(e.data)));
  es.addEventListener("chat", (e) => appendMessage(JSON.parse(e.data)));
  es.addEventListener("whisper", (e) => appendMessage(JSON.parse(e.data)));
}

elements.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-item-id]");
  if (!button) return;
  setActive(Number(button.dataset.itemId), { scrollIntoView: false });
});

async function sendChat(text) {
  if (!text.trim()) return;
  try {
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: name, text }),
    });
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
  if (value) setName(value);
});

elements.rename.addEventListener("click", promptForName);

elements.chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.chatInput.value;
  elements.chatInput.value = "";
  sendChat(text);
});

if (name) {
  elements.identity.textContent = name;
  elements.overlay.classList.add("hidden");
  sync();
  connect();
} else {
  promptForName();
}
