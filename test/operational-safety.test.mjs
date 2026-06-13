import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLogger } from "../lib/logger.mjs";
import { Vault, extractProtectedNotes } from "../lib/vault.mjs";
import { openTicketedEventSource } from "../public/stream-connection.mjs";
import {
  api,
  localDmSession,
  startTestServer,
  stopTestServer,
} from "../test-support/server.mjs";

test("structured logger removes credentials, private content, and paths", () => {
  const lines = [];
  const logger = createLogger({
    now: () => "2026-06-12T00:00:00.000Z",
    write: (_level, line) => lines.push(line),
  });

  logger.error("test_event", {
    route: "/api/test",
    outcome: "failed",
    pin: "pin-secret",
    token: "token-secret",
    csrfToken: "csrf-secret",
    cookie: "cookie-secret",
    notes: "notes-secret",
    whisper: "whisper-secret",
    vaultPath: "C:\\private\\vault",
    error: Object.assign(new Error("message-secret"), { code: "EIO" }),
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /"event":"test_event"/);
  assert.match(lines[0], /"route":"\/api\/test"/);
  assert.match(lines[0], /"code":"EIO"/);
  for (const secret of [
    "pin-secret",
    "token-secret",
    "csrf-secret",
    "cookie-secret",
    "notes-secret",
    "whisper-secret",
    "C:\\private\\vault",
    "message-secret",
  ]) {
    assert.doesNotMatch(lines[0], new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("ticketed stream reconnects request a fresh ticket every time", async () => {
  const issued = [];
  const opened = [];
  const issueTicket = async () => {
    const ticket = `ticket-${issued.length + 1}`;
    issued.push(ticket);
    return { ticket };
  };
  const options = {
    issueTicket,
    buildUrl: (ticket) => `/api/stream?ticket=${ticket}`,
    createEventSource: (url) => {
      opened.push(url);
      return { url };
    },
  };

  await openTicketedEventSource(options);
  await openTicketedEventSource(options);

  assert.deepEqual(issued, ["ticket-1", "ticket-2"]);
  assert.deepEqual(opened, [
    "/api/stream?ticket=ticket-1",
    "/api/stream?ticket=ticket-2",
  ]);
});

test("health and readiness do not expose the vault path", async (t) => {
  const { base, root } = await startTestServer(t, {
    prefix: "gm-cockpit-health-",
  });

  const health = await api(base, "GET", "/api/health");
  const readiness = await api(base, "GET", "/api/readiness");
  assert.deepEqual(health.data, { ok: true });
  assert.equal(readiness.status, 200);
  assert.deepEqual(readiness.data, {
    ready: true,
    checks: { persistence: "ready", vault: "ready" },
  });
  assert.doesNotMatch(JSON.stringify(health.data), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(JSON.stringify(readiness.data), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("server logs operational events without request secrets", async (t) => {
  const tablePin = "correct-horse-private";
  const wrongPin = "wrong-pin-private";
  const chatText = "private-chat-content";
  const { base, child, output } = await startTestServer(null, {
    prefix: "gm-cockpit-log-redaction-",
    env: {
      ALLOW_LOCAL_DM: "false",
      TABLE_PIN: tablePin,
    },
  });
  t.after(async () => {
    await stopTestServer(child);
  });

  await api(base, "POST", "/api/dm/login", { pin: wrongPin });
  const login = await api(base, "POST", "/api/dm/login", { pin: tablePin });
  const joined = await api(base, "POST", "/api/player/join", {
    displayName: "Private Player",
  });
  await api(
    base,
    "POST",
    "/api/chat",
    { text: chatText },
    { token: joined.data.token },
  );
  await stopTestServer(child);

  const log = output();
  assert.match(log, /"event":"startup"/);
  assert.match(log, /"event":"dm_login"/);
  assert.match(log, /"event":"player_joined"/);
  assert.match(log, /"event":"shutdown_complete"/);
  for (const secret of [
    tablePin,
    wrongPin,
    chatText,
    joined.data.token,
    login.data.csrfToken,
  ]) {
    assert.doesNotMatch(log, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("tracker persistence failure rolls back memory and returns a safe error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-persist-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "state");
  const trackersFile = path.join(statePath, "trackers.json");
  const { base, output } = await startTestServer(t, {
    root,
    env: { TRACKERS_FILE: trackersFile },
  });
  await writeFile(statePath, "blocks tracker directory creation", "utf8");
  const dm = await localDmSession(base);
  const headers = {
    Cookie: dm.cookie,
    "X-GM-Cockpit-CSRF": dm.csrfToken,
  };

  const created = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Pressure", type: "clock" },
    { headers },
  );
  assert.equal(created.status, 503);
  assert.equal(created.data.error, "Tracker changes could not be saved");

  const status = await api(
    base,
    "GET",
    "/api/status",
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.deepEqual(status.data.status.trackers, []);
  assert.match(output(), /"event":"persistence_failure"/);
  assert.doesNotMatch(output(), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("backup failure leaves the workbook unchanged and reports a safe error", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-backup-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "app");
  const campaign = path.join(root, "Campaign");
  await mkdir(appRoot);
  await mkdir(campaign);
  await writeFile(
    path.join(campaign, "Director's Guide.md"),
    "# Session 1: Start\n## Scene 1.1: Door\n",
    "utf8",
  );
  const workbook = [
    "# Session Notes Workbook",
    "",
    "<!-- gm-cockpit:session-1:start -->",
    "Original",
    "<!-- gm-cockpit:session-1:end -->",
    "",
  ].join("\n");
  const workbookPath = path.join(campaign, "Session Notes Workbook.md");
  await writeFile(workbookPath, workbook, "utf8");
  await writeFile(path.join(appRoot, "data"), "blocks backup directory", "utf8");
  const vault = new Vault({ root, appRoot });

  await assert.rejects(
    () => vault.saveNotes("Campaign", 1, "Replacement"),
    (error) =>
      error.status === 503 &&
      error.expose === true &&
      error.code === "NOTES_BACKUP_FAILED" &&
      error.message === "Notes were not saved because a backup could not be created",
  );
  const unchanged = await readFile(workbookPath, "utf8");
  assert.equal(extractProtectedNotes(unchanged, 1), "Original");
});

test("unexpected server failures return a generic error without path disclosure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-generic-error-"));
  const { base, output } = await startTestServer(t, { root });
  const dm = await localDmSession(base);
  await rm(root, { recursive: true, force: true });

  const response = await api(
    base,
    "GET",
    "/api/campaigns",
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(response.data, { error: "Internal server error" });
  assert.doesNotMatch(output(), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
