import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeRelayEnvelope,
  encodeRelayEnvelope,
  RELAY_PROTOCOL_NAME,
  RELAY_PROTOCOL_VERSION,
  validateRelayEnvelope,
} from "../lib/relay-protocol.mjs";
import {
  chatForAudience,
  createRelayRoomState,
  messageVisibleToAudience,
  trackerStateForAudience,
} from "../lib/room-projection.mjs";

const now = 1_718_000_000_000;

function envelope(type, payload, overrides = {}) {
  return {
    protocol: RELAY_PROTOCOL_NAME,
    version: RELAY_PROTOCOL_VERSION,
    id: "message-1",
    type,
    ...(type.startsWith("room.") ? { roomId: "room-1" } : {}),
    sentAt: now,
    payload,
    ...overrides,
  };
}

function roomState() {
  return {
    presentation: {
      items: [
        {
          id: 1,
          type: "text",
          ts: now,
          title: "A warning",
          text: "The bridge is failing.",
        },
        {
          id: 2,
          type: "image",
          ts: now,
          title: "The map",
          assetId: "asset-1",
        },
      ],
      updatedAt: now,
    },
    status: {
      trackers: [
        {
          id: 1,
          type: "clock",
          name: "Collapse",
          hidden: false,
          max: 6,
          value: 2,
        },
      ],
      updatedAt: now,
    },
    chat: [
      {
        id: 1,
        ts: now,
        scope: "table",
        from: "Aria",
        fromPlayerId: "player-1",
        text: "Run!",
      },
    ],
    players: [{ playerId: "player-1", displayName: "Aria" }],
  };
}

test("relay envelopes round-trip with a strict protocol version", () => {
  const message = envelope("room.snapshot", {
    revision: 3,
    state: roomState(),
  });
  const encoded = encodeRelayEnvelope(message, {
    direction: "agent-to-relay",
  });
  assert.deepEqual(
    decodeRelayEnvelope(encoded, { direction: "agent-to-relay" }),
    message,
  );
  assert.throws(
    () =>
      validateRelayEnvelope({
        ...message,
        version: RELAY_PROTOCOL_VERSION + 1,
      }),
    /version is not supported/,
  );
});

test("message direction and room binding fail closed", () => {
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope("room.command", {
          commandId: "command-1",
          playerId: "player-1",
          commandType: "player.leave",
          data: {},
        }),
        { direction: "agent-to-relay" },
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope(
          "room.event",
          {
            revision: 1,
            eventType: "presence.set",
            audience: { kind: "all" },
            data: { players: [] },
          },
          { roomId: undefined },
        ),
      ),
    /requires a roomId/,
  );
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope(
          "agent.hello",
          {
            agentId: "agent-1",
            appVersion: "0.1.0",
            capabilities: [],
          },
          { roomId: "room-1" },
        ),
      ),
    /must not include a roomId/,
  );
});

test("unknown commands, events, and fields are rejected", () => {
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope("room.command", {
          commandId: "command-1",
          playerId: "player-1",
          commandType: "vault.read",
          data: {},
        }),
        { direction: "relay-to-agent" },
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope("room.event", {
          revision: 1,
          eventType: "notes.set",
          audience: { kind: "all" },
          data: {},
        }),
      ),
    /not supported/,
  );
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope("room.command-result", {
          commandId: "command-1",
          accepted: false,
          reason: "No",
        }),
      ),
    /unknown field reason/,
  );
});

test("relay payloads reject local paths, notes, and credentials", () => {
  for (const [field, value] of [
    ["path", "C:\\Campaign\\secret.png"],
    ["file", "Maps/secret.png"],
    ["campaign", "Private Campaign"],
    ["notes", "Director-only notes"],
    ["token", "secret-token"],
    ["pin", "123456"],
    ["cookie", "gm_session=secret"],
    ["vaultRoot", "/Users/dm/Vault"],
  ]) {
    const state = roomState();
    state.presentation.items[0][field] = value;
    assert.throws(
      () =>
        validateRelayEnvelope(
          envelope("room.snapshot", { revision: 1, state }),
        ),
      /unknown field|forbidden field/,
      field,
    );
  }
});

test("relay snapshots reject hidden trackers even without the projector", () => {
  const state = roomState();
  state.status.trackers[0].hidden = true;
  assert.throws(
    () =>
      validateRelayEnvelope(
        envelope("room.snapshot", { revision: 1, state }),
      ),
    /must not contain a hidden tracker/,
  );
});

test("relay room projection strips local metadata and private state", () => {
  const projected = createRelayRoomState({
    presentation: {
      items: [
        {
          id: 1,
          type: "card",
          ts: now,
          title: "Oracle",
          markdown: "**Speak clearly.**",
          campaign: "Private Campaign",
          cardId: "oracle",
        },
        {
          id: 2,
          type: "image",
          ts: now,
          title: "Map",
          assetId: "asset-1",
          campaign: "Private Campaign",
          file: "Maps/secret.png",
        },
      ],
      updatedAt: now,
    },
    status: {
      trackers: [
        {
          id: 1,
          type: "clock",
          name: "Visible",
          hidden: false,
          max: 4,
          value: 1,
        },
        {
          id: 2,
          type: "clock",
          name: "Secret",
          hidden: true,
          max: 6,
          value: 5,
        },
      ],
      updatedAt: now,
    },
    chat: [
      {
        id: 1,
        ts: now,
        scope: "table",
        from: "DM",
        text: "Shared",
      },
      {
        id: 2,
        ts: now,
        scope: "secret",
        from: "DM",
        type: "roll",
        roll: { total: 20 },
      },
    ],
    players: [
      {
        playerId: "player-1",
        displayName: "Aria",
        tokenHash: "must-not-leak",
        lastSeenAt: now,
      },
    ],
  });

  assert.equal(projected.status.trackers.length, 1);
  assert.equal(projected.chat.length, 1);
  assert.deepEqual(projected.players, [
    { playerId: "player-1", displayName: "Aria" },
  ]);
  assert.deepEqual(projected.presentation.items[0], {
    id: 1,
    type: "card",
    ts: now,
    title: "Oracle",
    markdown: "**Speak clearly.**",
  });
  assert.deepEqual(projected.presentation.items[1], {
    id: 2,
    type: "image",
    ts: now,
    title: "Map",
    assetId: "asset-1",
  });
  assert.doesNotMatch(JSON.stringify(projected), /Private Campaign|secret\.png|tokenHash/);
});

test("relay image projection refuses filesystem-backed reveals", () => {
  assert.throws(
    () =>
      createRelayRoomState({
        presentation: {
          items: [
            {
              id: 1,
              type: "image",
              ts: now,
              title: "Map",
              campaign: "Private Campaign",
              file: "Maps/secret.png",
            },
          ],
          updatedAt: now,
        },
        status: { trackers: [], updatedAt: now },
        chat: [],
        players: [],
      }),
    /opaque assetId/,
  );
});

test("audience projections isolate hidden trackers and whispers", () => {
  const status = {
    trackers: [
      { id: 1, hidden: false },
      { id: 2, hidden: true },
    ],
    updatedAt: now,
  };
  assert.deepEqual(
    trackerStateForAudience(status, { role: "player" }).trackers,
    [{ id: 1, hidden: false }],
  );
  assert.equal(
    trackerStateForAudience(status, { role: "dm" }).trackers.length,
    2,
  );

  const messages = [
    { id: 1, scope: "table" },
    {
      id: 2,
      scope: "whisper",
      fromPlayerId: "player-1",
      toPlayerId: "player-2",
    },
    { id: 3, scope: "secret" },
  ];
  assert.equal(
    messageVisibleToAudience(messages[1], {
      role: "player",
      playerId: "player-3",
    }),
    false,
  );
  assert.deepEqual(
    chatForAudience(messages, { role: "player", playerId: "player-1" }).map(
      (message) => message.id,
    ),
    [1, 2],
  );
  assert.deepEqual(
    chatForAudience(messages, { role: "player", playerId: "player-3" }).map(
      (message) => message.id,
    ),
    [1],
  );
  assert.deepEqual(
    chatForAudience(messages, { role: "dm" }).map((message) => message.id),
    [1, 2, 3],
  );
});

test("relay commands accept only bounded player actions", () => {
  const command = envelope("room.command", {
    commandId: "command-1",
    playerId: "player-1",
    commandType: "chat.send",
    data: { text: "Hello", whisper: false },
  });
  assert.deepEqual(
    validateRelayEnvelope(command, { direction: "relay-to-agent" }),
    command,
  );
  command.payload.data.text = "x".repeat(2_001);
  assert.throws(
    () =>
      validateRelayEnvelope(command, { direction: "relay-to-agent" }),
    /1-2000 characters/,
  );
});
