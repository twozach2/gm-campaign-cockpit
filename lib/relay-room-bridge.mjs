function commandError(code) {
  return Object.assign(new Error("Relay command rejected"), { code });
}

export class RelayRoomBridge {
  constructor() {
    this.players = new Map();
  }

  applyMembership(membership) {
    this.players.clear();
    for (const player of membership.players) {
      this.players.set(player.playerId, structuredClone(player));
    }
  }

  getPlayer(playerId) {
    const player = this.players.get(playerId);
    return player ? structuredClone(player) : null;
  }

  playerIds() {
    return [...this.players.keys()];
  }

  combinedPlayers(localPlayers) {
    const combined = new Map(
      localPlayers.map((player) => [player.playerId, player]),
    );
    for (const player of this.players.values()) {
      combined.set(player.playerId, structuredClone(player));
    }
    return [...combined.values()];
  }

  audienceForMessage(message) {
    if (message.scope === "table") return { kind: "all" };
    if (message.scope !== "whisper") return null;
    const playerIds = [message.fromPlayerId, message.toPlayerId].filter(
      (playerId) => playerId && this.players.has(playerId),
    );
    const unique = [...new Set(playerIds)];
    if (!unique.length) return null;
    if (unique.length === 1) {
      return { kind: "player", playerId: unique[0] };
    }
    return { kind: "players", playerIds: unique };
  }

  async handleCommand(command, { submitChat, onPresence }) {
    const player = this.players.get(command.playerId);
    if (!player) throw commandError("PLAYER_NOT_PRESENT");

    if (command.commandType === "chat.send") {
      submitChat({
        role: "player",
        player: structuredClone(player),
        text: command.data.text,
        whisper: command.data.whisper,
      });
      return { accepted: true };
    }

    if (command.commandType === "player.rename") {
      const displayName = command.data.displayName.trim();
      if (!displayName || /^dm$/i.test(displayName)) {
        throw commandError("DISPLAY_NAME_REJECTED");
      }
      this.players.set(player.playerId, { ...player, displayName });
      await onPresence();
      return { accepted: true };
    }

    if (command.commandType === "player.leave") {
      this.players.delete(player.playerId);
      await onPresence();
      return { accepted: true };
    }

    throw commandError("COMMAND_NOT_SUPPORTED");
  }
}
