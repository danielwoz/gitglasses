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
