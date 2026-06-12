import { renderMarkdown, escapeHtml, IMAGE_EXT, feedEntryHtml, trackerHtml, rollHtml } from "/render.mjs";
import {
  createNotesSaveCoordinator,
  selectInitialSession,
} from "/notes-save.mjs";

const state = {
  campaigns: [],
  sessions: [],
  session: null,
  selectedScene: null,
  notesDirty: false,
  notesSaving: false,
  notesSaveError: null,
  documents: [],
  currentLinks: [],
  lastSavedAt: null,
  connectedPlayers: [],
  dmStream: null,
  chatRendered: new Set(),
  revealedItems: [],
  trackers: [],
  initEditing: new Set(),
  dmStreamConnecting: false,
  dmStreamReconnect: null,
  dmCsrfToken: null,
};

const elements = {
  campaignSelect: document.querySelector("#campaign-select"),
  sessionSelect: document.querySelector("#session-select"),
  campaignName: document.querySelector("#campaign-name"),
  sessionName: document.querySelector("#session-name"),
  sceneNav: document.querySelector("#scene-nav"),
  content: document.querySelector("#content"),
  overviewButton: document.querySelector("#overview-button"),
  sceneCounter: document.querySelector("#scene-counter"),
  referenceList: document.querySelector("#reference-list"),
  referenceView: document.querySelector("#reference-view"),
  closeReference: document.querySelector("#close-reference"),
  notes: document.querySelector("#notes"),
  notesPreview: document.querySelector("#notes-preview"),
  notesWorkspace: document.querySelector("#notes-workspace"),
  notesViewToggle: document.querySelector(".notes-view-toggle"),
  saveNotes: document.querySelector("#save-notes"),
  saveState: document.querySelector("#save-state"),
  referenceSearch: document.querySelector("#reference-search"),
  notesHint: document.querySelector("#notes-hint"),
  validateButton: document.querySelector("#validate-button"),
  validateModal: document.querySelector("#validate-modal"),
  validateClose: document.querySelector("#validate-close"),
  validateBody: document.querySelector("#validate-body"),
  toast: document.querySelector("#toast"),
  pushCards: document.querySelector("#push-cards"),
  pushText: document.querySelector("#push-text"),
  pushTextButton: document.querySelector("#push-text-button"),
  clearScreen: document.querySelector("#clear-screen"),
  playerCount: document.querySelector("#player-count"),
  chatLogDm: document.querySelector("#chat-log-dm"),
  chatInputDm: document.querySelector("#chat-input-dm"),
  whisperTarget: document.querySelector("#whisper-target"),
  whisperText: document.querySelector("#whisper-text"),
  whisperSend: document.querySelector("#whisper-send"),
  revealedList: document.querySelector("#revealed-list"),
  revealedWrap: document.querySelector("#revealed-wrap"),
  revealedCount: document.querySelector("#revealed-count"),
  trackerList: document.querySelector("#tracker-list"),
  trackerForm: document.querySelector("#tracker-form"),
  trackerName: document.querySelector("#tracker-name"),
  trackerType: document.querySelector("#tracker-type"),
  trackerMax: document.querySelector("#tracker-max"),
  previewOpen: document.querySelector("#preview-open"),
  previewModal: document.querySelector("#preview-modal"),
  previewClose: document.querySelector("#preview-close"),
  previewBody: document.querySelector("#preview-body"),
  dmLogin: document.querySelector("#dm-login"),
  dmLoginForm: document.querySelector("#dm-login-form"),
  dmLoginPin: document.querySelector("#dm-login-pin"),
  dmLoginError: document.querySelector("#dm-login-error"),
  dmLogout: document.querySelector("#dm-logout"),
};

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (
    state.dmCsrfToken &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(
      String(options.method || "GET").toUpperCase(),
    )
  ) {
    headers["X-GM-Cockpit-CSRF"] = state.dmCsrfToken;
  }
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const notesSaver = createNotesSaveCoordinator({
  getSnapshot: () => {
    if (!state.session) return null;
    return {
      contextKey: `${state.session.campaign.id}:${state.session.number}`,
      campaign: state.session.campaign.id,
      session: state.session.number,
      notes: elements.notes.value,
    };
  },
  saveSnapshot: (operation) =>
    request("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(operation),
    }),
  onStateChange: (saveState) => {
    state.notesDirty = saveState.dirty;
    state.notesSaving = saveState.saving;
    state.notesSaveError = saveState.lastError;
    state.lastSavedAt = saveState.lastSavedAt;
    if (elements.saveNotes) elements.saveNotes.disabled = saveState.saving;
    if (elements.saveState) renderSaveState();
  },
});

function fileUrl(file) {
  const campaign = state.session?.campaign?.id || "";
  return `/api/file?campaign=${encodeURIComponent(campaign)}&file=${encodeURIComponent(file)}`;
}

const renderOpts = () => ({ fileUrl });

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setError(error) {
  console.error(error);
  elements.content.innerHTML = `<div class="error-card">${escapeHtml(error.message)}</div>`;
  showToast(error.message);
}

function option(value, label, selected = false) {
  return `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

const STORAGE = {
  campaign: "gm-cockpit:campaign",
  session: (campaignId) => `gm-cockpit:session:${campaignId}`,
};

function readStored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

async function loadCampaigns() {
  const { campaigns } = await request("/api/campaigns");
  state.campaigns = campaigns;
  if (!campaigns.length) throw new Error("No campaign folders with a Director's Guide were found.");

  const storedId = readStored(STORAGE.campaign);
  const selected = campaigns.find((campaign) => campaign.id === storedId) || campaigns[0];
  elements.campaignSelect.innerHTML = campaigns
    .map((campaign) => option(campaign.id, campaign.name, campaign.id === selected.id))
    .join("");
  await loadSessions(selected.id);
}

async function loadDocuments(campaignId) {
  try {
    const { documents } = await request(`/api/documents?campaign=${encodeURIComponent(campaignId)}`);
    state.documents = documents;
  } catch {
    state.documents = [];
  }
}

async function loadSessions(campaignId) {
  elements.content.innerHTML = '<div class="loading-card">Indexing sessions...</div>';
  const { sessions } = await request(`/api/sessions?campaign=${encodeURIComponent(campaignId)}`);
  state.sessions = sessions;
  if (!sessions.length) throw new Error("No session headings were found in this Director's Guide.");

  await loadDocuments(campaignId);

  const pilot = selectInitialSession(
    sessions,
    readStored(STORAGE.session(campaignId)),
  );
  elements.sessionSelect.innerHTML = sessions
    .map((session) => option(session.number, `${session.number} · ${session.title}`, session.number === pilot.number))
    .join("");
  await loadSession(campaignId, pilot.number);
}

async function loadSession(campaignId, sessionNumber) {
  elements.content.innerHTML = '<div class="loading-card">Loading the run sheet...</div>';
  const session = await request(
    `/api/session?campaign=${encodeURIComponent(campaignId)}&number=${encodeURIComponent(sessionNumber)}`,
  );
  state.session = session;
  state.selectedScene = null;
  elements.notes.value = session.notes;
  notesSaver.reset(`${session.campaign.id}:${session.number}`);
  updateNotesPreview();
  elements.campaignName.textContent = session.campaign.name;
  elements.sessionName.textContent = `Session ${session.number} · ${session.title}`;
  if (elements.notesHint) {
    elements.notesHint.textContent = `⌘/Ctrl+S saves into the protected Session ${session.number} notes block.`;
  }
  if (elements.referenceSearch) elements.referenceSearch.value = "";
  renderSaveState();
  renderNavigation();
  renderOverview();
  writeStored(STORAGE.campaign, campaignId);
  writeStored(STORAGE.session(campaignId), String(session.number));
  refreshValidationBadge(campaignId);
  loadPushCards(campaignId);
}

function renderNavigation() {
  const overviewButton = `
        <button class="scene-button overview-nav" type="button" data-overview="true">
          <span class="scene-number">★</span>
          <span class="scene-title">Session Brief</span>
        </button>`;
  elements.sceneNav.innerHTML = overviewButton + state.session.scenes
    .map(
      (scene) => `
        <button class="scene-button" type="button" data-scene-id="${escapeHtml(scene.id)}">
          <span class="scene-number">${escapeHtml(scene.id)}</span>
          <span class="scene-title">${escapeHtml(scene.title)}</span>
        </button>`,
    )
    .join("");
}

function renderOverview() {
  state.selectedScene = null;
  elements.overviewButton.classList.add("active");
  document.querySelectorAll(".scene-button").forEach((button) => button.classList.remove("active"));
  elements.sceneNav.querySelector("[data-overview]")?.classList.add("active");
  elements.sceneCounter.textContent = `${state.session.scenes.length} scenes`;
  elements.content.innerHTML = renderMarkdown(state.session.overview, renderOpts());
  renderReferences(state.session.links);
  closeReference();
  elements.content.closest(".main-panel").scrollTop = 0;
}

function renderScene(sceneId) {
  const scene = state.session.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  state.selectedScene = scene;
  elements.overviewButton.classList.remove("active");
  document.querySelectorAll(".scene-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.sceneId === sceneId);
  });
  const sceneIndex = state.session.scenes.findIndex((item) => item.id === sceneId);
  elements.sceneCounter.textContent = `Scene ${sceneIndex + 1} of ${state.session.scenes.length}`;
  elements.content.innerHTML = renderMarkdown(scene.markdown, renderOpts());
  renderReferences(scene.links);
  closeReference();
  elements.content.closest(".main-panel").scrollTop = 0;
}

function renderReferences(links) {
  state.currentLinks = links;
  if (elements.referenceSearch && elements.referenceSearch.value.trim()) {
    renderSearchResults(elements.referenceSearch.value);
    return;
  }
  const visible = links.filter((link) => !link.embed);
  renderReferenceCards(
    visible.map((link) => ({
      file: link.file,
      heading: link.heading,
      label: link.label,
      sub: `${link.file}${link.heading ? ` · ${link.heading}` : ""}`,
    })),
    "No linked reference files in this view.",
  );
}

function renderReferenceCards(entries, emptyText) {
  elements.referenceList.innerHTML = entries.length
    ? entries
        .map(
          (entry) => `
            <button class="reference-card" type="button" data-wiki-file="${escapeHtml(entry.file)}" data-wiki-heading="${escapeHtml(entry.heading || "")}">
              <strong>${escapeHtml(entry.label)}</strong>
              <span>${escapeHtml(entry.sub)}</span>
            </button>`,
        )
        .join("")
    : `<p class="empty-state">${escapeHtml(emptyText)}</p>`;
}

function renderSearchResults(query) {
  const needle = query.trim().toLowerCase();
  const matches = state.documents
    .filter((doc) => doc.file.toLowerCase().includes(needle) || doc.name.toLowerCase().includes(needle))
    .slice(0, 40)
    .map((doc) => ({ file: doc.file, heading: "", label: doc.name, sub: doc.file }));
  renderReferenceCards(matches, "No files match that search.");
}

function showReferenceView() {
  elements.referenceView.classList.remove("hidden");
  elements.referenceList.classList.add("hidden");
  elements.closeReference.classList.remove("hidden");
  elements.referenceView.closest(".rail-section").scrollTop = 0;
}

async function openReference(file, heading = "") {
  if (IMAGE_EXT.test(file)) {
    elements.referenceView.innerHTML = `
      <div class="image-preview">
        <img class="embed-image" src="${escapeHtml(fileUrl(file))}" alt="${escapeHtml(file)}">
        <button class="push-to-players" type="button" data-push-image="${escapeHtml(file)}">Push to players</button>
      </div>`;
    showReferenceView();
    paintPushImageActiveState();
    return;
  }
  if (/\.pdf$/i.test(file)) {
    elements.referenceView.innerHTML = `<p><a class="wiki-link" href="${escapeHtml(fileUrl(file))}" target="_blank" rel="noreferrer">Open ${escapeHtml(file)} ↗</a></p>`;
    showReferenceView();
    return;
  }
  try {
    const params = new URLSearchParams({
      campaign: state.session.campaign.id,
      file,
      heading,
    });
    const documentData = await request(`/api/document?${params}`);
    elements.referenceView.innerHTML = renderMarkdown(documentData.markdown, renderOpts());
    showReferenceView();
  } catch (error) {
    showToast(error.message);
  }
}

function closeReference() {
  elements.referenceView.classList.add("hidden");
  elements.referenceList.classList.remove("hidden");
  elements.closeReference.classList.add("hidden");
}

function updateNotesPreview() {
  const markdown = elements.notes.value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(\s*#{1,6})(?=\S)/, "$1 ")
        .replace(/^(\s*[-+*])(?=\S)/, "$1 "),
    )
    .join("\n")
    .trim();
  elements.notesPreview.innerHTML = markdown
    ? renderMarkdown(markdown, { ...renderOpts(), preserveLineBreaks: true })
    : '<p class="empty-state">Your formatted notes will appear here as you type.</p>';
}

function setNotesView(view) {
  if (!["write", "split", "preview"].includes(view)) return;
  elements.notesWorkspace.dataset.view = view;
  elements.notesViewToggle.querySelectorAll("[data-notes-view]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.notesView === view));
  });
  if (view === "write") elements.notes.focus();
  if (view === "preview") updateNotesPreview();
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function renderSaveState() {
  if (state.notesSaving) {
    elements.saveState.textContent = "Saving...";
    return;
  }
  if (state.notesSaveError) {
    elements.saveState.textContent = "Save failed - retrying";
    return;
  }
  if (state.notesDirty) {
    elements.saveState.textContent = "Unsaved changes";
    return;
  }
  if (state.lastSavedAt) {
    elements.saveState.textContent = `Saved ${relativeTime(state.lastSavedAt)}`;
    return;
  }
  elements.saveState.textContent = "Synced";
}

async function saveNotes({ silent = false } = {}) {
  if (!state.session || (silent && !notesSaver.isDirty())) return;
  const savedBefore = notesSaver.getState().savedRevision;
  await notesSaver.save();
  const saveState = notesSaver.getState();
  if (saveState.lastError) {
    if (!silent) showToast(saveState.lastError.message);
    return;
  }
  if (!silent && saveState.savedRevision > savedBefore) {
    showToast("Workbook saved");
  }
}

function navigateScene(direction) {
  if (!state.session) return;
  const order = [null, ...state.session.scenes.map((scene) => scene.id)];
  const currentId = state.selectedScene ? state.selectedScene.id : null;
  const nextIndex = Math.min(
    order.length - 1,
    Math.max(0, order.indexOf(currentId) + direction),
  );
  const target = order[nextIndex];
  if (target === null) renderOverview();
  else renderScene(target);
}

function confirmDiscard() {
  if (!state.notesDirty) return true;
  return window.confirm("You have unsaved notes. Discard them and switch?");
}

function reportStatus(report) {
  if (!report.ok) return "error";
  return report.warnings.length ? "warn" : "ok";
}

function renderValidateReport({ reports, skipped }) {
  if (!reports.length) {
    elements.validateBody.innerHTML =
      "<p class=\"empty-state\">No campaigns found. A campaign is any folder containing a Director's Guide.md.</p>";
    return;
  }
  const blocks = reports
    .map((report) => {
      const status = reportStatus(report);
      const label = status === "ok" ? "Ready" : status === "warn" ? "Check" : "Blocked";
      const s = report.stats || {};
      const stats =
        s.sessions != null
          ? `${s.sessions} sessions · ${s.scenes} scenes · ${s.links} links${s.missingLinks ? ` · ${s.missingLinks} broken` : ""}`
          : "";
      const lines = [
        ...report.errors.map((item) => ["error", "✗", item.message]),
        ...report.warnings.map((item) => ["warn", "⚠", item.message]),
        ...report.info.map((item) => ["info", "·", item.message]),
      ];
      return `
        <div class="v-campaign">
          <div class="v-campaign-head">
            <strong>${escapeHtml(report.name)}</strong>
            <span class="v-status ${status}">${label}</span>
          </div>
          ${stats ? `<div class="v-stats">${escapeHtml(stats)}</div>` : ""}
          ${lines
            .map(
              ([kind, mark, text]) =>
                `<div class="v-line ${kind}"><span class="mark">${mark}</span><span>${escapeHtml(text)}</span></div>`,
            )
            .join("")}
        </div>`;
    })
    .join("");
  const skippedBlock = skipped.length
    ? `<div class="v-skipped">Skipped (no Director's Guide.md): ${skipped.map(escapeHtml).join(", ")}</div>`
    : "";
  elements.validateBody.innerHTML = blocks + skippedBlock;
}

async function openValidate() {
  elements.validateModal.classList.remove("hidden");
  elements.validateBody.innerHTML = '<div class="loading-card">Checking documents...</div>';
  try {
    renderValidateReport(await request("/api/validate"));
  } catch (error) {
    elements.validateBody.innerHTML = `<div class="error-card">${escapeHtml(error.message)}</div>`;
  }
}

function closeValidate() {
  elements.validateModal.classList.add("hidden");
}

async function refreshValidationBadge(campaignId) {
  if (!elements.validateButton) return;
  try {
    const { reports } = await request(`/api/validate?campaign=${encodeURIComponent(campaignId)}`);
    const report = reports[0];
    const count = report.errors.length + report.warnings.length;
    const status = reportStatus(report);
    const badge = count > 0 ? `<span class="badge ${status}">${count}</span>` : '<span class="badge ok">✓</span>';
    elements.validateButton.innerHTML = `Check documents ${badge}`;
  } catch {
    elements.validateButton.textContent = "Check documents";
  }
}

elements.campaignSelect.addEventListener("change", () => {
  if (!confirmDiscard()) {
    elements.campaignSelect.value = state.session?.campaign?.id ?? elements.campaignSelect.value;
    return;
  }
  loadSessions(elements.campaignSelect.value).catch(setError);
});

elements.sessionSelect.addEventListener("change", () => {
  if (!confirmDiscard()) {
    elements.sessionSelect.value = String(state.session?.number ?? elements.sessionSelect.value);
    return;
  }
  loadSession(elements.campaignSelect.value, Number(elements.sessionSelect.value)).catch(setError);
});

elements.sceneNav.addEventListener("click", (event) => {
  if (event.target.closest("[data-overview]")) {
    renderOverview();
    return;
  }
  const button = event.target.closest("[data-scene-id]");
  if (button) renderScene(button.dataset.sceneId);
});

elements.overviewButton.addEventListener("click", renderOverview);
elements.closeReference.addEventListener("click", closeReference);
elements.saveNotes.addEventListener("click", () => saveNotes());
elements.notesViewToggle.addEventListener("click", (event) => {
  const button = event.target.closest("[data-notes-view]");
  if (button) setNotesView(button.dataset.notesView);
});

elements.referenceSearch?.addEventListener("input", () => {
  const value = elements.referenceSearch.value.trim();
  if (value) {
    closeReference();
    renderSearchResults(value);
  } else {
    renderReferences(state.currentLinks);
  }
});

elements.validateButton?.addEventListener("click", openValidate);
elements.validateClose?.addEventListener("click", closeValidate);
elements.validateModal?.addEventListener("click", (event) => {
  if (event.target === elements.validateModal) closeValidate();
});

document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-wiki-file]");
  if (link && !link.dataset.sceneId) {
    event.preventDefault();
    openReference(link.dataset.wikiFile, link.dataset.wikiHeading);
    return;
  }
  const pushImage = event.target.closest("[data-push-image]");
  if (pushImage && state.session) {
    event.preventDefault();
    const campaignId = state.session.campaign.id;
    const file = pushImage.dataset.pushImage;
    const existing = findRevealedImage(campaignId, file);
    const action = existing
      ? postJson("/api/reveal/remove", { id: existing.id }).then(() => `Retracted ${file}`)
      : postJson("/api/reveal/image", { campaign: campaignId, file }).then(() => `Pushed ${file}`);
    action.then(showToast).catch((error) => showToast(error.message));
  }
});

elements.notes.addEventListener("input", () => {
  notesSaver.markChanged();
  updateNotesPreview();
});

elements.notes.addEventListener("blur", () => {
  saveNotes({ silent: true });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && elements.validateModal && !elements.validateModal.classList.contains("hidden")) {
    closeValidate();
    return;
  }
  if (event.key === "Escape" && elements.previewModal && !elements.previewModal.classList.contains("hidden")) {
    closePreview();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveNotes();
    return;
  }
  const tag = event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "ArrowRight" || event.key === "]") {
    navigateScene(1);
  } else if (event.key === "ArrowLeft" || event.key === "[") {
    navigateScene(-1);
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.notesDirty) return;
  event.preventDefault();
  event.returnValue = "";
});

setInterval(() => {
  if (state.notesDirty) saveNotes({ silent: true });
}, 45000);

setInterval(renderSaveState, 15000);

function findRevealedCard(campaignId, cardId) {
  return state.revealedItems.find(
    (item) => item.type === "card" && item.campaign === campaignId && item.cardId === cardId,
  );
}

function findRevealedImage(campaignId, file) {
  return state.revealedItems.find(
    (item) => item.type === "image" && item.campaign === campaignId && item.file === file,
  );
}

function paintPushCardActiveStates() {
  if (!elements.pushCards) return;
  const campaignId = state.session?.campaign?.id;
  if (!campaignId) return;
  elements.pushCards.querySelectorAll("[data-card-id]").forEach((button) => {
    const active = Boolean(findRevealedCard(campaignId, button.dataset.cardId));
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function paintPushImageActiveState() {
  const button = elements.referenceView?.querySelector("[data-push-image]");
  if (!button) return;
  const campaignId = state.session?.campaign?.id;
  const active = Boolean(campaignId && findRevealedImage(campaignId, button.dataset.pushImage));
  button.classList.toggle("active", active);
  button.textContent = active ? "Remove from players" : "Push to players";
}

async function loadPushCards(campaignId) {
  if (!elements.pushCards) return;
  try {
    const { cards } = await request(`/api/player-guide?campaign=${encodeURIComponent(campaignId)}`);
    elements.pushCards.innerHTML = cards.length
      ? cards
          .map(
            (card) =>
              `<button class="push-card" type="button" data-card-id="${escapeHtml(card.id)}" aria-pressed="false">${escapeHtml(card.title)}</button>`,
          )
          .join("")
      : '<p class="empty-state">Player\'s Guide has no ## cards.</p>';
  } catch {
    elements.pushCards.innerHTML = '<p class="empty-state">No Player\'s Guide.md in this campaign.</p>';
  }
  paintPushCardActiveStates();
}

function postJson(url, body) {
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function appendDmMessage(message) {
  if (!message || !elements.chatLogDm || state.chatRendered.has(message.id)) return;
  state.chatRendered.add(message.id);
  const isWhisper = message.scope === "whisper";
  const isSecret = message.scope === "secret";
  const isRoll = message.type === "roll";
  let label;
  if (isSecret) label = "Secret roll";
  else if (isWhisper && message.from === "DM") label = `Whisper → ${escapeHtml(message.to || "")}`;
  else if (isWhisper) label = `${escapeHtml(message.from || "Anon")} → you (whisper)`;
  else label = escapeHtml(message.from || "Anon");
  const body = isRoll ? rollHtml(message.roll) : escapeHtml(message.text || "");
  const node = document.createElement("div");
  node.className = `chat-msg${isWhisper ? " whisper" : ""}${isSecret ? " secret" : ""}${isRoll ? " roll" : ""}`;
  node.innerHTML = `<span class="chat-from">${label}</span><span class="chat-text">${body}</span>`;
  elements.chatLogDm.appendChild(node);
  elements.chatLogDm.scrollTop = elements.chatLogDm.scrollHeight;
}

function updatePlayers(players) {
  state.connectedPlayers = players || [];
  const nameCounts = state.connectedPlayers.reduce((counts, player) => {
    counts.set(
      player.displayName,
      (counts.get(player.displayName) || 0) + 1,
    );
    return counts;
  }, new Map());
  if (elements.playerCount) {
    elements.playerCount.textContent = `${state.connectedPlayers.length} connected`;
  }
  if (elements.whisperTarget) {
    const current = elements.whisperTarget.value;
    elements.whisperTarget.innerHTML = state.connectedPlayers.length
      ? state.connectedPlayers
          .map((player) =>
            option(
              player.playerId,
              nameCounts.get(player.displayName) > 1
                ? `${player.displayName} · ${player.playerId.slice(0, 6)}`
                : player.displayName,
              player.playerId === current,
            ),
          )
          .join("")
      : '<option value="">No players connected</option>';
  }
}

function scheduleDmReconnect() {
  clearTimeout(state.dmStreamReconnect);
  state.dmStreamReconnect = setTimeout(() => {
    connectDmStream();
  }, 1000);
}

async function connectDmStream() {
  if (state.dmStreamConnecting) return;
  state.dmStreamConnecting = true;
  if (state.dmStream) state.dmStream.close();
  try {
    const { ticket } = await postJson("/api/dm/stream-ticket", {});
    const es = new EventSource(
      `/api/stream?role=dm&ticket=${encodeURIComponent(ticket)}`,
    );
    state.dmStream = es;
    es.addEventListener("chat", (event) => appendDmMessage(JSON.parse(event.data)));
    es.addEventListener("whisper", (event) => appendDmMessage(JSON.parse(event.data)));
    es.addEventListener("presence", (event) => updatePlayers(JSON.parse(event.data).players));
    es.addEventListener("reveal-set", (event) => renderRevealed(JSON.parse(event.data).items || []));
    es.addEventListener("status-set", (event) => renderTrackers(JSON.parse(event.data).trackers || []));
    es.onerror = () => {
      if (state.dmStream !== es) return;
      es.close();
      state.dmStream = null;
      scheduleDmReconnect();
    };
  } catch (error) {
    if (error.status === 401) {
      showDmLogin();
    } else {
      showToast(error.message);
      scheduleDmReconnect();
    }
  } finally {
    state.dmStreamConnecting = false;
  }
}

function trackerMeterColor(ratio) {
  return `hsl(${(Math.round(96 - 111 * ratio) + 360) % 360} 100% 60%)`;
}

function trackerRowHtml(t) {
  const visLabel = t.hidden ? "Hidden from players — click to show" : "Visible to players — click to hide";
  const visButtons = `<button class="tracker-btn" type="button" data-tracker-vis title="${visLabel}" aria-label="${visLabel}">${t.hidden ? "🚫" : "👁"}</button>
            <button class="tracker-btn tracker-x" type="button" data-tracker-remove aria-label="Delete ${escapeHtml(t.name)}">×</button>`;
  if (t.type === "initiative") {
    const entries = t.entries || [];
    const count = entries.length ? `${t.turn + 1}/${entries.length}` : "—";
    const editing = state.initEditing.has(t.id);
    const editor = editing
      ? `<div class="tracker-edit">
            <textarea data-init-entries placeholder="One combatant per line, in turn order">${escapeHtml(entries.join("\n"))}</textarea>
            <span class="tracker-edit-hint">One name per line, top goes first.</span>
            <button type="button" data-init-save>Save order</button>
          </div>`
      : "";
    return `<div class="tracker-row${t.hidden ? " is-hidden" : ""}" data-tracker-id="${t.id}">
            <span class="tracker-kind" title="Initiative">⚔</span>
            <span class="tracker-row-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}${entries.length && !t.hidden ? ` — ${escapeHtml(entries[t.turn] || "")}` : ""}</span>
            <span class="tracker-row-value" style="color:var(--amber)">${count}</span>
            <button class="tracker-btn" type="button" data-tracker-turn="-1" aria-label="Previous turn">◀</button>
            <button class="tracker-btn" type="button" data-tracker-turn="1" aria-label="Next turn">▶</button>
            <button class="tracker-btn" type="button" data-tracker-edit title="Edit combatants" aria-label="Edit combatants">✎</button>
            ${visButtons}
            ${editor}
          </div>`;
  }
  const ratio = t.max ? t.value / t.max : 0;
  const color = t.type === "meter" ? trackerMeterColor(ratio) : "var(--amber)";
  const icon = t.type === "meter" ? "▮" : "◔";
  return `<div class="tracker-row${t.hidden ? " is-hidden" : ""}" data-tracker-id="${t.id}">
            <span class="tracker-kind" title="${t.type === "meter" ? "Meter" : "Clock"}">${icon}</span>
            <span class="tracker-row-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
            <span class="tracker-row-value" style="color:${color}">${t.value}/${t.max}</span>
            <button class="tracker-btn" type="button" data-tracker-step="-1" aria-label="Decrease ${escapeHtml(t.name)}">−</button>
            <button class="tracker-btn" type="button" data-tracker-step="1" aria-label="Increase ${escapeHtml(t.name)}">+</button>
            ${visButtons}
          </div>`;
}

function renderTrackers(trackers) {
  state.trackers = trackers;
  if (!elements.trackerList) return;
  const drafts = new Map();
  elements.trackerList.querySelectorAll("[data-tracker-id]").forEach((row) => {
    const textarea = row.querySelector("[data-init-entries]");
    if (textarea) drafts.set(Number(row.dataset.trackerId), textarea.value);
  });
  elements.trackerList.innerHTML = trackers.length
    ? trackers.map(trackerRowHtml).join("")
    : '<p class="empty-state">No trackers yet.</p>';
  for (const [id, draft] of drafts) {
    const textarea = elements.trackerList.querySelector(`[data-tracker-id="${id}"] [data-init-entries]`);
    if (textarea) textarea.value = draft;
  }
  renderPreview();
}

async function syncTrackers() {
  try {
    const { status } = await request("/api/status");
    renderTrackers(status?.trackers || []);
  } catch {
    /* ignore */
  }
}

function renderRevealed(items) {
  state.revealedItems = items;
  if (elements.revealedWrap) {
    elements.revealedWrap.classList.toggle("hidden", items.length === 0);
  }
  if (elements.revealedCount) {
    elements.revealedCount.textContent = String(items.length);
  }
  if (elements.revealedList) {
    elements.revealedList.innerHTML = items
      .map((item) => {
        const icon = item.type === "image" ? "🖼" : item.type === "text" ? "✎" : "✦";
        const kind = item.type === "image" ? "Image" : item.type === "text" ? "Note" : "Card";
        return `<div class="revealed-chip" data-item-id="${item.id}"><span class="revealed-icon" title="${kind}">${icon}</span><span class="revealed-title" title="${escapeHtml(item.title || "Untitled")}">${escapeHtml(item.title || "Untitled")}</span><button class="revealed-x" type="button" data-retract="${item.id}" aria-label="Retract ${escapeHtml(item.title || "item")}">×</button></div>`;
      })
      .join("");
  }
  paintPushCardActiveStates();
  paintPushImageActiveState();
  renderPreview();
}

function renderPreview() {
  if (!elements.previewBody || !elements.previewModal || elements.previewModal.classList.contains("hidden")) {
    return;
  }
  const items = state.revealedItems || [];
  const trackers = (state.trackers || []).filter((t) => !t.hidden);
  const feed = items.length
    ? items.map((item) => feedEntryHtml(item, { imageUrl: (i) => `/api/player/image?id=${i.id}` })).join("")
    : '<div class="status-empty">Waiting for the DM to share something…</div>';
  const status = trackers.length
    ? trackers.map(trackerHtml).join("")
    : '<div class="status-empty">Nothing tracked right now.</div>';
  elements.previewBody.innerHTML = `
    <div class="preview-section"><span class="eyebrow">Shared tab</span><div class="preview-feed">${feed}</div></div>
    <div class="preview-section"><span class="eyebrow">Status tab</span><div class="status-list">${status}</div></div>`;
}

function openPreview() {
  elements.previewModal?.classList.remove("hidden");
  renderPreview();
}

function closePreview() {
  elements.previewModal?.classList.add("hidden");
}

elements.previewOpen?.addEventListener("click", openPreview);
elements.previewClose?.addEventListener("click", closePreview);
elements.previewModal?.addEventListener("click", (event) => {
  if (event.target === elements.previewModal) closePreview();
});

elements.revealedList?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-retract]");
  if (!button) return;
  const id = Number(button.dataset.retract);
  try {
    await postJson("/api/reveal/remove", { id });
  } catch (error) {
    showToast(error.message);
  }
});

elements.trackerList?.addEventListener("click", async (event) => {
  const row = event.target.closest("[data-tracker-id]");
  if (!row) return;
  const id = Number(row.dataset.trackerId);
  const tracker = state.trackers.find((t) => t.id === id);
  if (!tracker) return;
  try {
    const step = event.target.closest("[data-tracker-step]");
    const turn = event.target.closest("[data-tracker-turn]");
    if (step) {
      await postJson("/api/status/upsert", { id, value: tracker.value + Number(step.dataset.trackerStep) });
    } else if (turn) {
      await postJson("/api/status/upsert", { id, turn: (tracker.turn || 0) + Number(turn.dataset.trackerTurn) });
    } else if (event.target.closest("[data-tracker-edit]")) {
      if (state.initEditing.has(id)) state.initEditing.delete(id);
      else state.initEditing.add(id);
      renderTrackers(state.trackers);
    } else if (event.target.closest("[data-init-save]")) {
      const textarea = row.querySelector("[data-init-entries]");
      const entries = (textarea?.value || "").split("\n").map((line) => line.trim()).filter(Boolean);
      state.initEditing.delete(id);
      await postJson("/api/status/upsert", { id, entries });
    } else if (event.target.closest("[data-tracker-vis]")) {
      await postJson("/api/status/upsert", { id, hidden: !tracker.hidden });
    } else if (event.target.closest("[data-tracker-remove]")) {
      state.initEditing.delete(id);
      await postJson("/api/status/remove", { id });
    }
  } catch (error) {
    showToast(error.message);
  }
});

elements.trackerForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = elements.trackerName.value.trim();
  if (!name) return;
  try {
    const type = elements.trackerType.value;
    const { tracker } = await postJson("/api/status/upsert", {
      name,
      type,
      max: type === "initiative" ? undefined : Number(elements.trackerMax.value) || undefined,
    });
    if (type === "initiative" && tracker) state.initEditing.add(tracker.id);
    elements.trackerName.value = "";
  } catch (error) {
    showToast(error.message);
  }
});

async function syncDmChat() {
  try {
    const { presentation, chat } = await request("/api/dm/state");
    state.chatRendered.clear();
    if (elements.chatLogDm) elements.chatLogDm.innerHTML = "";
    chat.forEach(appendDmMessage);
    renderRevealed(presentation?.items || []);
  } catch {
    /* ignore */
  }
}

elements.pushCards?.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-card-id]");
  if (!button || !state.session) return;
  const campaignId = state.session.campaign.id;
  const cardId = button.dataset.cardId;
  const existing = findRevealedCard(campaignId, cardId);
  try {
    if (existing) {
      await postJson("/api/reveal/remove", { id: existing.id });
      showToast(`Retracted: ${button.textContent}`);
    } else {
      await postJson("/api/reveal/card", { campaign: campaignId, cardId });
      showToast(`Pushed: ${button.textContent}`);
    }
  } catch (error) {
    showToast(error.message);
  }
});

elements.pushTextButton?.addEventListener("click", async () => {
  const text = elements.pushText.value;
  if (!text.trim()) return;
  try {
    await postJson("/api/reveal/text", { text });
    showToast("Note pushed");
  } catch (error) {
    showToast(error.message);
  }
});

elements.clearScreen?.addEventListener("click", async () => {
  try {
    await postJson("/api/reveal/clear", {});
    showToast("Player screen cleared");
  } catch (error) {
    showToast(error.message);
  }
});

elements.chatInputDm?.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  const text = elements.chatInputDm.value;
  if (!text.trim()) return;
  elements.chatInputDm.value = "";
  try {
    await postJson("/api/chat", { from: "DM", text });
  } catch (error) {
    showToast(error.message);
  }
});

elements.whisperSend?.addEventListener("click", async () => {
  const toPlayerId = elements.whisperTarget?.value || "";
  const text = elements.whisperText?.value || "";
  if (!toPlayerId || !text.trim()) {
    showToast("Pick a player and type a whisper");
    return;
  }
  try {
    await postJson("/api/whisper", { toPlayerId, text });
    elements.whisperText.value = "";
  } catch (error) {
    showToast(error.message);
  }
});

let dmLoginResolve = null;

function showDmLogin() {
  elements.dmLogin?.classList.remove("hidden");
  elements.dmLoginPin?.focus();
}

function hideDmLogin() {
  elements.dmLogin?.classList.add("hidden");
  if (elements.dmLoginError) elements.dmLoginError.textContent = "";
  if (elements.dmLoginPin) elements.dmLoginPin.value = "";
}

async function ensureDmSession() {
  try {
    const session = await request("/api/dm/session");
    state.dmCsrfToken = session.csrfToken;
    hideDmLogin();
  } catch (error) {
    if (error.status !== 401) throw error;
    showDmLogin();
    await new Promise((resolve) => {
      dmLoginResolve = resolve;
    });
  }
}

elements.dmLoginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = elements.dmLoginPin?.value || "";
  if (!pin) return;
  if (elements.dmLoginError) elements.dmLoginError.textContent = "";
  try {
    const session = await postJson("/api/dm/login", { pin });
    state.dmCsrfToken = session.csrfToken;
    hideDmLogin();
    const resolveLogin = dmLoginResolve;
    dmLoginResolve = null;
    if (resolveLogin) resolveLogin();
    else window.location.reload();
  } catch (error) {
    if (elements.dmLoginError) elements.dmLoginError.textContent = error.message;
    elements.dmLoginPin?.select();
  }
});

elements.dmLogout?.addEventListener("click", async () => {
  try {
    await postJson("/api/dm/logout", {});
  } finally {
    window.location.reload();
  }
});

const LAYOUT_STORAGE = "gm-cockpit:layout";
const LAYOUT_LIMITS = {
  sidebar: { min: 180, max: 520 },
  rail: { min: 240, max: 640 },
};

function loadLayout() {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_STORAGE) || "{}") || {};
  } catch {
    return {};
  }
}

function saveLayout(layout) {
  try { localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(layout)); } catch {}
}

function applyLayout(layout) {
  const shell = document.querySelector(".app-shell");
  const rail = document.querySelector(".right-rail");
  if (!shell || !rail) return;
  if (layout.sidebar) shell.style.setProperty("--col-sidebar", `${layout.sidebar}px`);
  if (layout.rail) shell.style.setProperty("--col-rail", `${layout.rail}px`);
  if (layout.notesFraction) {
    const f = Math.max(0.18, Math.min(0.82, layout.notesFraction));
    rail.style.setProperty("--row-notes", `${f}fr`);
    rail.style.setProperty("--row-player", `${1 - f}fr`);
  }
}

function initResizers() {
  const shell = document.querySelector(".app-shell");
  const rail = document.querySelector(".right-rail");
  if (!shell) return;
  const layout = loadLayout();
  applyLayout(layout);

  const clamp = (value, { min, max }) => Math.max(min, Math.min(max, value));

  const startColumnDrag = (kind, event) => {
    event.preventDefault();
    const startX = event.clientX;
    const shellRect = shell.getBoundingClientRect();
    const startValue = parseFloat(
      getComputedStyle(shell).getPropertyValue(kind === "sidebar" ? "--col-sidebar" : "--col-rail"),
    ) || (kind === "sidebar" ? 310 : 340);
    document.body.classList.add("resizing");
    event.target.classList.add("dragging");
    const onMove = (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const raw = kind === "sidebar" ? startValue + delta : startValue - delta;
      const next = clamp(raw, LAYOUT_LIMITS[kind]);
      // also keep main panel >= 320
      const otherKey = kind === "sidebar" ? "rail" : "sidebar";
      const other = parseFloat(getComputedStyle(shell).getPropertyValue(`--col-${otherKey}`)) || 310;
      const reserved = 12; // two 6px handle tracks
      const minMain = 320;
      const available = shellRect.width - reserved - other;
      const capped = Math.min(next, available - minMain);
      if (capped < LAYOUT_LIMITS[kind].min) return;
      shell.style.setProperty(kind === "sidebar" ? "--col-sidebar" : "--col-rail", `${capped}px`);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing");
      document.querySelectorAll(".col-resizer, .row-resizer").forEach((r) => r.classList.remove("dragging"));
      const stored = loadLayout();
      stored.sidebar = parseFloat(getComputedStyle(shell).getPropertyValue("--col-sidebar"));
      stored.rail = parseFloat(getComputedStyle(shell).getPropertyValue("--col-rail"));
      saveLayout(stored);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  const startRowDrag = (event) => {
    if (!rail) return;
    event.preventDefault();
    const startY = event.clientY;
    const railRect = rail.getBoundingClientRect();
    const handleHeight = 6;
    const availableHeight = railRect.height - handleHeight;
    const startNotesPx = event.target.getBoundingClientRect().top - railRect.top;
    document.body.classList.add("resizing-row");
    event.target.classList.add("dragging");
    const onMove = (moveEvent) => {
      const delta = moveEvent.clientY - startY;
      const notesPx = Math.max(140, Math.min(availableHeight - 180, startNotesPx + delta));
      const fraction = notesPx / availableHeight;
      rail.style.setProperty("--row-notes", `${fraction}fr`);
      rail.style.setProperty("--row-player", `${1 - fraction}fr`);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-row");
      document.querySelectorAll(".col-resizer, .row-resizer").forEach((r) => r.classList.remove("dragging"));
      const stored = loadLayout();
      const fStr = getComputedStyle(rail).getPropertyValue("--row-notes");
      stored.notesFraction = parseFloat(fStr) || 0.5;
      saveLayout(stored);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  document.querySelectorAll(".col-resizer").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => startColumnDrag(handle.dataset.resize, event));
    handle.addEventListener("dblclick", () => {
      const stored = loadLayout();
      delete stored[handle.dataset.resize];
      saveLayout(stored);
      shell.style.removeProperty(handle.dataset.resize === "sidebar" ? "--col-sidebar" : "--col-rail");
    });
  });

  document.querySelectorAll(".row-resizer").forEach((handle) => {
    handle.addEventListener("pointerdown", startRowDrag);
    handle.addEventListener("dblclick", () => {
      const stored = loadLayout();
      delete stored.notesFraction;
      saveLayout(stored);
      rail?.style.removeProperty("--row-notes");
      rail?.style.removeProperty("--row-player");
    });
  });
}

async function bootstrap() {
  initResizers();
  await ensureDmSession();
  await loadCampaigns();
  await syncDmChat();
  await syncTrackers();
  await connectDmStream();
}

bootstrap().catch(setError);
