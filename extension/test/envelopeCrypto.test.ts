import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptEnvelope,
  encryptEnvelope,
  isEncryptedEnvelope,
} from '../src/patches/envelopeCrypto';

const PLAIN_ENVELOPE = JSON.stringify({
  format: 'gitglasses-patch',
  version: 1,
  baseSha: 'a'.repeat(40),
  summary: 'fix the frobnicator',
  patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
  createdAtIso: '2026-07-22T00:00:00Z',
});

describe('envelope encryption', () => {
  it('round-trips envelope JSON through encrypt/decrypt', () => {
    const encrypted = encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery');
    expect(decryptEnvelope(encrypted, 'correct horse battery')).toBe(PLAIN_ENVELOPE);
  });

  it('round-trips non-ASCII content', () => {
    const json = JSON.stringify({ summary: 'héllo — ünïcode ✓ 日本語' });
    expect(decryptEnvelope(encryptEnvelope(json, 'pässwörd123'), 'pässwörd123')).toBe(json);
  });

  it('fails clearly on a wrong passphrase', () => {
    const encrypted = encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery');
    expect(() => decryptEnvelope(encrypted, 'wrong passphrase')).toThrow(/wrong passphrase/i);
  });

  it('detects tampering (flipped ciphertext byte fails authentication)', () => {
    const container = JSON.parse(encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery'));
    const bytes = Buffer.from(container.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    container.ciphertext = bytes.toString('base64');
    expect(() =>
      decryptEnvelope(JSON.stringify(container), 'correct horse battery'),
    ).toThrow(/wrong passphrase|modified/i);
  });

  it('writes the documented format and kdf parameters', () => {
    const container = JSON.parse(encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    expect(container.format).toBe('gitglasses-patch-encrypted');
    expect(container.version).toBe(1);
    expect(container.kdf).toMatchObject({ N: 16384, r: 8, p: 1 });
    for (const field of ['salt', 'iv', 'ciphertext', 'tag'] as const) {
      const value = field === 'salt' ? container.kdf.salt : container[field];
      expect(Buffer.from(value, 'base64').toString('base64')).toBe(value);
    }
    expect(Buffer.from(container.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(container.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(container.tag, 'base64')).toHaveLength(16);
  });

  it('uses a fresh salt and iv per encryption', () => {
    const a = JSON.parse(encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    const b = JSON.parse(encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('decrypt honors the kdf parameters stored in the container', () => {
    // A container produced with non-default (weaker) scrypt cost.
    const kdf = { N: 4096, r: 4, p: 2 };
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync('the passphrase', salt, 32, { ...kdf, maxmem: 1 << 26 });
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(PLAIN_ENVELOPE, 'utf8'), cipher.final()]);
    const container = JSON.stringify({
      format: 'gitglasses-patch-encrypted',
      version: 1,
      kdf: { ...kdf, salt: salt.toString('base64') },
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
    expect(decryptEnvelope(container, 'the passphrase')).toBe(PLAIN_ENVELOPE);
  });

  it('rejects hostile kdf parameters instead of allocating unbounded memory', () => {
    const container = JSON.parse(encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    container.kdf.N = 2 ** 24; // 128 * N * r = 16 GiB
    expect(() => decryptEnvelope(JSON.stringify(container), 'passphrase!')).toThrow(
      /key-derivation/i,
    );
    container.kdf.N = 12345; // not a power of two
    expect(() => decryptEnvelope(JSON.stringify(container), 'passphrase!')).toThrow(
      /key-derivation/i,
    );
  });

  it('detects the encrypted format and rejects everything else', () => {
    expect(isEncryptedEnvelope(encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'))).toBe(true);
    expect(isEncryptedEnvelope(PLAIN_ENVELOPE)).toBe(false);
    expect(isEncryptedEnvelope('not json at all')).toBe(false);
    expect(isEncryptedEnvelope('{"format":"gitglasses-patch-encrypted"}')).toBe(false);
    expect(isEncryptedEnvelope('{"format":"gitglasses-patch-encrypted","version":2}')).toBe(false);
  });

  it('decrypt rejects a plain (unencrypted) envelope with a clear error', () => {
    expect(() => decryptEnvelope(PLAIN_ENVELOPE, 'passphrase!')).toThrow(/not a gitglasses/i);
  });
});
