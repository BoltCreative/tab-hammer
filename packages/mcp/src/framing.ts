// Chrome native messaging framing: each message is a 32-bit length (native byte order, little-endian
// on every platform Chrome ships on) followed by that many bytes of UTF-8 JSON.

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reassembles frames from arbitrarily split chunks of a stream. */
export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  /** Feed one chunk; returns every message it completed, in order. */
  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const out: unknown[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (this.buffered.length < 4 + length) break;
      out.push(JSON.parse(this.buffered.subarray(4, 4 + length).toString('utf8')));
      this.buffered = this.buffered.subarray(4 + length);
    }
    return out;
  }
}
