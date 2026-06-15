import {
  createHash,
  randomBytes,
  scryptSync,
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
const MIN_PASSPHRASE_LENGTH = 10;
const DEFAULT_CAPACITY = Object.freeze({
  accounts: 1_000,
  devicesPerAccount: 20,
  activeRoomsPerAccount: 20,
  activeInvitesPerRoom: 5,
  activeMembershipsPerRoom: 200,
  pendingPairingsPerAccount: 10,
});
const DEFAULT_LOCKOUT = Object.freeze({
  threshold: 10,
  baseMs: 15 * 60 * 1_000,
  maxMs: 24 * 60 * 60 * 1_000,
});
const MAX_LOCK_EXPONENT = 20;

function clone(value) {
  return structuredClone(value);
}

function secretHash(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function passwordDigest(passphrase, salt) {
  return scryptSync(String(passphrase), salt, 32).toString("base64url");
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

function enforceCapacity(count, maximum, message, code) {
  if (count >= maximum) throw error(message, code, 409);
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

export function validRelayDatabase(value) {
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
    "pairings",
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
    !unique(value.pairings, "id") ||
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
        ((account.passwordSalt === null && account.passwordHash === null) ||
          (typeof account.passwordSalt === "string" &&
            account.passwordSalt.length >= 16 &&
            typeof account.passwordHash === "string" &&
            account.passwordHash.length >= 32)) &&
        validTimestamp(account.createdAt) &&
        Number.isSafeInteger(account.failedLoginCount) &&
        account.failedLoginCount >= 0 &&
        validNullableTimestamp(account.lockedUntil),
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
  if (
    !value.pairings.every(
      (pairing) =>
        validId(pairing.id) &&
        accountIds.has(pairing.accountId) &&
        typeof pairing.tokenHash === "string" &&
        pairing.tokenHash.length > 20 &&
        validTimestamp(pairing.createdAt) &&
        validTimestamp(pairing.expiresAt) &&
        validNullableTimestamp(pairing.redeemedAt),
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

function publicInvite(invite) {
  return {
    id: invite.id,
    roomId: invite.roomId,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt,
    maxUses: invite.maxUses,
    useCount: invite.useCount,
  };
}

function publicPairing(pairing) {
  return {
    id: pairing.id,
    accountId: pairing.accountId,
    createdAt: pairing.createdAt,
    expiresAt: pairing.expiresAt,
    redeemedAt: pairing.redeemedAt,
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
    capacity = {},
    lockout = {},
  }) {
    this.now = now;
    this.randomId = randomId;
    this.randomSecret = randomSecret;
    this.logger = logger;
    this.capacity = { ...DEFAULT_CAPACITY, ...capacity };
    this.lockout = { ...DEFAULT_LOCKOUT, ...lockout };
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
    if (!validRelayDatabase(migrated)) {
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

  stats() {
    return {
      accounts: this.database.accounts.length,
      devices: this.database.devices.filter((entry) => entry.revokedAt === null)
        .length,
      activeRooms: this.database.rooms.filter(
        (entry) => entry.status === "active",
      ).length,
      activeInvites: this.database.invites.filter((entry) =>
        active(entry, this.now()),
      ).length,
      activeMemberships: this.database.memberships.filter(
        (entry) => entry.revokedAt === null,
      ).length,
      roomStates: this.database.roomStates.length,
    };
  }

  transact(mutator) {
    const operation = this.tail.then(async () => {
      const draft = clone(this.database);
      const result = await mutator(draft);
      if (!validRelayDatabase(draft)) {
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

  async bootstrap({ email, passphrase, deviceName, roomName }) {
    const account = await this.createAccount({ email, passphrase });
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

  createAccount({ email, passphrase }) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized || normalized.length > 320 || !normalized.includes("@")) {
      throw error("A valid account email is required", "INVALID_EMAIL");
    }
    const password =
      passphrase === undefined ? null : String(passphrase || "");
    if (
      password !== null &&
      (password.length < MIN_PASSPHRASE_LENGTH || password.length > 512)
    ) {
      throw error(
        `Account passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        "INVALID_PASSPHRASE",
      );
    }
    const passwordSalt = password === null ? null : this.randomSecret(18);
    const passwordHash =
      password === null ? null : passwordDigest(password, passwordSalt);
    return this.transact((draft) => {
      enforceCapacity(
        draft.accounts.length,
        this.capacity.accounts,
        "Account capacity reached",
        "ACCOUNT_CAPACITY",
      );
      if (draft.accounts.some((account) => account.email === normalized)) {
        throw error("Account already exists", "ACCOUNT_EXISTS", 409);
      }
      const account = {
        id: this.randomId("acct"),
        email: normalized,
        status: "active",
        passwordSalt,
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        createdAt: this.now(),
      };
      draft.accounts.push(account);
      return publicAccount(account);
    });
  }

  setAccountPassword(accountId, passphrase) {
    const password = String(passphrase || "");
    if (password.length < MIN_PASSPHRASE_LENGTH || password.length > 512) {
      throw error(
        `Account passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`,
        "INVALID_PASSPHRASE",
      );
    }
    const passwordSalt = this.randomSecret(18);
    const passwordHash = passwordDigest(password, passwordSalt);
    return this.transact((draft) => {
      const account = draft.accounts.find(
        (entry) => entry.id === accountId && entry.status === "active",
      );
      if (!account) {
        throw error("Account not found", "ACCOUNT_NOT_FOUND", 404);
      }
      account.passwordSalt = passwordSalt;
      account.passwordHash = passwordHash;
      return publicAccount(account);
    });
  }

  authenticateAccount(email, passphrase) {
    const normalized = String(email || "").trim().toLowerCase();
    const account = this.database.accounts.find(
      (entry) => entry.email === normalized && entry.status === "active",
    );
    if (!account?.passwordSalt || !account.passwordHash) return null;
    const actual = passwordDigest(passphrase, account.passwordSalt);
    return equalHash(actual, account.passwordHash)
      ? publicAccount(account)
      : null;
  }

  account(accountId) {
    const account = this.database.accounts.find(
      (entry) => entry.id === accountId && entry.status === "active",
    );
    return account ? publicAccount(account) : null;
  }

  accountByEmail(email) {
    const normalized = String(email || "").trim().toLowerCase();
    if (!normalized) return null;
    const account = this.database.accounts.find(
      (entry) => entry.email === normalized && entry.status === "active",
    );
    return account ? publicAccount(account) : null;
  }

  accountLockState(email) {
    const normalized = String(email || "").trim().toLowerCase();
    const account = this.database.accounts.find(
      (entry) => entry.email === normalized && entry.status === "active",
    );
    if (!account || account.lockedUntil === null) {
      return { locked: false, lockedUntil: null, retryAfterMs: 0 };
    }
    const retryAfterMs = account.lockedUntil - this.now();
    if (retryAfterMs <= 0) {
      return { locked: false, lockedUntil: account.lockedUntil, retryAfterMs: 0 };
    }
    return { locked: true, lockedUntil: account.lockedUntil, retryAfterMs };
  }

  recordLoginFailure(email) {
    const normalized = String(email || "").trim().toLowerCase();
    const exists = this.database.accounts.some(
      (entry) => entry.email === normalized && entry.status === "active",
    );
    if (!exists) {
      return Promise.resolve({
        locked: false,
        lockedUntil: null,
        failedLoginCount: 0,
      });
    }
    return this.transact((draft) => {
      const account = draft.accounts.find(
        (entry) => entry.email === normalized && entry.status === "active",
      );
      account.failedLoginCount += 1;
      if (account.failedLoginCount >= this.lockout.threshold) {
        const exponent = Math.min(
          account.failedLoginCount - this.lockout.threshold,
          MAX_LOCK_EXPONENT,
        );
        const lockMs = Math.min(
          this.lockout.baseMs * 2 ** exponent,
          this.lockout.maxMs,
        );
        account.lockedUntil = this.now() + lockMs;
      }
      return {
        locked:
          account.lockedUntil !== null && account.lockedUntil > this.now(),
        lockedUntil: account.lockedUntil,
        failedLoginCount: account.failedLoginCount,
      };
    });
  }

  recordLoginSuccess(accountId) {
    const current = this.database.accounts.find(
      (entry) => entry.id === accountId && entry.status === "active",
    );
    if (
      !current ||
      (current.failedLoginCount === 0 && current.lockedUntil === null)
    ) {
      return Promise.resolve(false);
    }
    return this.transact((draft) => {
      const account = draft.accounts.find(
        (entry) => entry.id === accountId && entry.status === "active",
      );
      if (account) {
        account.failedLoginCount = 0;
        account.lockedUntil = null;
      }
      return true;
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
      enforceCapacity(
        draft.devices.filter(
          (device) =>
            device.accountId === accountId && device.revokedAt === null,
        ).length,
        this.capacity.devicesPerAccount,
        "Device capacity reached for this account",
        "DEVICE_CAPACITY",
      );
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

  devices(accountId) {
    return this.database.devices
      .filter((device) => device.accountId === accountId)
      .map(publicDevice);
  }

  revokeDevice(accountId, deviceId) {
    return this.transact((draft) => {
      const device = draft.devices.find(
        (entry) =>
          entry.id === deviceId &&
          entry.accountId === accountId &&
          entry.revokedAt === null,
      );
      if (!device) {
        throw error("Device not found", "DEVICE_NOT_FOUND", 404);
      }
      device.revokedAt = this.now();
      for (const room of draft.rooms) {
        if (
          room.agentDeviceId === device.id &&
          room.status === "active"
        ) {
          room.status = "ended";
          room.joinsOpen = false;
          room.endedAt = this.now();
          this.revokeRoomCapabilities(draft, room.id);
        }
      }
      return publicDevice(device);
    });
  }

  createPairing({ accountId, ttlMs = 10 * 60 * 1_000 }) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 3_600_000) {
      throw error("Pairing lifetime is invalid", "INVALID_PAIRING_TTL");
    }
    const token = this.randomSecret(24);
    return this.transact((draft) => {
      if (
        !draft.accounts.some(
          (account) => account.id === accountId && account.status === "active",
        )
      ) {
        throw error("Account not found", "ACCOUNT_NOT_FOUND", 404);
      }
      enforceCapacity(
        draft.pairings.filter(
          (entry) =>
            entry.accountId === accountId &&
            entry.redeemedAt === null &&
            entry.expiresAt > this.now(),
        ).length,
        this.capacity.pendingPairingsPerAccount,
        "Pending pairing capacity reached for this account",
        "PAIRING_CAPACITY",
      );
      const pairing = {
        id: this.randomId("pair"),
        accountId,
        tokenHash: secretHash(token),
        createdAt: this.now(),
        expiresAt: this.now() + ttlMs,
        redeemedAt: null,
      };
      draft.pairings.push(pairing);
      return { pairing: publicPairing(pairing), token };
    });
  }

  redeemPairing({ token, name }) {
    const deviceName = String(name || "").trim();
    if (!deviceName || deviceName.length > 80) {
      throw error("A device name is required", "INVALID_DEVICE_NAME");
    }
    const tokenHash = secretHash(token);
    const deviceToken = this.randomSecret();
    return this.transact((draft) => {
      const now = this.now();
      const pairing = draft.pairings.find(
        (entry) =>
          equalHash(entry.tokenHash, tokenHash) &&
          entry.redeemedAt === null &&
          entry.expiresAt > now,
      );
      if (!pairing) {
        throw error(
          "Pairing code is invalid or expired",
          "PAIRING_INVALID",
          401,
        );
      }
      const account = draft.accounts.find(
        (entry) =>
          entry.id === pairing.accountId && entry.status === "active",
      );
      if (!account) {
        throw error("Account not found", "ACCOUNT_NOT_FOUND", 404);
      }
      enforceCapacity(
        draft.devices.filter(
          (device) =>
            device.accountId === account.id && device.revokedAt === null,
        ).length,
        this.capacity.devicesPerAccount,
        "Device capacity reached for this account",
        "DEVICE_CAPACITY",
      );
      pairing.redeemedAt = now;
      const device = {
        id: this.randomId("dev"),
        accountId: account.id,
        name: deviceName,
        tokenHash: secretHash(deviceToken),
        createdAt: now,
        revokedAt: null,
      };
      draft.devices.push(device);
      return {
        account: publicAccount(account),
        device: publicDevice(device),
        token: deviceToken,
      };
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
      enforceCapacity(
        draft.rooms.filter(
          (room) =>
            room.accountId === accountId && room.status === "active",
        ).length,
        this.capacity.activeRoomsPerAccount,
        "Active room capacity reached for this account",
        "ROOM_CAPACITY",
      );
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

  rooms(accountId) {
    return this.database.rooms
      .filter((room) => room.accountId === accountId)
      .map(publicRoom);
  }

  roomForAccount(accountId, roomId) {
    const room = this.database.rooms.find(
      (entry) => entry.id === roomId && entry.accountId === accountId,
    );
    return room ? publicRoom(room) : null;
  }

  setRoomJoins(accountId, roomId, joinsOpen) {
    if (typeof joinsOpen !== "boolean") {
      throw error("joinsOpen must be a boolean", "INVALID_JOINS_STATE");
    }
    return this.transact((draft) => {
      const room = draft.rooms.find(
        (entry) =>
          entry.id === roomId &&
          entry.accountId === accountId &&
          entry.status === "active",
      );
      if (!room) throw error("Room not found", "ROOM_NOT_FOUND", 404);
      room.joinsOpen = joinsOpen;
      return publicRoom(room);
    });
  }

  endRoom(accountId, roomId) {
    return this.transact((draft) => {
      const room = draft.rooms.find(
        (entry) =>
          entry.id === roomId &&
          entry.accountId === accountId &&
          entry.status === "active",
      );
      if (!room) throw error("Room not found", "ROOM_NOT_FOUND", 404);
      room.status = "ended";
      room.joinsOpen = false;
      room.endedAt = this.now();
      this.revokeRoomCapabilities(draft, room.id);
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
      enforceCapacity(
        draft.invites.filter(
          (invite) =>
            invite.roomId === roomId && active(invite, this.now()),
        ).length,
        this.capacity.activeInvitesPerRoom,
        "Active invite capacity reached for this room",
        "INVITE_CAPACITY",
      );
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
        invite: publicInvite(invite),
        token,
      };
    });
  }

  invites(roomId) {
    return this.database.invites
      .filter((invite) => invite.roomId === roomId)
      .map(publicInvite);
  }

  rotateInvite(accountId, roomId, options = {}) {
    const token = this.randomSecret(24);
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    const maxUses = options.maxUses ?? 20;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
      throw error("Invite lifetime is too short", "INVALID_INVITE_TTL");
    }
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1_000) {
      throw error("Invite use limit is invalid", "INVALID_INVITE_LIMIT");
    }
    return this.transact((draft) => {
      const room = draft.rooms.find(
        (entry) =>
          entry.id === roomId &&
          entry.accountId === accountId &&
          entry.status === "active",
      );
      if (!room) throw error("Room not found", "ROOM_NOT_FOUND", 404);
      const now = this.now();
      for (const invite of draft.invites) {
        if (invite.roomId === roomId && invite.revokedAt === null) {
          invite.revokedAt = now;
        }
      }
      const invite = {
        id: this.randomId("invite"),
        roomId,
        tokenHash: secretHash(token),
        createdAt: now,
        expiresAt: now + ttlMs,
        revokedAt: null,
        maxUses,
        useCount: 0,
      };
      draft.invites.push(invite);
      return { invite: publicInvite(invite), token };
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
      enforceCapacity(
        draft.memberships.filter(
          (membership) =>
            membership.roomId === room.id &&
            membership.revokedAt === null,
        ).length,
        this.capacity.activeMembershipsPerRoom,
        "Player capacity reached for this room",
        "MEMBERSHIP_CAPACITY",
      );
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

  removeMembership(accountId, roomId, membershipId) {
    return this.transact((draft) => {
      const room = draft.rooms.find(
        (entry) => entry.id === roomId && entry.accountId === accountId,
      );
      if (!room) throw error("Room not found", "ROOM_NOT_FOUND", 404);
      const membership = draft.memberships.find(
        (entry) =>
          entry.id === membershipId &&
          entry.roomId === roomId &&
          entry.revokedAt === null,
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

  revokeRoomCapabilities(draft, roomId) {
    const now = this.now();
    for (const invite of draft.invites) {
      if (invite.roomId === roomId && invite.revokedAt === null) {
        invite.revokedAt = now;
      }
    }
    for (const membership of draft.memberships) {
      if (membership.roomId === roomId && membership.revokedAt === null) {
        membership.revokedAt = now;
      }
    }
  }
}
