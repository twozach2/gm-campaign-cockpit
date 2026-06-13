export const RELAY_SCHEMA_VERSION = 2;

export function emptyRelayDatabase() {
  return {
    schemaVersion: RELAY_SCHEMA_VERSION,
    accounts: [],
    devices: [],
    rooms: [],
    invites: [],
    memberships: [],
    roomStates: [],
    pairings: [],
  };
}

function recordArray(value, key) {
  return Array.isArray(value?.[key]) ? value[key] : [];
}

export function canMigrateRelayDatabase(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.schemaVersion === undefined ||
      (Number.isSafeInteger(value.schemaVersion) &&
        value.schemaVersion >= 0 &&
        value.schemaVersion <= RELAY_SCHEMA_VERSION))
  );
}

export function migrateRelayDatabase(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay database must be an object");
  }
  const version = value.schemaVersion ?? 0;
  if (version > RELAY_SCHEMA_VERSION) {
    throw new Error(
      `Relay database schema ${version} is newer than supported schema ${RELAY_SCHEMA_VERSION}`,
    );
  }
  let migrated = structuredClone(value);
  if (version === 0) {
    migrated = {
      schemaVersion: 1,
      accounts: recordArray(migrated, "accounts"),
      devices: recordArray(migrated, "devices"),
      rooms: recordArray(migrated, "rooms"),
      invites: recordArray(migrated, "invites"),
      memberships: recordArray(migrated, "memberships"),
      roomStates: recordArray(migrated, "roomStates"),
    };
  }
  if (migrated.schemaVersion === 1) {
    migrated = {
      ...migrated,
      schemaVersion: 2,
      accounts: recordArray(migrated, "accounts").map((account) => ({
        ...account,
        passwordSalt: null,
        passwordHash: null,
      })),
      pairings: [],
    };
  }
  return migrated;
}
