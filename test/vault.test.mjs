import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  Vault,
  collectWikiLinks,
  extractProtectedNotes,
  parseScenes,
  parseSessions,
} from "../lib/vault.mjs";
import { scaffoldCampaign } from "../scaffold.mjs";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(appRoot, "..", "templates");

const guide = `---
campaign: Test Campaign
---
# Session 11 — Before
Old material.

# Session 12 — The Forge Below ^test-session-12
## Session Overview
See [[Location — Foundry]].

## Scene 12.1: The Cell Block ^test-scene-12-1
Escape through [[Location — Foundry#Prison|the prison]].

## Scene 12.2: The Mark ^test-scene-12-2
Find the mark.

# Session 13 — After
Future material.
`;

const playerGuide = `---
campaign: Test Campaign
---
# Player's Guide
Welcome, adventurers.

## The North
Snowy.

## The North
Still snowy.

## Giants
Big.
`;

const workbook = `# Session 12 — The Forge Below ^test-workbook-12

## Live Session Notes

<!-- gm-cockpit:session-12:start -->
Original note
<!-- gm-cockpit:session-12:end -->
`;

test("parses sessions, scenes, and wiki links", () => {
  const sessions = parseSessions(guide);
  assert.deepEqual(
    sessions.map((session) => [session.number, session.title]),
    [
      [11, "Before"],
      [12, "The Forge Below"],
      [13, "After"],
    ],
  );

  const scenes = parseScenes(sessions[1].markdown, 12);
  assert.equal(scenes.length, 2);
  assert.equal(scenes[1].title, "The Mark");
  assert.deepEqual(collectWikiLinks(scenes[0].markdown)[0], {
    file: "Location — Foundry",
    heading: "Prison",
    label: "the prison",
    embed: false,
  });
});

test("parseSessions ignores sub-headings that lack a separator", () => {
  const markdown = `# Session 0: Campaign Launch
## Session 0 End State
## Session 0 Closing Line
### Session 0 Closing Line Options

# Session 1: Accusation
## Session 1 Post-Session Notes
`;
  const sessions = parseSessions(markdown);
  assert.deepEqual(
    sessions.map((session) => [session.number, session.title]),
    [
      [0, "Campaign Launch"],
      [1, "Accusation"],
    ],
  );
});

test("parseScenes accepts a parenthetical qualifier before the separator", () => {
  const markdown = `## Scene 13.1: Two Messages
## Scene 13.2 (Setesh path): The Open Yard at Noon
## Scene 13.3 (Setesh path): The Obelisk of Set
`;
  const scenes = parseScenes(markdown, 13);
  assert.equal(scenes.length, 3);
  assert.deepEqual(
    scenes.map((scene) => [scene.id, scene.title]),
    [
      ["13.1", "Two Messages"],
      ["13.2", "The Open Yard at Noon"],
      ["13.3", "The Obelisk of Set"],
    ],
  );
});

test("writes only the protected notes block and creates a backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-"));
  const appRoot = path.join(root, "GM Campaign Cockpit");
  const campaignFolder = path.join(root, "Test Campaign");
  await mkdir(appRoot, { recursive: true });
  await mkdir(campaignFolder, { recursive: true });
  await writeFile(path.join(campaignFolder, "Director's Guide.md"), guide, "utf8");
  await writeFile(path.join(campaignFolder, "Session Notes Workbook.md"), workbook, "utf8");
  await writeFile(path.join(campaignFolder, "Location — Foundry.md"), "# Foundry\n\n## Prison\nStone cells.", "utf8");

  const vault = new Vault({ root, appRoot });
  const session = await vault.session("Test Campaign", 12);
  assert.equal(session.scenes.length, 2);
  assert.equal(session.notes, "Original note");

  const result = await vault.saveNotes("Test Campaign", 12, "Round 1: alarms raised.");
  assert.equal(result.saved, true);

  const updated = await readFile(path.join(campaignFolder, "Session Notes Workbook.md"), "utf8");
  assert.equal(extractProtectedNotes(updated, 12), "Round 1: alarms raised.");
  assert.match(updated, /^# Session 12/m);

  const backupFolder = path.join(appRoot, "data", "backups", "Test_Campaign");
  const backups = await readdir(backupFolder);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(backupFolder, backups[0]), "utf8"), workbook);

  const document = await vault.resolveDocument("Test Campaign", "Location — Foundry", "Prison");
  assert.match(document.markdown, /^## Prison/m);
  assert.doesNotMatch(document.markdown, /^# Foundry/m);
});

async function setupCampaign() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-"));
  const appRoot = path.join(root, "GM Campaign Cockpit");
  const campaignFolder = path.join(root, "Test Campaign");
  await mkdir(appRoot, { recursive: true });
  await mkdir(campaignFolder, { recursive: true });
  await writeFile(path.join(campaignFolder, "Director's Guide.md"), guide, "utf8");
  return { root, appRoot, campaignFolder, vault: new Vault({ root, appRoot }) };
}

test("saveNotes auto-creates a protected block when missing", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "Session Notes Workbook.md"), workbook, "utf8");

  const result = await vault.saveNotes("Test Campaign", 13, "Fresh notes for 13.");
  assert.equal(result.created, true);

  const updated = await readFile(path.join(campaignFolder, "Session Notes Workbook.md"), "utf8");
  assert.equal(extractProtectedNotes(updated, 13), "Fresh notes for 13.");
  assert.equal(extractProtectedNotes(updated, 12), "Original note");
});

test("saveNotes creates the workbook when it does not exist", async () => {
  const { campaignFolder, vault } = await setupCampaign();

  const result = await vault.saveNotes("Test Campaign", 12, "First notes.");
  assert.equal(result.created, true);
  assert.equal(result.backup, null);

  const updated = await readFile(path.join(campaignFolder, "Session Notes Workbook.md"), "utf8");
  assert.equal(extractProtectedNotes(updated, 12), "First notes.");
});

test("listDocuments lists campaign files recursively", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "Location — Foundry.md"), "# Foundry", "utf8");
  await mkdir(path.join(campaignFolder, "Maps"), { recursive: true });
  await writeFile(path.join(campaignFolder, "Maps", "overland.png"), "fake-bytes", "utf8");

  const docs = await vault.listDocuments("Test Campaign");
  const map = docs.find((doc) => doc.file === "Maps/overland.png");
  assert.ok(map, "nested file should be listed");
  assert.equal(map.name, "overland");
  assert.equal(map.ext, "png");
  assert.ok(docs.some((doc) => doc.file === "Director's Guide.md"));
});

test("resolveFilePath resolves within campaign and blocks traversal", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "art.png"), "fake-bytes", "utf8");

  const resolved = await vault.resolveFilePath("Test Campaign", "art.png");
  assert.equal(resolved, await realpath(path.join(campaignFolder, "art.png")));

  await assert.rejects(
    () => vault.resolveFilePath("Test Campaign", "../../../etc/hosts"),
    /outside the campaign/,
  );
});

test("pruneBackups keeps only the most recent backups", async () => {
  const { appRoot, vault } = await setupCampaign();
  const backupFolder = path.join(appRoot, "data", "backups", "Test_Campaign");
  await mkdir(backupFolder, { recursive: true });
  for (let i = 0; i < 30; i += 1) {
    const stamp = String(i).padStart(3, "0");
    await writeFile(
      path.join(backupFolder, `Session Notes Workbook.2026-01-01T00-00-${stamp}.md`),
      "x",
      "utf8",
    );
  }

  await vault.pruneBackups(backupFolder);
  const remaining = await readdir(backupFolder);
  assert.equal(remaining.length, 25);
  assert.ok(remaining.includes("Session Notes Workbook.2026-01-01T00-00-029.md"));
  assert.ok(!remaining.includes("Session Notes Workbook.2026-01-01T00-00-000.md"));
});

test("validateCampaign passes a well-formed campaign", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "Location — Foundry.md"), "# Foundry\n\n## Prison\nCells.", "utf8");

  const report = await vault.validateCampaign("Test Campaign");
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.equal(report.stats.sessions, 3);
  assert.equal(report.stats.scenes, 2);
  assert.equal(report.stats.missingLinks, 0);
});

test("validateCampaign warns about broken link targets", async () => {
  const { vault } = await setupCampaign();

  const report = await vault.validateCampaign("Test Campaign");
  assert.equal(report.ok, true);
  assert.ok(report.stats.missingLinks >= 1);
  assert.ok(report.warnings.some((warning) => /not found/.test(warning.message)));
});

test("validateCampaign warns about a scene heading missing its separator", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(
    path.join(campaignFolder, "Director's Guide.md"),
    "# Session 1 — Opener\n## Scene 1.1 No Separator Here\ncontent\n",
    "utf8",
  );

  const report = await vault.validateCampaign("Test Campaign");
  assert.ok(report.warnings.some((warning) => /separator/.test(warning.message)));
});

test("validateCampaign errors when no sessions are found", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "Director's Guide.md"), "# Just a title\nNo sessions.\n", "utf8");

  const report = await vault.validateCampaign("Test Campaign");
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => /No "# Session/.test(error.message)));
});

test("validateAll lists folders without a Director's Guide as skipped", async () => {
  const { root, vault } = await setupCampaign();
  await mkdir(path.join(root, "Not A Campaign"), { recursive: true });

  const { reports, skipped } = await vault.validateAll();
  assert.ok(reports.some((report) => report.id === "Test Campaign"));
  assert.ok(skipped.includes("Not A Campaign"));
});

test("playerGuide parses cards with unique slug ids", async () => {
  const { campaignFolder, vault } = await setupCampaign();
  await writeFile(path.join(campaignFolder, "Player's Guide.md"), playerGuide, "utf8");

  const guideData = await vault.playerGuide("Test Campaign");
  assert.equal(guideData.title, "Player's Guide");
  assert.match(guideData.intro, /Welcome/);
  assert.equal(guideData.cards.length, 3);
  const ids = guideData.cards.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[1], "the-north-2");
  assert.match(guideData.cards[0].markdown, /^## The North/);
});

test("playerGuide returns null when file missing", async () => {
  const { vault } = await setupCampaign();
  assert.equal(await vault.playerGuide("Test Campaign"), null);
});

test("scaffoldCampaign creates a campaign that validates cleanly", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  const result = await scaffoldCampaign("Test Campaign", { vaultRoot, templatesDir: TEMPLATES_DIR });
  assert.ok(result.files.includes("Director's Guide.md"));
  assert.ok(result.files.includes("Handout - Example.md"));
  assert.ok(result.files.includes("Player's Guide.md"));
  assert.ok(result.files.includes("Session Notes Workbook.md"));
  assert.ok(result.files.every((file) => /^[\x00-\x7F]+$/.test(file)));

  const vault = new Vault({ root: vaultRoot, appRoot: vaultRoot });
  const report = await vault.validateCampaign("Test Campaign");
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0, `unexpected warnings: ${report.warnings.map((w) => w.message).join("; ")}`);

  const playerGuideData = await vault.playerGuide("Test Campaign");
  assert.ok(playerGuideData.cards.length >= 2);
});

test("scaffoldCampaign refuses an existing folder", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  await scaffoldCampaign("Dup", { vaultRoot, templatesDir: TEMPLATES_DIR });
  await assert.rejects(
    () => scaffoldCampaign("Dup", { vaultRoot, templatesDir: TEMPLATES_DIR }),
    /already exists/,
  );
});

test("scaffoldCampaign rejects unsafe names", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "scaffold-"));
  await assert.rejects(
    () => scaffoldCampaign("../oops", { vaultRoot, templatesDir: TEMPLATES_DIR }),
    /slashes/,
  );
  await assert.rejects(
    () => scaffoldCampaign("", { vaultRoot, templatesDir: TEMPLATES_DIR }),
    /required/,
  );
});
