import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { DmAuth } from "../lib/dm-auth.mjs";
import {
  api,
  appRoot,
  startTestServer,
} from "../test-support/server.mjs";

function cookieFrom(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

async function rejectedStartup(env) {
  const child = spawn(process.execPath, [path.join(appRoot, "server.mjs")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("DM sessions enforce idle and absolute expiry", () => {
  let time = 1_000;
  let sequence = 0;
  const auth = new DmAuth({
    pin: "correct horse",
    now: () => time,
    random: () => `random-${++sequence}`,
    idleTtlMs: 50,
    absoluteTtlMs: 120,
  });
  assert.equal(auth.login("wrong"), null);
  const first = auth.login("correct horse");
  assert.ok(first.token);
  assert.ok(auth.authenticate(first.token));
  time += 49;
  assert.ok(auth.authenticate(first.token));
  time += 50;
  assert.equal(auth.authenticate(first.token), null);

  let absoluteTime = 10_000;
  let absoluteSequence = 0;
  const absoluteAuth = new DmAuth({
    pin: "correct horse",
    now: () => absoluteTime,
    random: () => `absolute-${++absoluteSequence}`,
    idleTtlMs: 1_000,
    absoluteTtlMs: 120,
  });
  const second = absoluteAuth.login("correct horse");
  absoluteTime += 119;
  assert.ok(absoluteAuth.authenticate(second.token));
  absoluteTime += 1;
  assert.equal(absoluteAuth.authenticate(second.token), null);
});

test("DM stream tickets are short-lived and single-use", () => {
  let time = 5_000;
  let sequence = 0;
  const auth = new DmAuth({
    pin: "correct horse",
    now: () => time,
    random: () => `random-${++sequence}`,
    ticketTtlMs: 25,
  });
  const session = auth.login("correct horse");
  const first = auth.issueStreamTicket(session.token);
  assert.ok(auth.consumeStreamTicket(first.ticket));
  assert.equal(auth.consumeStreamTicket(first.ticket), null);
  const expired = auth.issueStreamTicket(session.token);
  time += 25;
  assert.equal(auth.consumeStreamTicket(expired.ticket), null);
});

test("remote binding requires explicit opt-in and a strong PIN", async () => {
  const noOptIn = await rejectedStartup({
    HOST: "0.0.0.0",
    ALLOW_REMOTE_DM: "false",
    TABLE_PIN: "long-enough",
  });
  assert.notEqual(noOptIn.code, 0);
  assert.match(noOptIn.output, /ALLOW_REMOTE_DM=true/);

  const missingPin = await rejectedStartup({
    HOST: "0.0.0.0",
    ALLOW_REMOTE_DM: "true",
    TABLE_PIN: "",
  });
  assert.notEqual(missingPin.code, 0);
  assert.match(missingPin.output, /TABLE_PIN must be configured/);

  const weakPin = await rejectedStartup({
    HOST: "0.0.0.0",
    ALLOW_REMOTE_DM: "true",
    TABLE_PIN: "1234",
  });
  assert.notEqual(weakPin.code, 0);
  assert.match(weakPin.output, /at least 6 characters/);
});

test("remote-style DM login uses an opaque cookie and protects APIs", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-auth-",
    env: {
      ALLOW_LOCAL_DM: "false",
      TABLE_PIN: "correct-horse",
    },
  });

  const page = await fetch(`${base}/`);
  const script = await fetch(`${base}/app.js`);
  assert.equal(page.status, 200);
  assert.equal(script.status, 200);
  assert.ok(!page.url.includes("correct-horse"));

  const denied = await api(base, "GET", "/api/campaigns");
  assert.equal(denied.status, 401);
  const malformedCookie = await api(
    base,
    "GET",
    "/api/campaigns",
    undefined,
    { headers: { Cookie: "gm-cockpit-dm=%E0%A4%A" } },
  );
  assert.equal(malformedCookie.status, 401);
  const player = await api(base, "POST", "/api/player/join", {
    displayName: "Tav",
  });
  const playerDenied = await api(
    base,
    "GET",
    "/api/campaigns",
    undefined,
    { token: player.data.token },
  );
  assert.equal(playerDenied.status, 401);

  const invalid = await api(base, "POST", "/api/dm/login", {
    pin: "wrong",
  });
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.get("set-cookie"), null);

  const login = await api(base, "POST", "/api/dm/login", {
    pin: "correct-horse",
  });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  assert.match(cookie, /^gm-cockpit-dm=/);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/i);
  assert.doesNotMatch(cookie, /correct-horse/);

  const allowed = await api(
    base,
    "GET",
    "/api/campaigns",
    undefined,
    { headers: { Cookie: cookie } },
  );
  assert.equal(allowed.status, 200);

  const ticket = await api(
    base,
    "POST",
    "/api/dm/stream-ticket",
    {},
    {
      headers: {
        Cookie: cookie,
        "X-GM-Cockpit-CSRF": login.data.csrfToken,
      },
    },
  );
  assert.equal(ticket.status, 200);
  const stream = await fetch(
    `${base}/api/stream?role=dm&ticket=${encodeURIComponent(ticket.data.ticket)}`,
  );
  assert.equal(stream.status, 200);
  await stream.body.cancel();
  const reused = await fetch(
    `${base}/api/stream?role=dm&ticket=${encodeURIComponent(ticket.data.ticket)}`,
  );
  assert.equal(reused.status, 401);

  const logout = await api(
    base,
    "POST",
    "/api/dm/logout",
    {},
    {
      headers: {
        Cookie: cookie,
        "X-GM-Cockpit-CSRF": login.data.csrfToken,
      },
    },
  );
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/i);
  const afterLogout = await api(
    base,
    "GET",
    "/api/campaigns",
    undefined,
    { headers: { Cookie: cookie } },
  );
  assert.equal(afterLogout.status, 401);
});

test("loopback session endpoint keeps local DM access frictionless", async (t) => {
  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-local-auth-",
    env: { TABLE_PIN: "correct-horse" },
  });
  const session = await api(base, "GET", "/api/dm/session");
  assert.equal(session.status, 200);
  assert.equal(session.data.session.role, "dm");
  assert.match(session.headers.get("set-cookie"), /^gm-cockpit-dm=/);
});
