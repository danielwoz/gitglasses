// Minimal POSIX path implementation for the web bundle. The esbuild web
// config aliases 'node:path' to this module, so shared sources keep their
// node:path imports untouched while the browser bundle stays node-free.
// Paths on the web side are always POSIX (vscode.Uri.path and the engine's
// MEMFS both use forward slashes).

export const sep = '/';

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

export function normalize(p: string): string {
  if (p.length === 0) return '.';
  const absolute = isAbsolute(p);
  const trailingSlash = p.endsWith('/');
  const out: string[] = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  let result = out.join('/');
  if (result.length === 0) result = absolute ? '/' : '.';
  else {
    if (absolute) result = `/${result}`;
    if (trailingSlash && !result.endsWith('/')) result += '/';
  }
  return result;
}

export function join(...parts: string[]): string {
  const joined = parts.filter((part) => part.length > 0).join('/');
  return joined.length === 0 ? '.' : normalize(joined);
}

export function resolve(...parts: string[]): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.length === 0) continue;
    resolved = resolved.length === 0 ? part : `${part}/${resolved}`;
    if (isAbsolute(part)) break;
  }
  // There is no working directory in the web host; root anchors relatives.
  if (!isAbsolute(resolved)) resolved = `/${resolved}`;
  const normalized = normalize(resolved);
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
}

export function dirname(p: string): string {
  const normalized = normalize(p);
  const trimmed =
    normalized.length > 1 && normalized.endsWith('/')
      ? normalized.slice(0, -1)
      : normalized;
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

export function basename(p: string, ext?: string): string {
  const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf('/');
  let base = idx < 0 ? trimmed : trimmed.slice(idx + 1);
  if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

export function relative(from: string, to: string): string {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common += 1;
  }
  const up = fromParts.slice(common).map(() => '..');
  return [...up, ...toParts.slice(common)].join('/');
}

const path = {
  sep,
  isAbsolute,
  normalize,
  join,
  resolve,
  dirname,
  basename,
  extname,
  relative,
  posix: undefined as unknown,
};
path.posix = path;

export const posix = path;
export default path;
