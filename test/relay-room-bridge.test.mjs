import assert from "node:assert/strict";
import test from "node:test";
import { RelayRoomBridge } from "../lib/relay-room-bridge.mjs";

function bridgeWithPlayer() {
  const bridge = new RelayRoomBridge();
  bridge.applyMembership({
    players: [{ playerId: "remote-1", displayName: "Aria" }],
    joinsOpen: true,
  });
  return bridge;
}

test("relay membership combines with local presence by stable ID", () => {
  const bridge = bridgeWithPlayer();
  assert.deepEqual(bridge.getPlayer("remote-1"), {
    playerId: "remote-1",
    displayName: "Aria",
  });
  assert.equal(bridge.getPlayer("missing"), null);
  assert.deepEqual(bridge.playerIds(), ["remote-1"]);
  assert.deepEqual(
    bridge.combinedPlayers([
      { playerId: "local-1", displayName: "Bram" },
    ]),
    [
      { playerId: "local-1", displayName: "Bram" },
      { playerId: "remote-1", displayName: "Aria" },
    ],
  );
});

test("relay chat commands use server-derived player identity", async () => {
  const bridge = bridgeWithPlayer();
  const submitted = [];
  await bridge.handleCommand(
    {
      commandId: "command-1",
      playerId: "remote-1",
      commandType: "chat.send",
      data: { text: "Hello", whisper: true },
    },
    {
      submitChat: (message) => submitted.push(message),
      onPresence: () => {},
    },
  );
  assert.deepEqual(submitted, [
    {
      role: "player",
      player: { playerId: "remote-1", displayName: "Aria" },
      text: "Hello",
      whisper: true,
    },
  ]);
});

test("relay rename and leave commands update presence", async () => {
  const bridge = bridgeWithPlayer();
  let presenceUpdates = 0;
  const callbacks = {
    submitChat: () => {},
    onPresence: () => {
      presenceUpdates += 1;
    },
  };

  await bridge.handleCommand(
    {
      commandId: "command-1",
      playerId: "remote-1",
      commandType: "player.rename",
      data: { displayName: "Ariadne" },
    },
    callbacks,
  );
  assert.deepEqual(bridge.combinedPlayers([]), [
    { playerId: "remote-1", displayName: "Ariadne" },
  ]);

  await bridge.handleCommand(
    {
      commandId: "command-2",
      playerId: "remote-1",
      commandType: "player.leave",
      data: {},
    },
    callbacks,
  );
  assert.deepEqual(bridge.combinedPlayers([]), []);
  assert.equal(presenceUpdates, 2);
});

test("relay commands reject absent players and reserved names", async () => {
  const bridge = bridgeWithPlayer();
  const callbacks = { submitChat: () => {}, onPresence: () => {} };
  await assert.rejects(
    bridge.handleCommand(
      {
        commandId: "command-1",
        playerId: "missing",
        commandType: "player.leave",
        data: {},
      },
      callbacks,
    ),
    (error) => error.code === "PLAYER_NOT_PRESENT",
  );
  await assert.rejects(
    bridge.handleCommand(
      {
        commandId: "command-2",
        playerId: "remote-1",
        commandType: "player.rename",
        data: { displayName: "DM" },
      },
      callbacks,
    ),
    (error) => error.code === "DISPLAY_NAME_REJECTED",
  );
});

test("relay whisper audiences include only hosted participants", () => {
  const bridge = bridgeWithPlayer();
  assert.deepEqual(
    bridge.audienceForMessage({
      scope: "whisper",
      fromPlayerId: "remote-1",
      to: "DM",
    }),
    { kind: "player", playerId: "remote-1" },
  );
  assert.equal(
    bridge.audienceForMessage({
      scope: "whisper",
      fromPlayerId: "local-1",
      to: "DM",
    }),
    null,
  );
  assert.deepEqual(bridge.audienceForMessage({ scope: "table" }), {
    kind: "all",
  });
});
