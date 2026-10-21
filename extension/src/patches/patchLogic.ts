// Pure logic behind the Open Patches commands: envelope validation and
// serialization, the apply confirmation text, and snippet-URL
// classification.
// No vscode imports — everything here is unit-tested directly.

import type { PatchEnvelope, PatchFileChange } from '@gitglasses/protocol';
import { shortSha } from '@gitglasses/protocol/sha';

export type EnvelopeParseResult =
  | { ok: true; envelope: PatchEnvelope }
  | { ok: false; error: string };

/** Parse and validate a .ggpatch envelope, returning friendly errors. */
export function parseEnvelope(text: string): EnvelopeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the content is not valid JSON (expected a .ggpatch envelope)' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'the JSON is not a patch envelope object' };
  }
  const obj = json as Record<string, unknown>;
  if (obj.format !== 'gitglasses-patch') {
    return { ok: false, error: 'not a GitGlasses patch — missing "format": "gitglasses-patch"' };
  }
  if (obj.version !== 1) {
    return {
      ok: false,
      error: `unsupported patch version ${JSON.stringify(obj.version)} — this build understands version 1`,
    };
  }
  if (typeof obj.baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(obj.baseSha)) {
    return { ok: false, error: 'the envelope has no valid 40-character base SHA' };
  }
  if (typeof obj.patch !== 'string' || obj.patch.trim() === '') {
    return { ok: false, error: 'the envelope contains no patch content' };
  }
  return {
    ok: true,
    envelope: {
      format: 'gitglasses-patch',
      version: 1,
      baseSha: obj.baseSha,
      branch: typeof obj.branch === 'string' ? obj.branch : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      patch: obj.patch,
      remoteFingerprint:
        typeof obj.remoteFingerprint === 'string' ? obj.remoteFingerprint : undefined,
      createdAtIso: typeof obj.createdAtIso === 'string' ? obj.createdAtIso : '',
    },
  };
}

/** Pretty-printed envelope JSON (the on-disk .ggpatch format). */
export function envelopeToJson(envelope: PatchEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export type SnippetUrlClass =
  | { kind: 'gist'; host: string }
  | { kind: 'gitlab-snippet'; host: string }
  | { kind: 'raw' };

/**
 * Classify a patch URL: a known snippet host (fetched via the provider API
 * when connected) or a plain raw URL. Undefined when not an http(s) URL.
 */
export function classifySnippetUrl(url: string): SnippetUrlClass | undefined {
  const match = /^https?:\/\/([^/?#]+)((?:\/[^?#]*)?)$/i.exec(url.trim().split(/[?#]/)[0]);
  if (!match) return undefined;
  const host = match[1].toLowerCase();
  const path = match[2];
  if (host.startsWith('gist.')) return { kind: 'gist', host };
  if (/\/-\/snippets\/\d+|^\/snippets\/\d+/.test(path)) return { kind: 'gitlab-snippet', host };
  return { kind: 'raw' };
}

/**
 * The hosting-entry domain a snippet host serves, e.g. "gist.github.com" is
 * served by the "github.com" integration; GitLab snippet URLs live on the
 * instance host itself.
 */
export function snippetProviderHost(cls: SnippetUrlClass): string | undefined {
  if (cls.kind === 'gist') return cls.host.replace(/^gist\./, '');
  if (cls.kind === 'gitlab-snippet') return cls.host;
  return undefined;
}

/** Most files the confirmation lists by name; the rest are counted. */
export const CONFIRM_MAX_LISTED_FILES = 20;

/**
 * Directories whose files configure a tool that runs code, matched at any
 * depth: an editor or dev container opened on a subfolder of the repository
 * reads that subfolder's.
 */
const TOOLING_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  ['.vscode', 'editor settings and tasks'],
  ['.idea', 'editor settings and run configurations'],
  ['.devcontainer', 'dev container configuration'],
  ['.husky', 'git hooks'],
  ['.githooks', 'git hooks'],
  ['.github', 'CI configuration'],
  ['.circleci', 'CI configuration'],
]);

/**
 * File names (lowercase) that CI, git, package managers, build and test
 * tools or container engines run or read to decide what to run.
 */
const TOOLING_FILES: ReadonlyMap<string, string> = new Map([
  ...[
    '.gitlab-ci.yml',
    'azure-pipelines.yml',
    'bitbucket-pipelines.yml',
    'jenkinsfile',
    '.travis.yml',
    'appveyor.yml',
    '.drone.yml',
  ].map((name): [string, string] => [name, 'CI configuration']),
  ['.gitattributes', 'git attributes (filters and diff drivers)'],
  ['.gitmodules', 'submodules'],
  ['package.json', 'package scripts'],
  ...['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs'].map((name): [string, string] => [
    name,
    'package manager configuration',
  ]),
  ['.envrc', 'shell environment (direnv)'],
  ...[
    'makefile',
    'gnumakefile',
    'cmakelists.txt',
    'meson.build',
    'build.rs',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradlew',
    'gradle-wrapper.properties',
    'pom.xml',
    'mvnw',
    'build.sbt',
    'setup.py',
    'noxfile.py',
    'rakefile',
    'gemfile',
    'justfile',
    'taskfile.yml',
    'taskfile.yaml',
    'sconstruct',
    'build.bazel',
    'workspace',
    'workspace.bazel',
    'vagrantfile',
  ].map((name): [string, string] => [name, 'build script']),
  ['conftest.py', 'test setup'],
  ...[
    'dockerfile',
    'containerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ].map((name): [string, string] => [name, 'container definition']),
]);

/**
 * Why a path deserves a second look before a patch from someone else writes
 * it: files that configure the editor, CI, git itself, package managers,
 * the build, tests or containers, and so can run code. Undefined for
 * ordinary files.
 */
export function sensitivePathReason(path: string, executable = false): string | undefined {
  const segments = path.split('/');
  const name = segments[segments.length - 1].toLowerCase();
  for (const directory of segments.slice(0, -1)) {
    const reason = TOOLING_DIRECTORIES.get(directory.toLowerCase());
    if (reason) return reason;
  }
  const byName = TOOLING_FILES.get(name);
  if (byName) return byName;
  if (/\.(cmake|bzl|gemspec)$/.test(name)) return 'build script';
  if (name.endsWith('.dockerfile')) return 'container definition';
  if (executable) return 'made executable';
  if (/\.(sh|bash|zsh|ps1|psm1|bat|cmd)$/.test(name)) return 'script';
  if (segments.length > 1 && segments[0].startsWith('.')) return 'tool configuration';
  if (segments.length === 1 && name.startsWith('.') && name !== '.gitignore') {
    return 'configuration file';
  }
  return undefined;
}

function fileLine(file: PatchFileChange): string {
  const notes: string[] = [];
  if (file.status === 'A') notes.push('new');
  if (file.status === 'D') notes.push('deleted');
  if (file.status === 'R' && file.origPath) notes.push(`renamed from ${file.origPath}`);
  if (file.status === 'C' && file.origPath) notes.push(`copied from ${file.origPath}`);
  if (file.binary) notes.push('binary');
  const counts = file.binary ? '' : `  +${file.additions} −${file.deletions}`;
  const reason = sensitivePathReason(file.path, file.executable === true);
  const prefix = reason ? '⚠ ' : '• ';
  const noted = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  return `${prefix}${file.path}${noted}${counts}${reason ? ` — ${reason}` : ''}`;
}

/** How many of the files `sensitivePathReason` flags. */
export function sensitiveFileCount(files: readonly PatchFileChange[]): number {
  return files.filter((file) => sensitivePathReason(file.path, file.executable === true)).length;
}

/** Message line of the apply-patch confirmation modal. */
export function confirmMessage(files: readonly PatchFileChange[]): string {
  const flagged = sensitiveFileCount(files);
  if (flagged === 0) return 'Apply this patch to the repository?';
  return (
    `Apply this patch to the repository? It changes ${flagged} ` +
    `${flagged === 1 ? 'file' : 'files'} that can run code or change tooling (marked ⚠).`
  );
}

/**
 * Detail text for the apply-patch confirmation modal: the envelope's
 * summary, base and date, then the files git will change, as git's own
 * patch parser reads them (patch/apply with dryRun).
 */
export function confirmDetail(envelope: PatchEnvelope, files: readonly PatchFileChange[]): string {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const lines = [
    envelope.summary === '' ? '(no summary)' : envelope.summary,
    `Base: ${shortSha(envelope.baseSha)}${envelope.branch ? ` (branch ${envelope.branch})` : ''}`,
  ];
  if (envelope.createdAtIso !== '') lines.push(`Created: ${envelope.createdAtIso}`);
  lines.push(
    '',
    `${files.length} file${files.length === 1 ? '' : 's'} changed, +${additions} −${deletions}`,
  );
  // Flagged files first, so the cap hides an ordinary file before any
  // flagged one; the line counting hidden files says how many are flagged.
  const ordered = [...files].sort(
    (a, b) =>
      Number(sensitivePathReason(b.path, b.executable === true) !== undefined) -
      Number(sensitivePathReason(a.path, a.executable === true) !== undefined),
  );
  for (const file of ordered.slice(0, CONFIRM_MAX_LISTED_FILES)) lines.push(fileLine(file));
  const hidden = ordered.slice(CONFIRM_MAX_LISTED_FILES);
  if (hidden.length > 0) {
    const flagged = sensitiveFileCount(hidden);
    lines.push(
      `…and ${hidden.length} more ${hidden.length === 1 ? 'file' : 'files'}` +
        (flagged > 0 ? `, ${flagged} of them able to run code or change tooling` : ''),
    );
  }
  return lines.join('\n');
}

/** Suggested save-dialog file name derived from the patch summary. */
export function patchFileName(summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug === '' ? 'patch' : slug}.ggpatch`;
}
