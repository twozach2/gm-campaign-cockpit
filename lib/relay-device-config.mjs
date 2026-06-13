export const RELAY_DEVICE_SCHEMA_VERSION = 1;

export function emptyRelayDeviceConfig(controlUrl = "") {
  return {
    schemaVersion: RELAY_DEVICE_SCHEMA_VERSION,
    controlUrl,
    accountId: "",
    deviceId: "",
    deviceName: "",
    deviceToken: "",
    roomId: "",
  };
}

export function validRelayDeviceConfig(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== RELAY_DEVICE_SCHEMA_VERSION
  ) {
    return false;
  }
  return [
    "controlUrl",
    "accountId",
    "deviceId",
    "deviceName",
    "deviceToken",
    "roomId",
  ].every((key) => typeof value[key] === "string" && value[key].length <= 2_048);
}

export function normalizeRelayControlUrl(value) {
  const url = new URL(String(value || "").trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "RELAY_CONTROL_URL must not contain credentials, query parameters, or fragments",
    );
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(
    url.hostname.toLowerCase(),
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "RELAY_CONTROL_URL must use https://, except for loopback development",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href.replace(/\/$/, "");
}

export function controlUrlFromAgentUrl(value) {
  const url = new URL(value);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return normalizeRelayControlUrl(url.href);
}

export function agentUrl(controlUrl, roomId) {
  const url = new URL(normalizeRelayControlUrl(controlUrl));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/v1/agent/${encodeURIComponent(roomId)}`;
  return url.href;
}

export function publicRelayDeviceConfig(config, status, rooms = []) {
  return {
    configured: Boolean(config.controlUrl),
    paired: Boolean(config.deviceId && config.deviceToken),
    controlUrl: config.controlUrl,
    device:
      config.deviceId
        ? { id: config.deviceId, name: config.deviceName }
        : null,
    roomId: config.roomId || null,
    rooms,
    connection: status,
  };
}
