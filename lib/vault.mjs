import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DIRECTOR_GUIDE = "Director's Guide.md";
const PLAYER_GUIDE = "Player's Guide.md";
const WORKBOOK = "Session Notes Workbook.md";
const MAX_BACKUPS = 25;

function parseFrontmatter(markdown) {
  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return {};

  const result = {};
  for (const line of markdown.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return result;
}

function stripBlockId(text) {
  return text.replace(/\s+\^[A-Za-z0-9_-]+\s*$/, "").trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

function headingMatches(markdown, pattern) {
  const matches = [];
  for (const match of markdown.matchAll(pattern)) {
    matches.push({
      index: match.index,
      raw: match[0],
      level: match[1].length,
      groups: match.slice(2),
    });
  }
  return matches;
}

function sectionFromMatch(markdown, matches, index) {
  const current = matches[index];
  const next = matches.slice(index + 1).find((item) => item.level <= current.level);
  return markdown.slice(current.index, next?.index ?? markdown.length).trim();
}

export function parseSessions(markdown) {
  const pattern = /^(#{1,3})\s+Session\s+(\d+)(?:\s*[—–:-]\s*(.+?))?\s*$/gm;
  const matches = headingMatches(markdown, pattern);

  return matches.map((match, index) => ({
    number: Number(match.groups[0]),
    title: stripBlockId(match.groups[1] || "") || `Session ${match.groups[0]}`,
    heading: stripBlockId(match.raw.replace(/^#{1,3}\s+/, "")),
    markdown: sectionFromMatch(markdown, matches, index),
  }));
}

export function parseScenes(sessionMarkdown, sessionNumber) {
  const escaped = String(sessionNumber).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^(#{2,4})\\s+Scene\\s+${escaped}\\.(\\d+)\\s*(?:\\([^)]*\\)\\s*)?[:—–-]\\s*(.*?)\\s*$`,
    "gm",
  );
  const matches = headingMatches(sessionMarkdown, pattern);

  return matches.map((match, index) => ({
    id: `${sessionNumber}.${match.groups[0]}`,
    number: Number(match.groups[0]),
    title: stripBlockId(match.groups[1]),
    heading: stripBlockId(match.raw.replace(/^#{2,4}\s+/, "")),
    markdown: sectionFromMatch(sessionMarkdown, matches, index),
  }));
}

export function collectWikiLinks(markdown) {
  const links = [];
  const seen = new Set();
  const pattern = /!?\[\[([^#|\]]+)(?:#([^|\]]+))?(?:\|([^\]]+))?\]\]/g;

  for (const match of markdown.matchAll(pattern)) {
    const file = match[1].trim();
    const heading = match[2]?.trim() ?? "";
    const label = match[3]?.trim() || heading || path.basename(file, ".md");
    const key = `${file}\0${heading}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ file, heading, label, embed: match[0].startsWith("!") });
  }
  return links;
}

function extractHeadingSection(markdown, requestedHeading) {
  if (!requestedHeading) return markdown;
  const requested = requestedHeading.replace(/^\^/, "").trim().toLowerCase();
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*$/gm)].map((match) => ({
    index: match.index,
    level: match[1].length,
    title: stripBlockId(match[2]),
    blockId: match[2].match(/\^([A-Za-z0-9_-]+)\s*$/)?.[1] ?? "",
  }));
  const foundIndex = headings.findIndex(
    (item) =>
      item.title.toLowerCase() === requested ||
      item.blockId.toLowerCase() === requested,
  );
  if (foundIndex === -1) return markdown;
  const found = headings[foundIndex];
  const next = headings.slice(foundIndex + 1).find((item) => item.level <= found.level);
  return markdown.slice(found.index, next?.index ?? markdown.length).trim();
}

function notesMarkers(sessionNumber) {
  return {
    start: `<!-- gm-cockpit:session-${sessionNumber}:start -->`,
    end: `<!-- gm-cockpit:session-${sessionNumber}:end -->`,
  };
}

export function extractProtectedNotes(markdown, sessionNumber) {
  const { start, end } = notesMarkers(sessionNumber);
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return "";
  return markdown.slice(startIndex + start.length, endIndex).replace(/^\r?\n|\r?\n$/g, "");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class Vault {
  constructor({ root, appRoot }) {
    this.root = path.resolve(root);
    this.appRoot = path.resolve(appRoot);
    this.workbookWrites = new Map();
  }

  enqueueWorkbookWrite(workbookPath, write) {
    const previous = this.workbookWrites.get(workbookPath) || Promise.resolve();
    const current = previous.catch(() => {}).then(write);
    this.workbookWrites.set(workbookPath, current);
    const cleanup = () => {
      if (this.workbookWrites.get(workbookPath) === current) {
        this.workbookWrites.delete(workbookPath);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async flushWrites() {
    while (this.workbookWrites.size) {
      const results = await Promise.allSettled(this.workbookWrites.values());
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  }

  async campaigns() {
    const entries = await readdir(this.root, { withFileTypes: true });
    const campaigns = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === path.basename(this.appRoot)) continue;
      const folder = path.join(this.root, entry.name);
      const guide = path.join(folder, DIRECTOR_GUIDE);
      try {
        const markdown = await readFile(guide, "utf8");
        const frontmatter = parseFrontmatter(markdown);
        const sessions = parseSessions(markdown);
        campaigns.push({
          id: entry.name,
          name: frontmatter.campaign || entry.name,
          sessionCount: sessions.length,
          directorGuide: DIRECTOR_GUIDE,
        });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    return campaigns.sort((a, b) => a.name.localeCompare(b.name));
  }

  async campaignFolder(campaignId) {
    const campaigns = await this.campaigns();
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw Object.assign(new Error("Campaign not found"), { status: 404 });
    return { campaign, folder: path.join(this.root, campaign.id) };
  }

  async sessions(campaignId) {
    const { folder } = await this.campaignFolder(campaignId);
    const markdown = await readFile(path.join(folder, DIRECTOR_GUIDE), "utf8");
    return parseSessions(markdown).map(({ markdown: _markdown, ...session }) => session);
  }

  async session(campaignId, sessionNumber) {
    const { campaign, folder } = await this.campaignFolder(campaignId);
    const guideMarkdown = await readFile(path.join(folder, DIRECTOR_GUIDE), "utf8");
    const session = parseSessions(guideMarkdown).find(
      (item) => item.number === Number(sessionNumber),
    );
    if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });

    const scenes = parseScenes(session.markdown, session.number);
    const firstSceneIndex = scenes.length
      ? session.markdown.indexOf(scenes[0].markdown)
      : session.markdown.length;
    const overview = session.markdown.slice(0, firstSceneIndex).trim();

    let notes = "";
    try {
      const workbook = await readFile(path.join(folder, WORKBOOK), "utf8");
      notes = extractProtectedNotes(workbook, session.number);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    return {
      campaign,
      number: session.number,
      title: session.title,
      heading: session.heading,
      overview,
      scenes: scenes.map((scene) => ({
        ...scene,
        links: collectWikiLinks(scene.markdown),
      })),
      links: collectWikiLinks(session.markdown),
      notes,
      workbook: WORKBOOK,
    };
  }

  async playerGuide(campaignId) {
    const { folder } = await this.campaignFolder(campaignId);
    let markdown;
    try {
      markdown = await readFile(path.join(folder, PLAYER_GUIDE), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    let body = markdown;
    if (body.startsWith("---")) {
      const end = body.indexOf("\n---", 3);
      if (end !== -1) body = body.slice(body.indexOf("\n", end + 1) + 1);
    }

    const lines = body.replace(/\r\n/g, "\n").split("\n");
    let title = null;
    const introLines = [];
    const cards = [];
    const usedSlugs = new Map();
    let current = null;
    let sawHeading = false;

    const pushCurrent = () => {
      if (!current) return;
      current.markdown = current.lines.join("\n").trim();
      delete current.lines;
      cards.push(current);
    };

    for (const line of lines) {
      const h1 = line.match(/^#\s+(.+?)\s*$/);
      const h2 = line.match(/^##\s+(.+?)\s*$/);
      if (h1 && title === null && !sawHeading) {
        title = stripBlockId(h1[1]);
        continue;
      }
      if (h2) {
        sawHeading = true;
        pushCurrent();
        const cardTitle = stripBlockId(h2[1]);
        let id = slugify(cardTitle);
        if (usedSlugs.has(id)) {
          const n = usedSlugs.get(id) + 1;
          usedSlugs.set(id, n);
          id = `${id}-${n}`;
        } else {
          usedSlugs.set(id, 1);
        }
        current = { id, title: cardTitle, lines: [line] };
        continue;
      }
      if (current) current.lines.push(line);
      else if (sawHeading === false) introLines.push(line);
    }
    pushCurrent();

    return { title, intro: introLines.join("\n").trim(), cards };
  }

  async resolveDocument(campaignId, requestedFile, heading = "") {
    const { folder } = await this.campaignFolder(campaignId);
    if (!requestedFile || typeof requestedFile !== "string") {
      throw Object.assign(new Error("A document name is required"), { status: 400 });
    }

    const withExtension = path.extname(requestedFile) ? requestedFile : `${requestedFile}.md`;
    const candidate = path.resolve(folder, withExtension.replaceAll("/", path.sep));
    if (!isWithin(folder, candidate)) {
      throw Object.assign(new Error("Document path is outside the campaign"), { status: 400 });
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error("Not a file");
    } catch {
      throw Object.assign(new Error(`Document not found: ${requestedFile}`), { status: 404 });
    }

    const markdown = await readFile(candidate, "utf8");
    return {
      file: path.relative(folder, candidate).replaceAll(path.sep, "/"),
      heading,
      markdown: extractHeadingSection(markdown, heading),
      links: collectWikiLinks(markdown),
    };
  }

  async listDocuments(campaignId) {
    const { folder } = await this.campaignFolder(campaignId);
    const results = [];

    const walk = async (dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute);
        } else if (entry.isFile()) {
          results.push({
            file: path.relative(folder, absolute).replaceAll(path.sep, "/"),
            name: entry.name.replace(/\.[^.]+$/, ""),
            ext: path.extname(entry.name).toLowerCase().replace(/^\./, ""),
          });
        }
      }
    };

    await walk(folder);
    return results.sort((a, b) => a.file.localeCompare(b.file));
  }

  async resolveFilePath(campaignId, requestedFile) {
    const { folder } = await this.campaignFolder(campaignId);
    if (!requestedFile || typeof requestedFile !== "string") {
      throw Object.assign(new Error("A file name is required"), { status: 400 });
    }

    const candidate = path.resolve(folder, requestedFile.replaceAll("/", path.sep));
    if (!isWithin(folder, candidate)) {
      throw Object.assign(new Error("File path is outside the campaign"), { status: 400 });
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error("Not a file");
    } catch {
      throw Object.assign(new Error(`File not found: ${requestedFile}`), { status: 404 });
    }

    return candidate;
  }

  async pruneBackups(backupFolder) {
    let entries;
    try {
      entries = await readdir(backupFolder);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const backups = entries
      .filter((name) => name.startsWith("Session Notes Workbook.") && name.endsWith(".md"))
      .sort();
    const excess = backups.slice(0, Math.max(0, backups.length - MAX_BACKUPS));
    await Promise.all(excess.map((name) => unlink(path.join(backupFolder, name))));
  }

  async saveNotes(campaignId, sessionNumber, notes) {
    if (typeof notes !== "string" || notes.length > 100_000) {
      throw Object.assign(new Error("Notes must be text under 100,000 characters"), {
        status: 400,
      });
    }

    const { folder } = await this.campaignFolder(campaignId);
    const workbookPath = path.join(folder, WORKBOOK);
    return this.enqueueWorkbookWrite(workbookPath, () =>
      this.writeNotes(campaignId, sessionNumber, notes, workbookPath),
    );
  }

  async writeNotes(campaignId, sessionNumber, notes, workbookPath) {
    let markdown = "";
    let workbookExists = true;
    try {
      markdown = await readFile(workbookPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      workbookExists = false;
    }

    const { start, end } = notesMarkers(sessionNumber);
    let startIndex = markdown.indexOf(start);
    let endIndex = markdown.indexOf(end);
    const blockCreated = startIndex === -1 || endIndex === -1 || endIndex < startIndex;
    if (blockCreated) {
      const fileHeader = markdown.trim() ? "" : "# Session Notes Workbook\n";
      const separator = markdown.length && !markdown.endsWith("\n") ? "\n\n" : markdown.length ? "\n" : "";
      markdown = `${markdown}${separator}${fileHeader}\n## Session ${sessionNumber} Notes\n\n${start}\n${end}\n`;
      startIndex = markdown.indexOf(start);
      endIndex = markdown.indexOf(end);
    }

    const normalizedNotes = notes.replace(/\r\n/g, "\n").trimEnd();
    const before = markdown.slice(0, startIndex + start.length);
    const after = markdown.slice(endIndex);
    const updated = `${before}\n${normalizedNotes}${normalizedNotes ? "\n" : ""}${after}`;

    let backup = null;
    if (workbookExists) {
      const safeCampaign = campaignId.replace(/[^A-Za-z0-9._-]+/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFolder = path.join(this.appRoot, "data", "backups", safeCampaign);
      await mkdir(backupFolder, { recursive: true });
      const backupPath = path.join(backupFolder, `Session Notes Workbook.${timestamp}.md`);
      await copyFile(workbookPath, backupPath);
      await this.pruneBackups(backupFolder);
      backup = path.relative(this.appRoot, backupPath).replaceAll(path.sep, "/");
    }

    await writeFile(workbookPath, updated, "utf8");

    return { saved: true, backup, created: blockCreated };
  }

  async validateCampaign(campaignId) {
    const errors = [];
    const warnings = [];
    const info = [];

    let folder;
    let campaign;
    try {
      ({ campaign, folder } = await this.campaignFolder(campaignId));
    } catch {
      return {
        id: campaignId,
        name: campaignId,
        ok: false,
        errors: [{ message: `No campaign folder named "${campaignId}" containing ${DIRECTOR_GUIDE}.` }],
        warnings: [],
        info: [],
        stats: {},
      };
    }

    const guideMarkdown = await readFile(path.join(folder, DIRECTOR_GUIDE), "utf8");
    const sessions = parseSessions(guideMarkdown);

    if (!sessions.length) {
      errors.push({ message: `No "# Session N — Title" headings found in ${DIRECTOR_GUIDE}.` });
    }

    const counts = new Map();
    for (const session of sessions) {
      counts.set(session.number, (counts.get(session.number) || 0) + 1);
    }
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([number]) => number)
      .sort((a, b) => a - b);
    if (duplicates.length) {
      warnings.push({
        message: `${duplicates.length} session number(s) appear more than once, so the cockpit may merge or skip headings: ${duplicates.join(", ")}. Each session needs a unique "# Session N" heading.`,
      });
    }

    let totalScenes = 0;
    const briefOnly = [];
    for (const session of sessions) {
      const scenes = parseScenes(session.markdown, session.number);
      totalScenes += scenes.length;
      if (!scenes.length) {
        briefOnly.push(session.number);
      }
      for (const match of session.markdown.matchAll(/^#{1,6}\s+Scene\s+(\d+)\.(\d+)(.*)$/gm)) {
        const sceneNumber = Number(match[2]);
        const parsed = scenes.some((scene) => scene.id === `${session.number}.${sceneNumber}`);
        if (parsed) continue;
        if (Number(match[1]) !== session.number) {
          warnings.push({ message: `Heading "Scene ${match[1]}.${match[2]}" sits under Session ${session.number} but uses a different session number.` });
        } else if (!/^\s*[:—–-]\s*\S/.test(match[3])) {
          warnings.push({ message: `Scene ${session.number}.${match[2]} is missing a ":" or "—" separator before its title, so it won't parse.` });
        } else {
          warnings.push({ message: `Scene ${session.number}.${match[2]} didn't parse — check the heading level (use ## to ####).` });
        }
      }
    }

    if (briefOnly.length) {
      info.push({ message: `${briefOnly.length} session(s) have no scenes and will show as brief-only.` });
    }

    const links = collectWikiLinks(guideMarkdown);
    let missingLinks = 0;
    for (const link of links) {
      const withExtension = path.extname(link.file) ? link.file : `${link.file}.md`;
      const candidate = path.resolve(folder, withExtension.replaceAll("/", path.sep));
      if (!isWithin(folder, candidate)) {
        missingLinks += 1;
        warnings.push({ message: `Link target "${link.file}" points outside the campaign folder.` });
        continue;
      }
      try {
        const stats = await stat(candidate);
        if (!stats.isFile()) throw new Error("not a file");
      } catch {
        missingLinks += 1;
        warnings.push({ message: `${link.embed ? "Embed" : "Link"} target not found: ${withExtension}` });
      }
    }

    try {
      await stat(path.join(folder, WORKBOOK));
      info.push({ message: `${WORKBOOK} found.` });
    } catch {
      info.push({ message: `No ${WORKBOOK} yet — it is created automatically on first save.` });
    }

    return {
      id: campaign.id,
      name: campaign.name,
      ok: errors.length === 0,
      errors,
      warnings,
      info,
      stats: {
        sessions: sessions.length,
        scenes: totalScenes,
        links: links.length,
        missingLinks,
      },
    };
  }

  async validateAll() {
    const campaigns = await this.campaigns();
    const reports = [];
    for (const campaign of campaigns) {
      reports.push(await this.validateCampaign(campaign.id));
    }

    const known = new Set(campaigns.map((campaign) => campaign.id));
    const skipped = [];
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === path.basename(this.appRoot)) continue;
      if (entry.name.startsWith(".")) continue;
      if (known.has(entry.name)) continue;
      skipped.push(entry.name);
    }

    return { reports, skipped };
  }
}
