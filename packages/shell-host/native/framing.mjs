import { MAX_NATIVE_MESSAGE_BYTES } from './contracts.mjs';

export const NATIVE_EOF = Symbol('NATIVE_EOF');

export function createNativeMessageChannel({
  input = process.stdin,
  output = process.stdout,
  logLine,
  onInvalidFrame = () => process.exit(1),
  onOutputClosed = () => process.exit(0),
}) {
  let buffer = Buffer.alloc(0);
  let messageResolve = null;
  const messageQueue = [];
  let inputEnded = false;
  let outputClosed = false;
  let writeTail = Promise.resolve();

  function settleEnd() {
    inputEnded = true;
    if (!messageResolve) return;
    const resolve = messageResolve;
    messageResolve = null;
    resolve(NATIVE_EOF);
  }

  function deliver(message) {
    if (!messageResolve) {
      messageQueue.push(message);
      return;
    }
    const resolve = messageResolve;
    messageResolve = null;
    resolve(message);
  }

  function drainBuffer() {
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        logLine(`Invalid message length: ${length} (max ${MAX_NATIVE_MESSAGE_BYTES}). The extension should chunk requests.`);
        buffer = Buffer.alloc(0);
        inputEnded = true;
        onInvalidFrame(length);
        return;
      }
      if (buffer.length < 4 + length) return;
      const json = buffer.subarray(4, 4 + length).toString('utf8');
      buffer = buffer.subarray(4 + length);
      try {
        deliver(JSON.parse(json));
      } catch (error) {
        logLine(`JSON parse error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    drainBuffer();
  });
  input.on('end', settleEnd);
  input.on('error', settleEnd);
  // The write side needs its own listener: a writable stream reports failures as an
  // asynchronous 'error' event, so a try/catch around write() never sees them. Once
  // the browser's port is gone there is nothing left to serve, and an unhandled
  // EPIPE would kill the process without running the shutdown hook.
  output.on('error', (error) => {
    if (outputClosed) return;
    outputClosed = true;
    logLine(`Native channel output failed: ${error instanceof Error ? error.message : String(error)}`);
    onOutputClosed();
  });

  return {
    readMessage() {
      if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
      if (inputEnded) return Promise.resolve(NATIVE_EOF);
      return new Promise(resolve => { messageResolve = resolve; });
    },
    writeMessage(message) {
      const write = () => new Promise((resolve, reject) => {
        if (outputClosed) {
          reject(new Error('Native channel output is closed.'));
          return;
        }
        const body = Buffer.from(JSON.stringify(message), 'utf8');
        // Chrome caps a single native message at 1 MiB and silently truncates or
        // disconnects past it. Refuse to emit an oversized frame so the caller can
        // answer with an actionable error instead of an opaque disconnect.
        if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
          logLine(`writeNativeMessage REJECTED body=${body.length} bytes exceeds the ${MAX_NATIVE_MESSAGE_BYTES} native messaging cap.`);
          reject(new Error(`Native response is too large (${body.length} bytes > ${MAX_NATIVE_MESSAGE_BYTES}). Reduce the output size.`));
          return;
        }
        if (body.length > Math.floor(MAX_NATIVE_MESSAGE_BYTES * 0.95)) {
          logLine(`writeNativeMessage WARNING body=${body.length} bytes approaches the ${MAX_NATIVE_MESSAGE_BYTES} native messaging cap; Chrome may truncate this response.`);
        }
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length, 0);
        output.write(Buffer.concat([header, body]), resolve);
      });
      const result = writeTail.then(write, write);
      writeTail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
