import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPlayerImage } from "../lib/file-policy.mjs";
import { Vault } from "../lib/vault.mjs";
import { IMAGE_EXT, inlineMarkdown, renderMarkdown } from "../public/render.mjs";
import {
  api,
  localDmSession,
  startTestServer,
} from "../test-support/server.mjs";

const CAMPAIGN = "Secure Campaign";
const GUIDE = `---
campaign: Secure Campaign
---
# Session 1: Arrival
## Scene 1.1: The Door
Open the door.
`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9WlXgAAAAASUVORK5CYII=",
  "base64",
);

async function setupVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), "gm-cockpit-files-"));
  const appRoot = path.join(root, "GM Campaign Cockpit");
  const campaignFolder = path.join(root, CAMPAIGN);
  await mkdir(appRoot, { recursive: true });
  await mkdir(campaignFolder, { recursive: true });
  await writeFile(path.join(campaignFolder, "Director's Guide.md"), GUIDE, "utf8");
  return {
    appRoot,
    campaignFolder,
    root,
    vault: new Vault({ root, appRoot }),
  };
}

function dmHeaders(session) {
  return {
    Cookie: session.cookie,
    "X-GM-Cockpit-CSRF": session.csrfToken,
  };
}

test("vault blocks slash, backslash, and symlink path escapes", async (t) => {
  const { campaignFolder, root, vault } = await setupVault();
  await writeFile(path.join(campaignFolder, "portrait.png"), PNG);
  await writeFile(path.join(root, "outside.txt"), "private", "utf8");

  assert.equal(
    await vault.resolveFilePath(CAMPAIGN, "portrait.png"),
    await realpath(path.join(campaignFolder, "portrait.png")),
  );
  await assert.rejects(
    () => vault.resolveFilePath(CAMPAIGN, "../outside.txt"),
    /outside the campaign/,
  );
  await assert.rejects(
    () => vault.resolveFilePath(CAMPAIGN, "..\\outside.txt"),
    /outside the campaign/,
  );

  const outsideFolder = path.join(root, "outside");
  const linkedFolder = path.join(campaignFolder, "escape");
  await mkdir(outsideFolder);
  await writeFile(path.join(outsideFolder, "secret.txt"), "secret", "utf8");
  try {
    await symlink(
      outsideFolder,
      linkedFolder,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`Symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => vault.resolveFilePath(CAMPAIGN, "escape/secret.txt"),
    /outside the campaign/,
  );
});

test("notes cannot be written through a symbolic workbook path", async (t) => {
  const { campaignFolder, root, vault } = await setupVault();
  const outsideFolder = path.join(root, "outside-notes");
  const workbookPath = path.join(campaignFolder, "Session Notes Workbook.md");
  await mkdir(outsideFolder);
  await writeFile(path.join(outsideFolder, "marker.txt"), "unchanged", "utf8");
  try {
    await symlink(
      outsideFolder,
      workbookPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) {
      t.skip(`Symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => vault.saveNotes(CAMPAIGN, 1, "Do not write this"),
    /cannot be a symbolic link/,
  );
  assert.equal(
    await readFile(path.join(outsideFolder, "marker.txt"), "utf8"),
    "unchanged",
  );
});

test("player image verification rejects unsupported and spoofed files", async () => {
  const { campaignFolder } = await setupVault();
  const valid = path.join(campaignFolder, "valid.png");
  const spoofed = path.join(campaignFolder, "spoofed.png");
  const svg = path.join(campaignFolder, "active.svg");
  await writeFile(valid, PNG);
  await writeFile(spoofed, "<script>alert(1)</script>", "utf8");
  await writeFile(svg, "<svg onload=\"alert(1)\"></svg>", "utf8");

  assert.equal(await verifyPlayerImage(valid), "image/png");
  await assert.rejects(
    () => verifyPlayerImage(spoofed),
    /do not match the file extension/,
  );
  await assert.rejects(
    () => verifyPlayerImage(svg),
    /Only PNG, JPEG, GIF, and WebP/,
  );
});

test("rendering escapes active markup and excludes SVG image embeds", () => {
  assert.equal(IMAGE_EXT.test("portrait.png"), true);
  assert.equal(IMAGE_EXT.test("active.svg"), false);
  assert.match(
    inlineMarkdown("[site](https://example.com)"),
    /rel="noopener noreferrer"/,
  );

  const rendered = renderMarkdown("<script>alert('x')</script>");
  assert.doesNotMatch(rendered, /<script>/);
  assert.match(rendered, /&lt;script&gt;/);
});

test("server exposes only current verified reveals and hardens file responses", async (t) => {
  const { campaignFolder, root } = await setupVault();
  await writeFile(path.join(campaignFolder, "valid.png"), PNG);
  await writeFile(
    path.join(campaignFolder, "spoofed.png"),
    "<script>alert(1)</script>",
    "utf8",
  );
  await writeFile(
    path.join(campaignFolder, "active.svg"),
    "<svg onload=\"alert(1)\"></svg>",
    "utf8",
  );
  await writeFile(
    path.join(campaignFolder, "active.html"),
    "<script>alert(1)</script>",
    "utf8",
  );
  await writeFile(path.join(campaignFolder, "handout.pdf"), "%PDF-1.4\n", "utf8");
  await writeFile(path.join(root, "outside.txt"), "private", "utf8");

  const { base } = await startTestServer(t, {
    prefix: "gm-cockpit-file-security-",
    root,
  });
  const dm = await localDmSession(base);
  const headers = dmHeaders(dm);

  const unrevealed = await fetch(`${base}/api/player/image?id=999`);
  assert.equal(unrevealed.status, 404);

  const traversal = await api(
    base,
    "GET",
    `/api/file?campaign=${encodeURIComponent(CAMPAIGN)}&file=%2e%2e%2foutside.txt`,
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(traversal.status, 400);

  const backslashTraversal = await api(
    base,
    "POST",
    "/api/reveal/image",
    { campaign: CAMPAIGN, file: "..\\outside.txt" },
    { headers },
  );
  assert.equal(backslashTraversal.status, 400);

  for (const file of ["active.svg", "active.html", "spoofed.png"]) {
    const rejected = await api(
      base,
      "POST",
      "/api/reveal/image",
      { campaign: CAMPAIGN, file },
      { headers },
    );
    assert.equal(rejected.status, 400, file);
  }

  const reveal = await api(
    base,
    "POST",
    "/api/reveal/image",
    { campaign: CAMPAIGN, file: "valid.png" },
    { headers },
  );
  assert.equal(reveal.status, 200);
  const imageId = reveal.data.item.id;

  const altered = await fetch(`${base}/api/player/image?id=${imageId + 1}`);
  assert.equal(altered.status, 404);

  const image = await fetch(`${base}/api/player/image?id=${imageId}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.match(image.headers.get("content-disposition"), /^inline;/);
  assert.equal(image.headers.get("cache-control"), "private, no-store");
  assert.equal(
    image.headers.get("content-security-policy"),
    "sandbox; default-src 'none'",
  );
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const active = await fetch(
    `${base}/api/file?campaign=${encodeURIComponent(CAMPAIGN)}&file=active.html`,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(active.status, 200);
  assert.equal(active.headers.get("content-type"), "application/octet-stream");
  assert.match(active.headers.get("content-disposition"), /^attachment;/);
  assert.equal(
    active.headers.get("content-security-policy"),
    "sandbox; default-src 'none'",
  );

  const pdf = await fetch(
    `${base}/api/file?campaign=${encodeURIComponent(CAMPAIGN)}&file=handout.pdf`,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /^inline;/);
  assert.equal(
    pdf.headers.get("content-security-policy"),
    "sandbox; default-src 'none'",
  );

  const document = await api(
    base,
    "GET",
    `/api/document?campaign=${encodeURIComponent(CAMPAIGN)}&file=active.html`,
    undefined,
    { headers: { Cookie: dm.cookie } },
  );
  assert.equal(document.status, 400);

  await writeFile(
    path.join(campaignFolder, "valid.png"),
    "<script>alert(1)</script>",
    "utf8",
  );
  const changedAfterReveal = await fetch(
    `${base}/api/player/image?id=${imageId}`,
  );
  assert.equal(changedAfterReveal.status, 400);
});
