import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AtomicJsonStore } from "../lib/atomic-json-store.mjs";
import { Vault, extractProtectedNotes } from "../lib/vault.mjs";

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const validState = (value) =>
  Boolean(value && typeof value === "object" && Array.isArray(value.trackers));

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function availablePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function startTestServer(root, trackersFile) {
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(appRoot, "server.mjs")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TABLE_PIN: "1234",
      TRACKERS_FILE: trackersFile,
      VAULT_ROOT: root,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited during startup:\n${output}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return { base, child, output: () => output };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill();
  throw new Error(`Test server did not start:\n${output}`);
}

async function stopTestServer(child) {
  if (child.exitCode !== null) return child.exitCode;
  const exited = once(child, "exit");
  child.send({ type: "shutdown" });
  const [code, signal] = await exited;
  assert.equal(signal, null);
  return code;
}

async function api(base, method, pathname, body, dmSession) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (dmSession) {
    headers.Cookie = dmSession.cookie;
    headers["X-GM-Cockpit-CSRF"] = dmSession.csrfToken;
  }
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}

async function localDmSession(base) {
  const response = await fetch(`${base}/api/dm/session`);
  assert.equal(response.status, 200);
  const data = await response.json();
  return {
    cookie: response.headers.get("set-cookie").split(";")[0],
    csrfToken: data.csrfToken,
  };
}

test("atomic JSON store loads missing and valid state", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-store-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  const store = new AtomicJsonStore({ file, validate: validState });

  assert.deepEqual(await store.load({ trackers: [] }), { trackers: [] });
  await writeFile(file, JSON.stringify({ trackers: [{ id: 4 }] }), "utf8");
  assert.deepEqual(await store.load({ trackers: [] }), {
    trackers: [{ id: 4 }],
  });
});

test("atomic JSON store quarantines malformed state", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-corrupt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  const warnings = [];
  await writeFile(file, "{ definitely not JSON", "utf8");
  const store = new AtomicJsonStore({
    file,
    validate: validState,
    onWarning: (message) => warnings.push(message),
  });

  assert.deepEqual(await store.load({ trackers: [] }), { trackers: [] });
  const entries = await readdir(root);
  assert.ok(entries.some((entry) => entry.endsWith(".corrupt")));
  assert.ok(!entries.includes("trackers.json"));
  assert.equal(warnings.length, 1);
});

test("atomic JSON store quarantines state that fails validation", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-invalid-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  await writeFile(file, JSON.stringify({ trackers: "not-an-array" }), "utf8");
  const store = new AtomicJsonStore({
    file,
    validate: validState,
    onWarning: () => {},
  });

  assert.deepEqual(await store.load({ trackers: [] }), { trackers: [] });
  assert.ok((await readdir(root)).some((entry) => entry.endsWith(".corrupt")));
});

test("atomic JSON store rejects unsupported snapshots before writing", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-unsupported-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  const store = new AtomicJsonStore({ file, validate: validState });

  await assert.rejects(store.write(undefined), /not serializable/);
  assert.deepEqual(await readdir(root), []);
});

test("rapid writes serialize and persist the final snapshot", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-rapid-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  const store = new AtomicJsonStore({ file, validate: validState });
  const writes = [];

  for (let value = 1; value <= 100; value += 1) {
    writes.push(store.write({ trackers: [{ id: 1, value }] }));
  }
  await Promise.all(writes);
  await store.close();

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.trackers[0].value, 100);
});

test("failed replacement retains the previous valid file", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-interrupt-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  const original = { trackers: [{ id: 1, value: 3 }] };
  await writeFile(file, JSON.stringify(original), "utf8");
  const store = new AtomicJsonStore({
    file,
    validate: validState,
    operations: {
      mkdir,
      open,
      readFile,
      rename: async () => {
        throw Object.assign(new Error("simulated interrupted replace"), {
          code: "EIO",
        });
      },
      unlink,
    },
  });

  await assert.rejects(
    store.write({ trackers: [{ id: 1, value: 9 }] }),
    /interrupted replace/,
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), original);
  assert.ok(!(await readdir(root)).some((entry) => entry.endsWith(".tmp")));
});

test("close waits for an in-flight write and rejects later writes", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-close-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "trackers.json");
  let releaseRename;
  const renameAllowed = new Promise((resolve) => {
    releaseRename = resolve;
  });
  const store = new AtomicJsonStore({
    file,
    validate: validState,
    operations: {
      mkdir,
      open,
      readFile,
      rename: async (...args) => {
        await renameAllowed;
        return rename(...args);
      },
      unlink,
    },
  });

  const write = store.write({ trackers: [{ id: 1, value: 7 }] });
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(closed, false);
  releaseRename();
  await Promise.all([write, closing]);
  assert.equal(closed, true);
  await assert.rejects(
    store.write({ trackers: [] }),
    /closed JSON store/,
  );
});

test("concurrent workbook writes serialize without losing another session", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-workbook-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "app");
  const campaign = path.join(root, "Campaign");
  await mkdir(appRoot, { recursive: true });
  await mkdir(campaign, { recursive: true });
  await writeFile(
    path.join(campaign, "Director's Guide.md"),
    "# Session 1 - One\n## Scene 1.1: Start\n\n# Session 2 - Two\n## Scene 2.1: Continue\n",
    "utf8",
  );
  await writeFile(
    path.join(campaign, "Session Notes Workbook.md"),
    [
      "# Session Notes Workbook",
      "",
      "## Session 1 Notes",
      "<!-- gm-cockpit:session-1:start -->",
      "<!-- gm-cockpit:session-1:end -->",
      "",
      "## Session 2 Notes",
      "<!-- gm-cockpit:session-2:start -->",
      "<!-- gm-cockpit:session-2:end -->",
      "",
    ].join("\n"),
    "utf8",
  );
  const vault = new Vault({ root, appRoot });

  await Promise.all([
    vault.saveNotes("Campaign", 1, "Notes for one"),
    vault.saveNotes("Campaign", 2, "Notes for two"),
  ]);
  await vault.flushWrites();

  const saved = await readFile(
    path.join(campaign, "Session Notes Workbook.md"),
    "utf8",
  );
  assert.equal(extractProtectedNotes(saved, 1), "Notes for one");
  assert.equal(extractProtectedNotes(saved, 2), "Notes for two");
});

test("server startup quarantines malformed trackers and accepts valid state", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-startup-");
  const servers = [];
  t.after(async () => {
    for (const running of servers.reverse()) {
      await stopTestServer(running.child);
    }
    await rm(root, { recursive: true, force: true });
  });
  const trackersFile = path.join(root, "trackers.json");
  await writeFile(trackersFile, "{broken", "utf8");

  const malformedServer = await startTestServer(root, trackersFile);
  servers.push(malformedServer);
  const malformedSession = await localDmSession(malformedServer.base);
  const empty = await api(
    malformedServer.base,
    "GET",
    "/api/status",
    undefined,
    malformedSession,
  );
  assert.deepEqual(empty.data.status.trackers, []);
  assert.equal(await stopTestServer(malformedServer.child), 0);
  assert.ok((await readdir(root)).some((entry) => entry.endsWith(".corrupt")));

  const savedState = {
    trackers: [
      {
        id: 7,
        type: "clock",
        name: "Alarm",
        max: 6,
        value: 2,
        hidden: false,
      },
    ],
  };
  await writeFile(trackersFile, JSON.stringify(savedState), "utf8");
  const validServer = await startTestServer(root, trackersFile);
  servers.push(validServer);
  const validSession = await localDmSession(validServer.base);
  const loaded = await api(
    validServer.base,
    "GET",
    "/api/status",
    undefined,
    validSession,
  );
  assert.deepEqual(loaded.data.status.trackers, savedState.trackers);
  assert.equal(await stopTestServer(validServer.child), 0);
});

test("rapid tracker API updates persist the final value and shut down cleanly", async (t) => {
  const root = await temporaryDirectory("gm-cockpit-server-persist-");
  const trackersFile = path.join(root, "trackers.json");
  const running = await startTestServer(root, trackersFile);
  t.after(async () => {
    await stopTestServer(running.child);
    await rm(root, { recursive: true, force: true });
  });
  const dmSession = await localDmSession(running.base);
  const created = await api(running.base, "POST", "/api/status/upsert", {
    name: "Pressure",
    type: "meter",
    max: 1000,
  }, dmSession);
  const id = created.data.tracker.id;

  await Promise.all(
    Array.from({ length: 99 }, (_, index) =>
      api(running.base, "POST", "/api/status/upsert", {
        id,
        value: index + 1,
      }, dmSession),
    ),
  );
  const final = await api(running.base, "POST", "/api/status/upsert", {
    id,
    value: 100,
  }, dmSession);
  assert.equal(final.status, 200);
  assert.equal(final.data.tracker.value, 100);

  const persisted = JSON.parse(await readFile(trackersFile, "utf8"));
  assert.equal(persisted.trackers[0].value, 100);
  assert.equal(await stopTestServer(running.child), 0);
  assert.ok(!(await readdir(root)).some((entry) => entry.endsWith(".tmp")));
});
