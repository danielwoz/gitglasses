// Pure branch-name derivation for Start Work (no vscode imports).

const MAX_BRANCH_LENGTH = 60;

/** Reduce arbitrary text to a git-branch-safe, lowercase, dash-separated name. */
export function sanitizeBranchName(text: string): string {
  const sanitized = text
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+|[-./]+$/g, '')
    .slice(0, MAX_BRANCH_LENGTH)
    .replace(/^[-./]+|[-./]+$/g, '');
  return sanitized;
}

/**
 * Fallback branch name when the issue provider offers no suggestBranchName
 * (or it fails): "<key>-<title>" sanitized, e.g. "proj-42-fix-login-flow".
 */
export function fallbackBranchName(key: string, title: string): string {
  const combined = sanitizeBranchName(`${key} ${title}`);
  if (combined !== '') return combined;
  const keyOnly = sanitizeBranchName(key);
  return keyOnly !== '' ? keyOnly : 'work';
}
