// What a commit declares about who wrote it, worded for the surfaces that
// show commits: the graph badge and filter, the blame hover, Commit Details
// and the history views. Pure (no vscode imports), and shared with the graph
// webview. Every label says "declared": the engine reads only what the commit
// and its git-ai note state, and never infers authorship from the code.

import type { CommitProvenance, ProvenanceDeclaration } from '@gitglasses/protocol';

/** The setting that shows or hides provenance everywhere. */
export const PROVENANCE_SETTING = 'provenance.enabled';

/** A commit's declared provenance in a sentence and its parts. */
export interface ProvenanceSummary {
  /** At least one declaration names an AI agent. */
  agent: boolean;
  /** 'AI-authored' (an agent is the author), 'AI-assisted', or 'Human-written'
   *  (only known humans declared, which only a git-ai note can say). */
  label: string;
  /** What the highest priority declaration says, such as
   *  "Co-authored-by: Claude Opus 4.7" or "git-ai note: Cursor · gpt-5". */
  via: string;
  /** "AI-assisted (declared via Co-authored-by: Claude Opus 4.7)". */
  text: string;
  /** Every agent named, each once, in declaration order. */
  agents: string[];
  /** The first agent session link, http(s) only. Rendered, never fetched. */
  sessionUrl?: string;
}

/** The longest declaration text shown in one line. */
const MAX_VIA_LENGTH = 80;

function clip(text: string, max: number = MAX_VIA_LENGTH): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "Name <email>" without the address. */
function nameOf(identity: string): string {
  const open = identity.lastIndexOf('<');
  return (open > 0 ? identity.slice(0, open) : identity).trim();
}

/** An http(s) URL without whitespace or control characters. */
export function isSessionLink(url: string | undefined): url is string {
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) return false;
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** What one declaration says, as "via: who". */
export function declarationText(declaration: ProvenanceDeclaration): string {
  if (declaration.source === 'notes') {
    const who = declaration.kind === 'agent' ? declaration.name : nameOf(declaration.name);
    return clip(`git-ai note: ${who}${declaration.model ? ` · ${declaration.model}` : ''}`);
  }
  // A session link standing alone: its value is the link itself.
  if (declaration.url && declaration.value === declaration.url) {
    return clip(`${declaration.via} (${declaration.name})`);
  }
  return clip(`${declaration.via}: ${nameOf(declaration.value) || declaration.name}`);
}

/** The summary of `provenance`, or undefined when it declares nothing. */
export function summarizeProvenance(
  provenance: CommitProvenance | undefined,
): ProvenanceSummary | undefined {
  if (!provenance || provenance.declared === 'unknown') return undefined;
  const agent = provenance.declared === 'agent';
  const primary = provenance.declarations.find((d) => d.kind === (agent ? 'agent' : 'human'));
  if (!primary) return undefined;
  const authored = provenance.declarations.some(
    (d) => d.kind === 'agent' && d.source === 'identity' && d.via === 'author',
  );
  const label = !agent ? 'Human-written' : authored ? 'AI-authored' : 'AI-assisted';
  const agents: string[] = [];
  for (const declaration of provenance.declarations) {
    if (declaration.kind === 'agent' && !agents.includes(declaration.name)) {
      agents.push(declaration.name);
    }
  }
  const via = declarationText(primary);
  const sessionUrl = provenance.declarations.map((d) => d.url).find(isSessionLink);
  return {
    agent,
    label,
    via,
    text: `${label} (declared via ${via})`,
    agents,
    ...(sessionUrl ? { sessionUrl } : {}),
  };
}

/** Every declaration as a line, for tooltips. */
export function provenanceLines(provenance: CommitProvenance | undefined): string[] {
  const summary = summarizeProvenance(provenance);
  if (!summary || !provenance) return [];
  const lines = [summary.text];
  const rest = provenance.declarations.map(declarationText).filter((text) => text !== summary.via);
  for (const text of [...new Set(rest)]) lines.push(`also declared via ${text}`);
  if (summary.sessionUrl) lines.push(`session: ${summary.sessionUrl}`);
  return lines;
}

/** Graph filter by declared provenance. 'human' keeps the commits that
 *  declare no agent, which includes those that declare nothing at all. */
export type ProvenanceFilter = 'all' | 'agent' | 'human';

export const PROVENANCE_FILTERS: readonly { value: ProvenanceFilter; label: string }[] = [
  { value: 'all', label: 'All Commits' },
  { value: 'agent', label: 'Agent-Declared' },
  { value: 'human', label: 'Human-Only (No Agent Declared)' },
];

/** Whether a commit row passes the filter. `agent` is undefined while its
 *  provenance is still loading, which counts as no agent declared. Rows that
 *  are not commits (uncommitted changes, stashes) always pass. */
export function passesProvenanceFilter(
  filter: ProvenanceFilter,
  isCommit: boolean,
  agent: boolean | undefined,
): boolean {
  if (filter === 'all' || !isCommit) return true;
  return filter === 'agent' ? agent === true : agent !== true;
}

export function isProvenanceFilter(value: unknown): value is ProvenanceFilter {
  return value === 'all' || value === 'agent' || value === 'human';
}

/** `shas` in batches of at most `size`, duplicates dropped. */
export function batches(shas: readonly string[], size: number): string[][] {
  const unique = [...new Set(shas)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}
