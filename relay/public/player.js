import {
  escapeHtml,
  feedEntryHtml,
  rollHtml,
  trackerHtml,
} from "/player/render.mjs";

const STORAGE_KEY = "gm-campaign-relay:player-session";
const PROTOCOL = "gm-campaign-cockpit-player-relay";
const VERSION = 1;

const state = {
  token: "",
  roomId: "",
  membership: null,
  socket: null,
  reconnectTimer: null,
  reconnectAttempt: 0,
  manualClose: false,
  revision: 0,
  roomState: {
    presentation: { items: [], updatedAt: 0 },
    status: { trackers: [], updatedAt: 0 },
    chat: [],
    players: [],
  },
  pending: new Map(),
  renderedMessages: new Set(),
  feedNodes: new Map(),
  assetUrls: new Map(),
  statusSignature: null,
  activeTab: "shared",
  whisper: false,
  syncing: false,
  unread: { shared: 0, chat: 0, status: 0 },
};

const elements = {
  nav: document.querySelector("#player-nav"),
  panels: {
    shared: document.querySelector("#panel-shared"),
    chat: document.querySelector("#panel-chat"),
    status: document.querySelector("#panel-status"),
  },
  connection: document.querySelector("#player-connection"),
  presence: document.querySelector("#presence"),
  identity: document.querySelector("#player-identity"),
  rename: document.querySelector("#player-rename"),
  leave: document.querySelector("#player-leave"),
  feed: document.querySelector("#feed"),
  holding: document.querySelector("#holding"),
  chatLog: document.querySelector("#chat-log"),
  chatForm: document.querySelector("#chat-form"),
  chatInput: document.querySelector("#chat-input"),
  whisperToggle: document.querySelector("#whisper-toggle"),
  statusList: document.querySelector("#status-list"),
  joinOverlay: document.querySelector("#join-overlay"),
  joinForm: document.querySelector("#join-form"),
  inviteToken: document.querySelector("#invite-token"),
  displayName: document.querySelector("#display-name"),
  joinError: document.querySelector("#join-error"),
  renameOverlay: document.querySelector("#rename-overlay"),
  renameForm: document.querySelector("#rename-form"),
  renameName: document.querySelector("#rename-name"),
  renameCancel: document.querySelector("#rename-cancel"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImg: document.querySelector("#lightbox-img"),
  toast: document.querySelector("#player-toast"),
};

function createFocusTrap(container) {
  if (!container) return { activate() {}, deactivate() {} };
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let restoreTo = null;
  const focusable = () =>
    Array.from(container.querySelectorAll(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
  function onKeydown(event) {
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) {
      event.preventDefault();
      container.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return {
    activate(initialFocus) {
      restoreTo = document.activeElement;
      container.addEventListener("keydown", onKeydown);
      (initialFocus || focusable()[0] || container).focus();
    },
    deactivate() {
      container.removeEventListener("keydown", onKeydown);
      if (restoreTo && typeof restoreTo.focus === "function") restoreTo.focus();
      restoreTo = null;
    },
  };
}

const lightboxTrap = createFocusTrap(elements.lightbox);
const joinTrap = createFocusTrap(elements.joinOverlay);
const renameTrap = createFocusTrap(elements.renameOverlay);

function showJoinOverlay() {
  elements.joinOverlay.classList.remove("hidden");
  joinTrap.activate(elements.inviteToken);
}

function hideJoinOverlay() {
  joinTrap.deactivate();
  elements.joinOverlay.classList.add("hidden");
}

function loadStoredSession() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (
      typeof value.token === "string" &&
      typeof value.roomId === "string"
    ) {
      state.token = value.token;
      state.roomId = value.roomId;
    }
  } catch {
    clearStoredSession();
  }
}

function saveSession() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ token: state.token, roomId: state.roomId }),
  );
}

function clearStoredSession() {
  state.token = "";
  state.roomId = "";
  state.membership = null;
  state.revision = 0;
  state.roomState = {
    presentation: { items: [], updatedAt: 0 },
    status: { trackers: [], updatedAt: 0 },
    chat: [],
    players: [],
  };
  for (const node of state.feedNodes.values()) node.remove();
  for (const url of state.assetUrls.values()) URL.revokeObjectURL(url);
  state.feedNodes.clear();
  state.assetUrls.clear();
  state.renderedMessages.clear();
  state.statusSignature = null;
  elements.holding.classList.remove("hidden");
  elements.chatLog.innerHTML = "";
  elements.statusList.innerHTML =
    '<div class="status-empty">Nothing tracked right now.</div>';
  elements.identity.textContent = "Player";
  elements.presence.textContent = "0 online";
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable in a private browser context.
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 2800);
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() ||
    `command-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function api(pathname, { method = "GET", body, authenticate = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (authenticate && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  const response = await fetch(pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setConnection(next) {
  elements.connection.dataset.state = next;
  elements.connection.textContent =
    next === "connected"
      ? "Live"
      : next === "reconnecting"
        ? "Reconnecting"
        : next === "disconnected"
          ? "Offline"
          : "Connecting";
}

function renderBadges() {
  for (const tab of Object.keys(state.unread)) {
    const badge = elements.nav.querySelector(`[data-badge="${tab}"]`);
    badge.textContent = state.unread[tab] > 9 ? "9+" : String(state.unread[tab]);
    badge.classList.toggle("hidden", state.unread[tab] === 0);
  }
}

function bumpUnread(tab) {
  if (tab === state.activeTab || state.syncing) return;
  state.unread[tab] += 1;
  renderBadges();
}

function setTab(tab) {
  state.activeTab = tab;
  state.unread[tab] = 0;
  elements.nav.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  for (const [name, panel] of Object.entries(elements.panels)) {
    panel.classList.toggle("active", name === tab);
  }
  renderBadges();
}

function applyMembership(membership) {
  state.membership = membership;
  elements.identity.textContent = membership.displayName;
}

function buildFeedEntry(item) {
  const template = document.createElement("template");
  template.innerHTML = feedEntryHtml(item, {
    imageUrl: () => "data:,",
    fileUrl: () => "",
  });
  return template.content.firstElementChild;
}

async function loadImage(item, node) {
  try {
    const response = await fetch(
      `/v1/assets/${encodeURIComponent(item.assetId)}`,
      {
        headers: { Authorization: `Bearer ${state.token}` },
      },
    );
    if (!response.ok) throw new Error(`Image request failed (${response.status})`);
    const blob = await response.blob();
    if (state.feedNodes.get(item.id) !== node) return;
    const previous = state.assetUrls.get(item.id);
    if (previous) URL.revokeObjectURL(previous);
    const objectUrl = URL.createObjectURL(blob);
    state.assetUrls.set(item.id, objectUrl);
    const image = node.querySelector(".feed-image");
    if (image) image.src = objectUrl;
  } catch {
    if (state.feedNodes.get(item.id) === node) {
      node.querySelector(".feed-image")?.remove();
      node.querySelector(".feed-body")?.insertAdjacentHTML(
        "beforeend",
        '<p class="muted">This image is unavailable.</p>',
      );
    }
  }
}

function applyPresentation(presentation) {
  const items = presentation?.items || [];
  const ids = new Set(items.map((item) => item.id));
  for (const [id, node] of state.feedNodes) {
    if (!ids.has(id)) {
      node.remove();
      state.feedNodes.delete(id);
      const objectUrl = state.assetUrls.get(id);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      state.assetUrls.delete(id);
    }
  }
  let added = false;
  for (const item of items) {
    if (state.feedNodes.has(item.id)) continue;
    const node = elements.feed.appendChild(buildFeedEntry(item));
    state.feedNodes.set(item.id, node);
    if (item.type === "image") void loadImage(item, node);
    added = true;
  }
  elements.holding.classList.toggle("hidden", state.feedNodes.size > 0);
  if (added) bumpUnread("shared");
}

function applyStatus(status) {
  const trackers = status?.trackers || [];
  const signature = JSON.stringify(trackers);
  elements.statusList.innerHTML = trackers.length
    ? trackers.map(trackerHtml).join("")
    : '<div class="status-empty">Nothing tracked right now.</div>';
  if (state.statusSignature !== null && signature !== state.statusSignature) {
    bumpUnread("status");
  }
  state.statusSignature = signature;
}

function messageLabel(message) {
  if (message.scope !== "whisper") return escapeHtml(message.from || "Anon");
  if (message.fromPlayerId === state.membership?.playerId) {
    return "You whisper to the DM";
  }
  return "DM whispers to you";
}

function appendMessage(message) {
  if (!message || state.renderedMessages.has(message.id)) return;
  state.renderedMessages.add(message.id);
  const node = document.createElement("div");
  const isRoll = message.type === "roll";
  node.className = `chat-msg${message.scope === "whisper" ? " whisper" : ""}${isRoll ? " roll" : ""}`;
  const body = isRoll ? rollHtml(message.roll) : escapeHtml(message.text || "");
  node.innerHTML = `<span class="chat-from">${messageLabel(message)}</span><span class="chat-text">${body}</span>`;
  elements.chatLog.appendChild(node);
  elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  bumpUnread("chat");
}

function applyPlayers(players) {
  state.roomState.players = players || [];
  const count = state.roomState.players.length;
  elements.presence.textContent = `${count} ${count === 1 ? "player" : "players"} online`;
}

function applyRoomState(roomState) {
  state.roomState = roomState;
  state.syncing = true;
  applyPresentation(roomState.presentation);
  applyStatus(roomState.status);
  applyPlayers(roomState.players);
  elements.chatLog.innerHTML = "";
  state.renderedMessages.clear();
  for (const message of roomState.chat || []) appendMessage(message);
  state.syncing = false;
}

function applyEvent(payload) {
  if (payload.revision <= state.revision) return;
  if (payload.eventType === "reveal.set") {
    state.roomState.presentation = payload.data.presentation;
    applyPresentation(payload.data.presentation);
  } else if (payload.eventType === "status.set") {
    state.roomState.status = payload.data.status;
    applyStatus(payload.data.status);
  } else if (payload.eventType === "chat.append") {
    state.roomState.chat.push(payload.data.message);
    if (state.roomState.chat.length > 200) state.roomState.chat.shift();
    appendMessage(payload.data.message);
  } else if (payload.eventType === "presence.set") {
    applyPlayers(payload.data.players);
  }
  state.revision = payload.revision;
}

function playerEnvelope(type, payload, id = requestId()) {
  return {
    protocol: PROTOCOL,
    version: VERSION,
    id,
    type,
    roomId: state.roomId,
    sentAt: Date.now(),
    payload,
  };
}

function sendCommand(commandType, data) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("The relay connection is offline"));
  }
  const id = requestId();
  state.socket.send(
    JSON.stringify(
      playerEnvelope("command", { commandType, data }, id),
    ),
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error("The command timed out"));
    }, 16_000);
    state.pending.set(id, { resolve, reject, timer });
  });
}

function completeCommand(message) {
  const pending = state.pending.get(message.id);
  if (!pending) return;
  state.pending.delete(message.id);
  clearTimeout(pending.timer);
  if (message.payload.accepted) pending.resolve(message.payload);
  else pending.reject(new Error(message.payload.code || "Command rejected"));
}

function rejectPending(message) {
  for (const pending of state.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  state.pending.clear();
}

function websocketUrl() {
  const url = new URL(
    `/v1/player/${encodeURIComponent(state.roomId)}`,
    window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function scheduleReconnect() {
  if (state.manualClose || !state.token) return;
  setConnection("reconnecting");
  clearTimeout(state.reconnectTimer);
  const delay = Math.min(10_000, 500 * 2 ** state.reconnectAttempt);
  state.reconnectAttempt += 1;
  state.reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (!state.token || !state.roomId || state.socket) return;
  setConnection(state.reconnectAttempt ? "reconnecting" : "connecting");
  const socket = new WebSocket(websocketUrl(), [
    "gm-campaign-cockpit-player-v1",
    `auth.${state.token}`,
  ]);
  state.socket = socket;
  socket.addEventListener("open", () => {
    state.reconnectAttempt = 0;
    setConnection("connected");
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      socket.close(1002, "Invalid relay message");
      return;
    }
    if (
      message.protocol !== PROTOCOL ||
      message.version !== VERSION ||
      message.roomId !== state.roomId
    ) {
      socket.close(1008, "Relay identity mismatch");
      return;
    }
    if (message.type === "snapshot") {
      applyMembership(message.payload.membership);
      state.revision = message.payload.revision;
      applyRoomState(message.payload.state);
    } else if (message.type === "event") {
      applyEvent(message.payload);
    } else if (message.type === "command-result") {
      completeCommand(message);
    } else if (message.type === "heartbeat") {
      socket.send(
        JSON.stringify(
          playerEnvelope("heartbeat", {
            nonce: message.payload.nonce,
          }),
        ),
      );
    } else if (message.type === "error") {
      showToast(message.payload.code || "Relay message rejected");
    }
  });
  socket.addEventListener("close", (event) => {
    if (state.socket === socket) state.socket = null;
    rejectPending("Connection closed");
    if (event.code === 4003 || event.code === 4004) {
      clearStoredSession();
      setConnection("disconnected");
      showJoinOverlay();
      showToast(event.code === 4004 ? "This room has ended" : "Your room access was removed");
      return;
    }
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  });
}

async function restoreSession() {
  const data = await api("/v1/player/session");
  state.roomId = data.room.id;
  applyMembership(data.membership);
  state.revision = data.revision;
  applyRoomState(data.state);
  saveSession();
}

async function join(inviteToken, displayName) {
  const data = await api("/v1/invites/redeem", {
    method: "POST",
    authenticate: false,
    body: { inviteToken, displayName },
  });
  state.token = data.token;
  state.roomId = data.room.id;
  state.manualClose = false;
  state.reconnectAttempt = 0;
  applyMembership(data.membership);
  saveSession();
  await restoreSession();
  hideJoinOverlay();
  connect();
}

function leaveSession() {
  state.manualClose = true;
  clearTimeout(state.reconnectTimer);
  state.socket?.close(1000, "Player left");
  state.socket = null;
  rejectPending("Player left");
  clearStoredSession();
  setConnection("disconnected");
  showJoinOverlay();
}

elements.nav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (button) setTab(button.dataset.tab);
});

elements.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.joinError.textContent = "";
  const displayName = elements.displayName.value.trim();
  if (/^dm$/i.test(displayName)) {
    elements.joinError.textContent = "That name is reserved for the DM";
    return;
  }
  try {
    await join(elements.inviteToken.value.trim(), displayName);
    elements.inviteToken.value = "";
  } catch (error) {
    elements.joinError.textContent = error.message;
  }
});

elements.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.chatInput.value.trim();
  if (!text) return;
  elements.chatInput.value = "";
  try {
    await sendCommand("chat.send", { text, whisper: state.whisper });
  } catch (error) {
    showToast(error.message);
  }
});

elements.whisperToggle.addEventListener("click", () => {
  state.whisper = !state.whisper;
  elements.whisperToggle.classList.toggle("active", state.whisper);
  elements.whisperToggle.setAttribute("aria-pressed", String(state.whisper));
  elements.chatForm.classList.toggle("whispering", state.whisper);
  elements.chatInput.placeholder = state.whisper
    ? "Whisper to the DM..."
    : "Message the table... (/roll 2d6+3)";
});

elements.rename.addEventListener("click", () => {
  elements.renameName.value = state.membership?.displayName || "";
  elements.renameOverlay.classList.remove("hidden");
  renameTrap.activate(elements.renameName);
});

function closeRenameOverlay() {
  if (elements.renameOverlay.classList.contains("hidden")) return;
  elements.renameOverlay.classList.add("hidden");
  renameTrap.deactivate();
}

elements.renameCancel.addEventListener("click", closeRenameOverlay);

elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = elements.renameName.value.trim();
  if (!displayName || /^dm$/i.test(displayName)) {
    showToast("That display name is not available");
    return;
  }
  try {
    await sendCommand("player.rename", { displayName });
    applyMembership({ ...state.membership, displayName });
    closeRenameOverlay();
  } catch (error) {
    showToast(error.message);
  }
});

elements.leave.addEventListener("click", async () => {
  if (!window.confirm("Leave this room and revoke this browser session?")) return;
  try {
    await sendCommand("player.leave", {});
  } catch (error) {
    if (!/Connection closed|Player left/.test(error.message)) {
      showToast(error.message);
    }
  } finally {
    leaveSession();
  }
});

elements.feed.addEventListener("click", (event) => {
  const image = event.target.closest(".feed-image");
  if (!image) return;
  elements.lightboxImg.src = image.src;
  elements.lightbox.classList.remove("hidden");
  lightboxTrap.activate();
});

function closeLightbox() {
  if (elements.lightbox.classList.contains("hidden")) return;
  elements.lightbox.classList.add("hidden");
  elements.lightboxImg.src = "";
  lightboxTrap.deactivate();
}

elements.lightbox.addEventListener("click", closeLightbox);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.lightbox.classList.contains("hidden")) {
    closeLightbox();
  } else {
    closeRenameOverlay();
  }
});

async function start() {
  loadStoredSession();
  if (!state.token || !state.roomId) {
    setConnection("disconnected");
    showJoinOverlay();
    return;
  }
  try {
    state.manualClose = false;
    await restoreSession();
    hideJoinOverlay();
    connect();
  } catch (error) {
    clearStoredSession();
    setConnection("disconnected");
    showJoinOverlay();
    if (error.status !== 401 && error.status !== 404) showToast(error.message);
  }
}

start();
