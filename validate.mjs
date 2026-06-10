import path from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "./lib/vault.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const argRoot = process.argv[2];
const vaultRoot = path.resolve(argRoot || process.env.VAULT_ROOT || path.join(appRoot, ".."));
const vault = new Vault({ root: vaultRoot, appRoot });

function line(symbol, message) {
  console.log(`  ${symbol} ${message}`);
}

function report({ reports, skipped }) {
  console.log(`\nGM Campaign Cockpit — validating vault:\n  ${vaultRoot}\n`);

  if (!reports.length) {
    console.log("No campaigns found. A campaign is any folder containing \"Director's Guide.md\".");
  }

  let errorCount = 0;
  let warningCount = 0;

  for (const campaign of reports) {
    const status = campaign.ok ? (campaign.warnings.length ? "⚠" : "✓") : "✗";
    console.log(`${status}  ${campaign.name}`);
    const { sessions = 0, scenes = 0, links = 0, missingLinks = 0 } = campaign.stats;
    if (campaign.ok || sessions) {
      line("·", `${sessions} sessions · ${scenes} scenes · ${links} links${missingLinks ? ` · ${missingLinks} broken` : ""}`);
    }
    for (const item of campaign.errors) {
      errorCount += 1;
      line("✗", item.message);
    }
    for (const item of campaign.warnings) {
      warningCount += 1;
      line("⚠", item.message);
    }
    for (const item of campaign.info) {
      line("·", item.message);
    }
    console.log("");
  }

  if (skipped.length) {
    console.log("Skipped (no Director's Guide.md):");
    for (const name of skipped) line("·", name);
    console.log("");
  }

  console.log(`Summary: ${reports.length} campaign(s), ${errorCount} error(s), ${warningCount} warning(s).\n`);
  return errorCount;
}

try {
  const result = await vault.validateAll();
  const errorCount = report(result);
  process.exit(errorCount > 0 ? 1 : 0);
} catch (error) {
  console.error(`\nValidation could not run: ${error.message}\n`);
  process.exit(2);
}
