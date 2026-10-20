// LSP-style Content-Length framing over a byte stream. Buffer-only, with no
// node module imports, so it is unit-testable with plain buffers and usable
// by any byte-stream transport.

const HEADER_END = '\r\n\r\n';

export class FrameParser {
  // Bytes received but not yet consumed, kept as the chunks they arrived in.
  // A frame's body is copied out once, when it is complete, so the cost of a
  // large frame is linear in its size however many chunks it arrives in.
  private chunks: Buffer[] = [];
  private buffered = 0;
  private expected = -1;

  /** Feed raw bytes; returns any complete message payloads. */
  push(chunk: Buffer): string[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const messages: string[] = [];
    for (;;) {
      if (this.expected < 0) {
        // Between frames only a header and the start of a body are buffered,
        // so merging the chunks here copies little.
        const head = this.coalesce();
        if (!head) break;
        const headerEnd = head.indexOf(HEADER_END);
        if (headerEnd < 0) break;
        const header = head.subarray(0, headerEnd).toString('utf8');
        this.replaceWith(head.subarray(headerEnd + HEADER_END.length));
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) continue; // skip malformed header block
        this.expected = Number(match[1]);
      }
      if (this.buffered < this.expected) break;
      messages.push(this.take(this.expected).toString('utf8'));
      this.expected = -1;
    }
    return messages;
  }

  /** The buffered bytes as one buffer, or undefined when there are none. */
  private coalesce(): Buffer | undefined {
    if (this.chunks.length === 0) return undefined;
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    return this.chunks[0];
  }

  private replaceWith(rest: Buffer): void {
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
  }

  /** Removes and returns the first `size` buffered bytes. */
  private take(size: number): Buffer {
    const first = this.chunks[0];
    if (first && first.length >= size) {
      const body = first.subarray(0, size);
      const rest = first.subarray(size);
      if (rest.length > 0) this.chunks[0] = rest;
      else this.chunks.shift();
      this.buffered -= size;
      return body;
    }
    const body = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const next = this.chunks[0];
      const needed = size - filled;
      if (next.length <= needed) {
        next.copy(body, filled);
        filled += next.length;
        this.chunks.shift();
      } else {
        next.copy(body, filled, 0, needed);
        filled += needed;
        this.chunks[0] = next.subarray(needed);
      }
    }
    this.buffered -= size;
    return body;
  }
}

/** Wraps one payload in a Content-Length header block. */
export function frame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}
