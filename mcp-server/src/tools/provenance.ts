// git_provenance: who declared they wrote a range of a file. The range is
// blamed, and each commit behind it reports what it declares about its
// authorship (commit/provenance): a git-ai note in refs/notes/ai, trailers
// such as Co-authored-by, and authors or committers that are known agent
// identities. Commit-level and declared only: nothing is inferred from the
// code, and a commit that declares nothing is reported as unknown.

import { randomUUID } from 'node:crypto';
import {
  UNCOMMITTED_SHA,
  type BlameCommit,
  type BlameHunk,
  type CommitProvenance,
} from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';
import type { EngineClient } from '@gitglasses/rpc';
import { isoDate } from '../format.js';

/** Most blame hunks one call reports. */
export const MAX_PROVENANCE_HUNKS = 500;

/** Commits per commit/provenance request. */
const PROVENANCE_BATCH = 500;

export interface ProvenanceArgs {
  file: string;
  startLine?: number;
  endLine?: number;
}

/** What one call found: the hunks covering the range and what their commits
 *  declare. */
export interface ProvenanceReport {
  file: string;
  startLine: number;
  /** Undefined for "to the end of the file". */
  endLine?: number;
  totalLines: number;
  hunks: BlameHunk[];
  /** More hunks covered the range than were kept. */
  truncated: boolean;
  commits: Record<string, BlameCommit>;
  provenance: Record<string, CommitProvenance>;
}

/** Blames the range and asks what its commits declare. */
export async function collectProvenance(
  client: EngineClient,
  repoId: string,
  args: ProvenanceArgs,
): Promise<ProvenanceReport> {
  const startLine = args.startLine ?? 1;
  const endLine = args.endLine;
  if (endLine !== undefined && endLine < startLine) {
    throw new Error(`endLine (${endLine}) is before startLine (${startLine})`);
  }
  const streamId = randomUUID();
  const hunks: BlameHunk[] = [];
  let truncated = false;
  const sub = client.onNotification('blame/hunks', (params) => {
    if (params.streamId !== streamId) return;
    for (const hunk of params.hunks) {
      const last = hunk.resultLine + hunk.lineCount - 1;
      if (last < startLine || (endLine !== undefined && hunk.resultLine > endLine)) continue;
      // Hunks stream in blame order; keep the lowest lines, in line order.
      let low = 0;
      let high = hunks.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (hunks[mid].resultLine < hunk.resultLine) low = mid + 1;
        else high = mid;
      }
      hunks.splice(low, 0, hunk);
      if (hunks.length > MAX_PROVENANCE_HUNKS) {
        hunks.pop();
        truncated = true;
      }
    }
  });
  let blame;
  try {
    blame = await client.request('blame/file', { repoId, path: args.file, streamId });
  } finally {
    sub.dispose();
  }

  const shas = [...new Set(hunks.map((hunk) => hunk.sha))].filter((sha) => sha !== UNCOMMITTED_SHA);
  const provenance: Record<string, CommitProvenance> = {};
  for (let i = 0; i < shas.length; i += PROVENANCE_BATCH) {
    const { commits } = await client.request('commit/provenance', {
      repoId,
      shas: shas.slice(i, i + PROVENANCE_BATCH),
    });
    Object.assign(provenance, commits);
  }
  return {
    file: args.file,
    startLine,
    endLine,
    totalLines: blame.totalLines,
    hunks,
    truncated,
    commits: blame.commits,
    provenance,
  };
}

/** The declared kind of a commit and the source that declared it first. */
function declaredOf(provenance: CommitProvenance | undefined): string {
  if (!provenance || provenance.declared === 'unknown') return 'unknown';
  const first = provenance.declarations.find(
    (d) => d.kind === (provenance.declared === 'agent' ? 'agent' : 'human'),
  );
  return first ? `${provenance.declared} (${first.source})` : provenance.declared;
}

/** One declaration: who, which model, what carried it, as written. Values
 *  come from the repository and are quoted. */
function declarationLine(declaration: CommitProvenance['declarations'][number]): string {
  const who =
    declaration.kind === 'agent'
      ? `agent ${JSON.stringify(declaration.name)}`
      : `human ${JSON.stringify(declaration.name)}`;
  const model = declaration.model ? ` model ${JSON.stringify(declaration.model)}` : '';
  const source =
    declaration.source === 'notes'
      ? `git-ai note in ${declaration.via}${declaration.value ? ` (session ${JSON.stringify(declaration.value)})` : ''}`
      : `${declaration.source} ${declaration.via}: ${JSON.stringify(declaration.value)}`;
  const session = declaration.url ? `; session link ${declaration.url} (not fetched)` : '';
  return `  - ${who}${model} via ${source}${session}`;
}

export function formatProvenance(report: ProvenanceReport): string {
  const range =
    report.endLine === undefined
      ? `L${report.startLine}-${report.totalLines}`
      : `L${report.startLine}-${report.endLine}`;
  const header =
    `provenance ${report.file} ${range}: what each commit declares (git-ai notes in ` +
    'refs/notes/ai, trailers such as Co-authored-by, known agent identities). Nothing is ' +
    'inferred from the code; "unknown" means the commit declares nothing.';
  if (report.hunks.length === 0) return `${header}\n\nNo blame hunks cover this range.`;

  const hunkLines = report.hunks.map((hunk) => {
    const last = hunk.resultLine + hunk.lineCount - 1;
    const lines = hunk.lineCount === 1 ? `L${hunk.resultLine}` : `L${hunk.resultLine}-${last}`;
    if (hunk.sha === UNCOMMITTED_SHA) return `${lines} uncommitted`;
    return `${lines} ${shortSha(hunk.sha)} ${declaredOf(report.provenance[hunk.sha])}`;
  });

  const commitLines: string[] = [];
  const seen = new Set<string>();
  for (const hunk of report.hunks) {
    if (hunk.sha === UNCOMMITTED_SHA || seen.has(hunk.sha)) continue;
    seen.add(hunk.sha);
    const commit = report.commits[hunk.sha];
    const identity = commit
      ? `${commit.author.name} ${isoDate(commit.author.time)} ${JSON.stringify(commit.summary)}`
      : '';
    commitLines.push(`${shortSha(hunk.sha)} ${identity}`.trimEnd());
    const provenance = report.provenance[hunk.sha];
    if (!provenance || provenance.declared === 'unknown') {
      commitLines.push('  declares nothing');
    } else {
      commitLines.push(...provenance.declarations.map(declarationLine));
    }
    if (provenance?.note && !provenance.note.read) {
      commitLines.push(
        `  a git-ai note is attached but not read${
          provenance.note.schemaVersion
            ? ` (schema ${JSON.stringify(provenance.note.schemaVersion)})`
            : ''
        }`,
      );
    }
  }

  const parts = [header, '', 'hunks:', ...hunkLines, '', 'commits:', ...commitLines];
  if (report.truncated) {
    const last = report.hunks[report.hunks.length - 1];
    parts.push(
      '',
      `(showing the first ${report.hunks.length} hunks; pass startLine: ${
        last.resultLine + last.lineCount
      } for the rest)`,
    );
  }
  return parts.join('\n');
}
