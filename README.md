# GM Campaign Cockpit

GM Campaign Cockpit runs tabletop campaigns directly from Markdown files. It
provides session and scene navigation, references, notes, player reveals,
trackers, chat, rolls, and whispers without moving campaign content into a
database.

This release is hardened for one computer or a trusted local network. It is not
designed to be exposed directly to the public internet. Worldwide access needs
a separate hosted relay and authentication boundary.

## Requirements

- A current Node.js LTS release, version 20.12 or newer.
- Campaign files stored locally or in a locally synchronized folder.
- No `npm install` step is required.

## Quick Start

Place the application folder beside your campaign folders:

```text
Dungeons_and_Dragons/
|-- GM Campaign Cockpit/
|-- Storm King's Thunder/
|   |-- Director's Guide.md
|   `-- Session Notes Workbook.md
`-- The Sands of Aaru/
    `-- Director's Guide.md
```

With that layout, the default vault is the folder above the application and no
configuration is required.

### Windows

Run `Start GM Cockpit.ps1`.

If PowerShell blocks local scripts, open PowerShell in the application folder
and run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\Start GM Cockpit.ps1"
```

### macOS

Double-click `Start GM Cockpit Mac.command`. If macOS removed its executable
permission, run this once:

```bash
chmod +x "/path/to/GM Campaign Cockpit/Start GM Cockpit Mac.command"
```

### Terminal

```bash
npm start
```

Open <http://127.0.0.1:4173>.

## Configuration

Copy `.env.example` to `.env` and edit it. The app, validator, scaffolder, and
launchers load `.env` automatically. Existing shell environment variables take
precedence.

Common settings:

```text
VAULT_ROOT=/absolute/path/to/the/folder/containing/campaigns
HOST=127.0.0.1
PORT=4173
STATE_DIR=/absolute/path/to/runtime/state
```

If `VAULT_ROOT` is omitted, it defaults to the folder above the application.
If `STATE_DIR` is omitted, runtime state uses the application-local `data`
folder.

## Local And LAN Modes

### Local-only mode

The default `HOST=127.0.0.1` accepts connections only from the same computer.
The local browser receives a DM session automatically.

### Trusted-LAN mode

To let players and a DM browser on the same trusted network connect, set:

```text
HOST=0.0.0.0
ALLOW_REMOTE_DM=true
TABLE_PIN=choose-a-long-private-passphrase
```

`TABLE_PIN` is mandatory in LAN mode and must contain at least six characters.
It is never printed to logs or placed in a URL. The DM enters it on the login
screen. Players do not need it.

Open the player screen at:

```text
http://<server-lan-address>:<port>/player.html
```

Do not port-forward this server, place it on an untrusted network, or expose it
through a public reverse proxy. Phase One does not provide public accounts,
TLS termination, hosted room isolation, or an internet relay.

## Campaign File Contract

Each campaign is a folder containing a file named exactly
`Director's Guide.md`. That filename is the only hard requirement.

```text
Campaign Name/
|-- Director's Guide.md
|-- Session Notes Workbook.md
|-- Player's Guide.md
|-- NPC - Example.md
|-- Maps/
|   `-- overland.png
`-- handout.pdf
```

Sessions are numbered headings:

```markdown
# Session 12: The Forge Below
```

Scenes live beneath a session and use a `session.scene` number:

```markdown
## Scene 12.1: The Cell Block
## Scene 12.2: The Mark
```

Wiki links resolve within the same campaign folder:

```markdown
See [[NPC - Example]] and [[Location - Foundry#Prison]].
![[Maps/overland.png]]
```

Markdown documents render in the cockpit. PNG, JPEG, GIF, and WebP images may
be previewed and explicitly revealed to players. PDFs open with restrictive
headers. SVG, HTML, and other active file types are download-only and cannot be
revealed on the player screen.

## Session Notes

The notes editor writes only inside the session's protected block in
`Session Notes Workbook.md`:

```markdown
<!-- gm-cockpit:session-12:start -->
Live notes go here.
<!-- gm-cockpit:session-12:end -->
```

The editor provides write, split, and preview views. Saves are serialized and
revision-aware, so typing during an active save cannot mark newer text as
saved.

Before changing an existing workbook, the app creates a timestamped backup. If
the backup cannot be created, the workbook is left unchanged and the DM sees a
save failure. The newest 25 backups per campaign are retained.

## Player Screen

Players open `/player.html`, choose a display name, and receive a private
server-issued session. Display names are labels, not authentication identities,
so duplicate names remain separate players.

The DM can share:

- Cards from `Player's Guide.md`
- Verified raster images
- Freeform text
- Visible clocks, meters, and initiative trackers
- Table chat, rolls, secret DM rolls, and private whispers

Player file access is capability-based. A player can fetch only a currently
revealed image by its server-created reveal ID; players cannot browse the vault
or alter an ID to select another file.

## Data Storage

| Data | Location | Persistence |
|---|---|---|
| Campaign manuscripts and handouts | `VAULT_ROOT/<Campaign>/` | Existing files |
| Session notes | Campaign `Session Notes Workbook.md` | Persistent |
| Notes backups | Application `data/backups/<Campaign>/` | Newest 25 retained |
| Tracker state | `STATE_DIR/trackers.json` | Persistent and atomic |
| Presentation, chat, DM/player sessions | Server memory | Reset on restart |
| Player name/session and DM layout | Browser local storage | Per browser |

Tracker writes use a queued atomic replacement. If stored tracker JSON is
malformed, it is renamed with a `.corrupt` suffix and the server starts with an
empty tracker list. Failed tracker writes roll back the in-memory mutation.

For a complete backup, preserve both `VAULT_ROOT` and `STATE_DIR`. The notes
backup folder is under the application `data` folder unless the application
itself is included in that backup.

## Health And Recovery

Two public, non-disclosing checks are available:

- `GET /api/health` - process liveness
- `GET /api/readiness` - vault and persistence readiness

Neither endpoint returns filesystem paths. The launchers wait for readiness
before opening the browser.

The DM and player interfaces show `Connecting`, `Live`, `Reconnecting`, or
`Offline`. Every stream connection and reconnect requests a fresh short-lived,
single-use ticket.

Shutdown waits for queued tracker and workbook writes. Operational logs are
structured JSON and omit PINs, cookies, bearer tokens, CSRF tokens, session
identifiers, whispers, notes, campaign contents, and filesystem paths.

## Security Model

- Static application assets contain no campaign data.
- DM APIs require an opaque `HttpOnly; SameSite=Strict` cookie.
- Player APIs require a server-issued bearer session.
- State-changing requests require same-origin JSON.
- DM writes also require a session-bound CSRF token.
- API roles, methods, schemas, and body limits are declared centrally.
- Rate limits and bounded registries protect public and authenticated routes.
- Vault paths are checked lexically and by real path to block traversal and
  symlink escapes.
- Player reveals accept only signature-verified PNG, JPEG, GIF, or WebP files.
- Active content is served as a sandboxed download rather than inline.
- Internal server failures return generic responses without filesystem paths.

These controls reduce risk on a trusted LAN. They do not replace TLS, public
identity, tenant isolation, a cloud database, or an internet-facing gateway.

## Validation

Run the document validator:

```bash
npm run check
```

You may also pass a vault path directly:

```bash
node validate.mjs "/path/to/campaigns"
```

The validator reports session, scene, and link counts; malformed headings;
duplicate session numbers; broken links; and files that point outside the
campaign folder.

## New Campaign

Create a campaign from the templates:

```bash
npm run new-campaign -- "My New Campaign"
```

The command uses `VAULT_ROOT` and creates a Director's Guide, notes workbook,
Player's Guide, and example handout.

## Development Checks

```bash
npm test
npm run check
```

The automated suite covers saves, persistence, authentication, authorization,
origin and CSRF checks, player identity, rate limits, resource bounds, file
exposure, recovery, logging, and configuration.
