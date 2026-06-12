import { createHash, randomBytes } from "node:crypto";

function unauthorized(message = "Player session required") {
  return Object.assign(new Error(message), { status: 401 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function capacityReached(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function displayName(value) {
  const name = typeof value === "string" ? value.trim().slice(0, 60) : "";
  if (!name) throw badRequest("A display name is required");
  if (/^dm$/i.test(name)) throw badRequest("That display name is reserved");
  return name;
}

function publicPlayer(record) {
  return {
    playerId: record.playerId,
    displayName: record.displayName,
  };
}

export class SessionRegistry {
  constructor({
    now = () => Date.now(),
    random = (size) => randomBytes(size).toString("base64url"),
    ticketTtlMs = 15_000,
    maxPlayers = 100,
    maxTickets = 256,
  } = {}) {
    this.now = now;
    this.random = random;
    this.ticketTtlMs = ticketTtlMs;
    this.maxPlayers = maxPlayers;
    this.maxTickets = maxTickets;
    this.players = new Map();
    this.tokenIndex = new Map();
    this.streamTickets = new Map();
  }

  hash(secret) {
    return createHash("sha256").update(secret).digest("base64url");
  }

  join(value) {
    if (this.players.size >= this.maxPlayers) {
      throw capacityReached("The player limit has been reached");
    }
    const createdAt = this.now();
    const token = this.random(32);
    const record = {
      playerId: this.random(18),
      tokenHash: this.hash(token),
      displayName: displayName(value),
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
    };
    this.players.set(record.playerId, record);
    this.tokenIndex.set(record.tokenHash, record.playerId);
    return { player: publicPlayer(record), token };
  }

  authenticate(token) {
    if (typeof token !== "string" || !token) return null;
    const playerId = this.tokenIndex.get(this.hash(token));
    const record = playerId ? this.players.get(playerId) : null;
    if (!record || record.revokedAt !== null) return null;
    record.lastSeenAt = this.now();
    return publicPlayer(record);
  }

  require(token) {
    const player = this.authenticate(token);
    if (!player) throw unauthorized();
    return player;
  }

  get(playerId) {
    const record = this.players.get(playerId);
    if (!record || record.revokedAt !== null) return null;
    return publicPlayer(record);
  }

  rename(token, value) {
    const player = this.require(token);
    const record = this.players.get(player.playerId);
    record.displayName = displayName(value);
    record.lastSeenAt = this.now();
    return publicPlayer(record);
  }

  revoke(token) {
    const player = this.require(token);
    const record = this.players.get(player.playerId);
    record.revokedAt = this.now();
    this.tokenIndex.delete(record.tokenHash);
    for (const [ticketHash, ticket] of this.streamTickets) {
      if (ticket.playerId === player.playerId) {
        this.streamTickets.delete(ticketHash);
      }
    }
    const removed = publicPlayer(record);
    this.players.delete(player.playerId);
    return removed;
  }

  issueStreamTicket(token) {
    const player = this.require(token);
    const now = this.now();
    for (const [ticketHash, ticket] of this.streamTickets) {
      if (ticket.expiresAt <= now) this.streamTickets.delete(ticketHash);
    }
    while (this.streamTickets.size >= this.maxTickets) {
      this.streamTickets.delete(this.streamTickets.keys().next().value);
    }
    const ticket = this.random(24);
    const expiresAt = now + this.ticketTtlMs;
    this.streamTickets.set(this.hash(ticket), {
      playerId: player.playerId,
      expiresAt,
    });
    return { ticket, expiresAt };
  }

  consumeStreamTicket(ticket) {
    if (typeof ticket !== "string" || !ticket) return null;
    const hash = this.hash(ticket);
    const entry = this.streamTickets.get(hash);
    this.streamTickets.delete(hash);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return this.get(entry.playerId);
  }
}
