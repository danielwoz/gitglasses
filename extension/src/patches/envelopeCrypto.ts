// Passphrase encryption for shared patch envelopes: scrypt key derivation +
// AES-256-GCM. Pure node:crypto logic, no vscode imports — unit-tested
// directly. The encrypted container is itself JSON so it travels over the
// same channels (files, gists, snippets, clipboard) as a plain envelope.

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const FORMAT = 'gitglasses-patch-encrypted';
const VERSION = 1;
/** scrypt cost parameters written into every envelope: OWASP's minimum for
 *  scrypt (128 MiB, a few hundred milliseconds). Readers since the format's
 *  first release accept them. */
const KDF = { N: 1 << 17, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
/** Bounds accepted on decrypt, so a hostile envelope can demand neither
 *  gigabytes of memory nor hours of work. Memory is 128 * N * r bytes
 *  (256 MiB at the cap); work grows with N * r * p, capped at four times
 *  what the writer uses. */
const MAX_KDF_MEMORY = 1 << 28;
const MAX_KDF_N = 1 << 20;
const MAX_KDF_R = 32;
const MAX_KDF_P = 4;
const MAX_KDF_WORK = 4 * KDF.N * KDF.r * KDF.p;

/** The input is not an encrypted envelope this build can open; asking for
 *  another passphrase cannot help. */
export class EnvelopeFormatError extends Error {}

export interface EncryptedEnvelopeFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  kdf: { N: number; r: number; p: number; salt: string };
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Whether a reader accepts these scrypt parameters (see the bounds above). */
export function kdfParamsSupported(params: { N: number; r: number; p: number }): boolean {
  const { N, r, p } = params;
  return (
    Number.isInteger(N) &&
    N >= 2 &&
    N <= MAX_KDF_N &&
    (N & (N - 1)) === 0 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= MAX_KDF_R &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= MAX_KDF_P &&
    128 * N * r <= MAX_KDF_MEMORY &&
    N * r * p <= MAX_KDF_WORK
  );
}

/** scrypt on libuv's thread pool, so the extension host stays responsive
 *  while the key is derived. */
function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_KDF_MEMORY + 4 * KEY_BYTES },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Encrypt envelope JSON with a passphrase into the encrypted-container JSON. */
export async function encryptEnvelope(json: string, passphrase: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const container: EncryptedEnvelopeFile = {
    format: FORMAT,
    version: VERSION,
    kdf: { ...KDF, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
  return `${JSON.stringify(container, null, 2)}\n`;
}

function parseContainer(text: string): EncryptedEnvelopeFile | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const obj = json as Record<string, unknown>;
  if (obj.format !== FORMAT || obj.version !== VERSION) return undefined;
  const kdf = obj.kdf as Record<string, unknown> | undefined;
  if (
    typeof kdf !== 'object' ||
    kdf === null ||
    typeof kdf.N !== 'number' ||
    typeof kdf.r !== 'number' ||
    typeof kdf.p !== 'number' ||
    typeof kdf.salt !== 'string'
  ) {
    return undefined;
  }
  if (
    typeof obj.iv !== 'string' ||
    typeof obj.ciphertext !== 'string' ||
    typeof obj.tag !== 'string'
  ) {
    return undefined;
  }
  return obj as unknown as EncryptedEnvelopeFile;
}

/** True when the text is an encrypted patch container (vs a plain envelope). */
export function isEncryptedEnvelope(text: string): boolean {
  return parseContainer(text) !== undefined;
}

/**
 * Decrypt an encrypted patch container back to envelope JSON. Rejects with
 * an EnvelopeFormatError on a malformed container or key-derivation
 * parameters outside the bounds (before any work is done), and with a plain
 * Error on an authentication failure (wrong passphrase or tampered content
 * — GCM cannot tell those apart).
 */
export async function decryptEnvelope(text: string, passphrase: string): Promise<string> {
  const container = parseContainer(text);
  if (!container) {
    throw new EnvelopeFormatError('not a GitGlasses encrypted patch envelope');
  }
  const { N, r, p } = container.kdf;
  if (!kdfParamsSupported({ N, r, p })) {
    throw new EnvelopeFormatError('the envelope requests unsupported key-derivation parameters');
  }
  const salt = Buffer.from(container.kdf.salt, 'base64');
  const iv = Buffer.from(container.iv, 'base64');
  const ciphertext = Buffer.from(container.ciphertext, 'base64');
  const tag = Buffer.from(container.tag, 'base64');
  const key = await deriveKey(passphrase, salt, { N, r, p });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('wrong passphrase (or the envelope was modified in transit)');
  }
}
