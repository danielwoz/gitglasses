import { describe, expect, it } from 'vitest';
import { FrameParser, frame } from '../src/framing.js';

describe('FrameParser', () => {
  it('parses a single frame', () => {
    const parser = new FrameParser();
    expect(parser.push(frame('{"id":1}'))).toEqual(['{"id":1}']);
  });

  it('parses frames split across arbitrary chunk boundaries', () => {
    const parser = new FrameParser();
    const bytes = Buffer.concat([frame('hello'), frame('world!')]);
    const results: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      results.push(...parser.push(bytes.subarray(i, i + 3)));
    }
    expect(results).toEqual(['hello', 'world!']);
  });

  it('handles multi-byte utf8 payloads', () => {
    const parser = new FrameParser();
    const payload = JSON.stringify({ name: 'Grüße 你好', summary: 'café → résumé' });
    expect(parser.push(frame(payload))).toEqual([payload]);
  });

  it('skips unknown headers', () => {
    const parser = new FrameParser();
    const body = Buffer.from('ok');
    const raw = Buffer.concat([
      Buffer.from(`X-Junk: yes\r\nContent-Length: ${body.length}\r\nX-More: 1\r\n\r\n`),
      body,
    ]);
    expect(parser.push(raw)).toEqual(['ok']);
  });

  it('buffers incomplete frames until completion', () => {
    const parser = new FrameParser();
    const framed = frame('abcdef');
    expect(parser.push(framed.subarray(0, framed.length - 2))).toEqual([]);
    expect(parser.push(framed.subarray(framed.length - 2))).toEqual(['abcdef']);
  });
});

describe('FrameParser throughput', () => {
  // A large frame arriving in pipe-sized chunks must cost time linear in its
  // size: re-copying everything buffered so far on every chunk made a 40 MB
  // frame take seconds.
  it('assembles a 40 MB frame from 64 KB chunks in linear time', () => {
    const payload = 'x'.repeat(40 * 1024 * 1024);
    const bytes = frame(payload);
    const parser = new FrameParser();
    const chunkSize = 64 * 1024;
    const started = performance.now();
    const results: string[] = [];
    for (let i = 0; i < bytes.length; i += chunkSize) {
      results.push(...parser.push(bytes.subarray(i, i + chunkSize)));
    }
    const elapsed = performance.now() - started;
    expect(results).toHaveLength(1);
    expect(results[0].length).toBe(payload.length);
    expect(elapsed).toBeLessThan(1500);
  });

  it('keeps bytes that follow a frame inside the same chunk', () => {
    const parser = new FrameParser();
    const big = 'y'.repeat(200_000);
    const bytes = Buffer.concat([frame(big), frame('{"tail":1}'), frame('z')]);
    const results: string[] = [];
    // Uneven chunks so frame boundaries fall mid-chunk and headers straddle
    // chunk edges.
    let offset = 0;
    let size = 7;
    while (offset < bytes.length) {
      results.push(...parser.push(bytes.subarray(offset, offset + size)));
      offset += size;
      size = size * 3 + 1;
    }
    expect(results).toEqual([big, '{"tail":1}', 'z']);
  });
});
