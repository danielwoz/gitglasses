import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EnvelopeFormatError,
  decryptEnvelope,
  encryptEnvelope,
  isEncryptedEnvelope,
  kdfParamsSupported,
} from '../src/patches/envelopeCrypto';

const PLAIN_ENVELOPE = JSON.stringify({
  format: 'gitglasses-patch',
  version: 1,
  baseSha: 'a'.repeat(40),
  summary: 'fix the frobnicator',
  patch: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
  createdAtIso: '2026-07-22T00:00:00Z',
});

/** A container encrypted with explicit scrypt parameters, as another writer
 *  (an older release, or a hostile one) would produce it. */
function containerWith(kdf: { N: number; r: number; p: number }, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { ...kdf, maxmem: 1 << 28 });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(PLAIN_ENVELOPE, 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: 'gitglasses-patch-encrypted',
    version: 1,
    kdf: { ...kdf, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}

describe('envelope encryption', () => {
  it('round-trips envelope JSON through encrypt/decrypt', async () => {
    const encrypted = await encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery');
    expect(await decryptEnvelope(encrypted, 'correct horse battery')).toBe(PLAIN_ENVELOPE);
  });

  it('round-trips non-ASCII content', async () => {
    const json = JSON.stringify({ summary: 'héllo — ünïcode ✓ 日本語' });
    const encrypted = await encryptEnvelope(json, 'pässwörd123');
    expect(await decryptEnvelope(encrypted, 'pässwörd123')).toBe(json);
  });

  it('fails clearly on a wrong passphrase', async () => {
    const encrypted = await encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery');
    const failure = decryptEnvelope(encrypted, 'wrong passphrase');
    await expect(failure).rejects.toThrow(/wrong passphrase/i);
    await expect(failure).rejects.not.toBeInstanceOf(EnvelopeFormatError);
  });

  it('detects tampering (flipped ciphertext byte fails authentication)', async () => {
    const container = JSON.parse(await encryptEnvelope(PLAIN_ENVELOPE, 'correct horse battery'));
    const bytes = Buffer.from(container.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    container.ciphertext = bytes.toString('base64');
    await expect(
      decryptEnvelope(JSON.stringify(container), 'correct horse battery'),
    ).rejects.toThrow(/wrong passphrase|modified/i);
  });

  it('writes the documented format and OWASP-strength kdf parameters', async () => {
    const container = JSON.parse(await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    expect(container.format).toBe('gitglasses-patch-encrypted');
    expect(container.version).toBe(1);
    expect(container.kdf).toMatchObject({ N: 131072, r: 8, p: 1 });
    // Within what readers of the first release accept: 128 * N * r <= 2^28.
    expect(128 * container.kdf.N * container.kdf.r).toBeLessThanOrEqual(2 ** 28);
    for (const field of ['salt', 'iv', 'ciphertext', 'tag'] as const) {
      const value = field === 'salt' ? container.kdf.salt : container[field];
      expect(Buffer.from(value, 'base64').toString('base64')).toBe(value);
    }
    expect(Buffer.from(container.kdf.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(container.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(container.tag, 'base64')).toHaveLength(16);
  });

  it('uses a fresh salt and iv per encryption', async () => {
    const a = JSON.parse(await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    const b = JSON.parse(await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('decrypt honors the kdf parameters stored in the container', async () => {
    // Weaker and older parameter sets, including what the first release wrote.
    for (const kdf of [
      { N: 4096, r: 4, p: 2 },
      { N: 16384, r: 8, p: 1 },
    ]) {
      expect(await decryptEnvelope(containerWith(kdf, 'the passphrase'), 'the passphrase')).toBe(
        PLAIN_ENVELOPE,
      );
    }
  });

  it('rejects hostile kdf parameters before doing any work', async () => {
    const container = JSON.parse(await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'));
    for (const kdf of [
      { N: 2 ** 24, r: 8, p: 1 }, // 128 * N * r = 16 GiB
      { N: 12345, r: 8, p: 1 }, // not a power of two
      { N: 2 ** 14, r: 8, p: 245760 }, // hours of work at 16 MiB
      { N: 2 ** 14, r: 8, p: 64 },
      { N: 2 ** 10, r: 1024, p: 1 },
      { N: 2 ** 18, r: 8, p: 4 }, // each bound alone is fine, the total work is not
    ]) {
      container.kdf = { ...container.kdf, ...kdf };
      const started = Date.now();
      await expect(decryptEnvelope(JSON.stringify(container), 'passphrase!')).rejects.toThrow(
        EnvelopeFormatError,
      );
      expect(Date.now() - started).toBeLessThan(100);
    }
  });

  it('accepts the parameter sets readers must open and no more', () => {
    expect(kdfParamsSupported({ N: 2 ** 17, r: 8, p: 1 })).toBe(true);
    expect(kdfParamsSupported({ N: 2 ** 14, r: 8, p: 1 })).toBe(true);
    expect(kdfParamsSupported({ N: 2 ** 17, r: 8, p: 4 })).toBe(true);
    expect(kdfParamsSupported({ N: 2 ** 17, r: 8, p: 5 })).toBe(false);
    expect(kdfParamsSupported({ N: 2 ** 21, r: 1, p: 1 })).toBe(false);
    expect(kdfParamsSupported({ N: 2 ** 14, r: 33, p: 1 })).toBe(false);
    expect(kdfParamsSupported({ N: 2 ** 17, r: 8, p: 0 })).toBe(false);
  });

  it('derives the key off the calling thread', async () => {
    const encrypted = await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!');
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);
    await decryptEnvelope(encrypted, 'passphrase!');
    // A synchronous derivation would have held the event loop until it was
    // done, and the timer could not have run first.
    expect(timerRan).toBe(true);
  });

  it('detects the encrypted format and rejects everything else', async () => {
    expect(isEncryptedEnvelope(await encryptEnvelope(PLAIN_ENVELOPE, 'passphrase!'))).toBe(true);
    expect(isEncryptedEnvelope(PLAIN_ENVELOPE)).toBe(false);
    expect(isEncryptedEnvelope('not json at all')).toBe(false);
    expect(isEncryptedEnvelope('{"format":"gitglasses-patch-encrypted"}')).toBe(false);
    expect(isEncryptedEnvelope('{"format":"gitglasses-patch-encrypted","version":2}')).toBe(false);
  });

  it('decrypt rejects a plain (unencrypted) envelope with a clear error', async () => {
    await expect(decryptEnvelope(PLAIN_ENVELOPE, 'passphrase!')).rejects.toThrow(
      /not a gitglasses/i,
    );
  });
});
