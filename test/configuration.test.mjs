import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadLocalEnvironment } from "../lib/config.mjs";
import {
  api,
  localDmSession,
  startTestServer,
} from "../test-support/server.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function localPath(file) {
  return path.join(repoRoot, file);
}

async function rejectedStartup(env) {
  const child = spawn(process.execPath, [localPath("server.mjs")], {
    env: {
      ...process.env,
      RELAY_URL: "",
      RELAY_AGENT_ID: "",
      RELAY_ROOM_ID: "",
      RELAY_DEVICE_TOKEN: "",
      ...env,
    },
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

test("local environment file loads defaults without replacing shell values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileValueKey = `GM_COCKPIT_FILE_${Date.now()}`;
  const shellValueKey = `GM_COCKPIT_SHELL_${Date.now()}`;
  delete process.env[fileValueKey];
  process.env[shellValueKey] = "from-shell";
  t.after(() => {
    delete process.env[fileValueKey];
    delete process.env[shellValueKey];
  });
  await writeFile(
    path.join(root, ".env"),
    `${fileValueKey}=from-file\n${shellValueKey}=from-file\n`,
    "utf8",
  );

  assert.equal(await loadLocalEnvironment(root), true);
  assert.equal(process.env[fileValueKey], "from-file");
  assert.equal(process.env[shellValueKey], "from-shell");
});

test("portable configuration files contain no personal machine paths", async () => {
  const files = [
    "package.json",
    "README.md",
    ".env.example",
    "MAC SETUP.txt",
    "Start GM Cockpit.ps1",
    "Start GM Cockpit Mac.command",
  ];
  for (const file of files) {
    const content = await readFile(localPath(file), "utf8");
    assert.doesNotMatch(content, /zacht|zacholen/i, file);
    assert.doesNotMatch(content, /\/Users\/[^/\s]+\/Documents\/Obsidian/i, file);
  }

  const packageData = JSON.parse(
    await readFile(localPath("package.json"), "utf8"),
  );
  assert.equal(packageData.scripts.session, undefined);
  assert.equal(packageData.engines.node, ">=20.12");
  assert.equal(packageData.scripts["relay:start"], "node relay/server.mjs");
  assert.equal(
    packageData.scripts["relay:bootstrap"],
    "node relay/bootstrap.mjs",
  );
});

test("documentation describes the supported security and recovery boundary", async () => {
  const readme = await readFile(localPath("README.md"), "utf8");
  const example = await readFile(localPath(".env.example"), "utf8");

  for (const pattern of [
    /trusted local network/i,
    /not\s+designed to be exposed directly to the public internet/i,
    /GET \/api\/health/i,
    /GET \/api\/readiness/i,
    /STATE_DIR/,
    /backup cannot be created/i,
    /single-use ticket/i,
  ]) {
    assert.match(readme, pattern);
  }
  for (const variable of [
    "VAULT_ROOT",
    "HOST",
    "PORT",
    "TABLE_PIN",
    "ALLOW_REMOTE_DM",
    "ALLOW_LOCAL_DM",
    "ALLOWED_ORIGINS",
    "STATE_DIR",
    "RELAY_URL",
    "RELAY_AGENT_ID",
    "RELAY_ROOM_ID",
    "RELAY_DEVICE_TOKEN",
    "RELAY_HOST",
    "RELAY_PORT",
    "RELAY_STATE_FILE",
    "RELAY_TLS_CERT_FILE",
    "RELAY_TLS_KEY_FILE",
  ]) {
    assert.match(example, new RegExp(`\\b${variable}\\b`));
  }
  assert.doesNotMatch(readme, /prints? (?:the )?(?:table )?pin/i);
  assert.match(readme, /outbound `wss:\/\/` connection/i);
  assert.match(readme, /no production hosted relay bundled/i);
  assert.match(readme, /npm run relay:start/i);
  assert.match(readme, /npm run relay:bootstrap/i);
});

test("relay configuration fails closed unless it is complete and secure", async () => {
  const incomplete = await rejectedStartup({
    RELAY_URL: "wss://relay.example.test/agent",
  });
  assert.notEqual(incomplete.code, 0);
  assert.match(incomplete.output, /RELAY_AGENT_ID is required/);

  const insecure = await rejectedStartup({
    RELAY_URL: "ws://relay.example.test/agent",
    RELAY_AGENT_ID: "agent-1",
    RELAY_ROOM_ID: "room-1",
    RELAY_DEVICE_TOKEN: "relay-device-token-123456",
  });
  assert.notEqual(insecure.code, 0);
  assert.match(insecure.output, /must use wss:\/\//);

  const querySecret = await rejectedStartup({
    RELAY_URL: "wss://relay.example.test/agent?token=secret",
    RELAY_AGENT_ID: "agent-1",
    RELAY_ROOM_ID: "room-1",
    RELAY_DEVICE_TOKEN: "relay-device-token-123456",
  });
  assert.notEqual(querySecret.code, 0);
  assert.match(querySecret.output, /must not contain credentials or query/);
});

test("STATE_DIR controls tracker persistence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-state-dir-"));
  const stateDir = path.join(root, "runtime-state");
  const { base } = await startTestServer(t, {
    root,
    env: {
      STATE_DIR: stateDir,
      TRACKERS_FILE: "",
    },
  });
  const dm = await localDmSession(base);
  const created = await api(
    base,
    "POST",
    "/api/status/upsert",
    { name: "Pressure", type: "clock" },
    {
      headers: {
        Cookie: dm.cookie,
        "X-GM-Cockpit-CSRF": dm.csrfToken,
      },
    },
  );
  assert.equal(created.status, 200);
  const saved = JSON.parse(
    await readFile(path.join(stateDir, "trackers.json"), "utf8"),
  );
  assert.equal(saved.trackers[0].name, "Pressure");
});
