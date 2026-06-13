import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload = Buffer.alloc(0)) {
  const content = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = content.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, content]);
}

function closePayload(code, reason) {
  const message = Buffer.from(String(reason || "").slice(0, 120), "utf8");
  const payload = Buffer.alloc(2 + message.length);
  payload.writeUInt16BE(code, 0);
  message.copy(payload, 2);
  return payload;
}

function protocolError(message) {
  return Object.assign(new Error(message), { code: "WEBSOCKET_PROTOCOL_ERROR" });
}

export function offeredProtocols(request) {
  return String(request.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
  socket.destroy();
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { head = Buffer.alloc(0), maxMessageBytes = 1_048_576 }) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.from(head);
    this.closed = false;
    socket.on("data", (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parse();
      } catch (error) {
        this.emit("error", error);
        this.close(1002, "Protocol error");
      }
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    });
    socket.on("error", (error) => this.emit("error", error));
    if (this.buffer.length) queueMicrotask(() => this.parse());
  }

  parse() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = Boolean(first & 0x80);
      const reserved = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (!final || reserved) throw protocolError("Fragmented frames are unsupported");
      if (!masked) throw protocolError("Client WebSocket frames must be masked");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw protocolError("WebSocket frame is too large");
        }
        length = Number(large);
        offset = 10;
      }
      if (length > this.maxMessageBytes) {
        throw protocolError("WebSocket message exceeds the configured limit");
      }
      if (opcode >= 0x8 && length > 125) {
        throw protocolError("WebSocket control frame is too large");
      }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.handleFrame(opcode, payload);
    }
  }

  handleFrame(opcode, payload) {
    if (opcode === 0x1) {
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      } catch {
        throw protocolError("WebSocket text frame is not valid UTF-8");
      }
      this.emit("message", text);
      return;
    }
    if (opcode === 0x8) {
      if (!this.closed) this.socket.write(frame(0x8, payload));
      this.closed = true;
      this.socket.end();
      this.emit("close");
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(frame(0x0a, payload));
      return;
    }
    if (opcode === 0x0a) {
      this.emit("pong", payload);
      return;
    }
    throw protocolError("Unsupported WebSocket frame");
  }

  sendText(value) {
    if (this.closed) throw new Error("WebSocket is closed");
    this.socket.write(frame(0x1, Buffer.from(String(value), "utf8")));
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  ping(value = "") {
    if (this.closed) return;
    this.socket.write(frame(0x09, Buffer.from(String(value), "utf8")));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(frame(0x08, closePayload(code, reason)));
    } finally {
      this.socket.end();
      this.emit("close");
    }
  }
}

export function acceptWebSocket(
  request,
  socket,
  head,
  { protocol, maxMessageBytes },
) {
  const key = request.headers["sec-websocket-key"];
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade || "").toLowerCase() !== "websocket" ||
    !String(request.headers.connection || "").toLowerCase().includes("upgrade") ||
    request.headers["sec-websocket-version"] !== "13" ||
    typeof key !== "string" ||
    !offeredProtocols(request).includes(protocol)
  ) {
    rejectUpgrade(socket, 400, "Invalid WebSocket upgrade");
    return null;
  }
  const accept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      `Sec-WebSocket-Protocol: ${protocol}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, { head, maxMessageBytes });
}
