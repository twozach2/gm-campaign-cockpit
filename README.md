# GM Campaign Cockpit

A local, dependency-free cockpit for running any tabletop campaign straight from
your Markdown notes. Point it at a folder of campaigns and it gives you a
session-by-session run-of-show, scene-by-scene navigation, inline maps and
handouts, cross-linked references, and a live notes pane — all in the browser,
all driven by plain files you already own.

It is **campaign-agnostic**: there is no database and no lock-in. Every campaign
is just a folder of Markdown. The app reads your material in place and only ever
writes inside a clearly fenced live-notes block (with timestamped backups), so
your prep is never silently rewritten.

- **Zero dependencies.** Pure Node.js built-ins — no `npm install` step.
- **Your files stay yours.** Edit them in Obsidian, VS Code, anything. The
  cockpit just reads them.
- **Self-validating.** A built-in checker tells you exactly which headings or
  links need fixing before you sit down to play.

## Quick Start

You need [Node.js](https://nodejs.org/en/download) (LTS or newer). Then:

```bash
git clone <this-repo> "GM Campaign Cockpit"
cd "GM Campaign Cockpit"
VAULT_ROOT="/path/to/your/campaigns" npm start
```

Open <http://127.0.0.1:4173> and pick a campaign from the sidebar.

`VAULT_ROOT` is the folder that contains your campaign folders. If you omit it,
the app uses the folder **one level above** the cockpit, so dropping this folder
beside your campaigns works with no configuration. `HOST` and `PORT` can be
overridden the same way.

### Launchers

- **macOS:** double-click `Start GM Cockpit Mac.command`. It pins `VAULT_ROOT`
  and opens the browser for you. See `MAC SETUP.txt` for first-run notes. If a
  sync client strips the executable bit, run
  `chmod +x "Start GM Cockpit Mac.command"` once.
- **Windows:** run `Start GM Cockpit.ps1`, or `node server.mjs` directly.

## The File Contract

Each campaign is a folder. The only hard requirement is a file named exactly
`Director's Guide.md` — that file is what makes a folder show up as a campaign,
and its name becomes the campaign's id in the dropdown.

```
your-campaigns/
├── The Sands of Aaru/            ← a campaign (folder name = its id)
│   ├── Director's Guide.md       ← REQUIRED: sessions & scenes are parsed here
│   ├── Session Notes Workbook.md ← optional: created on first save
│   ├── NPC — Tahir.md            ← any [[wiki-linked]] doc
│   ├── Maps/overland.png         ← images/PDFs embed and open inline
│   └── handout.pdf
├── Storm King's Thunder/
│   └── Director's Guide.md
└── GM Campaign Cockpit/          ← the app itself; skipped automatically
```

### Inside `Director's Guide.md`

**Sessions** are top-level headings (`#` to `###`). The number is required; the
separator and title are optional:

```markdown
# Session 1 — The Forge Below
# Session 2: Into the Underdark
```

**Scenes** live under a session and need both a `session.scene` number and a
`:`/`—`/`-` separator before the title (`##` to `####`):

```markdown
## Scene 1.1: The Cell Block
## Scene 1.2 — The Long Stair
```

**Links and embeds** resolve to a file in the same campaign folder (`.md` is
assumed if you omit an extension); `#Heading` jumps to that section:

```markdown
See [[NPC — Tahir]] and [[Location — Foundry#Prison]].
![[Maps/overland.png]]      ← images and PDFs render/open inline
```

### The notes workbook

Notes you type in the cockpit are written to `Session Notes Workbook.md`, inside
a protected block — one per session — and nothing outside it is touched:

```markdown
<!-- gm-cockpit:session-1:start -->
Live notes for session 1 go here.
<!-- gm-cockpit:session-1:end -->
```

You never have to create this by hand. If the file or the block is missing, the
first save creates it and writes a timestamped copy of any existing workbook to
`data/backups/` (only the 25 most recent backups per campaign are kept).

## Validation

Before a session, check that your files parse the way the cockpit expects.

**From the terminal:**

```bash
VAULT_ROOT="/path/to/your/campaigns" npm run check
```

This prints a per-campaign `✓ / ⚠ / ✗` report with session/scene/link counts and
exits non-zero if any campaign has errors — handy in a pre-game script or CI.

**In the app:** click **Check documents** in the sidebar for the same report in a
modal. The button also carries a badge showing the issue count for the active
campaign, refreshed whenever you switch sessions.

The checker reports:

- **Errors** (block parsing): no `Director's Guide.md`, or no parseable
  `# Session N` headings.
- **Warnings** (likely mistakes): duplicate session numbers, `Scene N.M`
  headings that won't parse (missing separator, wrong session number, or wrong
  heading level), and `[[links]]`/`![[embeds]]` whose target file is missing or
  points outside the campaign folder.
- **Info**: sessions with no scenes (shown brief-only) and whether a workbook
  exists yet.

## Player Facing Interface

The cockpit can drive a shared player screen on a TV, tablet, or any browser on
your local network. The DM pushes content one card/image/text at a time;
players never browse the campaign vault themselves.

**Start it:**

```bash
HOST=0.0.0.0 VAULT_ROOT="/path/to/your/campaigns" npm start
```

The default `HOST=127.0.0.1` only accepts loopback connections. Setting
`HOST=0.0.0.0` lets LAN devices reach the server. The server prints the LAN URL
and the table PIN on startup:

```
GM Campaign Cockpit (DM): http://0.0.0.0:4173
Player screen (LAN):      http://192.168.1.42:4173/player.html
Table PIN (DM access off-localhost): 7321
```

Set a stable PIN with `TABLE_PIN=1234` if you don't want it to rotate on every
restart.

**What players see.** Each device opens `http://<lan-ip>:<port>/player.html`,
types a name once (stored in `localStorage`), and lands on a holding screen
until the DM shares something. Shared content replaces the previous screen.

**What the DM pushes.** A "Player Screen" panel appears in the cockpit's right
rail with one button per `## Card` heading in the campaign's `Player's Guide.md`,
a free-text composer, a Clear button, a shared table chat, and a whisper
composer (DM → one named player). A list of connected players keeps the
whisper-target dropdown in sync.

**Authoring `Player's Guide.md`.** Cards live in a file beside
`Director's Guide.md`:

```markdown
# Player's Guide
Optional intro paragraph the whole table can read.

## Welcome
Pushable card. The card heading and body get rendered on the player screen.

## Your Character
Another card.
```

Player-facing image reveals use the separate "push image" control; embedding
`![[image]]` inside a player card won't resolve on player devices.

**Security model.**

- LAN-open (no PIN): `/player.html`, `/api/player/state`,
  `/api/player/guide` (only the currently revealed card), `/api/player/image`
  (only the currently revealed image), `/api/stream?role=player`, `/api/chat`,
  `/api/health`.
- DM-gated (loopback **or** correct `x-table-pin` header / `?pin=` query):
  the DM page `/` and `/app.js`, every existing API (`/api/campaigns`,
  `/api/sessions`, `/api/session`, `/api/document(s)`, `/api/file`,
  `/api/validate`, `/api/notes`), the full card list (`/api/player-guide`),
  the DM SSE stream, and every reveal/whisper route.

The DM browser prompts for the PIN once on first off-localhost load and caches
it in `sessionStorage`. Presentation state and chat live in memory and reset on
every server restart (chat is capped at 200 messages).

## Templates & starting a new campaign

The `templates/` folder ships skeleton files that already satisfy the cockpit's
file contract. Two ways to use them:

**One-shot command (recommended):**

```bash
VAULT_ROOT="/path/to/your/campaigns" npm run new-campaign -- "My New Campaign"
```

This creates `VAULT_ROOT/My New Campaign/` containing a Director's Guide,
Session Notes Workbook, Player's Guide, and a sample handout — all with the
campaign name substituted into the frontmatter. A freshly scaffolded campaign
passes `npm run check` with 0 errors and 0 warnings.

**Manual copy:** copy any subset of files from `templates/` into a new
`VAULT_ROOT/<Campaign>/` folder and replace `__CAMPAIGN_NAME__` with your
campaign name. Only `Director's Guide.md` is strictly required.

The `templates/` directory lives in the app/repo root — not in your vault — so
it never shows up as a campaign in the dropdown or in `npm run check`.

## How It Works

- `server.mjs` — a tiny HTTP server (Node `http`) serving the `public/` UI and a
  small JSON API (`/api/campaigns`, `/api/sessions`, `/api/documents`,
  `/api/file`, `/api/validate`, notes read/write, the player reveal/chat API
  and SSE stream).
- `lib/vault.mjs` — all file parsing: session/scene extraction, wiki-link
  resolution, protected-block notes writing with backups, Player's Guide card
  parsing, and validation.
- `validate.mjs` — the standalone CLI behind `npm run check`.
- `scaffold.mjs` — the CLI behind `npm run new-campaign`.
- `public/` — the vanilla HTML/CSS/JS front end (DM cockpit + player screen).

Run the test suite with `npm test`.
