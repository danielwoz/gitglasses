// Pure logic behind "Suggest Change for Pull Request": selection-to-line
// mapping, the check against the pull request head, suggestion-comment body
// construction and the single-file fallback patch. No vscode imports.

import type { PatchEnvelope } from '@gitglasses/protocol';

/** A vscode.Selection-shaped range: 0-based lines and characters. */
export interface SelectionLike {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** 1-based inclusive line range the suggestion replaces. */
export interface SuggestionRange {
  startLine: number;
  endLine: number;
}

/**
 * Map an editor selection to the 1-based line range a suggestion replaces.
 * A selection ending at character 0 of a later line (the common shift-down
 * selection shape) does not include that line's content, so it is excluded.
 */
export function selectionToRange(selection: SelectionLike): SuggestionRange {
  let endLine = selection.endLine;
  if (endLine > selection.startLine && selection.endCharacter === 0) {
    endLine -= 1;
  }
  return { startLine: selection.startLine + 1, endLine: endLine + 1 };
}

export interface SuggestionBodyOptions {
  /** Replacement text for the selected lines. */
  replacement: string;
  /** Optional prose shown above the suggestion block. */
  comment?: string;
  /**
   * GitLab offset syntax: how many lines above the anchor line the suggestion
   * also replaces (```suggestion:-N+0). Omit for GitHub's plain fence, where
   * multi-line ranges are expressed via the API's start_line/line instead.
   */
  gitlabLinesAbove?: number;
}

/** Build the review-comment body containing the ```suggestion fenced block. */
export function buildSuggestionBody(options: SuggestionBodyOptions): string {
  const info =
    options.gitlabLinesAbove !== undefined
      ? `suggestion:-${options.gitlabLinesAbove}+0`
      : 'suggestion';
  // Grow the fence beyond any backtick run inside the replacement.
  let fence = '```';
  while (options.replacement.includes(fence)) {
    fence += '`';
  }
  const replacement = options.replacement.replace(/\n$/, '');
  const block = `${fence}${info}\n${replacement}\n${fence}`;
  const comment = options.comment?.trim();
  return comment ? `${comment}\n\n${block}` : block;
}

/**
 * True when a provider error status means the comment anchor was rejected —
 * i.e. the selected lines are not part of the PR head diff (GitHub 422,
 * GitLab 400).
 */
export function isAnchorRejection(status: number | undefined): boolean {
  return status === 422 || status === 400;
}

/** Grow a backtick fence until it exceeds any run inside the content. */
function fenceFor(content: string): string {
  let fence = '```';
  while (content.includes(fence)) fence += '`';
  return fence;
}

export interface PatchCommentOptions {
  /** File path relative to the repository root. */
  path: string;
  /** 1-based inclusive line range the suggestion targets. */
  startLine: number;
  endLine: number;
  /** Proposed replacement text for the selected lines. */
  replacement: string;
  /** Optional prose explaining the suggestion. */
  comment?: string;
  /** Browser URL of the uploaded patch (a secret gist), when it was uploaded. */
  patchUrl?: string;
  /** Patch envelope JSON carried in the comment itself, when nothing was uploaded. */
  inlineEnvelope?: string;
}

/**
 * Build the top-level PR comment posted when a suggestion cannot anchor to
 * the diff: describes the targeted lines, carries the prose and the proposed
 * replacement, and points at the GitGlasses patch that applies the change,
 * by link or folded into the comment.
 */
export function buildPatchCommentBody(options: PatchCommentOptions): string {
  const lines =
    options.startLine === options.endLine
      ? `line ${options.startLine}`
      : `lines ${options.startLine}-${options.endLine}`;
  const parts: string[] = [
    `**Suggested change** for \`${options.path}\` (${lines}) — outside the PR diff, so it is shared as a GitGlasses patch instead of an inline suggestion.`,
  ];
  const comment = options.comment?.trim();
  if (comment) parts.push(comment);
  const fence = fenceFor(options.replacement);
  parts.push(`Proposed replacement:\n${fence}\n${options.replacement.replace(/\n$/, '')}\n${fence}`);
  if (options.patchUrl) {
    parts.push(
      `Apply it with GitGlasses **Apply Patch** from this URL: ${options.patchUrl}`,
    );
  } else if (options.inlineEnvelope) {
    const envelope = options.inlineEnvelope.replace(/\n$/, '');
    const jsonFence = fenceFor(envelope);
    parts.push(
      '<details><summary>GitGlasses patch: copy it, then run <b>Apply Patch</b> → From Clipboard</summary>\n\n' +
        `${jsonFence}json\n${envelope}\n${jsonFence}\n\n</details>`,
    );
  }
  return parts.join('\n\n');
}

/**
 * The first line, 1-based, among lines 1..`throughLine` where the local text
 * differs from the text at the pull request head; undefined when they agree.
 * Line endings are not compared. A suggestion anchors by line number at the
 * head, so every line above the selection has to match as well as the
 * selection itself, or it lands on different text.
 */
export function firstMismatchedLine(
  localText: string,
  headText: string,
  throughLine: number,
): number | undefined {
  const local = localText.split(/\r?\n/);
  const head = headText.split(/\r?\n/);
  for (let line = 1; line <= throughLine; line++) {
    if (line > local.length || line > head.length || local[line - 1] !== head[line - 1]) {
      return line;
    }
  }
  return undefined;
}

/** Lines of context a unified diff hunk carries on each side. */
const CONTEXT_LINES = 3;

/** A path as git writes it in a diff header, C-quoted when it has to be. */
function diffPath(prefix: string, path: string): string {
  const full = `${prefix}${path}`;
  // Control characters, quotes, backslashes and non-ASCII bytes force quoting.
  // eslint-disable-next-line no-control-regex
  if (!/[\x00-\x1f"\\\x7f]|[^\x00-\x7f]/.test(full)) return full;
  let quoted = '';
  for (const byte of new TextEncoder().encode(full)) {
    const char = String.fromCharCode(byte);
    if (char === '"' || char === '\\') quoted += `\\${char}`;
    else if (char === '\t') quoted += '\\t';
    else if (char === '\n') quoted += '\\n';
    else if (byte < 0x20 || byte >= 0x7f) quoted += `\\${byte.toString(8).padStart(3, '0')}`;
    else quoted += char;
  }
  return `"${quoted}"`;
}

export interface SuggestionPatchInput {
  /** File path relative to the repository root, forward slashes. */
  path: string;
  /** The file's content at the pull request head. */
  headText: string;
  /** 1-based inclusive line range the replacement takes the place of. */
  startLine: number;
  endLine: number;
  /** Replacement text; empty removes the lines. */
  replacement: string;
}

export interface SuggestionPatch {
  /** Unified diff of the one file, as `git apply` takes it. */
  patch: string;
  added: number;
  removed: number;
}

/**
 * A single-file unified diff that replaces lines startLine..endLine of the
 * head content with the replacement, and nothing else. Lines are written with
 * "\n" endings, the form git stores and diffs text in. Undefined when the
 * replacement leaves the lines as they are, or the range is not in the file.
 */
export function buildSuggestionPatch(input: SuggestionPatchInput): SuggestionPatch | undefined {
  const endsWithNewline = input.headText.endsWith('\n');
  const lines = input.headText.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  const { startLine, endLine } = input;
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;

  const removed = lines.slice(startLine - 1, endLine);
  const replacement = input.replacement.replace(/\r?\n$/, '');
  const added = input.replacement === '' ? [] : replacement.split(/\r?\n/);
  if (added.length === removed.length && added.every((line, i) => line === removed[i])) {
    return undefined;
  }

  const before = lines.slice(Math.max(0, startLine - 1 - CONTEXT_LINES), startLine - 1);
  const after = lines.slice(endLine, endLine + CONTEXT_LINES);
  const oldStart = startLine - before.length;
  const oldCount = before.length + removed.length + after.length;
  const newCount = before.length + added.length + after.length;
  const newStart = newCount === 0 ? oldStart - 1 : oldStart;

  // The file's last line carries no newline: whichever side ends on it says so.
  const noNewline = '\\ No newline at end of file';
  const lastLineInHunk = endLine + after.length === lines.length && !endsWithNewline;
  const body: string[] = [...before.map((line) => ` ${line}`)];
  body.push(...removed.map((line) => `-${line}`));
  if (lastLineInHunk && after.length === 0) body.push(noNewline);
  body.push(...added.map((line) => `+${line}`));
  if (lastLineInHunk && after.length === 0 && added.length > 0) body.push(noNewline);
  body.push(...after.map((line) => ` ${line}`));
  if (lastLineInHunk && after.length > 0) body.push(noNewline);

  const patch = [
    `diff --git ${diffPath('a/', input.path)} ${diffPath('b/', input.path)}`,
    `--- ${diffPath('a/', input.path)}`,
    `+++ ${diffPath('b/', input.path)}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
  ].join('\n');
  return { patch: `${patch}\n`, added: added.length, removed: removed.length };
}

export interface SuggestionEnvelopeInput {
  /** Pull request head commit the patch applies to. */
  headSha: string;
  /** Pull request head branch. */
  headRef: string;
  summary: string;
  patch: SuggestionPatch;
  createdAtIso: string;
}

/**
 * The patch as a GitGlasses envelope based on the pull request head, or
 * undefined when the head is not a full commit sha an envelope can name.
 */
export function buildSuggestionEnvelope(input: SuggestionEnvelopeInput): PatchEnvelope | undefined {
  if (!/^[0-9a-f]{40}$/i.test(input.headSha)) return undefined;
  return {
    format: 'gitglasses-patch',
    version: 1,
    baseSha: input.headSha,
    branch: input.headRef,
    summary: input.summary,
    patch: input.patch.patch,
    createdAtIso: input.createdAtIso,
  };
}

/** Where a fallback patch can be uploaded, and who can read it there. */
export interface PatchUpload {
  /** Button label for uploading. */
  action: string;
  /** Where the patch goes, for the confirmation. */
  where: string;
  /** Who can read it once the link is posted. */
  visibility: string;
}

/**
 * The upload a provider offers for a fallback patch, or undefined when the
 * patch should travel inside the comment instead. Only a GitHub secret gist
 * is both unlisted and readable by the pull request's reviewers; a GitLab
 * personal snippet is either private to its author or open to everyone.
 */
export function patchUploadFor(providerId: string, host: string): PatchUpload | undefined {
  if (providerId !== 'github' && providerId !== 'github-enterprise') return undefined;
  return {
    action: 'Upload Secret Gist and Comment',
    where: `a secret gist on ${host}`,
    visibility:
      'A secret gist is unlisted, but anyone with its link can read it, and the link is posted on the pull request.',
  };
}

/** The button that opens the patch for reading before choosing. */
export const PREVIEW_PATCH = 'Preview Patch';

/**
 * The fallback confirmation's buttons. Posting the patch in the comment
 * comes first, which makes it the default: it stays with the pull request's
 * readers, while an uploaded link reaches anyone it is passed to.
 */
export function fallbackButtons(upload: PatchUpload | undefined, canPreview: boolean): string[] {
  return [
    upload ? 'Comment Only' : 'Post Comment',
    ...(upload ? [upload.action] : []),
    ...(canPreview ? [PREVIEW_PATCH] : []),
  ];
}

/** Longest diff the confirmation shows inline; Preview shows the rest. */
const CONFIRM_DIFF_LINES = 30;

export interface FallbackConfirmInput {
  pr: { repo: { owner: string; name: string }; number: number; title: string };
  path: string;
  startLine: number;
  endLine: number;
  patch?: SuggestionPatch;
  upload?: PatchUpload;
}

/** The confirmation text for the patch fallback: what goes where, and who sees it. */
export function fallbackConfirmDetail(input: FallbackConfirmInput): string {
  const lines =
    input.startLine === input.endLine
      ? `line ${input.startLine}`
      : `lines ${input.startLine}-${input.endLine}`;
  const parts = [
    `Pull request: ${input.pr.repo.owner}/${input.pr.repo.name}#${input.pr.number} "${input.pr.title}"`,
  ];
  if (!input.patch) {
    parts.push(
      `The comment carries the proposed replacement for ${input.path} (${lines}); no patch is attached.`,
    );
    return parts.join('\n\n');
  }
  parts.push(
    `Patch: ${input.path}, ${lines} (+${input.patch.added} -${input.patch.removed}). ` +
      'Nothing else from your working tree is included.',
  );
  parts.push(
    input.upload
      ? 'Comment Only puts the patch in the comment, visible to whoever can read the pull request. ' +
          `${input.upload.action.replace(/ and Comment$/, '')} puts it in ${input.upload.where} instead. ` +
          input.upload.visibility
      : 'The patch goes into the comment itself, visible to whoever can read the pull request; nothing is uploaded anywhere else.',
  );
  const diff = input.patch.patch.replace(/\n$/, '').split('\n');
  const shown = diff.slice(0, CONFIRM_DIFF_LINES).join('\n');
  parts.push(diff.length > CONFIRM_DIFF_LINES ? `${shown}\n…` : shown);
  return parts.join('\n\n');
}
