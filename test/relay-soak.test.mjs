import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("relay soak command measures loopback health and readiness", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/readiness") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ready":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  const target = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, "relay", "soak.mjs"), target],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        RELAY_SOAK_DURATION_SECONDS: "1",
        RELAY_SOAK_CONCURRENCY: "2",
        RELAY_SOAK_REGION: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
  const report = JSON.parse(output);
  assert.equal(report.target, target);
  assert.equal(report.region, "test");
  assert.equal(report.failures, 0);
  assert.ok(report.requests >= 2);
  assert.ok(report.latencyMs.p95 >= 0);
  assert.ok(report.statuses["/health:200"] >= 1);
  assert.ok(report.statuses["/readiness:200"] >= 1);
});
