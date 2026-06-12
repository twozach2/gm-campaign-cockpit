function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function parseNoteOperation(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Notes request must be a JSON object");
  }

  const campaign = typeof body.campaign === "string" ? body.campaign.trim() : "";
  if (!campaign || campaign.length > 200) {
    throw badRequest("A valid campaign is required");
  }

  const session = Number(body.session);
  if (!Number.isSafeInteger(session) || session < 0 || session > 1_000_000) {
    throw badRequest("A valid session number is required");
  }

  if (typeof body.notes !== "string" || body.notes.length > 100_000) {
    throw badRequest("Notes must be text under 100,000 characters");
  }

  const operationId =
    typeof body.operationId === "string" ? body.operationId.trim() : "";
  if (
    operationId.length < 8 ||
    operationId.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(operationId)
  ) {
    throw badRequest("A valid notes operation ID is required");
  }

  const revision = Number(body.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw badRequest("A valid notes revision is required");
  }

  return {
    campaign,
    session,
    notes: body.notes,
    operationId,
    revision,
  };
}

export function acknowledgeNoteOperation(operation, result) {
  return {
    ...result,
    operationId: operation.operationId,
    revision: operation.revision,
  };
}
