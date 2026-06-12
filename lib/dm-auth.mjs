import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function hash(value) {
  return createHash("sha256").update(String(value)).digest();
}

function publicSession(record) {
  return {
    role: "dm",
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export class DmAuth {
  constructor({
    pin,
    now = () => Date.now(),
    random = (size) => randomBytes(size).toString("base64url"),
    idleTtlMs = 8 * 60 * 60 * 1000,
    absoluteTtlMs = 24 * 60 * 60 * 1000,
    ticketTtlMs = 15_000,
    maxSessions = 32,
    maxTickets = 256,
  }) {
    this.pinHash = hash(pin);
    this.now = now;
    this.random = random;
    this.idleTtlMs = idleTtlMs;
    this.absoluteTtlMs = absoluteTtlMs;
    this.ticketTtlMs = ticketTtlMs;
    this.maxSessions = maxSessions;
    this.maxTickets = maxTickets;
    this.sessions = new Map();
    this.streamTickets = new Map();
  }

  verifyPin(pin) {
    return timingSafeEqual(this.pinHash, hash(pin));
  }

  createSession() {
    const token = this.random(32);
    const csrfToken = this.random(24);
    const createdAt = this.now();
    this.prune(createdAt);
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
      for (const [ticketKey, ticket] of this.streamTickets) {
        if (ticket.sessionKey === oldest) this.streamTickets.delete(ticketKey);
      }
    }
    const record = {
      createdAt,
      lastSeenAt: createdAt,
      expiresAt: createdAt + this.absoluteTtlMs,
      csrfToken,
    };
    this.sessions.set(hash(token).toString("base64url"), record);
    return { token, csrfToken, session: publicSession(record) };
  }

  login(pin) {
    if (!this.verifyPin(pin)) return null;
    return this.createSession();
  }

  authenticate(token) {
    if (typeof token !== "string" || !token) return null;
    const key = hash(token).toString("base64url");
    const record = this.sessions.get(key);
    if (!record) return null;
    const now = this.now();
    if (
      record.expiresAt <= now ||
      record.lastSeenAt + this.idleTtlMs <= now
    ) {
      this.sessions.delete(key);
      return null;
    }
    record.lastSeenAt = now;
    return publicSession(record);
  }

  csrfToken(token) {
    if (!this.authenticate(token)) return null;
    const record = this.sessions.get(hash(token).toString("base64url"));
    return record?.csrfToken || null;
  }

  verifyCsrf(token, csrfToken) {
    if (typeof csrfToken !== "string" || !csrfToken) return false;
    const expected = this.csrfToken(token);
    if (!expected) return false;
    return timingSafeEqual(hash(expected), hash(csrfToken));
  }

  revoke(token) {
    if (typeof token !== "string" || !token) return false;
    const key = hash(token).toString("base64url");
    const removed = this.sessions.delete(key);
    for (const [ticketKey, ticket] of this.streamTickets) {
      if (ticket.sessionKey === key) this.streamTickets.delete(ticketKey);
    }
    return removed;
  }

  issueStreamTicket(token) {
    const session = this.authenticate(token);
    if (!session) return null;
    const now = this.now();
    this.prune(now);
    while (this.streamTickets.size >= this.maxTickets) {
      this.streamTickets.delete(this.streamTickets.keys().next().value);
    }
    const ticket = this.random(24);
    const expiresAt = now + this.ticketTtlMs;
    this.streamTickets.set(hash(ticket).toString("base64url"), {
      sessionKey: hash(token).toString("base64url"),
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  consumeStreamTicket(ticket) {
    if (typeof ticket !== "string" || !ticket) return null;
    const key = hash(ticket).toString("base64url");
    const entry = this.streamTickets.get(key);
    this.streamTickets.delete(key);
    if (!entry || entry.expiresAt <= this.now()) return null;
    const record = this.sessions.get(entry.sessionKey);
    if (!record) return null;
    const now = this.now();
    if (
      record.expiresAt <= now ||
      record.lastSeenAt + this.idleTtlMs <= now
    ) {
      this.sessions.delete(entry.sessionKey);
      return null;
    }
    record.lastSeenAt = now;
    return { ...publicSession(record), sessionKey: entry.sessionKey };
  }

  prune(now = this.now()) {
    for (const [key, record] of this.sessions) {
      if (
        record.expiresAt <= now ||
        record.lastSeenAt + this.idleTtlMs <= now
      ) {
        this.sessions.delete(key);
        for (const [ticketKey, ticket] of this.streamTickets) {
          if (ticket.sessionKey === key) this.streamTickets.delete(ticketKey);
        }
      }
    }
    for (const [ticketKey, ticket] of this.streamTickets) {
      if (ticket.expiresAt <= now) this.streamTickets.delete(ticketKey);
    }
  }
}
