import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalEnvironment } from "../lib/config.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const relayRoot = path.dirname(fileURLToPath(import.meta.url));
await loadLocalEnvironment(path.dirname(relayRoot));

function positiveInteger(name, fallback, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

const targetText = process.argv[2] || process.env.RELAY_SOAK_URL;
if (!targetText) {
  throw new Error(
    "Set RELAY_SOAK_URL or pass the relay origin after --",
  );
}
const target = new URL(targetText);
const loopback = ["127.0.0.1", "::1", "localhost"].includes(
  target.hostname.toLowerCase(),
);
if (
  target.origin !== targetText.replace(/\/$/, "") ||
  (target.protocol !== "https:" &&
    !(target.protocol === "http:" && loopback))
) {
  throw new Error("The soak target must be an HTTPS origin or loopback HTTP");
}

const durationSeconds = positiveInteger(
  "RELAY_SOAK_DURATION_SECONDS",
  300,
  86_400,
);
const concurrency = positiveInteger("RELAY_SOAK_CONCURRENCY", 5, 100);
const region = String(process.env.RELAY_SOAK_REGION || "unspecified")
  .trim()
  .slice(0, 80);
const deadline = Date.now() + durationSeconds * 1_000;
const latencies = [];
const statuses = {};
let requests = 0;
let failures = 0;

async function probe(pathname) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL(pathname, target), {
      signal: controller.signal,
      redirect: "error",
    });
    const key = `${pathname}:${response.status}`;
    statuses[key] = (statuses[key] || 0) + 1;
    requests += 1;
    if (response.status !== 200) failures += 1;
    await response.arrayBuffer();
  } catch (error) {
    failures += 1;
    requests += 1;
    const key = `network:${error.name || "Error"}`;
    statuses[key] = (statuses[key] || 0) + 1;
  } finally {
    clearTimeout(timeout);
    latencies.push(performance.now() - startedAt);
  }
}

async function worker(index) {
  let sequence = index;
  while (Date.now() < deadline) {
    await probe(sequence % 2 === 0 ? "/health" : "/readiness");
    sequence += concurrency;
    await delay(100);
  }
}

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => worker(index)),
);

const report = {
  target: target.origin,
  region,
  durationSeconds,
  concurrency,
  requests,
  failures,
  failureRate: requests ? failures / requests : 1,
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.length ? Math.max(...latencies) : null,
  },
  statuses,
};
console.log(JSON.stringify(report, null, 2));
if (failures > 0) process.exitCode = 1;
