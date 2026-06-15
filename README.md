# GM Campaign Cockpit

GM Campaign Cockpit runs tabletop campaigns directly from Markdown files. It
provides session and scene navigation, references, notes, player reveals,
trackers, chat, rolls, and whispers without moving campaign content into a
database.

The local cockpit is hardened for one computer or a trusted local network. It
is not designed to be exposed directly to the public internet. For remote
players, the repository also includes a separately deployed hosted relay. The
local cockpit connects outward to that relay, so campaign files and the local
server remain private.

Three operating modes are available:

| Mode | Intended use | Player address |
|---|---|---|
| Local | DM and player display on one computer | `http://127.0.0.1:4173/player.html` |
| Trusted LAN | Devices on the same private network | `http://<server-lan-address>:4173/player.html` |
| Hosted relay | Remote players over the internet | `https://<relay-host>/player/` |

Local and trusted-LAN modes are ready for normal campaign use. The hosted relay
implements accounts, device pairing, rooms, invites, and the remote player
screen, including explicitly revealed raster images. It includes a managed-TLS
deployment example and operational tooling for a controlled private pilot, but
still requires the security review described below before broad public use.

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

Do not port-forward the local cockpit, place it on an untrusted network, or
expose it through a public reverse proxy. Use the separately deployed hosted
relay for internet players.

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
| Hosted relay device pairing | `STATE_DIR/relay-device.json` | Persistent until unpaired |
| Presentation, chat, DM/player sessions | Server memory | Reset on restart |
| Player name/session and DM layout | Browser local storage | Per browser |
| Hosted accounts, devices, rooms, and memberships | `RELAY_STATE_FILE` | Persistent and atomic |
| Hosted revealed image bytes and grants | `RELAY_ASSET_DIR` | Deleted at room end or after retention |
| Hosted player room session | Browser local storage | Per browser and relay origin |

Tracker writes use a queued atomic replacement. If stored tracker JSON is
malformed, it is renamed with a `.corrupt` suffix and the server starts with an
empty tracker list. Failed tracker writes roll back the in-memory mutation.

For a complete local cockpit backup, preserve both `VAULT_ROOT` and
`STATE_DIR`. The notes backup folder is under the application `data` folder
unless the application itself is included in that backup. A hosted relay
deployment must also back up `RELAY_STATE_FILE`.

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

These controls reduce risk on a trusted LAN. They do not make the local
cockpit an internet-facing server. Remote access must go through the hosted
relay over HTTPS/WSS.

## Hosted Relay

The `relay/` service is a working Phase Two private-pilot implementation. It
keeps the local cockpit authoritative and accepts the cockpit's outbound
`wss://` connection plus room-scoped player connections. It stores accounts,
devices, rooms, invites, memberships, and bounded player-safe room projections
in a versioned atomic JSON file. Account passphrases and device, invite, and
membership secrets are stored only as password hashes or capability hashes.

The connector publishes only player-safe room projections: explicit text,
card, and image reveals; visible trackers; scoped chat; and public player
identities. Vault paths, campaign manuscripts, session notes, local
credentials, hidden trackers, and secret rolls are rejected at the protocol
boundary.

For an image reveal, the local cockpit verifies the raster signature and size,
requests a short-lived one-time upload grant, and uploads the bytes over TLS.
The hosted presentation contains only an opaque room-scoped asset ID. Remote
players fetch the image with their membership bearer session; asset tokens are
never placed in URLs. Assets are removed when retracted, when the room ends, or
when their configured retention period expires.

### 1. Start The Relay

For local development, start the relay as a separate process:

```bash
npm run relay:start
```

Development defaults are `127.0.0.1:8787` and
`relay/data/relay.json`. Configure `RELAY_STATE_FILE` to place the persistent
relay database elsewhere. Hosted image bytes default to an `assets` directory
beside that file. Configure `RELAY_ASSET_DIR`, `RELAY_MAX_ASSET_BYTES`,
`RELAY_ASSET_RETENTION_MS`, and `RELAY_ASSET_GRANT_TTL_MS` to change the asset
storage and limits.

Public traffic requires HTTPS/WSS. Configure both `RELAY_TLS_CERT_FILE` and
`RELAY_TLS_KEY_FILE`, or run the service behind a trusted managed TLS proxy.
When using a proxy, set:

```text
RELAY_PUBLIC_ORIGIN=https://relay.example.com
```

The public origin controls same-origin checks and secure account cookies.
The service also applies scoped IP, account, device, invite, room, player, and
asset limits. See `.env.example` for the configurable capacity ceilings.

### 2. Create The First Account

The relay has no public account-registration endpoint. Initialize the first
development account from the relay host:

```powershell
$env:RELAY_BOOTSTRAP_PASSPHRASE = "choose-a-long-account-passphrase"
npm run relay:bootstrap -- "dm@example.com" "Campaign laptop" "Tuesday table"
```

On macOS or Linux, use
`export RELAY_BOOTSTRAP_PASSPHRASE="choose-a-long-account-passphrase"`.
The command creates the account plus an initial device, room, and invite. It
prints the device token, room ID, and invite token once. Keep those
capabilities private.

Open the relay root URL in a browser and sign in with the email and passphrase.
The account dashboard can generate one-time device pairing codes, list and
revoke devices, create and end rooms, open or close joins, rotate invites, and
remove players.

### 3. Pair The Local Cockpit

For the normal browser-guided pairing flow, configure only the relay's public
control origin in the local cockpit:

```text
RELAY_CONTROL_URL=https://relay.example.com
```

Restart the local cockpit, then:

1. Sign in to the hosted relay account page.
2. Generate a one-time device pairing code. It expires after ten minutes.
3. Open **Hosted relay** in the local cockpit header.
4. Enter the pairing code and a name for the campaign computer.
5. In the relay account dashboard, create a room assigned to that device.
6. In the local cockpit, select the assigned room.

The local cockpit stores the resulting device capability in
`STATE_DIR/relay-device.json` with restricted file permissions. The token is
never returned to browser JavaScript or placed in a URL.

For managed installations, the connector can instead be configured directly:

```text
RELAY_URL=wss://relay.example.com/v1/agent/<room-id>
RELAY_AGENT_ID=<device-id>
RELAY_ROOM_ID=<room-id>
RELAY_DEVICE_TOKEN=<device-token>
```

The connector is disabled unless all four managed values are present. Do not
combine managed connector values with browser-guided pairing. In either mode,
the local cockpit remains private and opens no inbound internet connection.

### 4. Invite Remote Players

Create a room from the relay account dashboard and share its current invite
capability privately. Remote players open
`https://relay.example.com/player/`, enter the invite, and choose a display
name.

The browser receives a room-scoped session and reconnects through the hosted
player WebSocket. The remote screen supports text and card reveals, verified
raster image reveals, visible trackers, table chat, dice rolls, whispers with
the DM, player presence, rename, leave, and snapshot recovery. Duplicate
display names remain separate identities.

The account dashboard can close joins, rotate a compromised invite, remove a
player, revoke a paired device, or end the room. Those actions invalidate the
corresponding remote access.

### Service Boundaries

Available service boundaries:

- `GET /health` and `GET /readiness`
- Protected `GET /metrics` with `RELAY_METRICS_TOKEN`
- `POST /v1/invites/redeem`
- `GET /v1/player/session`
- Hosted player interface at `/player/`
- Account-session and room-control routes under `/v1/admin/`
- `POST /v1/devices/pair` and `GET /v1/device/state`
- `POST /v1/device/assets/grants`
- `PUT /v1/assets/upload/<asset-id>`
- `GET /v1/assets/<asset-id>` and `DELETE /v1/device/assets/<asset-id>`
- `WS /v1/agent/<room-id>`
- `WS /v1/player/<room-id>`

### Operations And Deployment

The repository includes a non-root relay image, a private-network
`deploy/compose.yaml`, and Caddy-managed HTTPS/WSS termination. Only Caddy
publishes internet ports; the relay has no host port in the sample deployment.
The complete release checklist, alerts, backup schedule, restore procedure,
and incident actions are in `relay/OPERATIONS.md`.

Stop the relay before backup or restore so the database and asset directory
form one consistent snapshot:

```bash
npm run relay:backup
npm run relay:rehearse
RELAY_RESTORE_CONFIRM=RESTORE npm run relay:restore -- /path/to/relay-backup
```

Backups use a checksummed inventory and preserve pre-restore rollback copies.
For staging availability and regional latency checks:

```bash
RELAY_SOAK_URL=https://relay.example.com npm run relay:soak
```

There is no broad-public hosted service bundled with this repository. The
remaining gate is Phase Two security review and an invite-only pilot,
including dependency/container scanning, an external authorization review,
account-recovery administration, and published privacy and retention terms.

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
