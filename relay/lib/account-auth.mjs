import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AtomicJsonStore } from "../../lib/atomic-json-store.mjs";

const SESSION_SCHEMA_VERSION = 1;
const MAX_PERSISTED_SESSIONS = 10_000;

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

function key(value) {
  return hash(value).toString("base64url");
}

function validSessionStore(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === SESSION_SCHEMA_VERSION &&
    Array.isArray(value.sessions) &&
    value.sessions.length <= MAX_PERSISTED_SESSIONS &&
    value.sessions.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.tokenKey === "string" &&
        entry.tokenKey.length > 0 &&
        typeof entry.accountId === "string" &&
        entry.accountId.length > 0 &&
        Number.isSafeInteger(entry.createdAt) &&
        entry.createdAt >= 0 &&
        Number.isSafeInteger(entry.expiresAt) &&
        entry.expiresAt >= 0 &&
        typeof entry.csrfToken === "string" &&
        entry.csrfToken.length > 0,
    )
  );
}

export class RelayAccountAuth {
  constructor({
    store,
    now = () => Date.now(),
    random = (size) => randomBytes(size).toString("base64url"),
    idleTtlMs = 8 * 60 * 60 * 1_000,
    absoluteTtlMs = 24 * 60 * 60 * 1_000,
    maxSessions = 1_000,
    file,
    logger,
  }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.idleTtlMs = idleTtlMs;
    this.absoluteTtlMs = absoluteTtlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
    this.persistence = file
      ? new AtomicJsonStore({
          file,
          validate: validSessionStore,
          onWarning: (_message, details = {}) => {
            logger?.warn?.("relay_session_recovery", {
              action: details.code || "RECOVERY_WARNING",
            });
          },
        })
      : null;
  }

  async init() {
    if (!this.persistence) return this;
    const loaded = await this.persistence.load({
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessions: [],
    });
    const now = this.now();
    for (const record of loaded.sessions) {
      if (record.expiresAt > now) {
        this.sessions.set(record.tokenKey, {
          accountId: record.accountId,
          createdAt: record.createdAt,
          lastSeenAt: now,
          expiresAt: record.expiresAt,
          csrfToken: record.csrfToken,
        });
      }
    }
    return this;
  }

  toRecords() {
    const sessions = [];
    for (const [tokenKey, session] of this.sessions) {
      sessions.push({
        tokenKey,
        accountId: session.accountId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        csrfToken: session.csrfToken,
      });
    }
    return { schemaVersion: SESSION_SCHEMA_VERSION, sessions };
  }

  persist() {
    if (!this.persistence) return Promise.resolve();
    return this.persistence.write(this.toRecords());
  }

  async login(email, passphrase) {
    const account = this.store.authenticateAccount(email, passphrase);
    if (!account) return null;
    const token = this.random(32);
    const csrfToken = this.random(24);
    const now = this.now();
    this.prune(now);
    while (this.sessions.size >= this.maxSessions) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const session = {
      accountId: account.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.absoluteTtlMs,
      csrfToken,
    };
    this.sessions.set(key(token), session);
    await this.persist();
    return {
      token,
      csrfToken,
      account,
      session: {
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      },
    };
  }

  authenticate(token) {
    if (typeof token !== "string" || !token) return null;
    const session = this.sessions.get(key(token));
    if (!session) return null;
    const now = this.now();
    if (
      session.expiresAt <= now ||
      session.lastSeenAt + this.idleTtlMs <= now
    ) {
      this.sessions.delete(key(token));
      return null;
    }
    const account = this.store.account(session.accountId);
    if (!account) {
      this.sessions.delete(key(token));
      return null;
    }
    session.lastSeenAt = now;
    return {
      account,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      csrfToken: session.csrfToken,
    };
  }

  verifyCsrf(token, csrfToken) {
    if (typeof csrfToken !== "string" || !csrfToken) return false;
    const session = this.authenticate(token);
    return Boolean(
      session &&
        timingSafeEqual(hash(session.csrfToken), hash(csrfToken)),
    );
  }

  async revoke(token) {
    if (typeof token !== "string" || !token) return false;
    const removed = this.sessions.delete(key(token));
    if (removed) await this.persist();
    return removed;
  }

  prune(now = this.now()) {
    for (const [sessionKey, session] of this.sessions) {
      if (
        session.expiresAt <= now ||
        session.lastSeenAt + this.idleTtlMs <= now
      ) {
        this.sessions.delete(sessionKey);
      }
    }
  }

  async close() {
    if (this.persistence) await this.persistence.close();
  }
}
