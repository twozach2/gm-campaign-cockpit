import { parseNoteOperation } from "./note-operation.mjs";

function badRequest(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

function objectBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest("Request body must be a JSON object");
  }
  return value;
}

function exactKeys(value, allowed) {
  const body = objectBody(value);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).find((key) => !allowedSet.has(key));
  if (unknown) badRequest(`Unknown request field: ${unknown}`);
  return body;
}

function requiredString(body, key, maxLength, label = key) {
  if (typeof body[key] !== "string") {
    badRequest(`${label} must be text`);
  }
  const value = body[key].trim();
  if (!value || value.length > maxLength) {
    badRequest(`${label} must be between 1 and ${maxLength} characters`);
  }
  return value;
}

function optionalString(body, key, maxLength, label = key) {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== "string") {
    badRequest(`${label} must be text`);
  }
  const value = body[key].trim();
  if (value.length > maxLength) {
    badRequest(`${label} must be at most ${maxLength} characters`);
  }
  return value;
}

function requiredContent(body, key, maxLength, label = key) {
  if (
    typeof body[key] !== "string" ||
    !body[key].trim() ||
    body[key].length > maxLength
  ) {
    badRequest(`${label} must be non-empty text under ${maxLength} characters`);
  }
  return body[key];
}

function optionalBoolean(body, key) {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== "boolean") {
    badRequest(`${key} must be true or false`);
  }
  return body[key];
}

function requiredInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    badRequest(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalInteger(body, key, limits) {
  if (body[key] === undefined) return undefined;
  return requiredInteger(body[key], key, limits);
}

function emptyBody(value) {
  exactKeys(value, []);
  return {};
}

function displayNameBody(value) {
  const body = exactKeys(value, ["displayName"]);
  return { displayName: requiredString(body, "displayName", 60, "Display name") };
}

function loginBody(value) {
  const body = exactKeys(value, ["pin"]);
  if (
    typeof body.pin !== "string" ||
    body.pin.length < 1 ||
    body.pin.length > 256
  ) {
    badRequest("Table PIN must be between 1 and 256 characters");
  }
  return { pin: body.pin };
}

function chatBody(value) {
  const body = exactKeys(value, ["text", "whisper", "from"]);
  return {
    text: requiredContent(body, "text", 2_000, "Chat text"),
    whisper: optionalBoolean(body, "whisper") || false,
  };
}

function revealCardBody(value) {
  const body = exactKeys(value, ["campaign", "cardId"]);
  return {
    campaign: requiredString(body, "campaign", 200, "Campaign"),
    cardId: requiredString(body, "cardId", 200, "Card ID"),
  };
}

function revealImageBody(value) {
  const body = exactKeys(value, ["campaign", "file", "title"]);
  return {
    campaign: requiredString(body, "campaign", 200, "Campaign"),
    file: requiredString(body, "file", 1_000, "File"),
    title: optionalString(body, "title", 120, "Title"),
  };
}

function revealTextBody(value) {
  const body = exactKeys(value, ["text", "title"]);
  return {
    text: requiredContent(body, "text", 4_000, "Reveal text"),
    title: optionalString(body, "title", 80, "Title"),
  };
}

function idBody(value, label) {
  const body = exactKeys(value, ["id"]);
  return { id: requiredInteger(body.id, label, { min: 1 }) };
}

function whisperBody(value) {
  const body = exactKeys(value, ["toPlayerId", "text"]);
  return {
    toPlayerId: requiredString(body, "toPlayerId", 200, "Player ID"),
    text: requiredContent(body, "text", 2_000, "Whisper text"),
  };
}

function statusUpsertBody(value) {
  const body = exactKeys(value, [
    "id",
    "name",
    "type",
    "max",
    "value",
    "hidden",
    "entries",
    "turn",
  ]);
  const result = {
    id: optionalInteger(body, "id", { min: 1 }),
    name: optionalString(body, "name", 80, "Tracker name"),
    max: optionalInteger(body, "max", { min: 1, max: 1_000 }),
    value: optionalInteger(body, "value", {
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    }),
    hidden: optionalBoolean(body, "hidden"),
    turn: optionalInteger(body, "turn", {
      min: Number.MIN_SAFE_INTEGER,
      max: Number.MAX_SAFE_INTEGER,
    }),
  };
  if (body.type !== undefined) {
    if (!["clock", "meter", "initiative"].includes(body.type)) {
      badRequest("type must be clock, meter, or initiative");
    }
    result.type = body.type;
  }
  if (body.entries !== undefined) {
    if (!Array.isArray(body.entries) || body.entries.length > 40) {
      badRequest("entries must be an array of at most 40 names");
    }
    result.entries = body.entries.map((entry) => {
      if (typeof entry !== "string") badRequest("Initiative entries must be text");
      const trimmed = entry.trim();
      if (!trimmed || trimmed.length > 60) {
        badRequest("Initiative entries must be between 1 and 60 characters");
      }
      return trimmed;
    });
  }
  if (result.id === undefined && !result.name) {
    badRequest("Tracker name required");
  }
  return Object.fromEntries(
    Object.entries(result).filter(([, entry]) => entry !== undefined),
  );
}

function notesBody(value) {
  const body = exactKeys(value, [
    "campaign",
    "session",
    "notes",
    "operationId",
    "revision",
  ]);
  return parseNoteOperation(body);
}

function queryValues(searchParams, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) badRequest(`Unknown query parameter: ${key}`);
    if (searchParams.getAll(key).length > 1) {
      badRequest(`Query parameter may only appear once: ${key}`);
    }
  }
  return Object.fromEntries(
    allowedKeys.map((key) => [key, searchParams.get(key)]),
  );
}

function queryString(values, key, maxLength, { required = true, label = key } = {}) {
  const value = values[key];
  if (value === null) {
    if (required) badRequest(`${label} is required`);
    return undefined;
  }
  const trimmed = value.trim();
  if ((!trimmed && required) || trimmed.length > maxLength) {
    badRequest(`${label} is invalid`);
  }
  return trimmed || undefined;
}

function queryInteger(values, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = values[key];
  if (value === null || !/^-?\d+$/.test(value)) {
    badRequest(`${key} must be an integer`);
  }
  return requiredInteger(Number(value), key, { min, max });
}

function noQuery(searchParams) {
  queryValues(searchParams, []);
  return {};
}

function streamQuery(searchParams) {
  const values = queryValues(searchParams, ["role", "ticket"]);
  const role = queryString(values, "role", 20, { required: false });
  if (role !== undefined && role !== "dm") badRequest("role must be dm when provided");
  return {
    role,
    ticket: queryString(values, "ticket", 256, { label: "Stream ticket" }),
  };
}

function campaignQuery(searchParams) {
  const values = queryValues(searchParams, ["campaign"]);
  return {
    campaign: queryString(values, "campaign", 200, { label: "Campaign" }),
  };
}

function sessionQuery(searchParams) {
  const values = queryValues(searchParams, ["campaign", "number"]);
  return {
    campaign: queryString(values, "campaign", 200, { label: "Campaign" }),
    number: queryInteger(values, "number", { min: 0, max: 1_000_000 }),
  };
}

function documentQuery(searchParams) {
  const values = queryValues(searchParams, ["campaign", "file", "heading"]);
  return {
    campaign: queryString(values, "campaign", 200, { label: "Campaign" }),
    file: queryString(values, "file", 1_000, { label: "Document" }),
    heading:
      queryString(values, "heading", 300, {
        required: false,
        label: "Heading",
      }) || "",
  };
}

function fileQuery(searchParams) {
  const values = queryValues(searchParams, ["campaign", "file"]);
  return {
    campaign: queryString(values, "campaign", 200, { label: "Campaign" }),
    file: queryString(values, "file", 1_000, { label: "File" }),
  };
}

function optionalCampaignQuery(searchParams) {
  const values = queryValues(searchParams, ["campaign"]);
  return {
    campaign: queryString(values, "campaign", 200, {
      required: false,
      label: "Campaign",
    }),
  };
}

function imageQuery(searchParams) {
  const values = queryValues(searchParams, ["id"]);
  return { id: queryInteger(values, "id", { min: 1 }) };
}

function route(method, role, options = {}) {
  return Object.freeze({
    method,
    role,
    mutates: method !== "GET",
    maxBodyBytes: 4_096,
    parseBody: method === "GET" ? null : emptyBody,
    parseQuery: noQuery,
    ...options,
  });
}

export const API_ROUTES = Object.freeze({
  "/api/health": route("GET", "public"),
  "/api/dm/session": route("GET", "public"),
  "/api/dm/login": route("POST", "public", { parseBody: loginBody }),
  "/api/dm/logout": route("POST", "dm"),
  "/api/dm/stream-ticket": route("POST", "dm"),
  "/api/player/join": route("POST", "public", { parseBody: displayNameBody }),
  "/api/player/rename": route("POST", "player", { parseBody: displayNameBody }),
  "/api/player/leave": route("POST", "player"),
  "/api/player/stream-ticket": route("POST", "player"),
  "/api/stream": route("GET", "ticket", { parseQuery: streamQuery }),
  "/api/player/state": route("GET", "player"),
  "/api/dm/state": route("GET", "dm"),
  "/api/player/image": route("GET", "revealed", { parseQuery: imageQuery }),
  "/api/chat": route("POST", "dm-or-player", {
    maxBodyBytes: 8_192,
    parseBody: chatBody,
  }),
  "/api/player-guide": route("GET", "dm", { parseQuery: campaignQuery }),
  "/api/reveal/card": route("POST", "dm", { parseBody: revealCardBody }),
  "/api/reveal/image": route("POST", "dm", {
    maxBodyBytes: 8_192,
    parseBody: revealImageBody,
  }),
  "/api/reveal/text": route("POST", "dm", {
    maxBodyBytes: 8_192,
    parseBody: revealTextBody,
  }),
  "/api/reveal/remove": route("POST", "dm", {
    parseBody: (body) => idBody(body, "Reveal ID"),
  }),
  "/api/reveal/clear": route("POST", "dm"),
  "/api/whisper": route("POST", "dm", {
    maxBodyBytes: 8_192,
    parseBody: whisperBody,
  }),
  "/api/status": route("GET", "dm"),
  "/api/status/upsert": route("POST", "dm", {
    maxBodyBytes: 16_384,
    parseBody: statusUpsertBody,
  }),
  "/api/status/remove": route("POST", "dm", {
    parseBody: (body) => idBody(body, "Tracker ID"),
  }),
  "/api/campaigns": route("GET", "dm"),
  "/api/sessions": route("GET", "dm", { parseQuery: campaignQuery }),
  "/api/session": route("GET", "dm", { parseQuery: sessionQuery }),
  "/api/document": route("GET", "dm", { parseQuery: documentQuery }),
  "/api/documents": route("GET", "dm", { parseQuery: campaignQuery }),
  "/api/file": route("GET", "dm", { parseQuery: fileQuery }),
  "/api/validate": route("GET", "dm", {
    parseQuery: optionalCampaignQuery,
  }),
  "/api/notes": route("POST", "dm", {
    maxBodyBytes: 150_000,
    parseBody: notesBody,
  }),
});

export function apiRoute(pathname) {
  return API_ROUTES[pathname] || null;
}

export function parseRouteQuery(policy, searchParams) {
  return policy.parseQuery(searchParams);
}

export function parseRouteBody(policy, body) {
  return policy.parseBody ? policy.parseBody(body) : null;
}
