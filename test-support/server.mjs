import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

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

export async function stopTestServer(child) {
  if (!child || child.exitCode !== null) return child?.exitCode ?? 0;
  const exited = once(child, "exit");
  if (child.connected) child.send({ type: "shutdown" });
  else child.kill("SIGTERM");
  const [code] = await exited;
  return code;
}

export async function startTestServer(
  t,
  { prefix = "gm-cockpit-server-", env = {}, root } = {},
) {
  const temporaryRoot = root || (await mkdtemp(path.join(os.tmpdir(), prefix)));
  const ownsRoot = !root;
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(appRoot, "server.mjs")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TABLE_PIN: "1234",
      TRACKERS_FILE: path.join(temporaryRoot, "trackers.json"),
      VAULT_ROOT: temporaryRoot,
      ...env,
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

  if (t) {
    t.after(async () => {
      await stopTestServer(child);
      if (ownsRoot) {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    });
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited during startup:\n${output}`);
    }
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return {
          appRoot,
          base,
          child,
          output: () => output,
          root: temporaryRoot,
        };
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await stopTestServer(child);
  if (ownsRoot) await rm(temporaryRoot, { recursive: true, force: true });
  throw new Error(`Test server did not start:\n${output}`);
}

export async function api(
  base,
  method,
  pathname,
  body,
  { token, headers = {} } = {},
) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data, headers: response.headers };
}
