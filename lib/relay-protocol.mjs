export const RELAY_PROTOCOL_NAME = "gm-campaign-cockpit-relay";
export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_MAX_MESSAGE_BYTES = 1024 * 1024;

export const AGENT_MESSAGE_TYPES = Object.freeze([
  "agent.hello",
  "room.snapshot",
  "room.event",
  "room.command-result",
  "heartbeat",
]);

export const RELAY_MESSAGE_TYPES = Object.freeze([
  "relay.hello",
  "room.command",
  "room.membership",
  "heartbeat",
]);

export const ROOM_EVENT_TYPES = Object.freeze([
  "reveal.set",
  "status.set",
  "chat.append",
  "presence.set",
]);

export const ROOM_COMMAND_TYPES = Object.freeze([
  "chat.send",
  "player.rename",
  "player.leave",
]);

const FORBIDDEN_RELAY_FIELDS =
  /^(authorization|campaign|cookie|credentials?|csrf(?:token)?|file|filename|localPath|notes?|passphrase|path|pin|secret|sessionNotes|token|vaultRoot|workbook)$/i;

function protocolError(message) {
  return Object.assign(new Error(message), { code: "INVALID_RELAY_MESSAGE" });
}

function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw protocolError(`${label} must be an object`);
  }
  return value;
}

function exact(value, keys, label) {
  const result = object(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) {
      throw protocolError(`${label} contains unknown field ${key}`);
    }
  }
  return result;
}

function string(value, label, { min = 1, max = 256 } = {}) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max
  ) {
    throw protocolError(`${label} must be ${min}-${max} characters`);
  }
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw protocolError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw protocolError(`${label} must be a boolean`);
  }
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) {
    throw protocolError(`${label} is not supported`);
  }
  return value;
}

function optionalString(value, label, options) {
  return value === undefined ? undefined : string(value, label, options);
}

function stringArray(value, label, { maxItems = 100, itemMax = 128 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw protocolError(`${label} must contain at most ${maxItems} values`);
  }
  const result = value.map((entry, index) =>
    string(entry, `${label}[${index}]`, { max: itemMax }),
  );
  if (new Set(result).size !== result.length) {
    throw protocolError(`${label} must not contain duplicates`);
  }
  return result;
}

export function assertRelaySafeValue(
  value,
  { label = "Relay payload", depth = 0 } = {},
) {
  if (depth > 12) throw protocolError(`${label} is nested too deeply`);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 32_000) {
      throw protocolError(`${label} contains an oversized string`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw protocolError(`${label} contains an oversized array`);
    }
    value.forEach((entry, index) =>
      assertRelaySafeValue(entry, {
        label: `${label}[${index}]`,
        depth: depth + 1,
      }),
    );
    return value;
  }
  const record = object(value, label);
  for (const [key, entry] of Object.entries(record)) {
    if (FORBIDDEN_RELAY_FIELDS.test(key)) {
      throw protocolError(`${label} contains forbidden field ${key}`);
    }
    assertRelaySafeValue(entry, {
      label: `${label}.${key}`,
      depth: depth + 1,
    });
  }
  return value;
}

function player(value, label = "Player") {
  const record = exact(value, ["playerId", "displayName"], label);
  return {
    playerId: string(record.playerId, `${label}.playerId`, { max: 128 }),
    displayName: string(record.displayName, `${label}.displayName`, {
      max: 60,
    }),
  };
}

function players(value, label = "Players") {
  if (!Array.isArray(value) || value.length > 100) {
    throw protocolError(`${label} must contain at most 100 players`);
  }
  const result = value.map((entry, index) => player(entry, `${label}[${index}]`));
  if (new Set(result.map((entry) => entry.playerId)).size !== result.length) {
    throw protocolError(`${label} contains duplicate player IDs`);
  }
  return result;
}

function tracker(value, label) {
  const record = object(value, label);
  const common = ["id", "type", "name", "hidden"];
  const keys =
    record.type === "initiative"
      ? [...common, "entries", "turn"]
      : [...common, "max", "value"];
  exact(record, keys, label);
  const result = {
    id: integer(record.id, `${label}.id`, { min: 1 }),
    type: oneOf(record.type, ["clock", "meter", "initiative"], `${label}.type`),
    name: string(record.name, `${label}.name`, { max: 80 }),
    hidden: boolean(record.hidden, `${label}.hidden`),
  };
  if (result.hidden) {
    throw protocolError(`${label} must not contain a hidden tracker`);
  }
  if (result.type === "initiative") {
    result.entries = stringArray(record.entries, `${label}.entries`, {
      maxItems: 40,
      itemMax: 60,
    });
    result.turn = integer(record.turn, `${label}.turn`, {
      max: Math.max(0, result.entries.length - 1),
    });
  } else {
    result.max = integer(record.max, `${label}.max`, { min: 1, max: 1000 });
    result.value = integer(record.value, `${label}.value`, {
      max: result.max,
    });
  }
  return result;
}

function status(value, label = "Status") {
  const record = exact(value, ["trackers", "updatedAt"], label);
  if (!Array.isArray(record.trackers) || record.trackers.length > 100) {
    throw protocolError(`${label}.trackers must contain at most 100 trackers`);
  }
  return {
    trackers: record.trackers.map((entry, index) =>
      tracker(entry, `${label}.trackers[${index}]`),
    ),
    updatedAt: integer(record.updatedAt, `${label}.updatedAt`),
  };
}

function roll(value, label) {
  assertRelaySafeValue(value, { label });
  return structuredClone(value);
}

function chatMessage(value, label = "Chat message") {
  const record = exact(
    value,
    [
      "id",
      "ts",
      "scope",
      "from",
      "fromPlayerId",
      "to",
      "toPlayerId",
      "type",
      "text",
      "roll",
    ],
    label,
  );
  const scope = oneOf(record.scope, ["table", "whisper"], `${label}.scope`);
  const result = {
    id: integer(record.id, `${label}.id`, { min: 1 }),
    ts: integer(record.ts, `${label}.ts`),
    scope,
    from: string(record.from, `${label}.from`, { max: 60 }),
  };
  const fromPlayerId = optionalString(
    record.fromPlayerId,
    `${label}.fromPlayerId`,
    { max: 128 },
  );
  if (fromPlayerId !== undefined) result.fromPlayerId = fromPlayerId;
  if (scope === "whisper") {
    result.to = string(record.to, `${label}.to`, { max: 60 });
    result.toPlayerId = string(record.toPlayerId, `${label}.toPlayerId`, {
      max: 128,
    });
  } else if (record.to !== undefined || record.toPlayerId !== undefined) {
    throw protocolError(`${label} table messages cannot name a recipient`);
  }
  if (record.type !== undefined) {
    result.type = oneOf(record.type, ["roll"], `${label}.type`);
  }
  if (record.text !== undefined) {
    result.text = string(record.text, `${label}.text`, { max: 2_000 });
  }
  if (record.roll !== undefined) result.roll = roll(record.roll, `${label}.roll`);
  if (result.text === undefined && result.roll === undefined) {
    throw protocolError(`${label} requires text or roll`);
  }
  return result;
}

function presentationItem(value, label) {
  const record = object(value, label);
  const common = ["id", "type", "ts", "title"];
  const keys =
    record.type === "text"
      ? [...common, "text"]
      : record.type === "card"
        ? [...common, "markdown"]
        : [...common, "assetId"];
  exact(record, keys, label);
  const result = {
    id: integer(record.id, `${label}.id`, { min: 1 }),
    type: oneOf(record.type, ["text", "card", "image"], `${label}.type`),
    ts: integer(record.ts, `${label}.ts`),
    title: string(record.title, `${label}.title`, { max: 120 }),
  };
  if (result.type === "text") {
    result.text = string(record.text, `${label}.text`, { max: 8_000 });
  } else if (result.type === "card") {
    result.markdown = string(record.markdown, `${label}.markdown`, {
      max: 32_000,
    });
  } else {
    result.assetId = string(record.assetId, `${label}.assetId`, { max: 128 });
  }
  return result;
}

function presentation(value, label = "Presentation") {
  const record = exact(value, ["items", "updatedAt"], label);
  if (!Array.isArray(record.items) || record.items.length > 100) {
    throw protocolError(`${label}.items must contain at most 100 items`);
  }
  return {
    items: record.items.map((entry, index) =>
      presentationItem(entry, `${label}.items[${index}]`),
    ),
    updatedAt: integer(record.updatedAt, `${label}.updatedAt`),
  };
}

function roomState(value) {
  const record = exact(
    value,
    ["presentation", "status", "chat", "players"],
    "Room state",
  );
  if (!Array.isArray(record.chat) || record.chat.length > 200) {
    throw protocolError("Room state.chat must contain at most 200 messages");
  }
  return {
    presentation: presentation(record.presentation),
    status: status(record.status),
    chat: record.chat.map((entry, index) =>
      chatMessage(entry, `Room state.chat[${index}]`),
    ),
    players: players(record.players),
  };
}

function audience(value) {
  const record = object(value, "Audience");
  if (record.kind === "all" || record.kind === "dm") {
    exact(record, ["kind"], "Audience");
    return { kind: record.kind };
  }
  if (record.kind === "player") {
    exact(record, ["kind", "playerId"], "Audience");
    return {
      kind: record.kind,
      playerId: string(record.playerId, "Audience.playerId", { max: 128 }),
    };
  }
  if (record.kind === "players") {
    exact(record, ["kind", "playerIds"], "Audience");
    return {
      kind: record.kind,
      playerIds: stringArray(record.playerIds, "Audience.playerIds", {
        maxItems: 100,
        itemMax: 128,
      }),
    };
  }
  throw protocolError("Audience kind is not supported");
}

function eventData(eventType, value) {
  const record = object(value, "Room event data");
  if (eventType === "reveal.set") {
    exact(record, ["presentation"], "Room event data");
    return { presentation: presentation(record.presentation) };
  }
  if (eventType === "status.set") {
    exact(record, ["status"], "Room event data");
    return { status: status(record.status) };
  }
  if (eventType === "chat.append") {
    exact(record, ["message"], "Room event data");
    return { message: chatMessage(record.message) };
  }
  exact(record, ["players"], "Room event data");
  return { players: players(record.players) };
}

function commandData(commandType, value) {
  const record = object(value, "Room command data");
  if (commandType === "chat.send") {
    exact(record, ["text", "whisper"], "Room command data");
    return {
      text: string(record.text, "Room command data.text", { max: 2_000 }),
      whisper: boolean(record.whisper, "Room command data.whisper"),
    };
  }
  if (commandType === "player.rename") {
    exact(record, ["displayName"], "Room command data");
    return {
      displayName: string(
        record.displayName,
        "Room command data.displayName",
        { max: 60 },
      ),
    };
  }
  exact(record, [], "Room command data");
  return {};
}

function validatePayload(type, payload) {
  const record = object(payload, "Relay payload");
  if (type === "agent.hello") {
    exact(record, ["agentId", "appVersion", "capabilities"], "Relay payload");
    return {
      agentId: string(record.agentId, "Relay payload.agentId", { max: 128 }),
      appVersion: string(record.appVersion, "Relay payload.appVersion", {
        max: 40,
      }),
      capabilities: stringArray(
        record.capabilities,
        "Relay payload.capabilities",
        { maxItems: 32, itemMax: 64 },
      ),
    };
  }
  if (type === "relay.hello") {
    exact(
      record,
      ["connectionId", "heartbeatMs", "maxMessageBytes"],
      "Relay payload",
    );
    return {
      connectionId: string(
        record.connectionId,
        "Relay payload.connectionId",
        { max: 128 },
      ),
      heartbeatMs: integer(
        record.heartbeatMs,
        "Relay payload.heartbeatMs",
        { min: 5_000, max: 120_000 },
      ),
      maxMessageBytes: integer(
        record.maxMessageBytes,
        "Relay payload.maxMessageBytes",
        { min: 1_024, max: RELAY_MAX_MESSAGE_BYTES },
      ),
    };
  }
  if (type === "heartbeat") {
    exact(record, ["nonce"], "Relay payload");
    return {
      nonce: string(record.nonce, "Relay payload.nonce", { max: 128 }),
    };
  }
  if (type === "room.snapshot") {
    exact(record, ["revision", "state"], "Relay payload");
    return {
      revision: integer(record.revision, "Relay payload.revision"),
      state: roomState(record.state),
    };
  }
  if (type === "room.event") {
    exact(
      record,
      ["revision", "eventType", "audience", "data"],
      "Relay payload",
    );
    const eventType = oneOf(
      record.eventType,
      ROOM_EVENT_TYPES,
      "Relay payload.eventType",
    );
    return {
      revision: integer(record.revision, "Relay payload.revision", { min: 1 }),
      eventType,
      audience: audience(record.audience),
      data: eventData(eventType, record.data),
    };
  }
  if (type === "room.command") {
    exact(
      record,
      ["commandId", "playerId", "commandType", "data"],
      "Relay payload",
    );
    const commandType = oneOf(
      record.commandType,
      ROOM_COMMAND_TYPES,
      "Relay payload.commandType",
    );
    return {
      commandId: string(record.commandId, "Relay payload.commandId", {
        max: 128,
      }),
      playerId: string(record.playerId, "Relay payload.playerId", {
        max: 128,
      }),
      commandType,
      data: commandData(commandType, record.data),
    };
  }
  if (type === "room.command-result") {
    exact(
      record,
      ["commandId", "accepted", "code", "revision"],
      "Relay payload",
    );
    const result = {
      commandId: string(record.commandId, "Relay payload.commandId", {
        max: 128,
      }),
      accepted: boolean(record.accepted, "Relay payload.accepted"),
    };
    const code = optionalString(record.code, "Relay payload.code", {
      max: 80,
    });
    if (code !== undefined) result.code = code;
    if (record.revision !== undefined) {
      result.revision = integer(record.revision, "Relay payload.revision");
    }
    return result;
  }
  exact(record, ["players", "joinsOpen"], "Relay payload");
  return {
    players: players(record.players),
    joinsOpen: boolean(record.joinsOpen, "Relay payload.joinsOpen"),
  };
}

function requiresRoom(type) {
  return type.startsWith("room.");
}

export function validateRelayEnvelope(value, { direction } = {}) {
  const record = exact(
    value,
    ["protocol", "version", "id", "type", "roomId", "sentAt", "payload"],
    "Relay envelope",
  );
  if (record.protocol !== RELAY_PROTOCOL_NAME) {
    throw protocolError("Relay protocol name is not supported");
  }
  if (record.version !== RELAY_PROTOCOL_VERSION) {
    throw protocolError("Relay protocol version is not supported");
  }
  const types =
    direction === "agent-to-relay"
      ? AGENT_MESSAGE_TYPES
      : direction === "relay-to-agent"
        ? RELAY_MESSAGE_TYPES
        : [...AGENT_MESSAGE_TYPES, ...RELAY_MESSAGE_TYPES];
  const type = oneOf(record.type, types, "Relay envelope.type");
  const roomId = optionalString(record.roomId, "Relay envelope.roomId", {
    max: 128,
  });
  if (requiresRoom(type) && roomId === undefined) {
    throw protocolError(`${type} requires a roomId`);
  }
  if (!requiresRoom(type) && roomId !== undefined) {
    throw protocolError(`${type} must not include a roomId`);
  }
  const result = {
    protocol: RELAY_PROTOCOL_NAME,
    version: RELAY_PROTOCOL_VERSION,
    id: string(record.id, "Relay envelope.id", { max: 128 }),
    type,
    sentAt: integer(record.sentAt, "Relay envelope.sentAt"),
    payload: validatePayload(type, record.payload),
  };
  if (roomId !== undefined) result.roomId = roomId;
  assertRelaySafeValue(result);
  return result;
}

export function encodeRelayEnvelope(value, options) {
  const validated = validateRelayEnvelope(value, options);
  const encoded = JSON.stringify(validated);
  if (Buffer.byteLength(encoded, "utf8") > RELAY_MAX_MESSAGE_BYTES) {
    throw protocolError("Relay message exceeds the maximum encoded size");
  }
  return encoded;
}

export function decodeRelayEnvelope(encoded, options) {
  if (typeof encoded !== "string") {
    throw protocolError("Relay message must be a JSON string");
  }
  if (Buffer.byteLength(encoded, "utf8") > RELAY_MAX_MESSAGE_BYTES) {
    throw protocolError("Relay message exceeds the maximum encoded size");
  }
  let value;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw protocolError("Relay message is not valid JSON");
  }
  return validateRelayEnvelope(value, options);
}
