import assert from "node:assert/strict";
import test from "node:test";
import {
  createNotesSaveCoordinator,
  selectInitialSession,
} from "../public/notes-save.mjs";
import {
  acknowledgeNoteOperation,
  parseNoteOperation,
} from "../lib/note-operation.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(predicate, message = "condition was not met") {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

test("missing stored session selects the highest session instead of Session 0", () => {
  const sessions = [
    { number: 0, title: "Before the Thunder" },
    { number: 12, title: "The Forge Below" },
    { number: 3, title: "Nightstone" },
  ];

  assert.equal(selectInitialSession(sessions, null).number, 12);
  assert.equal(selectInitialSession(sessions, "").number, 12);
  assert.equal(selectInitialSession(sessions, "0").number, 0);
  assert.equal(selectInitialSession(sessions, "not-a-number").number, 12);
});

test("typing during an in-flight save queues and persists the newest revision", async () => {
  let notes = "First snapshot";
  const calls = [];
  const pending = [];
  const states = [];

  const coordinator = createNotesSaveCoordinator({
    getSnapshot: () => ({
      contextKey: "Campaign:12",
      campaign: "Campaign",
      session: 12,
      notes,
    }),
    saveSnapshot: (operation) => {
      calls.push(operation);
      const wait = deferred();
      pending.push({ operation, wait });
      return wait.promise;
    },
    onStateChange: (state) => states.push(state),
    createOperationId: (() => {
      let id = 0;
      return () => `operation-${++id}`;
    })(),
  });

  coordinator.reset("Campaign:12");
  coordinator.markChanged();
  const saving = coordinator.save();
  await until(() => calls.length === 1);

  notes = "First snapshot\nTyped after request started";
  coordinator.markChanged();
  pending[0].wait.resolve({
    saved: true,
    operationId: pending[0].operation.operationId,
    revision: pending[0].operation.revision,
  });

  await until(() => calls.length === 2, "newer revision was not queued");
  assert.equal(coordinator.getState().dirty, true);
  pending[1].wait.resolve({
    saved: true,
    operationId: pending[1].operation.operationId,
    revision: pending[1].operation.revision,
  });
  await saving;

  assert.deepEqual(
    calls.map((call) => [call.revision, call.notes]),
    [
      [1, "First snapshot"],
      [2, "First snapshot\nTyped after request started"],
    ],
  );
  assert.equal(coordinator.getState().dirty, false);
  assert.equal(coordinator.getState().savedRevision, 2);
  assert.ok(states.some((state) => state.saving && state.dirty));
});

test("duplicate save triggers share one request when nothing changed", async () => {
  const wait = deferred();
  const calls = [];
  const coordinator = createNotesSaveCoordinator({
    getSnapshot: () => ({
      contextKey: "Campaign:12",
      campaign: "Campaign",
      session: 12,
      notes: "One change",
    }),
    saveSnapshot: (operation) => {
      calls.push(operation);
      return wait.promise;
    },
    createOperationId: () => "operation-one",
  });

  coordinator.reset("Campaign:12");
  coordinator.markChanged();
  const first = coordinator.save();
  const second = coordinator.save();
  await until(() => calls.length === 1);
  wait.resolve({
    saved: true,
    operationId: calls[0].operationId,
    revision: calls[0].revision,
  });
  await Promise.all([first, second]);

  assert.equal(calls.length, 1);
  assert.equal(coordinator.getState().dirty, false);
});

test("failed saves leave the current revision dirty", async () => {
  const coordinator = createNotesSaveCoordinator({
    getSnapshot: () => ({
      contextKey: "Campaign:12",
      campaign: "Campaign",
      session: 12,
      notes: "Unsaved",
    }),
    saveSnapshot: async () => {
      throw new Error("disk unavailable");
    },
    createOperationId: () => "operation-fail",
  });

  coordinator.reset("Campaign:12");
  coordinator.markChanged();
  await coordinator.save();

  assert.equal(coordinator.getState().dirty, true);
  assert.match(coordinator.getState().lastError.message, /disk unavailable/);
});

test("switching sessions during a save cannot acknowledge the wrong editor", async () => {
  let snapshot = {
    contextKey: "Campaign:11",
    campaign: "Campaign",
    session: 11,
    notes: "Old session edit",
  };
  const calls = [];
  const pending = [];
  const coordinator = createNotesSaveCoordinator({
    getSnapshot: () => snapshot,
    saveSnapshot: (operation) => {
      calls.push(operation);
      const wait = deferred();
      pending.push({ operation, wait });
      return wait.promise;
    },
    createOperationId: (() => {
      let id = 0;
      return () => `context-operation-${++id}`;
    })(),
  });

  coordinator.reset("Campaign:11");
  coordinator.markChanged();
  const saving = coordinator.save();
  await until(() => calls.length === 1);

  snapshot = {
    contextKey: "Campaign:12",
    campaign: "Campaign",
    session: 12,
    notes: "New session edit",
  };
  coordinator.reset("Campaign:12");
  coordinator.markChanged();
  pending[0].wait.resolve({
    saved: true,
    operationId: pending[0].operation.operationId,
    revision: pending[0].operation.revision,
  });

  await until(() => calls.length === 2, "new session save was not queued");
  assert.deepEqual(
    calls.map((call) => [call.session, call.notes]),
    [
      [11, "Old session edit"],
      [12, "New session edit"],
    ],
  );
  assert.equal(coordinator.getState().dirty, true);

  pending[1].wait.resolve({
    saved: true,
    operationId: pending[1].operation.operationId,
    revision: pending[1].operation.revision,
  });
  await saving;

  assert.equal(coordinator.getState().contextKey, "Campaign:12");
  assert.equal(coordinator.getState().savedRevision, 1);
  assert.equal(coordinator.getState().dirty, false);
});

test("note operation validation requires revision metadata and echoes it", () => {
  const operation = parseNoteOperation({
    campaign: "Storm King's Thunder",
    session: 12,
    notes: "Round one",
    operationId: "operation-123",
    revision: 7,
  });
  const response = acknowledgeNoteOperation(operation, {
    saved: true,
    backup: "data/backups/example.md",
  });

  assert.equal(response.operationId, "operation-123");
  assert.equal(response.revision, 7);
  assert.throws(
    () =>
      parseNoteOperation({
        campaign: "Campaign",
        session: 12,
        notes: "Missing metadata",
      }),
    /operation ID/,
  );
  assert.throws(
    () =>
      parseNoteOperation({
        campaign: "Campaign",
        session: 12,
        notes: "Bad revision",
        operationId: "operation-123",
        revision: -1,
      }),
    /revision/,
  );
});
