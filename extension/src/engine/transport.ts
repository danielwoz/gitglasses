// LSP-style Content-Length framing over a byte stream. Kept free of any
// vscode/node-process dependency so it is unit-testable with plain buffers.

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private expected = -1;

  /** Feed raw bytes; returns any complete message payloads. */
  push(chunk: Buffer): string[] {
    if (this.buffer.length === 0) {
      this.buffer = chunk;
    } else {
      this.buffer = Buffer.concat([this.buffer, chunk]);
    }
    const messages: string[] = [];
    for (;;) {
      if (this.expected < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = this.buffer.subarray(0, headerEnd).toString('utf8');
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        this.buffer = this.buffer.subarray(headerEnd + 4);
        if (!match) continue; // skip malformed header block
        this.expected = Number(match[1]);
      }
      if (this.buffer.length < this.expected) break;
      messages.push(this.buffer.subarray(0, this.expected).toString('utf8'));
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = -1;
    }
    return messages;
  }
}

export function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
