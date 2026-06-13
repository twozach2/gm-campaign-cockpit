import { access } from "node:fs/promises";
import path from "node:path";

export async function loadLocalEnvironment(appRoot) {
  const envFile = path.join(appRoot, ".env");
  try {
    await access(envFile);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  if (typeof process.loadEnvFile !== "function") {
    throw new Error(
      "Loading .env requires a current Node.js LTS release (20.12 or newer)",
    );
  }
  process.loadEnvFile(envFile);
  return true;
}
