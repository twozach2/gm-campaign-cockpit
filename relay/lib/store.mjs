import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AtomicJsonStore } from "../../lib/atomic-json-store.mjs";
import {
  assertRelaySafeValue,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
  validateRelayEnvelope,
} from "../../lib/relay-protocol.mjs";
import {
  canMigrateRelayDatabase,
  emptyRelayDatabase,
  migrateRelayDatabase,
  RELAY_SCHEMA_VERSION,
} from "./migrations.mjs";

const MAX_RECORDS = 10_000;
const MAX_ROOM_CHAT = 200;

function clone(value) {
  return structuredClone(value);
}

function secretHash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function equalHash(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function id(prefix, size = 12) {
  return `${prefix}_${randomBytes(size).toString("base64url")}`;
}

function secret(size = 32) {
  return randomBytes(size).toString("base64url");
}

function error(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function active(record, now) {
  return (
    record &&
    record.revokedAt === null &&
    (record.expiresAt === undefined || record.expiresAt > now)
  );
}

function validId(value) {
  return typeof value === "string" && value.length >= 3 && value.length <= 128;
}

function validTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validNullableTimestamp(value) {
  return value === null || validTimestamp(value);
}

function unique(records, key) {
  const values = records.map((record) => record[key]);
  return new Set(values).size === values.length;
}

function validDatabase(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== RELAY_SCHEMA_VERSION
  ) {
    return false;
  }
  const collections = [
    "accounts",
    "devices",
    "rooms",
    "invites",
    "memberships",
    "roomStates",
  ];
  if (
    collections.some(
      (key) => !Array.isArray(value[key]) || value[key].length > MAX_RECORDS,
    )
  ) {
    return false;
  }
  if (
    !unique(value.accounts, "id") ||
    !unique(value.devices, "id") ||
    !unique(value.rooms, "id") ||
    !unique(value.invites, "id") ||
    !unique(value.memberships, "id") ||
    !unique(value.roomStates, "roomId")
  ) {
    return false;
  }
  if (
    !value.accounts.every(
      (account) =>
        validId(account.id) &&
        typeof account.email === "string" &&
        account.email.length <= 320 &&
        account.status === "active" &&
        validTimestamp(account.createdAt),
    )
  ) {
    return false;
  }
  const accountIds = new Set(value.accounts.map((account) => account.id));
  if (
    !value.devices.every(
      (device) =>
        validId(device.id) &&
        accountIds.has(device.accountId) &&
        typeof device.name === "string" &&
        device.name.length > 0 &&
        device.name.length <= 80 &&
        typeof device.tokenHash === "string" &&
        device.tokenHash.length > 20 &&
        validTimestamp(device.createdAt) &&
        validNullableTimestamp(device.revokedAt),
    )
  ) {
    return false;
  }
  const deviceIds = new Set(value.devices.map((device) => device.id));
  if (
    !value.rooms.every(
      (room) =>
        validId(room.id) &&
        accountIds.has(room.accountId) &&
        deviceIds.has(room.agentDeviceId) &&
        typeof room.name === "string" &&
        room.name.length > 0 &&
        room.name.length <= 120 &&
        (room.status === "active" || room.status === "ended") &&
        typeof room.joinsOpen === "boolean" &&
        validTimestamp(room.createdAt) &&
        validNullableTimestamp(room.endedAt),
    )
  ) {
    return false;
  }
  const roomIds = new Set(value.rooms.map((room) => room.id));
  if (
    !value.invites.every(
      (invite) =>
        validId(invite.id) &&
        roomIds.has(invite.roomId) &&
        typeof invite.tokenHash === "string" &&
        invite.tokenHash.length > 20 &&
        validTimestamp(invite.createdAt) &&
        validTimestamp(invite.expiresAt) &&
        validNullableTimestamp(invite.revokedAt) &&
        Number.isSafeInteger(invite.maxUses) &&
        invite.maxUses >= 1 &&
        invite.maxUses <= 1_000 &&
        Number.isSafeInteger(invite.useCount) &&
        invite.useCount >= 0 &&
        invite.useCount <= invite.maxUses,
    )
  ) {
    return false;
  }
  if (
    !value.memberships.every(
      (membership) =>
        validId(membership.id) &&
        roomIds.has(membership.roomId) &&
        validId(membership.playerId) &&
        typeof membership.displayName === "string" &&
        membership.displayName.length > 0 &&
        membership.displayName.length <= 60 &&
        typeof membership.tokenHash === "string" &&
        membership.tokenHash.length > 20 &&
        validTimestamp(membership.createdAt) &&
        validNullableTimestamp(membership.revokedAt),
    )
  ) {
    return false;
  }
  try {
    for (const roomState of value.roomStates) {
      if (
        !roomIds.has(roomState.roomId) ||
        !Number.isSafeInteger(roomState.revision) ||
        roomState.revision < 0 ||
        !validTimestamp(roomState.updatedAt)
      ) {
        return false;
      }
      assertRelaySafeValue(roomState.state, {
        label: "Stored relay room state",
      });
      validateRelayEnvelope({
        protocol: RELAY_PROTOCOL_NAME,
        version: RELAY_PROTOCOL_VERSION,
        id: "stored-state-validation",
        type: "room.snapshot",
        roomId: roomState.roomId,
        sentAt: roomState.updatedAt,
        payload: {
          revision: roomState.revision,
          state: roomState.state,
        },
      });
    }
  } catch {
    return false;
  }
  return true;
}

function publicAccount(account) {
  return {
    id: account.id,
    email: account.email,
    status: account.status,
    createdAt: account.createdAt,
  };
}

function publicDevice(device) {
  return {
    id: device.id,
    accountId: device.accountId,
    name: device.name,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt,
  };
}

function publicRoom(room) {
  return clone(room);
}

function publicMembership(membership) {
  return {
    id: membership.id,
    roomId: membership.roomId,
    playerId: membership.playerId,
    displayName: membership.displayName,
    createdAt: membership.createdAt,
    revokedAt: membership.revokedAt,
  };
}

function defaultRoomState() {
  return {
    presentation: { items: [], updatedAt: 0 },
    status: { trackers: [], updatedAt: 0 },
    chat: [],
    players: [],
  };
}

export class RelayStore {
  constructor({
    file,
    now = () => Date.now(),
    randomId = id,
    randomSecret = secret,
    logger,
  }) {
    this.now = now;
    this.randomId = randomId;
    this.randomSecret = randomSecret;
    this.logger = logger;
    this.database = emptyRelayDatabase();
    this.tail = Promise.resolve();
    this.store = new AtomicJsonStore({
      file,
      validate: canMigrateRelayDatabase,
      onWarning: (_message, details = {}) => {
        this.logger?.warn("relay_persistence_recovery", {
          action: details.code || "RECOVERY_WARNING",
        });
      },
    });
  }

  async init() {
    const loaded = await this.store.load(emptyRelayDatabase());
    const migrated = migrateRelayDatabase(loaded);
    if (!validDatabase(migrated)) {
      throw new Error("Relay database failed validation after migration");
    }
    this.database = migrated;
    if (loaded.schemaVersion !== RELAY_SCHEMA_VERSION) {
      await this.store.write(this.database);
    }
    return this;
  }

  snapshot() {
    return clone(this.database);
  }

  transact(mutator) {
    const operation = this.tail.then(async () => {
      const draft = clone(this.database);
      const result = await mutator(draft);
      if (!validDatabase(draft)) {
        throw new Error("Relay transaction produced invalid state");
      }
      await this.store.write(draft);
      this.database = draft;
      return clone(result);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async close() {
    await this.tail;
    await this.store.close();
  }

  async bootstrap({ email, deviceName, roomName }) {
    const account = await this.createAccount({ email });
    const device = await this.createDevice({
      accountId: account.id,
      name: deviceName,
    });
    const room = await this.createRoom({
      accountId: account.id,
      agentDeviceId: device.device.id,
      name: roomName,
    });
    const invite = await this.createInvite({ roomId: room.id });
    return { account, device, room, invite };
  }

  createAccount({ email }) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || normalized.length > 320 || !normalized.includes("@")) {
      throw error("A valid account email is required", "INVALID_EMAIL");
    }
    return this.transact((draft) => {
      if (draft.accounts.some((account) => account.email === normalized)) {
        throw error("Account already exists", "ACCOUNT_EXISTS", 409);
      }
      const account = {
        id: this.randomId("acct"),
        email: normalized,
        status: "active",
        createdAt: this.now(),
      };
      draft.accounts.push(account);
      return publicAccount(account);
    });
  }

  createDevice({ accountId, name }) {
    const deviceName = String(name || "").trim();
    if (!deviceName || deviceName.length > 80) {
      throw error("A device name is required", "INVALID_DEVICE_NAME");
    }
    const token = this.randomSecret();
    return this.transact((draft) => {
      if (!draft.accounts.some((account) => account.id === accountId)) {
        throw error("Account not found", "ACCOUNT_NOT_FOUND", 404);
      }
      const device = {
        id: this.randomId("dev"),
        accountId,
        name: deviceName,
        tokenHash: secretHash(token),
        createdAt: this.now(),
        revokedAt: null,
      };
      draft.devices.push(device);
      return { device: publicDevice(device), token };
    });
  }

  createRoom({ accountId, agentDeviceId, name }) {
    const roomName = String(name || "").trim();
    if (!roomName || roomName.length > 120) {
      throw error("A room name is required", "INVALID_ROOM_NAME");
    }
    return this.transact((draft) => {
      const device = draft.devices.find(
        (entry) => entry.id === agentDeviceId && entry.revokedAt === null,
      );
      if (!device || device.accountId !== accountId) {
        throw error("Device cannot create this room", "DEVICE_NOT_AUTHORIZED", 403);
      }
      const room = {
        id: this.randomId("room"),
        accountId,
        agentDeviceId,
        name: roomName,
        status: "active",
        joinsOpen: true,
        createdAt: this.now(),
        endedAt: null,
      };
      draft.rooms.push(room);
      draft.roomStates.push({
        roomId: room.id,
        revision: 0,
        state: defaultRoomState(),
        updatedAt: this.now(),
      });
      return publicRoom(room);
    });
  }

  createInvite({
    roomId,
    ttlMs = 24 * 60 * 60 * 1_000,
    maxUses = 20,
  }) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
      throw error("Invite lifetime is too short", "INVALID_INVITE_TTL");
    }
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000) {
      throw error("Invite use limit is invalid", "INVALID_INVITE_LIMIT");
    }
    const token = this.randomSecret(24);
    return this.transact((draft) => {
      const room = draft.rooms.find((entry) => entry.id === roomId);
      if (!room || room.status !== "active") {
        throw error("Room not found", "ROOM_NOT_FOUND", 404);
      }
      const invite = {
        id: this.randomId("invite"),
        roomId,
        tokenHash: secretHash(token),
        createdAt: this.now(),
        expiresAt: this.now() + ttlMs,
        revokedAt: null,
        maxUses,
        useCount: 0,
      };
      draft.invites.push(invite);
      return {
        invite: {
          id: invite.id,
          roomId,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
          maxUses,
          useCount: 0,
        },
        token,
      };
    });
  }

  redeemInvite({ token, displayName }) {
    const name = String(displayName || "").trim();
    if (!name || name.length > 60 || /^dm$/i.test(name)) {
      throw error("Display name is invalid", "INVALID_DISPLAY_NAME");
    }
    const tokenHash = secretHash(token);
    const membershipToken = this.randomSecret();
    return this.transact((draft) => {
      const now = this.now();
      const invite = draft.invites.find(
        (entry) =>
          equalHash(entry.tokenHash, tokenHash) &&
          active(entry, now) &&
          entry.useCount < entry.maxUses,
      );
      if (!invite) {
        throw error("Invite is invalid or expired", "INVITE_INVALID", 401);
      }
      const room = draft.rooms.find((entry) => entry.id === invite.roomId);
      if (!room || room.status !== "active" || !room.joinsOpen) {
        throw error("Room is not accepting players", "ROOM_CLOSED", 403);
      }
      const membership = {
        id: this.randomId("member"),
        roomId: room.id,
        playerId: this.randomId("player"),
        displayName: name,
        tokenHash: secretHash(membershipToken),
        createdAt: now,
        revokedAt: null,
      };
      invite.useCount += 1;
      draft.memberships.push(membership);
      return {
        membership: publicMembership(membership),
        token: membershipToken,
        room: publicRoom(room),
      };
    });
  }

  authenticateDevice(token) {
    const hash = secretHash(token);
    const device = this.database.devices.find(
      (entry) => entry.revokedAt === null && equalHash(entry.tokenHash, hash),
    );
    return device ? publicDevice(device) : null;
  }

  authenticateMembership(token) {
    const hash = secretHash(token);
    const membership = this.database.memberships.find(
      (entry) => entry.revokedAt === null && equalHash(entry.tokenHash, hash),
    );
    return membership ? publicMembership(membership) : null;
  }

  authorizeDeviceRoom(deviceId, roomId) {
    const device = this.database.devices.find(
      (entry) => entry.id === deviceId && entry.revokedAt === null,
    );
    const room = this.database.rooms.find(
      (entry) => entry.id === roomId && entry.status === "active",
    );
    if (
      !device ||
      !room ||
      room.accountId !== device.accountId ||
      room.agentDeviceId !== device.id
    ) {
      return null;
    }
    return publicRoom(room);
  }

  room(roomId) {
    const room = this.database.rooms.find((entry) => entry.id === roomId);
    return room ? publicRoom(room) : null;
  }

  memberships(roomId) {
    return this.database.memberships
      .filter(
        (membership) =>
          membership.roomId === roomId && membership.revokedAt === null,
      )
      .map(publicMembership);
  }

  renameMembership(membershipId, displayName) {
    const name = String(displayName || "").trim();
    if (!name || name.length > 60 || /^dm$/i.test(name)) {
      throw error("Display name is invalid", "INVALID_DISPLAY_NAME");
    }
    return this.transact((draft) => {
      const membership = draft.memberships.find(
        (entry) => entry.id === membershipId && entry.revokedAt === null,
      );
      if (!membership) {
        throw error("Membership not found", "MEMBERSHIP_NOT_FOUND", 404);
      }
      membership.displayName = name;
      return publicMembership(membership);
    });
  }

  revokeMembership(membershipId) {
    return this.transact((draft) => {
      const membership = draft.memberships.find(
        (entry) => entry.id === membershipId && entry.revokedAt === null,
      );
      if (!membership) {
        throw error("Membership not found", "MEMBERSHIP_NOT_FOUND", 404);
      }
      membership.revokedAt = this.now();
      return publicMembership(membership);
    });
  }

  roomState(roomId) {
    const state = this.database.roomStates.find(
      (entry) => entry.roomId === roomId,
    );
    return state ? clone(state) : null;
  }

  applySnapshot({ deviceId, roomId, revision, state }) {
    validateRelayEnvelope({
      protocol: RELAY_PROTOCOL_NAME,
      version: RELAY_PROTOCOL_VERSION,
      id: "snapshot-validation",
      type: "room.snapshot",
      roomId,
      sentAt: this.now(),
      payload: { revision, state },
    });
    return this.transact((draft) => {
      this.assertDeviceRoom(draft, deviceId, roomId);
      const roomState = draft.roomStates.find(
        (entry) => entry.roomId === roomId,
      );
      if (revision < roomState.revision) {
        throw error("Snapshot revision is stale", "STALE_REVISION", 409);
      }
      roomState.revision = revision;
      roomState.state = clone(state);
      roomState.updatedAt = this.now();
      return clone(roomState);
    });
  }

  applyEvent({ deviceId, roomId, revision, eventType, audience, data }) {
    validateRelayEnvelope({
      protocol: RELAY_PROTOCOL_NAME,
      version: RELAY_PROTOCOL_VERSION,
      id: "event-validation",
      type: "room.event",
      roomId,
      sentAt: this.now(),
      payload: { revision, eventType, audience, data },
    });
    return this.transact((draft) => {
      this.assertDeviceRoom(draft, deviceId, roomId);
      const roomState = draft.roomStates.find(
        (entry) => entry.roomId === roomId,
      );
      if (revision !== roomState.revision + 1) {
        throw error(
          "Room event revision is not the next revision",
          "REVISION_GAP",
          409,
        );
      }
      if (eventType === "reveal.set") {
        roomState.state.presentation = clone(data.presentation);
      } else if (eventType === "status.set") {
        roomState.state.status = clone(data.status);
      } else if (eventType === "presence.set") {
        roomState.state.players = clone(data.players);
      } else if (eventType === "chat.append") {
        roomState.state.chat.push(clone(data.message));
        if (roomState.state.chat.length > MAX_ROOM_CHAT) {
          roomState.state.chat.splice(
            0,
            roomState.state.chat.length - MAX_ROOM_CHAT,
          );
        }
      }
      roomState.revision = revision;
      roomState.updatedAt = this.now();
      return clone(roomState);
    });
  }

  assertDeviceRoom(draft, deviceId, roomId) {
    const device = draft.devices.find(
      (entry) => entry.id === deviceId && entry.revokedAt === null,
    );
    const room = draft.rooms.find(
      (entry) => entry.id === roomId && entry.status === "active",
    );
    if (
      !device ||
      !room ||
      room.accountId !== device.accountId ||
      room.agentDeviceId !== device.id
    ) {
      throw error("Device is not authorized for room", "ROOM_FORBIDDEN", 403);
    }
  }
}
