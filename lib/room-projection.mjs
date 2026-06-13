function copyDefined(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = structuredClone(source[key]);
  }
  return result;
}

export function publicPlayer(player) {
  return {
    playerId: player.playerId,
    displayName: player.displayName,
  };
}

export function messageVisibleToAudience(message, audience) {
  if (message.scope === "table") return true;
  if (audience.role === "dm") return true;
  if (message.scope === "secret") return false;
  return (
    audience.role === "player" &&
    Boolean(audience.playerId) &&
    (message.toPlayerId === audience.playerId ||
      message.fromPlayerId === audience.playerId)
  );
}

export function trackerStateForAudience(status, audience) {
  const trackers =
    audience.role === "dm"
      ? status.trackers
      : status.trackers.filter((tracker) => !tracker.hidden);
  return {
    trackers: structuredClone(trackers),
    updatedAt: status.updatedAt,
  };
}

export function chatForAudience(chat, audience) {
  return chat
    .filter((message) => messageVisibleToAudience(message, audience))
    .map((message) => structuredClone(message));
}

function relayPresentationItem(item) {
  const common = copyDefined(item, ["id", "type", "ts", "title"]);
  if (item.type === "text") {
    return { ...common, text: item.text };
  }
  if (item.type === "card") {
    return { ...common, markdown: item.markdown };
  }
  if (item.type === "image") {
    if (typeof item.assetId !== "string" || !item.assetId) {
      throw new Error("Relay image reveals require an opaque assetId");
    }
    return { ...common, assetId: item.assetId };
  }
  throw new Error(`Unsupported relay presentation item type: ${item.type}`);
}

function relayMessage(message) {
  if (message.scope === "secret") return null;
  return copyDefined(message, [
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
  ]);
}

export function createRelayRoomState({
  presentation,
  status,
  chat,
  players,
}) {
  return {
    presentation: {
      items: presentation.items.map(relayPresentationItem),
      updatedAt: presentation.updatedAt,
    },
    status: trackerStateForAudience(status, { role: "player" }),
    chat: chat.map(relayMessage).filter(Boolean),
    players: players.map(publicPlayer),
  };
}
