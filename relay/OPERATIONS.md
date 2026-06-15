# Hosted Relay Operations

The hosted relay is suitable for a controlled private pilot after the
deployment owner completes the checklist below. It is not approved for broad
public registration or unreviewed multi-tenant use.

## Deployment Boundary

- Expose only the managed TLS proxy on ports 80 and 443.
- Keep the relay listener on the private container network.
- Set `RELAY_PUBLIC_ORIGIN` to the exact public HTTPS origin.
- Set `RELAY_TRUST_PROXY=true` only when the proxy overwrites
  `X-Forwarded-For` and direct relay access is blocked.
- Keep the local GM cockpit private. It connects outward over WSS and requires
  no public inbound port.
- Store `/data` on encrypted persistent storage with host-level backups.

The sample `deploy/compose.yaml` and `deploy/Caddyfile` implement this boundary.
Create `deploy/.env` from `deploy/.env.example`, use a random monitoring token,
and run `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d`.

## Release Checklist

1. Run `npm test` and `npm run check`.
2. Run `npm run relay:rehearse` against a copy of production data.
3. Create and validate a backup while the relay is stopped.
4. Build the image and record its immutable image digest.
5. Deploy to staging, then run `npm run relay:soak` from at least two regions.
6. Confirm HTTPS, WSS, `/health`, `/readiness`, protected `/metrics`, pairing,
   invite redemption, image upload, room end, and revocation.
7. Deploy the recorded image digest and watch errors, latency, and capacity.

## Backup And Restore

The relay database and asset directory form one backup unit. Stop the relay
before backup or restore so the two stores cannot change during the snapshot.

```bash
npm run relay:backup
npm run relay:rehearse
RELAY_RESTORE_CONFIRM=RESTORE npm run relay:restore -- /path/to/relay-backup
```

Backups contain a checksummed inventory and are rejected when a file is
missing, altered, unlisted, or schema-invalid. Restore preserves timestamped
pre-restore copies beside the live state. Keep daily encrypted backups for 30
days, copy them to a separate failure domain, and rehearse restore monthly.

The admin session store (`sessions.json`, beside the database) is intentionally
outside the backup unit. It holds only hashed session keys, survives an ordinary
restart, and is safe to lose: DMs simply sign in again. Do not restore it from a
backup.

After restore, start the relay and verify `/readiness`, account login, room
state, and one authorized asset download before reopening traffic.

## Monitoring

`GET /metrics` returns bounded JSON only when called with
`Authorization: Bearer <RELAY_METRICS_TOKEN>`. It contains request, rate-limit,
connection, record, asset-byte, and audit-event counts; it contains no account
email, capability, passphrase, campaign content, or vault path.

Alert on:

- `/readiness` non-200 for 2 minutes.
- Process or container restart loops.
- HTTP 5xx responses above 1% for 5 minutes.
- A sustained rate-limit increase or login-denial spike.
- Connections, room memberships, assets, or storage above 80% of configured
  capacity.
- Backup age over 24 hours or any backup/restore rehearsal failure.
- Regional p95 health latency above 500 ms for 10 minutes.

The service writes structured JSON logs to stdout. Security-sensitive changes
use the `relay_audit` event with an allowlisted action and opaque record IDs.
Ship logs to access-controlled storage with a defined retention period. Do not
enable proxy request-body logging.

## Incident Actions

**Compromised invite:** close joins, rotate the invite, remove unknown
memberships, then reopen joins.

**Compromised player session:** remove that membership. Existing HTTP and
WebSocket access is revoked.

**Compromised device:** revoke the device. Its active rooms, memberships,
invites, connections, and room assets are invalidated.

**Suspected account compromise:** block public traffic at the proxy, preserve
logs, rotate the account passphrase with the offline reset command below,
revoke all devices, and create fresh rooms and invites.

**Forgotten or rotated passphrase:** run the operator reset from the relay host
while the relay is stopped. The new passphrase is read from the environment so
it never appears in shell history or process arguments:

```bash
RELAY_RESET_PASSPHRASE="choose-a-long-account-passphrase" \
  npm run relay:reset-passphrase -- "dm@example.com"
```

The command rewrites only the account's salted passphrase hash and prints the
opaque account ID. Existing device, room, and player capabilities are
unaffected; revoke them separately if compromise is suspected.

**Cross-room disclosure or integrity failure:** stop the relay, preserve the
state and logs, restore the last known-good backup if needed, and do not reopen
until the authorization path has been reproduced and reviewed.

**Capacity or abuse event:** keep rate limits enabled, close affected room
joins, preserve audit logs, and raise only the narrow capacity responsible
after confirming legitimate demand.

Document incident start/end time, affected opaque IDs, actions, evidence
location, and follow-up tests. Never paste capabilities or player content into
incident tickets.
