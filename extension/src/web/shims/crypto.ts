// Web substitute for the node:crypto surface the bundled sources use:
// randomUUID (repo groups) and randomBytes(...).toString (webview nonces).
// Backed by the Web Crypto API, which the worker extension host provides.

const BASE64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64[c & 63] : '=';
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function randomBytes(size: number): {
  toString(encoding?: 'base64' | 'hex'): string;
} {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return {
    toString: (encoding: 'base64' | 'hex' = 'hex') =>
      encoding === 'base64' ? toBase64(bytes) : toHex(bytes),
  };
}

export default { randomUUID, randomBytes };
