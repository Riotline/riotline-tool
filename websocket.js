/**
 * A WebSocket server, in about the smallest form RFC 6455 allows.
 *
 * This file knows nothing about graphics, accounts or Companion. It speaks the
 * wire protocol and hands whole text messages up; everything above it treats a
 * connection as "a thing you can send a string to". That split is deliberate -
 * the framing is fiddly and finished, the control surface on top of it is not.
 *
 * Why hand-rolled rather than `ws`: this project has no required dependencies,
 * and the subset a control channel needs is genuinely small. What it does NOT
 * do is as important as what it does - no extensions, no compression, no
 * binary, no client role. A control socket carrying twenty bytes of JSON has
 * nothing to gain from permessage-deflate, and negotiating an extension is most
 * of the complexity in a full implementation.
 *
 * The pieces that are not optional, and that a naive version gets wrong:
 *
 *   - Client frames are always masked, and a server MUST fail the connection if
 *     one is not (RFC 6455 s5.1). Unmasked client data is a proxy-poisoning
 *     vector, not a formatting preference.
 *   - Server frames are never masked.
 *   - A message can arrive in fragments, and a control frame may be interleaved
 *     *between* those fragments. So the reader tracks a message in progress and
 *     answers pings without disturbing it.
 *   - Control frames cannot be fragmented and cannot exceed 125 bytes.
 *   - TCP is a stream, so a read can deliver half a frame, nine frames, or a
 *     frame boundary in the middle of a length field. Every read appends to a
 *     buffer and the parser consumes only whole frames.
 */

import { createHash } from 'node:crypto';

/** The magic string from RFC 6455 s1.3. Not a secret, not configurable. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const acceptFor = (key) =>
  createHash('sha1')
    .update(String(key ?? '') + GUID)
    .digest('base64');

export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

const isControl = (opcode) => opcode >= 0x8;

/**
 * Close codes this server sends. 1000 is the only "nothing went wrong" one;
 * the rest name a specific fault so the far end's log says something useful.
 */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED: 1003,
  POLICY: 1008,
  TOO_BIG: 1009,
  INTERNAL: 1011,
};

/**
 * One frame, ready for the wire. Server frames are unmasked, and FIN is always
 * set because nothing here fragments what it sends.
 */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = body.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;

  return Buffer.concat([header, body], header.length + length);
}

/** A close frame's 2-byte big-endian status code, then an optional reason. */
function closePayload(code, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 123);
  const out = Buffer.alloc(2 + text.length);
  out.writeUInt16BE(code, 0);
  text.copy(out, 2);
  return out;
}

/**
 * Is this a WebSocket upgrade at all?
 *
 * Checked before anything else touches the socket, because a plain HTTP request
 * that happened to hit the upgrade handler must not be answered with a
 * handshake. `Connection` is a comma-separated list and its members are
 * case-insensitive - `Connection: keep-alive, Upgrade` is legal and common
 * through a proxy, so a `=== 'upgrade'` comparison rejects real clients.
 */
export function isWebSocketUpgrade(req) {
  const connection = String(req.headers.connection ?? '').toLowerCase();
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  return upgrade === 'websocket' && connection.split(',').some((part) => part.trim() === 'upgrade');
}

const STATUS_TEXT = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' };

/**
 * Refuse an upgrade with an HTTP response rather than a silent destroy.
 *
 * A dropped socket and a rejected credential look identical from Companion,
 * and one of those is worth telling somebody about. The body is plain text: at
 * this point there is no WebSocket to send a close frame over.
 */
export function refuseUpgrade(socket, status, message) {
  /*
   * The listener comes first, and it is not optional.
   *
   * A raw socket from an 'upgrade' event has NO error listener on it, and a
   * Node stream that emits 'error' with nothing listening throws it as an
   * uncaught exception - which, on a bare `net.Socket`, exits the process.
   * Refusing an upgrade is precisely when the peer is most likely to hang up
   * mid-write: it reads the status line, learns it was rejected, and closes
   * while these bytes are still in flight. That is an ECONNRESET, and without
   * this line an unauthenticated caller can stop the broadcast server by
   * sending one bad key and hanging up - the same shape of remote kill as the
   * `GET /%ZZ` crash.
   */
  socket.on('error', () => {});
  const body = Buffer.from(`${message}\n`, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Bad Request'}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${body.length}\r\n` +
      'Connection: close\r\n' +
      '\r\n',
  );
  socket.end(body);
}

/**
 * Complete the handshake and wrap the socket.
 *
 * @returns {object|null} the connection, or null if the request was not a
 *   usable upgrade (in which case it has already been refused).
 */
export function accept(req, socket, head, { maxMessageBytes = 256 * 1024, pingIntervalMs = 30_000 } = {}) {
  /*
   * Before anything else, for the reason spelled out in refuseUpgrade: an
   * unlistened 'error' on a raw socket exits the process. The real handler is
   * installed further down, once there is a connection to report it to; this
   * one only has to exist during the handshake.
   */
  socket.on('error', () => {});

  if (!isWebSocketUpgrade(req)) {
    refuseUpgrade(socket, 400, 'Expected a WebSocket upgrade.');
    return null;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    refuseUpgrade(socket, 400, 'Missing Sec-WebSocket-Key.');
    return null;
  }

  // 13 is the only version this protocol has ever shipped. Anything else is a
  // client from before the RFC, and saying so beats a parse error later.
  if (String(req.headers['sec-websocket-version'] ?? '') !== '13') {
    refuseUpgrade(socket, 400, 'This server speaks WebSocket version 13 only.');
    return null;
  }

  /*
   * Nagle's algorithm holds a small write back for up to 40ms hoping to
   * coalesce it with the next one. Every message here is small and every one of
   * them is a button press or the state behind a lamp, so that trade is exactly
   * backwards.
   */
  socket.setNoDelay(true);
  // The HTTP server's idle timeout would close a control channel that is
  // behaving correctly by being quiet. Keepalive is this file's job now.
  socket.setTimeout(0);

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n` +
      '\r\n',
  );

  const listeners = { message: [], close: [], error: [] };
  const emit = (event, ...args) => {
    for (const handler of listeners[event] ?? []) {
      try {
        handler(...args);
      } catch (error) {
        // A throwing message handler must not take the socket down with it, and
        // must not recurse back into itself through 'error'.
        if (event !== 'error') emit('error', error);
      }
    }
  };

  let closed = false;
  let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);

  // A message in progress, across fragments. Control frames may interleave.
  let fragments = [];
  let fragmentBytes = 0;

  let alive = true;

  const finish = (reason) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    socket.destroy();
    emit('close', reason);
  };

  function send(data, opcode = OPCODE.TEXT) {
    if (closed || socket.destroyed) return false;
    try {
      socket.write(encodeFrame(opcode, data));
      return true;
    } catch (error) {
      emit('error', error);
      finish('write failed');
      return false;
    }
  }

  function close(code = CLOSE.NORMAL, reason = '') {
    if (closed || socket.destroyed) return;
    try {
      socket.write(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch {
      // Already gone; the destroy below is what matters.
    }
    finish(reason || `closed ${code}`);
  }

  /** Protocol violations are fatal by design - there is no partial recovery. */
  const fail = (code, reason) => {
    emit('error', new Error(reason));
    close(code, reason);
  };

  function consume() {
    // Only ever consumes whole frames; a partial one is left for the next read.
    for (;;) {
      if (closed) return;
      if (buffer.length < 2) return;

      const first = buffer[0];
      const second = buffer[1];

      const fin = (first & 0x80) !== 0;
      // No extension was negotiated, so a reserved bit set is a client talking
      // a protocol we did not agree to.
      if ((first & 0x70) !== 0) return fail(CLOSE.PROTOCOL_ERROR, 'Reserved bits set.');

      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        // Well past any message this server accepts, and past what a Buffer can
        // hold - refuse before allocating anything.
        if (big > BigInt(maxMessageBytes)) return fail(CLOSE.TOO_BIG, 'Message too large.');
        length = Number(big);
        offset += 8;
      }

      // A client that does not mask is either broken or hostile; the RFC makes
      // this one non-negotiable.
      if (!masked) return fail(CLOSE.PROTOCOL_ERROR, 'Client frames must be masked.');
      if (buffer.length < offset + 4) return;
      const mask = buffer.subarray(offset, offset + 4);
      offset += 4;

      if (length > maxMessageBytes) return fail(CLOSE.TOO_BIG, 'Message too large.');
      if (buffer.length < offset + length) return; // the rest is still in flight

      const payload = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i & 3];

      buffer = buffer.subarray(offset + length);

      if (isControl(opcode)) {
        // Control frames carry status, so they must arrive whole and small.
        if (!fin) return fail(CLOSE.PROTOCOL_ERROR, 'Control frames cannot be fragmented.');
        if (length > 125) return fail(CLOSE.PROTOCOL_ERROR, 'Control frame too long.');

        if (opcode === OPCODE.CLOSE) {
          // Echo the close and go. No lingering half-open state: this is a
          // control channel, there is nothing in flight worth draining.
          close(CLOSE.NORMAL, 'peer closed');
          return;
        }
        if (opcode === OPCODE.PING) {
          send(payload, OPCODE.PONG);
          continue;
        }
        if (opcode === OPCODE.PONG) {
          alive = true;
          continue;
        }
        return fail(CLOSE.PROTOCOL_ERROR, `Unknown control opcode ${opcode}.`);
      }

      /*
       * ---- data frames ----
       *
       * Binary is dropped on the floor rather than refused, and that is a
       * deliberate reversal of the obvious behaviour.
       *
       * Companion's generic WebSocket module has an optional keepalive that
       * sends a *data* frame containing one hex byte - not a protocol ping -
       * every few seconds. Failing the connection on binary would therefore
       * disconnect any operator who ticked that box, on a three second loop,
       * with the module silently reconnecting each time. Nothing about that
       * failure points at the checkbox that caused it.
       *
       * Ignoring costs nothing: this endpoint's whole protocol is text, so a
       * binary frame carries nothing that could have been acted on anyway. It
       * still counts as the peer being alive, which is what it was sent for.
       */
      if (opcode === OPCODE.BINARY) {
        alive = true;
        continue;
      }

      if (opcode === OPCODE.TEXT) {
        if (fragments.length) return fail(CLOSE.PROTOCOL_ERROR, 'Interleaved message.');
        if (fin) {
          emit('message', payload.toString('utf8'));
          continue;
        }
        fragments = [payload];
        fragmentBytes = length;
        continue;
      }

      if (opcode === OPCODE.CONTINUATION) {
        if (!fragments.length) return fail(CLOSE.PROTOCOL_ERROR, 'Continuation with nothing to continue.');
        fragmentBytes += length;
        // The cap is on the assembled message, or a sender could walk past it
        // one small fragment at a time.
        if (fragmentBytes > maxMessageBytes) return fail(CLOSE.TOO_BIG, 'Message too large.');
        fragments.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(fragments, fragmentBytes);
        fragments = [];
        fragmentBytes = 0;
        emit('message', whole.toString('utf8'));
        continue;
      }

      return fail(CLOSE.PROTOCOL_ERROR, `Unknown opcode ${opcode}.`);
    }
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk], buffer.length + chunk.length) : chunk;
    try {
      consume();
    } catch (error) {
      emit('error', error);
      close(CLOSE.INTERNAL, 'Parser failed.');
    }
  });

  socket.on('error', (error) => {
    emit('error', error);
    finish('socket error');
  });
  socket.on('close', () => finish('socket closed'));

  /*
   * Keepalive, and the only way to notice a peer that went away without saying
   * so. A control channel is silent for most of a broadcast, which is exactly
   * when a NAT table or a corporate proxy decides the connection is finished -
   * and a dead socket that still looks open means an operator's buttons stop
   * working with nothing on screen to say why.
   */
  const heartbeat = setInterval(() => {
    if (closed) return;
    if (!alive) {
      close(CLOSE.GOING_AWAY, 'No pong.');
      return;
    }
    alive = false;
    send(Buffer.alloc(0), OPCODE.PING);
  }, pingIntervalMs);
  heartbeat.unref?.();

  const connection = {
    on(event, handler) {
      listeners[event]?.push(handler);
      return connection;
    },
    send,
    close,
    /** JSON in one call, since every message on this socket is an object. */
    sendJson(value) {
      let text;
      try {
        text = JSON.stringify(value);
      } catch (error) {
        emit('error', error);
        return false;
      }
      return send(text, OPCODE.TEXT);
    },
    get closed() {
      return closed;
    },
    get remoteAddress() {
      return socket.remoteAddress ?? '';
    },
  };

  // Bytes can arrive in the same packet as the handshake.
  if (buffer.length) queueMicrotask(() => !closed && consume());

  return connection;
}
