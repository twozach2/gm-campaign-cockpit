function defaultOperationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function selectInitialSession(sessions, storedValue) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  const highest = sessions.reduce(
    (max, session) => (session.number > max.number ? session : max),
    sessions[0],
  );
  if (storedValue === null || storedValue === undefined || storedValue === "") {
    return highest;
  }
  const storedNumber = Number(storedValue);
  if (!Number.isSafeInteger(storedNumber)) return highest;
  return sessions.find((session) => session.number === storedNumber) || highest;
}

export function createNotesSaveCoordinator({
  getSnapshot,
  saveSnapshot,
  onStateChange = () => {},
  createOperationId = defaultOperationId,
}) {
  let contextKey = null;
  let revision = 0;
  let savedRevision = 0;
  let savingRevision = null;
  let savePromise = null;
  let lastSavedAt = null;
  let lastError = null;

  function state() {
    return {
      contextKey,
      revision,
      savedRevision,
      savingRevision,
      saving: savePromise !== null,
      dirty: revision !== savedRevision,
      lastSavedAt,
      lastError,
    };
  }

  function emit() {
    onStateChange(state());
  }

  function reset(nextContextKey) {
    contextKey = nextContextKey;
    revision = 0;
    savedRevision = 0;
    lastSavedAt = null;
    lastError = null;
    emit();
  }

  function markChanged() {
    revision += 1;
    lastError = null;
    emit();
    return revision;
  }

  async function drain({ force = false } = {}) {
    if (savePromise) return savePromise;
    if (!force && revision === savedRevision) return null;

    const run = async () => {
      let shouldForce = force;
      while (shouldForce || revision !== savedRevision) {
        shouldForce = false;
        const snapshot = getSnapshot();
        if (!snapshot || snapshot.contextKey !== contextKey) break;

        const capturedContext = contextKey;
        const capturedRevision = revision;
        const operationId = createOperationId();
        const { contextKey: _contextKey, ...requestSnapshot } = snapshot;
        savingRevision = capturedRevision;
        lastError = null;
        emit();

        try {
          const result = await saveSnapshot({
            ...requestSnapshot,
            operationId,
            revision: capturedRevision,
          });
          if (
            result?.operationId !== operationId ||
            result?.revision !== capturedRevision
          ) {
            throw new Error("The notes server returned a mismatched save acknowledgement");
          }
          if (contextKey === capturedContext) {
            savedRevision = Math.max(savedRevision, capturedRevision);
            lastSavedAt = Date.now();
            lastError = null;
          }
        } catch (error) {
          if (contextKey === capturedContext) lastError = error;
          break;
        } finally {
          savingRevision = null;
          emit();
        }
      }
    };

    savePromise = Promise.resolve().then(run).finally(() => {
      savePromise = null;
      emit();
    });
    return savePromise;
  }

  return {
    reset,
    markChanged,
    save: drain,
    getState: state,
    isDirty: () => revision !== savedRevision,
    isSaving: () => savePromise !== null,
  };
}
