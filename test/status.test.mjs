import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import {
  api as requestApi,
  localDmCookie,
  startTestServer,
  stopTestServer,
} from "../test-support/server.mjs";

let running;
let base;
let tavToken;
let oloToken;
let dmCookie;

function api(method, pathname, body, token) {
  return requestApi(base, method, pathname, body, {
    token,
    headers: dmCookie ? { Cookie: dmCookie } : {},
  });
}

before(async () => {
  running = await startTestServer(null, {
    prefix: "gm-cockpit-status-",
  });
  base = running.base;
  dmCookie = await localDmCookie(base);
  tavToken = (
    await api("POST", "/api/player/join", { displayName: "Tav" })
  ).data.token;
  oloToken = (
    await api("POST", "/api/player/join", { displayName: "Olo" })
  ).data.token;
});

after(async () => {
  await stopTestServer(running?.child);
  if (running?.root) {
    await rm(running.root, { recursive: true, force: true });
  }
});

let clockId;
let meterId;

test("creating a clock applies defaults and explicit max", async () => {
  const { status, data } = await api("POST", "/api/status/upsert", {
    name: "Pursuit",
    type: "clock",
    max: 8,
  });
  assert.equal(status, 200);
  assert.equal(data.tracker.type, "clock");
  assert.equal(data.tracker.max, 8);
  assert.equal(data.tracker.value, 0);
  assert.equal(data.tracker.hidden, false);
  clockId = data.tracker.id;
});

test("tracker values clamp to 0..max", async () => {
  let res = await api("POST", "/api/status/upsert", { id: clockId, value: 99 });
  assert.equal(res.data.tracker.value, 8);
  res = await api("POST", "/api/status/upsert", { id: clockId, value: -3 });
  assert.equal(res.data.tracker.value, 0);
});

test("upsert without a name rejects new trackers", async () => {
  const { status } = await api("POST", "/api/status/upsert", { type: "meter" });
  assert.equal(status, 400);
});

test("upsert with an unknown id returns 404", async () => {
  const { status } = await api("POST", "/api/status/upsert", { id: 9999, value: 1 });
  assert.equal(status, 404);
});

test("hidden trackers are filtered from the player state", async () => {
  const created = await api("POST", "/api/status/upsert", {
    name: "Quarantine",
    type: "meter",
    max: 10,
  });
  meterId = created.data.tracker.id;
  await api("POST", "/api/status/upsert", { id: meterId, hidden: true });

  const playerState = await api("GET", "/api/player/state", undefined, tavToken);
  const playerNames = playerState.data.status.trackers.map((t) => t.name);
  assert.deepEqual(playerNames, ["Pursuit"]);

  const dmStatus = await api("GET", "/api/status");
  assert.equal(dmStatus.data.status.trackers.length, 2);
});

test("revealing a hidden tracker makes it visible to players", async () => {
  await api("POST", "/api/status/upsert", { id: meterId, hidden: false });
  const playerState = await api("GET", "/api/player/state", undefined, tavToken);
  const playerNames = playerState.data.status.trackers.map((t) => t.name);
  assert.deepEqual(playerNames.sort(), ["Pursuit", "Quarantine"]);
});

test("remove deletes a tracker and 404s on repeat", async () => {
  let res = await api("POST", "/api/status/remove", { id: clockId });
  assert.equal(res.status, 200);
  res = await api("POST", "/api/status/remove", { id: clockId });
  assert.equal(res.status, 404);
});

test("/roll produces a server-side table roll", async () => {
  const { status, data } = await api(
    "POST",
    "/api/chat",
    { text: "/roll 2d6+3" },
    tavToken,
  );
  assert.equal(status, 200);
  assert.equal(data.message.type, "roll");
  assert.equal(data.message.scope, "table");
  assert.equal(data.message.roll.expr, "2d6+3");
  const dice = data.message.roll.parts.find((p) => p.kind === "dice");
  assert.equal(dice.rolls.length, 2);
  for (const die of dice.rolls) assert.ok(die >= 1 && die <= 6);
  const sum = dice.rolls[0] + dice.rolls[1] + 3;
  assert.equal(data.message.roll.total, sum);
  assert.ok(sum >= 5 && sum <= 15);
});

test("/r alias and bare dN work; bad expressions are rejected", async () => {
  const ok = await api("POST", "/api/chat", { text: "/r d20" }, tavToken);
  assert.equal(ok.status, 200);
  assert.ok(ok.data.message.roll.total >= 1 && ok.data.message.roll.total <= 20);
  const bad = await api(
    "POST",
    "/api/chat",
    { text: "/roll banana" },
    tavToken,
  );
  assert.equal(bad.status, 400);
  const noDice = await api(
    "POST",
    "/api/chat",
    { text: "/roll 5+3" },
    tavToken,
  );
  assert.equal(noDice.status, 400);
});

test("secret rolls are DM-only and hidden from players", async () => {
  const denied = await api(
    "POST",
    "/api/chat",
    { text: "/sroll d20" },
    tavToken,
  );
  assert.equal(denied.status, 403);

  const { status, data } = await api("POST", "/api/chat", { from: "DM", text: "/sroll d20" });
  assert.equal(status, 200);
  assert.equal(data.message.scope, "secret");

  const playerState = await api("GET", "/api/player/state", undefined, tavToken);
  assert.ok(!playerState.data.chat.some((m) => m.scope === "secret"));

  const dmState = await api("GET", "/api/dm/state");
  assert.ok(dmState.data.chat.some((m) => m.scope === "secret"));
});

test("player whispers reach the DM and the sender only", async () => {
  const { status, data } = await api("POST", "/api/chat", {
    text: "I pocket the gem",
    whisper: true,
  }, tavToken);
  assert.equal(status, 200);
  assert.equal(data.message.scope, "whisper");
  assert.equal(data.message.to, "DM");

  const sender = await api("GET", "/api/player/state", undefined, tavToken);
  assert.ok(sender.data.chat.some((m) => m.scope === "whisper" && m.text === "I pocket the gem"));

  const bystander = await api("GET", "/api/player/state", undefined, oloToken);
  assert.ok(!bystander.data.chat.some((m) => m.scope === "whisper"));

  const dm = await api("GET", "/api/dm/state");
  assert.ok(dm.data.chat.some((m) => m.scope === "whisper" && m.from === "Tav"));
});

test("whispered rolls stay scoped to the DM", async () => {
  const { data } = await api(
    "POST",
    "/api/chat",
    { text: "/roll d6", whisper: true },
    tavToken,
  );
  assert.equal(data.message.scope, "whisper");
  assert.equal(data.message.to, "DM");
  assert.equal(data.message.type, "roll");
});

test("initiative trackers manage entries and wrap the turn", async () => {
  const created = await api("POST", "/api/status/upsert", { name: "Combat", type: "initiative" });
  assert.equal(created.status, 200);
  const id = created.data.tracker.id;
  assert.deepEqual(created.data.tracker.entries, []);
  assert.equal(created.data.tracker.turn, 0);

  let res = await api("POST", "/api/status/upsert", { id, entries: ["Tav", "Goblin", "Olo"] });
  assert.deepEqual(res.data.tracker.entries, ["Tav", "Goblin", "Olo"]);

  res = await api("POST", "/api/status/upsert", { id, turn: 3 });
  assert.equal(res.data.tracker.turn, 0);
  res = await api("POST", "/api/status/upsert", { id, turn: -1 });
  assert.equal(res.data.tracker.turn, 2);

  res = await api("POST", "/api/status/upsert", { id, entries: ["Tav"] });
  assert.equal(res.data.tracker.turn, 0);

  await api("POST", "/api/status/remove", { id });
});
