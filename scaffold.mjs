import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(appRoot, "templates");

function resolveVaultRoot() {
  return path.resolve(process.env.VAULT_ROOT || path.join(appRoot, ".."));
}

export async function scaffoldCampaign(campaignName, options = {}) {
  const name = String(campaignName || "").trim();
  if (!name) {
    throw Object.assign(new Error("A campaign name is required"), { status: 400 });
  }
  if (/[\\/]|\.\./.test(name)) {
    throw Object.assign(new Error("Campaign name cannot contain slashes or '..'"), { status: 400 });
  }

  const vaultRoot = options.vaultRoot || resolveVaultRoot();
  const templatesDir = options.templatesDir || TEMPLATES_DIR;
  const target = path.join(vaultRoot, name);

  let exists = true;
  try { await access(target); } catch { exists = false; }
  if (exists) {
    throw Object.assign(new Error(`"${name}" already exists in the vault`), { status: 409 });
  }

  await mkdir(target, { recursive: true });
  const created = [];
  for (const entry of await readdir(templatesDir)) {
    if (!entry.endsWith(".md")) continue;
    const raw = await readFile(path.join(templatesDir, entry), "utf8");
    const content = raw.replaceAll("__CAMPAIGN_NAME__", name);
    await writeFile(path.join(target, entry), content, "utf8");
    created.push(entry);
  }
  return { campaign: name, folder: target, files: created.sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv.slice(2).join(" ").trim();
  try {
    const result = await scaffoldCampaign(name);
    console.log(`Created campaign "${result.campaign}" at:\n  ${result.folder}`);
    console.log(`Files: ${result.files.join(", ")}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Edit "Director's Guide.md" — replace the placeholder sessions/scenes.`);
    console.log(`  2. Run:  VAULT_ROOT="..." npm run check   (should report 0 errors/warnings)`);
    console.log(`  3. Run:  npm start   and open the campaign in the cockpit.`);
  } catch (error) {
    console.error(`Could not scaffold: ${error.message}`);
    process.exitCode = 1;
  }
}
