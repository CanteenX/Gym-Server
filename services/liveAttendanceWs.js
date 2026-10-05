import crypto from "node:crypto";

/**
 * Lightweight, zero-dependency WebSocket & SSE broadcast server for
 * real-time branch QR scan check-ins.
 *
 * Implements RFC 6455 WebSocket server handshake & unmasked frame encoding,
 * plus Server-Sent Events (SSE) fallback.
 */

const wsClients = new Set();
const sseClients = new Set();

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Encode a UTF-8 string into an unmasked RFC 6455 WebSocket text frame.
 */
function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Encode a Pong frame.
 */
function encodePongFrame() {
  return Buffer.from([0x8a, 0x00]);
}

/**
 * Decode incoming masked WebSocket frames from the client.
 */
function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const byte1 = buffer[offset];
    const byte2 = buffer[offset + 1];
    const opcode = byte1 & 0x0f;
    const isMasked = (byte2 & 0x80) !== 0;
    let payloadLen = byte2 & 0x7f;
    let headerLen = 2;

    if (payloadLen === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (offset + 10 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }

    const maskKeyLen = isMasked ? 4 : 0;
    const totalFrameLen = headerLen + maskKeyLen + payloadLen;
    if (offset + totalFrameLen > buffer.length) break;

    let payload = buffer.subarray(
      offset + headerLen + maskKeyLen,
      offset + totalFrameLen,
    );

    if (isMasked) {
      const maskKey = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ maskKey[i % 4];
      }
      payload = unmasked;
    }

    messages.push({ opcode, payload });
    offset += totalFrameLen;
  }

  return { messages, remainder: buffer.subarray(offset) };
}

/**
 * Handles HTTP upgrade to WebSocket for /ws/attendance-live or /ws/live-scans.
 */
export function handleWebSocketUpgrade(req, socket, head) {
  const url = req.url || "";
  const isWsPath =
    url.startsWith("/ws/attendance-live") ||
    url.startsWith("/ws/live-scans") ||
    url.startsWith("/ws/attendance");

  if (!isWsPath) {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");

  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n",
  ].join("\r\n");

  socket.write(responseHeaders);

  const client = {
    socket,
    branchFilter: null,
    alive: true,
  };

  wsClients.add(client);

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  // Send initial welcome message
  try {
    socket.write(
      encodeTextFrame(
        JSON.stringify({
          type: "CONNECTED",
          message: "Live Attendance WebSocket connected",
          timestamp: new Date().toISOString(),
          clientsCount: wsClients.size,
        }),
      ),
    );
  } catch (err) {
    console.warn("WebSocket initial message error:", err);
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const { messages, remainder } = decodeFrames(buffer);
    buffer = remainder;

    for (const msg of messages) {
      if (msg.opcode === 0x08) {
        // Close frame
        try {
          socket.end();
        } catch {
          /* ignore */
        }
        wsClients.delete(client);
        return;
      }

      if (msg.opcode === 0x09) {
        // Ping -> respond with Pong
        try {
          socket.write(encodePongFrame());
        } catch {
          /* ignore */
        }
        continue;
      }

      if (msg.opcode === 0x01) {
        // Text message from client
        try {
          const str = msg.payload.toString("utf8");
          const data = JSON.parse(str);
          if (data.type === "PING") {
            socket.write(
              encodeTextFrame(
                JSON.stringify({ type: "PONG", timestamp: Date.now() }),
              ),
            );
          } else if (data.type === "FILTER") {
            client.branchFilter = data.branch || null;
          }
        } catch {
          /* ignore non-json client payloads */
        }
      }
    }
  });

  const cleanup = () => {
    wsClients.delete(client);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  };

  socket.on("error", cleanup);
  socket.on("end", cleanup);
  socket.on("close", cleanup);
}

/**
 * Broadcast scan data to all connected WebSocket and SSE clients.
 */
export function broadcastLiveScan(payload) {
  const messageStr = JSON.stringify({
    type: "CHECK_IN",
    timestamp: new Date().toISOString(),
    ...payload,
  });

  const frame = encodeTextFrame(messageStr);

  // Send to all WebSockets
  for (const client of Array.from(wsClients)) {
    try {
      // Check branch filter if client set one
      if (
        client.branchFilter &&
        payload.session?.branch &&
        client.branchFilter !== "All Branches" &&
        client.branchFilter !== payload.session?.branch
      ) {
        continue;
      }
      client.socket.write(frame);
    } catch (err) {
      wsClients.delete(client);
    }
  }

  // Send to all SSE streams
  const sseData = `data: ${messageStr}\n\n`;
  for (const res of Array.from(sseClients)) {
    try {
      res.write(sseData);
    } catch {
      sseClients.delete(res);
    }
  }
}

/**
 * Express SSE stream handler for /api/v1/attendance/live-stream
 */
export function handleSseStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  res.write(`: connected\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
}

// Periodic heartbeat every 25 seconds
setInterval(() => {
  const pingMessage = encodeTextFrame(
    JSON.stringify({ type: "HEARTBEAT", timestamp: Date.now() }),
  );
  for (const client of Array.from(wsClients)) {
    try {
      client.socket.write(pingMessage);
    } catch {
      wsClients.delete(client);
    }
  }

  for (const res of Array.from(sseClients)) {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);
