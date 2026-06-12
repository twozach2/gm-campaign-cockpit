import assert from "node:assert/strict";
import test from "node:test";
import { SessionRegistry } from "../lib/session-registry.mjs";
import { api, startTestServer } from "../test-support/server.mjs";

test("duplicate display names remain separate identities", () => {
  let sequence = 0;
  const registry = new SessionRegistry({
    random: () => `random-${++sequence}`,
  });
  const first = registry.join("Tav");
  const second = registry.join("Tav");

  assert.notEqual(first.player.playerId, second.player.playerId);
  assert.notEqual(first.token, second.token);
  assert.deepEqual(registry.authenticate(first.token), first.player);
  assert.deepEqual(registry.authenticate(second.token), second.player);
});

test("renaming preserves identity and revoked tokens fail", () => {
  let sequence = 0;
  const registry = new SessionRegistry({
    random: () => `random-${++sequence}`,
  });
  const joined = registry.join("Tav");
  const renamed = registry.rename(joined.token, "Tavren");

  assert.equal(renamed.playerId, joined.player.playerId);
  assert.equal(renamed.displayName, "Tavren");
  registry.revoke(joined.token);
  assert.equal(registry.authenticate(joined.token), null);
  assert.throws(() => registry.require(joined.token), /session required/i);
});

test("stream tickets expire and can only be consumed once", () => {
  let time = 1_000;
  let sequence = 0;
  const registry = new SessionRegistry({
    now: () => time,
    random: () => `random-${++sequence}`,
    ticketTtlMs: 50,
  });
  const joined = registry.join("Tav");
  const first = registry.issueStreamTicket(joined.token);

  assert.deepEqual(registry.consumeStreamTicket(first.ticket), joined.player);
  assert.equal(registry.consumeStreamTicket(first.ticket), null);

  const expired = registry.issueStreamTicket(joined.token);
  time += 50;
  assert.equal(registry.consumeStreamTicket(expired.ticket), null);
});

test("same-name browser cannot read or send another player's whispers", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-identity-",
  });
  const first = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  const second = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.data.player.playerId, second.data.player.playerId);

  const whispered = await api(
    base,
    "POST",
    "/api/chat",
    { text: "I pocket the gem", whisper: true, from: "Spoofed" },
    { token: first.data.token },
  );
  assert.equal(whispered.status, 200);
  assert.equal(whispered.data.message.from, "Tav");
  assert.equal(
    whispered.data.message.fromPlayerId,
    first.data.player.playerId,
  );

  const firstState = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: first.data.token },
  );
  const secondState = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: second.data.token },
  );
  assert.ok(
    firstState.data.chat.some((message) => message.text === "I pocket the gem"),
  );
  assert.ok(
    !secondState.data.chat.some((message) => message.text === "I pocket the gem"),
  );

  const dmWhisper = await api(base, "POST", "/api/whisper", {
    toPlayerId: first.data.player.playerId,
    text: "I saw that.",
  });
  assert.equal(dmWhisper.status, 200);
  const firstAfter = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: first.data.token },
  );
  const secondAfter = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: second.data.token },
  );
  assert.ok(firstAfter.data.chat.some((message) => message.text === "I saw that."));
  assert.ok(!secondAfter.data.chat.some((message) => message.text === "I saw that."));
});

test("rename, revocation, and stream-ticket endpoints enforce bearer identity", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-session-",
  });
  const joined = await api(base, "POST", "/api/player/join", {
    displayName: "Olo",
  });
  const token = joined.data.token;
  const playerId = joined.data.player.playerId;

  const renamed = await api(
    base,
    "POST",
    "/api/player/rename",
    { displayName: "Olo the Bold" },
    { token },
  );
  assert.equal(renamed.data.player.playerId, playerId);
  assert.equal(renamed.data.player.displayName, "Olo the Bold");

  const ticket = await api(
    base,
    "POST",
    "/api/player/stream-ticket",
    {},
    { token },
  );
  assert.equal(ticket.status, 200);
  const firstStream = await fetch(
    `${base}/api/stream?ticket=${encodeURIComponent(ticket.data.ticket)}`,
  );
  assert.equal(firstStream.status, 200);
  await firstStream.body.cancel();
  const reused = await fetch(
    `${base}/api/stream?ticket=${encodeURIComponent(ticket.data.ticket)}`,
  );
  assert.equal(reused.status, 401);

  const left = await api(
    base,
    "POST",
    "/api/player/leave",
    {},
    { token },
  );
  assert.equal(left.status, 200);
  const rejected = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token },
  );
  assert.equal(rejected.status, 401);
  const unknown = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: "not-a-real-token" },
  );
  assert.equal(unknown.status, 401);
});
