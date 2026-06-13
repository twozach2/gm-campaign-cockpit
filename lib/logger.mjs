const SENSITIVE_KEY =
  /(authorization|cookie|csrf|file|message|notes|pass|path|pin|secret|session|stack|token|vault|whisper)/i;

function safeValue(value, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value.replace(/[\r\n\t]+/g, " ").slice(0, 200);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      ...(value.code ? { code: String(value.code).slice(0, 80) } : {}),
    };
  }
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((entry) => safeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (value && typeof value === "object") {
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) continue;
      const safe = safeValue(entry, depth + 1);
      if (safe !== undefined) sanitized[key] = safe;
    }
    return sanitized;
  }
  return undefined;
}

function defaultWrite(level, line) {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger({
  now = () => new Date().toISOString(),
  write = defaultWrite,
} = {}) {
  function emit(level, event, details = {}) {
    const safeDetails = safeValue(details) || {};
    write(
      level,
      JSON.stringify({
        timestamp: now(),
        level,
        event,
        ...safeDetails,
      }),
    );
  }

  return {
    info: (event, details) => emit("info", event, details),
    warn: (event, details) => emit("warn", event, details),
    error: (event, details) => emit("error", event, details),
  };
}

export function operationalError(message, code) {
  return Object.assign(new Error(message), {
    code,
    expose: true,
    status: 503,
  });
}
