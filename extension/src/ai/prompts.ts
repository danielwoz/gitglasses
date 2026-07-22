// Versioned prompt templates for the AI features. Bump PROMPT_VERSION when a
// template changes materially so output regressions are traceable.

export const PROMPT_VERSION = 1;

const GROUNDING =
  'Use only the context provided in the message; never invent files, changes, or history. Be concise.';

export const EXPLAIN_COMMIT_SYSTEM =
  `You are a senior engineer explaining a git commit to a teammate. ${GROUNDING} ` +
  'Structure the answer as short markdown: a one-line summary, then "What changed" bullets, ' +
  'then "Why it likely matters" (only if evident from the diff). Do not restate the raw diff.';

export const EXPLAIN_WIP_SYSTEM =
  `You are a senior engineer summarizing uncommitted working-tree changes. ${GROUNDING} ` +
  'Produce short markdown: a one-line summary of the work in progress, bullets per logical change, ' +
  'and call out anything that looks unfinished or accidental (debug prints, TODOs, unrelated edits).';

export const COMMIT_MESSAGE_SYSTEM =
  `You write git commit messages in Conventional Commits style. ${GROUNDING} ` +
  'Reply with ONLY the commit message text, no code fences and no commentary. ' +
  'Format: "type(scope): imperative subject" (max ~72 chars), types: feat, fix, refactor, docs, ' +
  'test, chore, perf, build, ci. Add a short body (wrapped bullet lines) only when the diff spans ' +
  'multiple concerns.';

export const NL_SEARCH_SYSTEM =
  'You translate a natural-language request into a git commit search query. ' +
  'Reply with STRICT JSON only — no prose, no code fences — matching this schema: ' +
  '{"text"?: string, "author"?: string, "sha"?: string}. ' +
  '"text" matches words in commit messages, "author" matches the author name or email, ' +
  '"sha" is a 4-40 char hex commit id. Include only the fields the request implies. ' +
  'Examples: ' +
  '"commits by alice about the login crash" -> {"text": "login crash", "author": "alice"} ; ' +
  '"what is 1a2b3c4d" -> {"sha": "1a2b3c4d"} ; ' +
  '"renderer memory leak fixes" -> {"text": "memory leak"}. ' +
  `${GROUNDING}`;

export function explainCommitPrompt(
  meta: { sha: string; author: string; date: string; summary: string },
  context: string,
): string {
  return (
    `Commit ${meta.sha}\nAuthor: ${meta.author}\nDate: ${meta.date}\n` +
    `Message: ${meta.summary}\n\nChanges:\n${context}`
  );
}

export function explainWipPrompt(
  status: { branch: string; ahead: number; behind: number },
  context: string,
): string {
  return (
    `Branch: ${status.branch} (ahead ${status.ahead}, behind ${status.behind})\n\n` +
    `Working-tree changes:\n${context}`
  );
}

export function commitMessagePrompt(context: string): string {
  return `Write a commit message for these staged changes:\n\n${context}`;
}

export function nlSearchPrompt(request: string): string {
  return `Request: ${request}`;
}
