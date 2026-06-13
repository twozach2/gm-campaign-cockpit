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
      return null;
    }
    return { ...common, assetId: item.assetId };
  }
  throw new Error(`Unsupported relay presentation item type: ${item.type}`);
}

export function messageForRelay(message) {
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

export function presentationForRelay(presentation) {
  return {
    items: presentation.items.map(relayPresentationItem).filter(Boolean),
    updatedAt: presentation.updatedAt,
  };
}

export function createRelayRoomState({
  presentation,
  status,
  chat,
  players,
  relayPlayerIds,
}) {
  const hostedPlayers = relayPlayerIds
    ? new Set(relayPlayerIds)
    : null;
  const relayChat = chat
    .filter(
      (message) =>
        message.scope !== "whisper" ||
        !hostedPlayers ||
        hostedPlayers.has(message.fromPlayerId) ||
        hostedPlayers.has(message.toPlayerId),
    )
    .map(messageForRelay)
    .filter(Boolean);
  return {
    presentation: presentationForRelay(presentation),
    status: trackerStateForAudience(status, { role: "player" }),
    chat: relayChat,
    players: players.map(publicPlayer),
  };
}
