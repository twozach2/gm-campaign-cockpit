export const RELAY_SCHEMA_VERSION = 1;

export function emptyRelayDatabase() {
  return {
    schemaVersion: RELAY_SCHEMA_VERSION,
    accounts: [],
    devices: [],
    rooms: [],
    invites: [],
    memberships: [],
    roomStates: [],
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
      value.schemaVersion === 0 ||
      value.schemaVersion === RELAY_SCHEMA_VERSION)
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
  if (version === RELAY_SCHEMA_VERSION) return structuredClone(value);

  return {
    schemaVersion: RELAY_SCHEMA_VERSION,
    accounts: recordArray(value, "accounts"),
    devices: recordArray(value, "devices"),
    rooms: recordArray(value, "rooms"),
    invites: recordArray(value, "invites"),
    memberships: recordArray(value, "memberships"),
    roomStates: recordArray(value, "roomStates"),
  };
}
