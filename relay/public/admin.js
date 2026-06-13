const state = {
  csrfToken: null,
  account: null,
  devices: [],
  rooms: [],
};

const elements = {
  serviceState: document.querySelector("#service-state"),
  loginView: document.querySelector("#login-view"),
  loginForm: document.querySelector("#login-form"),
  loginError: document.querySelector("#login-error"),
  email: document.querySelector("#email"),
  passphrase: document.querySelector("#passphrase"),
  dashboard: document.querySelector("#dashboard"),
  accountEmail: document.querySelector("#account-email"),
  logout: document.querySelector("#logout"),
  refresh: document.querySelector("#refresh"),
  createPairing: document.querySelector("#create-pairing"),
  deviceList: document.querySelector("#device-list"),
  roomForm: document.querySelector("#room-form"),
  roomDevice: document.querySelector("#room-device"),
  roomName: document.querySelector("#room-name"),
  roomList: document.querySelector("#room-list"),
  secretCallout: document.querySelector("#one-time-secret"),
  secretTitle: document.querySelector("#secret-title"),
  secretValue: document.querySelector("#secret-value"),
  copySecret: document.querySelector("#copy-secret"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function request(pathname, { method = "GET", body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.csrfToken && method !== "GET") {
    headers["X-GM-Relay-CSRF"] = state.csrfToken;
  }
  const response = await fetch(pathname, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 3000);
}

function showSecret(title, value) {
  elements.secretTitle.textContent = title;
  elements.secretValue.textContent = value;
  elements.secretCallout.classList.remove("hidden");
}

function showLogin() {
  elements.loginView.classList.remove("hidden");
  elements.dashboard.classList.add("hidden");
  elements.logout.classList.add("hidden");
}

function showDashboard() {
  elements.loginView.classList.add("hidden");
  elements.dashboard.classList.remove("hidden");
  elements.logout.classList.remove("hidden");
}

function deviceHtml(device) {
  const status = device.revokedAt ? "Revoked" : "Paired";
  return `
    <article class="list-card">
      <div>
        <strong>${escapeHtml(device.name)}</strong>
        <span>${escapeHtml(device.id)}</span>
      </div>
      <div class="card-actions">
        <span class="badge ${device.revokedAt ? "danger" : "ok"}">${status}</span>
        ${
          device.revokedAt
            ? ""
            : `<button class="quiet danger-button" type="button" data-revoke-device="${escapeHtml(device.id)}">Revoke</button>`
        }
      </div>
    </article>`;
}

function membershipHtml(room, membership) {
  return `
    <div class="member-row">
      <span>${escapeHtml(membership.displayName)}</span>
      <button class="quiet danger-button" type="button"
        data-remove-member="${escapeHtml(membership.id)}"
        data-room-id="${escapeHtml(room.id)}">Remove</button>
    </div>`;
}

function roomHtml(room) {
  const active = room.status === "active";
  const invite = room.invites
    .filter((entry) => entry.revokedAt === null)
    .sort((left, right) => right.createdAt - left.createdAt)[0];
  return `
    <article class="panel room-card">
      <div class="room-heading">
        <div>
          <span class="eyebrow">${active ? "Active room" : "Ended room"}</span>
          <h3>${escapeHtml(room.name)}</h3>
        </div>
        <span class="badge ${room.agentConnected ? "ok" : "warn"}">
          ${room.agentConnected ? "Agent online" : "Agent offline"}
        </span>
      </div>
      <dl>
        <div><dt>Players online</dt><dd>${room.playerConnections}</dd></div>
        <div><dt>Joined members</dt><dd>${room.memberships.length}</dd></div>
        <div><dt>Invite uses</dt><dd>${invite ? `${invite.useCount}/${invite.maxUses}` : "None"}</dd></div>
      </dl>
      ${
        active
          ? `<div class="room-actions">
              <button class="quiet" type="button" data-toggle-joins="${escapeHtml(room.id)}" data-open="${String(!room.joinsOpen)}">
                ${room.joinsOpen ? "Close joins" : "Open joins"}
              </button>
              <button class="quiet" type="button" data-rotate-invite="${escapeHtml(room.id)}">Rotate invite</button>
              <button class="quiet danger-button" type="button" data-end-room="${escapeHtml(room.id)}">End room</button>
            </div>`
          : ""
      }
      <div class="members">
        <span class="eyebrow">Members</span>
        ${
          room.memberships.length
            ? room.memberships.map((membership) => membershipHtml(room, membership)).join("")
            : '<p class="muted">No active members.</p>'
        }
      </div>
    </article>`;
}

function render() {
  elements.accountEmail.textContent = state.account.email;
  elements.deviceList.innerHTML = state.devices.length
    ? state.devices.map(deviceHtml).join("")
    : '<p class="muted">No devices paired yet.</p>';
  const activeDevices = state.devices.filter((device) => !device.revokedAt);
  elements.roomDevice.innerHTML = activeDevices.length
    ? activeDevices
        .map(
          (device) =>
            `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}</option>`,
        )
        .join("")
    : '<option value="">Pair a device first</option>';
  elements.roomDevice.disabled = !activeDevices.length;
  elements.roomList.innerHTML = state.rooms.length
    ? state.rooms.map(roomHtml).join("")
    : '<div class="empty-state">No rooms yet. Pair a device and create your first table.</div>';
}

async function loadState() {
  const data = await request("/v1/admin/state");
  state.account = data.account;
  state.devices = data.devices;
  state.rooms = data.rooms;
  render();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.loginError.textContent = "";
  try {
    const data = await request("/v1/admin/login", {
      method: "POST",
      body: {
        email: elements.email.value,
        passphrase: elements.passphrase.value,
      },
    });
    state.csrfToken = data.csrfToken;
    state.account = data.account;
    elements.passphrase.value = "";
    showDashboard();
    await loadState();
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.logout.addEventListener("click", async () => {
  try {
    await request("/v1/admin/logout", { method: "POST", body: {} });
  } finally {
    state.csrfToken = null;
    state.account = null;
    showLogin();
  }
});

elements.refresh.addEventListener("click", () => {
  loadState().catch((error) => showToast(error.message));
});

elements.createPairing.addEventListener("click", async () => {
  try {
    const data = await request("/v1/admin/pairings", {
      method: "POST",
      body: {},
    });
    showSecret("Device pairing code", data.token);
  } catch (error) {
    showToast(error.message);
  }
});

elements.roomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await request("/v1/admin/rooms", {
      method: "POST",
      body: {
        deviceId: elements.roomDevice.value,
        name: elements.roomName.value,
      },
    });
    elements.roomName.value = "";
    showSecret("Player invite capability", data.invite.token);
    await loadState();
  } catch (error) {
    showToast(error.message);
  }
});

elements.deviceList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-revoke-device]");
  if (!button) return;
  if (!window.confirm("Revoke this device and end its active rooms?")) return;
  try {
    await request("/v1/admin/devices/revoke", {
      method: "POST",
      body: { deviceId: button.dataset.revokeDevice },
    });
    await loadState();
  } catch (error) {
    showToast(error.message);
  }
});

elements.roomList.addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-toggle-joins]");
  const rotate = event.target.closest("[data-rotate-invite]");
  const end = event.target.closest("[data-end-room]");
  const remove = event.target.closest("[data-remove-member]");
  try {
    if (toggle) {
      await request("/v1/admin/rooms/joins", {
        method: "POST",
        body: {
          roomId: toggle.dataset.toggleJoins,
          joinsOpen: toggle.dataset.open === "true",
        },
      });
    } else if (rotate) {
      if (!window.confirm("Rotate this invite and invalidate the previous one?")) {
        return;
      }
      const data = await request("/v1/admin/invites/rotate", {
        method: "POST",
        body: { roomId: rotate.dataset.rotateInvite },
      });
      showSecret("New player invite capability", data.token);
    } else if (end) {
      if (!window.confirm("End this room and revoke all player memberships?")) {
        return;
      }
      await request("/v1/admin/rooms/end", {
        method: "POST",
        body: { roomId: end.dataset.endRoom },
      });
    } else if (remove) {
      if (!window.confirm("Remove this player from the room?")) return;
      await request("/v1/admin/memberships/remove", {
        method: "POST",
        body: {
          roomId: remove.dataset.roomId,
          membershipId: remove.dataset.removeMember,
        },
      });
    } else {
      return;
    }
    await loadState();
  } catch (error) {
    showToast(error.message);
  }
});

elements.copySecret.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.secretValue.textContent);
    showToast("Copied");
  } catch {
    showToast("Copy failed. Select the value manually.");
  }
});

async function bootstrap() {
  try {
    const health = await request("/health");
    elements.serviceState.textContent = health.ok ? "Service ready" : "Unavailable";
    const session = await request("/v1/admin/session");
    state.csrfToken = session.csrfToken;
    state.account = session.account;
    showDashboard();
    await loadState();
  } catch (error) {
    elements.serviceState.textContent =
      error.status === 401 ? "Ready for sign-in" : "Service unavailable";
    showLogin();
  }
}

bootstrap();
