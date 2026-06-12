import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DmAuth } from "../lib/dm-auth.mjs";
import { TokenBucketRateLimiter } from "../lib/rate-limit.mjs";
import { SessionRegistry } from "../lib/session-registry.mjs";
import {
  api,
  localDmSession,
  startTestServer,
} from "../test-support/server.mjs";

function dmHeaders(session) {
  return {
    Cookie: session.cookie,
    "X-GM-Cockpit-CSRF": session.csrfToken,
  };
}

test("token buckets allow bursts, refill, expire, and stay bounded", () => {
  let now = 0;
  const limiter = new TokenBucketRateLimiter({
    now: () => now,
    maxKeys: 3,
    cleanupIntervalMs: 10,
  });
  const rule = { capacity: 2, windowMs: 1_000 };

  assert.equal(limiter.consume("chat", "one", rule).allowed, true);
  assert.equal(limiter.consume("chat", "one", rule).allowed, true);
  const denied = limiter.consume("chat", "one", rule);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 1);

  now += 500;
  assert.equal(limiter.consume("chat", "one", rule).allowed, true);

  limiter.consume("chat", "two", rule);
  limiter.consume("chat", "three", rule);
  limiter.consume("chat", "four", rule);
  assert.equal(limiter.size, 3);

  now += 3_000;
  limiter.prune();
  assert.equal(limiter.size, 0);
});

test("session and ticket registries enforce bounded capacity", () => {
  let sequence = 0;
  const registry = new SessionRegistry({
    random: () => `player-${++sequence}`,
    maxPlayers: 1,
    maxTickets: 1,
  });
  const joined = registry.join("Tav");
  assert.throws(
    () => registry.join("Olo"),
    (error) => error.status === 409 && /player limit/i.test(error.message),
  );
  const firstTicket = registry.issueStreamTicket(joined.token);
  const secondTicket = registry.issueStreamTicket(joined.token);
  assert.equal(registry.consumeStreamTicket(firstTicket.ticket), null);
  assert.equal(
    registry.consumeStreamTicket(secondTicket.ticket).playerId,
    joined.player.playerId,
  );

  let dmSequence = 0;
  const dmAuth = new DmAuth({
    pin: "correct horse",
    random: () => `dm-${++dmSequence}`,
    maxSessions: 1,
    maxTickets: 1,
  });
  const firstSession = dmAuth.createSession();
  const secondSession = dmAuth.createSession();
  assert.equal(dmAuth.authenticate(firstSession.token), null);
  assert.ok(dmAuth.authenticate(secondSession.token));
  const firstDmTicket = dmAuth.issueStreamTicket(secondSession.token);
  const secondDmTicket = dmAuth.issueStreamTicket(secondSession.token);
  assert.equal(dmAuth.consumeStreamTicket(firstDmTicket.ticket), null);
  assert.ok(dmAuth.consumeStreamTicket(secondDmTicket.ticket));
});

test("DM login attempts are throttled without revealing PIN correctness", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-login-limit-",
    env: {
      ALLOW_LOCAL_DM: "false",
      TABLE_PIN: "correct-horse",
    },
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await api(base, "POST", "/api/dm/login", {
      pin: "wrong",
    });
    assert.equal(response.status, 401);
  }
  const limited = await api(base, "POST", "/api/dm/login", {
    pin: "correct-horse",
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, "Too many requests");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("one chat flood does not block another player or the DM", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-chat-limit-",
  });
  const first = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  const second = await api(base, "POST", "/api/player/join", {
    displayName: "Olo",
  });
  const dm = await localDmSession(base);

  const burst = await Promise.all(
    Array.from({ length: 35 }, (_, index) =>
      api(
        base,
        "POST",
        "/api/chat",
        { text: `Flood ${index}` },
        { token: first.data.token },
      ),
    ),
  );
  assert.ok(burst.some((response) => response.status === 429));
  assert.ok(burst.some((response) => response.status === 200));

  const otherPlayer = await api(
    base,
    "POST",
    "/api/chat",
    { text: "Still here" },
    { token: second.data.token },
  );
  assert.equal(otherPlayer.status, 200);

  const dmMessage = await api(
    base,
    "POST",
    "/api/chat",
    { text: "Table pause" },
    { headers: dmHeaders(dm) },
  );
  assert.equal(dmMessage.status, 200);
});

test("player, tracker, and presentation caps fail without growing state", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-capacity-",
    env: {
      MAX_PLAYERS: "2",
      MAX_TRACKERS: "2",
      MAX_PRESENTATION_ITEMS: "2",
    },
  });
  const dm = await localDmSession(base);
  const headers = dmHeaders(dm);

  assert.equal(
    (await api(base, "POST", "/api/player/join", { displayName: "Tav" })).status,
    200,
  );
  assert.equal(
    (await api(base, "POST", "/api/player/join", { displayName: "Olo" })).status,
    200,
  );
  assert.equal(
    (await api(base, "POST", "/api/player/join", { displayName: "Yarn" })).status,
    409,
  );

  for (const name of ["Alarm", "Pursuit"]) {
    assert.equal(
      (
        await api(
          base,
          "POST",
          "/api/status/upsert",
          { name, type: "clock" },
          { headers },
        )
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await api(
        base,
        "POST",
        "/api/status/upsert",
        { name: "Pressure", type: "clock" },
        { headers },
      )
    ).status,
    409,
  );

  for (const text of ["First reveal", "Second reveal"]) {
    assert.equal(
      (
        await api(
          base,
          "POST",
          "/api/reveal/text",
          { text },
          { headers },
        )
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await api(
        base,
        "POST",
        "/api/reveal/text",
        { text: "Third reveal" },
        { headers },
      )
    ).status,
    409,
  );

  const state = await api(base, "GET", "/api/dm/state", undefined, {
    headers: { Cookie: dm.cookie },
  });
  assert.equal(state.data.status.trackers.length, 2);
  assert.equal(state.data.presentation.items.length, 2);
});

test("retained chat evicts the oldest message at its configured cap", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-chat-cap-",
    env: { MAX_CHAT_MESSAGES: "2" },
  });
  const joined = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  for (const text of ["First", "Second", "Third"]) {
    assert.equal(
      (
        await api(
          base,
          "POST",
          "/api/chat",
          { text },
          { token: joined.data.token },
        )
      ).status,
      200,
    );
  }
  const state = await api(
    base,
    "GET",
    "/api/player/state",
    undefined,
    { token: joined.data.token },
  );
  assert.deepEqual(
    state.data.chat.map((message) => message.text),
    ["Second", "Third"],
  );
});

test("SSE and file size caps return bounded failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaign = path.join(root, "Bounded Campaign");
  await mkdir(campaign, { recursive: true });
  await writeFile(
    path.join(campaign, "Director's Guide.md"),
    "# Session 1 - Bounded\n## Scene 1.1: Start\n",
    "utf8",
  );
  await writeFile(path.join(campaign, "large.bin"), Buffer.alloc(64, 1));

  const { base } = await startTestServer(t, {
    root,
    env: {
      MAX_CLIENTS: "1",
      MAX_FILE_BYTES: "16",
    },
  });
  const dm = await localDmSession(base);
  const file = await api(
    base,
    "GET",
    `/api/file?campaign=${encodeURIComponent("Bounded Campaign")}&file=large.bin`,
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(file.status, 413);

  const first = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  const second = await api(base, "POST", "/api/player/join", {
    displayName: "Olo",
  });
  const firstTicket = await api(
    base,
    "POST",
    "/api/player/stream-ticket",
    {},
    { token: first.data.token },
  );
  const secondTicket = await api(
    base,
    "POST",
    "/api/player/stream-ticket",
    {},
    { token: second.data.token },
  );
  const firstStream = await fetch(
    `${base}/api/stream?ticket=${encodeURIComponent(firstTicket.data.ticket)}`,
  );
  assert.equal(firstStream.status, 200);
  const limitedStream = await fetch(
    `${base}/api/stream?ticket=${encodeURIComponent(secondTicket.data.ticket)}`,
  );
  assert.equal(limitedStream.status, 429);
  assert.equal(limitedStream.headers.get("retry-after"), "60");
  await firstStream.body.cancel();
});
