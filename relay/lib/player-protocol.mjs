import {
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
  validateRelayEnvelope,
} from "../../lib/relay-protocol.mjs";

export const PLAYER_PROTOCOL_NAME = "gm-campaign-cockpit-player-relay";
export const PLAYER_PROTOCOL_VERSION = 1;

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_PLAYER_MESSAGE" });
}

function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalid(`${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  const record = object(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalid(`${label} contains unknown field ${key}`);
  }
  return record;
}

function string(value, label, max = 128) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${label} is invalid`);
  }
  return value;
}

export function decodePlayerEnvelope(encoded) {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16_384) {
    throw invalid("Player message is invalid or oversized");
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw invalid("Player message is not valid JSON");
  }
  const record = exact(
    value,
    ["protocol", "version", "id", "type", "roomId", "sentAt", "payload"],
    "Player envelope",
  );
  if (
    record.protocol !== PLAYER_PROTOCOL_NAME ||
    record.version !== PLAYER_PROTOCOL_VERSION
  ) {
    throw invalid("Player protocol is not supported");
  }
  const type = string(record.type, "Player message type", 40);
  if (type !== "command" && type !== "heartbeat") {
    throw invalid("Player message type is not supported");
  }
  const result = {
    protocol: PLAYER_PROTOCOL_NAME,
    version: PLAYER_PROTOCOL_VERSION,
    id: string(record.id, "Player message ID"),
    type,
    roomId: string(record.roomId, "Player room ID"),
    sentAt: integer(record.sentAt, "Player sentAt"),
  };
  if (type === "heartbeat") {
    const payload = exact(record.payload, ["nonce"], "Player heartbeat");
    result.payload = { nonce: string(payload.nonce, "Heartbeat nonce") };
    return result;
  }
  const payload = exact(
    record.payload,
    ["commandType", "data"],
    "Player command",
  );
  const validated = validateRelayEnvelope({
    protocol: RELAY_PROTOCOL_NAME,
    version: RELAY_PROTOCOL_VERSION,
    id: "player-command-validation",
    type: "room.command",
    roomId: result.roomId,
    sentAt: result.sentAt,
    payload: {
      commandId: result.id,
      playerId: "player_validation",
      commandType: payload.commandType,
      data: payload.data,
    },
  });
  result.payload = {
    commandType: validated.payload.commandType,
    data: validated.payload.data,
  };
  return result;
}

export function playerEnvelope({ id, type, roomId, sentAt, payload }) {
  return {
    protocol: PLAYER_PROTOCOL_NAME,
    version: PLAYER_PROTOCOL_VERSION,
    id,
    type,
    roomId,
    sentAt,
    payload,
  };
}
