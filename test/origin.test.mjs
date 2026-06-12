import assert from "node:assert/strict";
import test from "node:test";
import {
  api,
  localDmSession,
  startTestServer,
} from "../test-support/server.mjs";

const SAME_ORIGIN = (base) => base;
const EVIL_ORIGIN = "https://malicious.example";

function browserHeaders(base, extra = {}) {
  return {
    Origin: SAME_ORIGIN(base),
    "Sec-Fetch-Site": "same-origin",
    ...extra,
  };
}

test("cross-origin simple and JSON posts fail without side effects", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-origin-",
  });
  const dm = await localDmSession(base);

  const simple = await fetch(`${base}/api/status/upsert`, {
    method: "POST",
    headers: {
      Cookie: dm.cookie,
      "Content-Type": "text/plain",
      Origin: EVIL_ORIGIN,
      "Sec-Fetch-Site": "cross-site",
    },
    body: JSON.stringify({ name: "Injected", type: "clock" }),
  });
  assert.equal(simple.status, 403);

  const json = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Also Injected", type: "clock" },
    {
      headers: {
        Cookie: dm.cookie,
        Origin: EVIL_ORIGIN,
        "Sec-Fetch-Site": "cross-site",
        "X-GM-Cockpit-CSRF": dm.csrfToken,
      },
    },
  );
  assert.equal(json.status, 403);

  const reboundOrigin = new URL(base);
  reboundOrigin.hostname = "malicious.example";
  const rebound = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Rebound", type: "clock" },
    {
      headers: {
        Cookie: dm.cookie,
        Host: reboundOrigin.host,
        Origin: reboundOrigin.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-GM-Cockpit-CSRF": dm.csrfToken,
      },
    },
  );
  assert.equal(rebound.status, 403);

  const state = await api(
    base,
    "GET",
    "/api/status",
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.deepEqual(state.data.status.trackers, []);
});

test("DM cookie writes require same-origin JSON and the session CSRF token", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-csrf-",
  });
  const dm = await localDmSession(base);
  const common = {
    Cookie: dm.cookie,
    ...browserHeaders(base),
  };

  const missing = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Missing", type: "clock" },
    { headers: common },
  );
  assert.equal(missing.status, 403);

  const wrong = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Wrong", type: "clock" },
    {
      headers: {
        ...common,
        "X-GM-Cockpit-CSRF": "not-the-session-token",
      },
    },
  );
  assert.equal(wrong.status, 403);

  const wrongType = await fetch(`${base}/api/status/upsert`, {
    method: "POST",
    headers: {
      ...common,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-GM-Cockpit-CSRF": dm.csrfToken,
    },
    body: "name=Wrong+Type&type=clock",
  });
  assert.equal(wrongType.status, 415);

  const valid = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Valid", type: "clock" },
    {
      headers: {
        ...common,
        "X-GM-Cockpit-CSRF": dm.csrfToken,
      },
    },
  );
  assert.equal(valid.status, 200);
});

test("player bearer writes require same-origin JSON but not a CSRF token", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-player-origin-",
  });
  const joined = await api(
    base,
    "POST",
    "/api/player/join",
    { displayName: "Tav" },
    { headers: browserHeaders(base) },
  );
  assert.equal(joined.status, 200);

  const valid = await api(
    base,
    "POST",
    "/api/chat",
    { text: "Same origin" },
    {
      token: joined.data.token,
      headers: browserHeaders(base),
    },
  );
  assert.equal(valid.status, 200);

  const crossOrigin = await api(
    base,
    "POST",
    "/api/chat",
    { text: "Cross origin" },
    {
      token: joined.data.token,
      headers: {
        Origin: EVIL_ORIGIN,
        "Sec-Fetch-Site": "cross-site",
      },
    },
  );
  assert.equal(crossOrigin.status, 403);
});

test("security headers protect static and API responses", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-headers-",
  });
  const page = await fetch(`${base}/`);
  const health = await fetch(`${base}/api/health`);

  for (const response of [page, health]) {
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    assert.match(
      response.headers.get("content-security-policy"),
      /script-src 'self'; style-src 'self' 'unsafe-inline'/,
    );
    assert.equal(
      response.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});
