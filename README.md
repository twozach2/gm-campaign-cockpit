# GM Campaign Cockpit

GM Campaign Cockpit runs tabletop campaigns directly from Markdown files. It
provides session and scene navigation, references, notes, player reveals,
trackers, chat, rolls, and whispers without moving campaign content into a
database.

The local cockpit is hardened for one computer or a trusted local network. It
is not designed to be exposed directly to the public internet. The repository
also contains an experimental, separately-run hosted relay skeleton for
continued development of worldwide player access.

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

## Experimental Hosted Relay

The `relay/` service is a Phase Two development skeleton, not a production
deployment. It keeps the local cockpit authoritative and accepts the agent's
outbound `wss://` connection plus room-scoped player connections. It stores
accounts, devices, rooms, invites, memberships, and bounded player-safe room
projections in a versioned atomic JSON file. Device, invite, and membership
secrets are stored only as hashes.

The connector publishes only player-safe room projections: explicit text/card
reveals, visible trackers, scoped chat, and public player identities. Vault
paths, campaign manuscripts, session notes, local credentials, hidden trackers,
and secret rolls are rejected at the protocol boundary. Local image reveals
are omitted until the separate opaque asset-upload service is implemented.

Create a development account, device, room, and invite:

```powershell
$env:RELAY_BOOTSTRAP_PASSPHRASE = "choose-a-long-account-passphrase"
npm run relay:bootstrap -- "dm@example.com" "Campaign laptop" "Tuesday table"
```

On macOS or Linux, use
`export RELAY_BOOTSTRAP_PASSPHRASE="choose-a-long-account-passphrase"`.
The command prints the device token, room ID, and invite token once.

Open the relay root URL in a browser and sign in with the email and passphrase.
The account dashboard can generate one-time device pairing codes, list and
revoke devices, create and end rooms, open or close joins, rotate invites, and
remove players.

Remote players open `https://relay.example.com/player/`, enter the current
invite capability, and choose a display name. The browser receives a
room-scoped session and reconnects through the hosted player WebSocket. The
remote screen supports text and card reveals, visible trackers, table chat,
dice rolls, whispers with the DM, player presence, rename, leave, and snapshot
recovery. Duplicate display names remain separate identities.

Hosted image reveals remain disabled until the opaque asset service in
P2-WP6 is implemented. Local and LAN image reveals continue to work normally.

For the normal pairing flow, configure only the relay's public control origin
in the local cockpit:

```text
RELAY_CONTROL_URL=https://relay.example.com
```

Open **Hosted relay** in the local cockpit header, redeem a pairing code, then
choose a room assigned to that device. The device token is written to
`STATE_DIR/relay-device.json` with restricted file permissions and is never
returned to the browser.

The original environment-managed connector remains available for development
or managed installations:

```text
RELAY_URL=wss://relay.example.com/v1/agent/<room-id>
RELAY_AGENT_ID=<device-id>
RELAY_ROOM_ID=<room-id>
RELAY_DEVICE_TOKEN=<device-token>
```

The connector is disabled unless all four values are present. Start the relay
as a separate process:

```bash
npm run relay:start
```

Development defaults are `127.0.0.1:8787` and
`relay/data/relay.json`. Configure `RELAY_STATE_FILE` for durable storage.
Public traffic requires HTTPS/WSS: either configure both
`RELAY_TLS_CERT_FILE` and `RELAY_TLS_KEY_FILE`, or put the relay behind a
trusted managed TLS proxy. When using a proxy, set
`RELAY_PUBLIC_ORIGIN=https://relay.example.com` so same-origin and secure-cookie
checks use the external origin. The local cockpit server remains private and
opens no inbound internet connection.

Available service boundaries:

- `GET /health` and `GET /readiness`
- `POST /v1/invites/redeem`
- `GET /v1/player/session`
- Hosted player interface at `/player/`
- Account-session and room-control routes under `/v1/admin/`
- `POST /v1/devices/pair` and `GET /v1/device/state`
- `WS /v1/agent/<room-id>`
- `WS /v1/player/<room-id>`

There is no production hosted relay bundled with this repository yet. Before
public use, this skeleton still needs an asset service, a production database
and backups, stronger deployment limits, monitoring, and a dedicated security
review. Local and trusted-LAN modes remain the supported ways to run a session.

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
exposure, recovery, logging, configuration, and the hosted-relay protocol.
