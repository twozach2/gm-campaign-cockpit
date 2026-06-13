import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function clientFrame(opcode, payload = Buffer.alloc(0)) {
  const content = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let header;
  if (content.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | content.length]);
  } else if (content.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(content.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(content.length), 2);
  }
  const masked = Buffer.from(content);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function closeFrame(code = 1000) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return clientFrame(0x08, payload);
}

function waitForConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function parseHeaders(encoded) {
  const lines = encoded.split("\r\n");
  const statusCode = Number(lines[0].split(" ")[1]);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.set(
      line.slice(0, separator).trim().toLowerCase(),
      line.slice(separator + 1).trim(),
    );
  }
  return { statusCode, headers };
}

export class RawWebSocket {
  constructor(socket, initial = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.from(initial);
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parse();
    });
    socket.on("close", () => {
      this.closed = true;
      this.rejectWaiters(new Error("WebSocket closed"));
    });
    socket.on("error", (error) => this.rejectWaiters(error));
    this.parse();
  }

  parse() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (masked) throw new Error("Server frames must not be masked");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(
        this.buffer.subarray(offset, offset + length),
      );
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x01) {
        this.deliver(JSON.parse(payload.toString("utf8")));
      } else if (opcode === 0x08) {
        this.closed = true;
        this.socket.end();
        this.rejectWaiters(new Error("WebSocket closed"));
      } else if (opcode === 0x09) {
        this.socket.write(clientFrame(0x0a, payload));
      }
    }
  }

  deliver(message) {
    const waiterIndex = this.waiters.findIndex((entry) =>
      entry.predicate(message),
    );
    if (waiterIndex === -1) {
      this.messages.push(message);
      return;
    }
    const [waiter] = this.waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  sendJson(value) {
    this.socket.write(clientFrame(0x01, JSON.stringify(value)));
  }

  nextJson(predicate = () => true, timeoutMs = 1_000) {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) {
      return Promise.resolve(this.messages.splice(index, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error("Timed out waiting for WebSocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async expectNoJson(predicate = () => true, timeoutMs = 100) {
    try {
      const message = await this.nextJson(predicate, timeoutMs);
      throw new Error(`Unexpected WebSocket message: ${JSON.stringify(message)}`);
    } catch (error) {
      if (error.message !== "Timed out waiting for WebSocket message") {
        throw error;
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.end(closeFrame());
  }
}

export async function connectWebSocket({
  host = "127.0.0.1",
  port,
  pathname,
  protocols,
}) {
  const socket = net.createConnection({ host, port });
  await waitForConnect(socket);
  const key = randomBytes(16).toString("base64");
  socket.write(
    `GET ${pathname} HTTP/1.1\r\n` +
      `Host: ${host}:${port}\r\n` +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n\r\n`,
  );
  const response = await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      socket.off("data", onData);
      resolve({
        headers: buffer.subarray(0, boundary).toString("utf8"),
        remaining: buffer.subarray(boundary + 4),
      });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  const parsed = parseHeaders(response.headers);
  if (parsed.statusCode !== 101) {
    socket.destroy();
    throw Object.assign(
      new Error(`WebSocket upgrade failed with ${parsed.statusCode}`),
      { statusCode: parsed.statusCode },
    );
  }
  const expectedAccept = createHash("sha1")
    .update(`${key}${WEBSOCKET_GUID}`)
    .digest("base64");
  if (parsed.headers.get("sec-websocket-accept") !== expectedAccept) {
    socket.destroy();
    throw new Error("WebSocket accept hash did not match");
  }
  if (parsed.headers.get("sec-websocket-protocol") !== protocols[0]) {
    socket.destroy();
    throw new Error("WebSocket protocol was not negotiated");
  }
  return new RawWebSocket(socket, response.remaining);
}
