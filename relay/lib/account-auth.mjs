import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

function key(value) {
  return hash(value).toString("base64url");
}

export class RelayAccountAuth {
  constructor({
    store,
    now = () => Date.now(),
    random = (size) => randomBytes(size).toString("base64url"),
    idleTtlMs = 8 * 60 * 60 * 1_000,
    absoluteTtlMs = 24 * 60 * 60 * 1_000,
    maxSessions = 1_000,
  }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.idleTtlMs = idleTtlMs;
    this.absoluteTtlMs = absoluteTtlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  login(email, passphrase) {
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

  revoke(token) {
    if (typeof token !== "string" || !token) return false;
    return this.sessions.delete(key(token));
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
}
