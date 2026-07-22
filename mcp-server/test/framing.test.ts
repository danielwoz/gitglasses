import { describe, expect, it } from 'vitest';
import { FrameParser, frame } from '../src/engine.js';

describe('Content-Length framing', () => {
  it('parses messages split across arbitrary chunk boundaries', () => {
    const parser = new FrameParser();
    const bytes = Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]);
    const messages: string[] = [];
    for (let i = 0; i < bytes.length; i += 3) {
      messages.push(...parser.push(bytes.subarray(i, i + 3)));
    }
    expect(messages).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('round-trips multi-byte UTF-8 payloads', () => {
    const parser = new FrameParser();
    const payload = '{"summary":"café → résumé"}';
    expect(parser.push(frame(payload))).toEqual([payload]);
  });
});
