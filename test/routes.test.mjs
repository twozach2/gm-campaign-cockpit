import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { API_ROUTES, apiRoute } from "../lib/api-policy.mjs";
import {
  api,
  localDmSession,
  startTestServer,
} from "../test-support/server.mjs";

const EXPECTED_ROUTES = [
  "/api/campaigns",
  "/api/chat",
  "/api/dm/login",
  "/api/dm/logout",
  "/api/dm/session",
  "/api/dm/state",
  "/api/dm/stream-ticket",
  "/api/document",
  "/api/documents",
  "/api/file",
  "/api/health",
  "/api/notes",
  "/api/player-guide",
  "/api/player/image",
  "/api/player/join",
  "/api/player/leave",
  "/api/player/rename",
  "/api/player/state",
  "/api/player/stream-ticket",
  "/api/reveal/card",
  "/api/reveal/clear",
  "/api/reveal/image",
  "/api/reveal/remove",
  "/api/reveal/text",
  "/api/session",
  "/api/sessions",
  "/api/status",
  "/api/status/remove",
  "/api/status/upsert",
  "/api/stream",
  "/api/validate",
  "/api/whisper",
];

function dmHeaders(session) {
  return {
    Cookie: session.cookie,
    "X-GM-Cockpit-CSRF": session.csrfToken,
  };
}

test("route policy enumerates every API handler", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const handled = [
    ...new Set(
      [...source.matchAll(/url\.pathname === "(\/api\/[^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
  const declared = Object.keys(API_ROUTES).sort();

  assert.deepEqual(declared, EXPECTED_ROUTES);
  assert.deepEqual(handled, EXPECTED_ROUTES);
  assert.equal(apiRoute("/api/not-real"), null);
  for (const [pathname, policy] of Object.entries(API_ROUTES)) {
    assert.ok(["GET", "POST"].includes(policy.method), pathname);
    assert.ok(
      ["public", "player", "dm", "dm-or-player", "ticket", "revealed"].includes(
        policy.role,
      ),
      pathname,
    );
    assert.equal(policy.mutates, policy.method !== "GET", pathname);
    assert.ok(Number.isSafeInteger(policy.maxBodyBytes), pathname);
    assert.ok(policy.maxBodyBytes > 0, pathname);
    assert.equal(typeof policy.parseQuery, "function", pathname);
    if (policy.method === "POST") {
      assert.equal(typeof policy.parseBody, "function", pathname);
    }
  }
});

test("every API route returns 405 and Allow for the wrong method", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-route-method-",
  });

  for (const [pathname, policy] of Object.entries(API_ROUTES)) {
    const wrongMethod = policy.method === "GET" ? "POST" : "GET";
    const response = await api(
      base,
      wrongMethod,
      pathname,
      wrongMethod === "POST" ? {} : undefined,
    );
    assert.equal(response.status, 405, `${wrongMethod} ${pathname}`);
    assert.equal(response.headers.get("allow"), policy.method, pathname);
  }
});

test("declared DM and player routes reject missing identity before parsing", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-route-auth-",
  });

  for (const [pathname, policy] of Object.entries(API_ROUTES)) {
    if (!["dm", "player", "dm-or-player"].includes(policy.role)) continue;
    const response = await api(
      base,
      policy.method,
      pathname,
      policy.method === "POST" ? { deliberately: "invalid" } : undefined,
    );
    assert.equal(response.status, 401, `${policy.method} ${pathname}`);
  }
});

test("route schemas reject unknown, mistyped, and oversized input", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-route-schema-",
  });
  const dm = await localDmSession(base);
  const headers = dmHeaders(dm);

  const unknownBody = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Alarm", type: "clock", admin: true },
    { headers },
  );
  assert.equal(unknownBody.status, 400);
  assert.match(unknownBody.data.error, /Unknown request field/);

  const numericString = await api(
    base,
    "POST",
    "/api/status/remove",
    { id: "1" },
    { headers },
  );
  assert.equal(numericString.status, 400);

  const invalidType = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Alarm", type: "countdown" },
    { headers },
  );
  assert.equal(invalidType.status, 400);

  const unknownQuery = await api(
    base,
    "GET",
    "/api/campaigns?unexpected=true",
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(unknownQuery.status, 400);

  const missingQuery = await api(
    base,
    "GET",
    "/api/sessions",
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(missingQuery.status, 400);

  const malformedJson = await fetch(`${base}/api/status/upsert`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: "{",
  });
  assert.equal(malformedJson.status, 400);

  const oversized = await fetch(`${base}/api/dm/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "x".repeat(5_000) }),
  });
  assert.equal(oversized.status, 413);
});

test("validated bodies preserve server-derived sender identity", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-route-identity-",
  });
  const joined = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  const sent = await api(
    base,
    "POST",
    "/api/chat",
    { text: "Still me", from: "DM" },
    { token: joined.data.token },
  );

  assert.equal(sent.status, 200);
  assert.equal(sent.data.message.from, "Tav");
  assert.equal(sent.data.message.fromPlayerId, joined.data.player.playerId);
});
