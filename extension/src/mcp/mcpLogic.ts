// What the bundled MCP server is started with, and the configuration other
// agents need to start it. Pure (no vscode imports): the registration, the
// commands and the Home view build on these.

import * as path from 'node:path';

/** The name the server is registered under, in the editor and elsewhere. */
export const MCP_SERVER_NAME = 'gitglasses';

/** The program that runs the bundled server script. */
export interface NodeRuntime {
  /** Absolute path of the executable. */
  command: string;
  /** The editor's own binary, which acts as Node only with ELECTRON_RUN_AS_NODE. */
  electron: boolean;
}

/** A server process: the command line and the environment it needs. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface LaunchOptions {
  runtime: NodeRuntime;
  /** The bundled server script (dist/mcp/cli.js). */
  cliPath: string;
  /** The engine the extension itself runs. */
  enginePath: string;
  /**
   * Directories where the server may run git (--allow). Empty means none:
   * the server then reads only its client's own roots, without running git.
   */
  allowedRoots: readonly string[];
  /**
   * Directories the server reads without running git (--read), besides its
   * client's own roots: for clients that share no folders with it.
   */
  readRoots?: readonly string[];
}

const ALLOW_OPTION = '--allow=';
const READ_OPTION = '--read=';

/**
 * How to start the server. Each directory is its own argument, so no folder
 * name is ever split into others. GITGLASSES_ALLOWED_ROOTS is set empty, so a
 * value in the editor's own environment can never widen the list.
 */
export function buildLaunch(options: LaunchOptions): McpLaunch {
  const env: Record<string, string> = {
    GITGLASSES_ENGINE: options.enginePath,
    GITGLASSES_ALLOWED_ROOTS: '',
  };
  if (options.runtime.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    command: options.runtime.command,
    args: [
      options.cliPath,
      ...options.allowedRoots.map((root) => `${ALLOW_OPTION}${root}`),
      ...(options.readRoots ?? []).map((root) => `${READ_OPTION}${root}`),
    ],
    env,
  };
}

function optionValues(launch: McpLaunch, option: string): string[] {
  return launch.args.filter((arg) => arg.startsWith(option)).map((arg) => arg.slice(option.length));
}

/** The directories a launch lets git run in (its --allow arguments). */
export function launchGitRoots(launch: McpLaunch): string[] {
  return optionValues(launch, ALLOW_OPTION);
}

/** The directories a launch reads without git (its --read arguments). */
export function launchReadRoots(launch: McpLaunch): string[] {
  return optionValues(launch, READ_OPTION);
}

/** True when `child` is `parent` or lies inside it. */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface AllowedRootsOptions {
  /** Whether the user trusts the workspace (workspace trust). */
  trusted: boolean;
  /** The workspace folders on the local filesystem. */
  folders: readonly string[];
  /** The user's home directory. */
  home: string;
  /** Whether `dir` holds a .git directory or file. */
  hasGit: (dir: string) => boolean;
}

/**
 * Where the editor's server may run git: nowhere in an untrusted workspace,
 * otherwise in each workspace folder, widened to the repository that holds
 * it when the folder is part of a larger one (the server refuses a repository
 * that extends outside its allowed roots). A folder that is a filesystem
 * root, the home directory or a directory above it is left out, and no folder
 * is widened that far: either would admit every repository the user has.
 */
export function allowedRootsFor(options: AllowedRootsOptions): string[] {
  if (!options.trusted) return [];
  const tooWide = (dir: string): boolean =>
    path.parse(dir).root === dir || isWithin(options.home, dir);
  const roots: string[] = [];
  for (const folder of options.folders) {
    if (tooWide(folder)) continue;
    let root = folder;
    for (let dir = folder; !tooWide(dir); dir = path.dirname(dir)) {
      if (options.hasGit(dir)) {
        root = dir;
        break;
      }
    }
    if (roots.some((existing) => isWithin(root, existing))) continue;
    for (let i = roots.length - 1; i >= 0; i--) {
      if (isWithin(roots[i], root)) roots.splice(i, 1);
    }
    roots.push(root);
  }
  return roots;
}

// --- feature detection -------------------------------------------------------

/** The editor API that can register the server, if any. */
export type McpHost = 'vscode' | 'cursor';

/** The parts of the vscode namespace that registration may find. */
export interface McpApiSurface {
  lm?: { registerMcpServerDefinitionProvider?: unknown };
  McpStdioServerDefinition?: unknown;
  cursor?: { mcp?: { registerServer?: unknown; unregisterServer?: unknown } };
}

/**
 * Which registration API this editor offers. Cursor's own wins where both
 * exist, since its agent reads only servers registered through it. VS Code
 * 1.101 and newer have the definition provider API; older releases and other
 * hosts have neither, and the commands that write an agent's configuration
 * are the way in there.
 */
export function detectMcpHost(api: McpApiSurface): McpHost | undefined {
  const cursor = api.cursor?.mcp;
  if (
    typeof cursor?.registerServer === 'function' &&
    typeof cursor.unregisterServer === 'function'
  ) {
    return 'cursor';
  }
  if (
    typeof api.lm?.registerMcpServerDefinitionProvider === 'function' &&
    typeof api.McpStdioServerDefinition === 'function'
  ) {
    return 'vscode';
  }
  return undefined;
}

// --- Node runtime ------------------------------------------------------------

/**
 * Oldest Node major the bundled server supports: the one its bundle is built
 * for (mcpConfig's node20 target in extension/esbuild.mjs), which VS Code
 * 1.90, the oldest editor the extension installs in, also ships. The npm
 * package needs 20.11 for import.meta.dirname; the bundle replaces that with
 * __dirname.
 */
export const MIN_NODE_MAJOR = 20;

/**
 * True when `--version` output names a Node the server runs on. An editor
 * that ignores ELECTRON_RUN_AS_NODE prints its own version instead, with no
 * leading v, which never passes.
 */
export function isSupportedNodeVersion(output: string): boolean {
  const major = /^v(\d+)\.\d+\.\d+/.exec(output.trim())?.[1];
  return major !== undefined && Number(major) >= MIN_NODE_MAJOR;
}

export interface FindOnPathOptions {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  isFile: (candidate: string) => boolean;
  /** Extensions tried on Windows; defaults to .exe alone. */
  windowsExtensions?: readonly string[];
}

/**
 * The absolute path `name` resolves to on PATH, or undefined. Only absolute
 * PATH entries count, so a relative entry can never resolve into the
 * workspace. On Windows only real executables (.exe) are taken by default:
 * a .cmd shim cannot be started without a shell.
 */
export function findOnPath(name: string, options: FindOnPathOptions): string | undefined {
  const win = options.platform === 'win32';
  const pathValue = win
    ? (Object.entries(options.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '')
    : (options.env.PATH ?? '');
  const extensions = win ? (options.windowsExtensions ?? ['.exe']) : [''];
  const join = win ? path.win32.join : path.posix.join;
  const isAbsolute = win ? path.win32.isAbsolute : path.posix.isAbsolute;
  for (const dir of pathValue.split(win ? ';' : ':')) {
    const entry = dir.trim().replace(/^"(.*)"$/, '$1');
    if (entry === '' || !isAbsolute(entry)) continue;
    for (const extension of extensions) {
      const candidate = join(entry, `${name}${extension}`);
      if (options.isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

// --- configuration for other agents -----------------------------------------

/** The server as an entry of an `mcpServers` map, the shape most agents read. */
export function serverEntry(launch: McpLaunch): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return { command: launch.command, args: [...launch.args], env: { ...launch.env } };
}

/**
 * JSON for agents configured with an `mcpServers` map: Claude Desktop,
 * Windsurf, Kiro, Theia AI and others.
 */
export function mcpServersJson(launch: McpLaunch): string {
  return `${JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: serverEntry(launch) } }, null, 2)}\n`;
}

/** The arguments of `claude mcp add-json` that add the server for every project. */
export function claudeAddJsonArgs(launch: McpLaunch): string[] {
  return [
    'mcp',
    'add-json',
    '--scope',
    'user',
    MCP_SERVER_NAME,
    JSON.stringify({ type: 'stdio', ...serverEntry(launch) }),
  ];
}

/** The arguments of `claude mcp remove` for the server added above. */
export function claudeRemoveArgs(): string[] {
  return ['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME];
}

/** True when `claude mcp add-json` refused because the server already exists. */
export function isAlreadyExistsOutput(output: string): boolean {
  return /already exists/i.test(output);
}

// --- Codex config.toml -------------------------------------------------------

/** A TOML basic string. JSON's escapes are all valid TOML escapes. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** A TOML key: bare where TOML allows it, quoted otherwise. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/** The [mcp_servers.gitglasses] table Codex reads. */
export function codexServerToml(launch: McpLaunch): string {
  const env = Object.entries(launch.env)
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`)
    .join(', ');
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(launch.command)}`,
    `args = [${launch.args.map(tomlString).join(', ')}]`,
    `env = { ${env} }`,
    '',
  ].join('\n');
}

/** The config holds the server in a form that cannot be replaced line by line. */
export class CodexConfigConflict extends Error {}

/** A dotted TOML key (`a."b.c".d`) split into its parts, or undefined. */
function parseKeyPath(text: string): string[] | undefined {
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  const keys: string[] = [];
  let index = 0;
  while (index < text.length) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) return undefined;
    keys.push(
      match[1] !== undefined ? (JSON.parse(`"${match[1]}"`) as string) : (match[2] ?? match[3]),
    );
    index = part.lastIndex;
    if (match[4] === '') break;
  }
  return index >= text.length && keys.length > 0 ? keys : undefined;
}

/** A table header line, `[a.b]` or `[[a.b]]`, with its key path. */
function tableHeader(line: string): { keys: string[]; array: boolean } | undefined {
  const match = /^\s*(\[\[?)(.+?)\]\]?\s*(#.*)?$/.exec(line);
  const keys = match ? parseKeyPath(match[2]) : undefined;
  return match && keys ? { keys, array: match[1] === '[[' } : undefined;
}

/** The key path of a `key = value` line, or undefined for any other line. */
function assignedKey(line: string): string[] | undefined {
  const match = /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.\s-])+?)\s*=/.exec(line);
  return match ? parseKeyPath(match[1]) : undefined;
}

/**
 * Where a TOML line leaves the parser: inside a multi-line string (and which
 * delimiter closes it), or inside an array or inline table that continues on
 * the next line. Only a line that starts outside both can be a table header
 * or a key.
 */
interface TomlScan {
  string?: '"""' | "'''";
  depth: number;
}

/** Closes a multi-line string at `index`, where `quote` repeats three times. */
function closeMultiline(line: string, index: number, quote: string): number {
  // Up to two more quotes right before the delimiter belong to the string.
  let end = index + 3;
  while (end < line.length && line[end] === quote && end - index < 5) end++;
  return end;
}

/** The scan state after `line`, given the state before it. */
function scanTomlLine(line: string, before: TomlScan): TomlScan {
  let open = before.string;
  let depth = before.depth;
  let i = 0;
  while (i < line.length) {
    if (open === '"""') {
      if (line[i] === '\\') i += 2;
      else if (line.startsWith('"""', i)) {
        i = closeMultiline(line, i, '"');
        open = undefined;
      } else i++;
      continue;
    }
    if (open === "'''") {
      if (line.startsWith("'''", i)) {
        i = closeMultiline(line, i, "'");
        open = undefined;
      } else i++;
      continue;
    }
    const ch = line[i];
    if (ch === '#') break;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      open = line.startsWith('"""', i) ? '"""' : "'''";
      i += 3;
    } else if (ch === '"') {
      for (i++; i < line.length && line[i] !== '"'; i++) if (line[i] === '\\') i++;
      i++;
    } else if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      i = close < 0 ? line.length : close + 1;
    } else {
      if (ch === '[' || ch === '{') depth++;
      else if ((ch === ']' || ch === '}') && depth > 0) depth--;
      i++;
    }
  }
  return { string: open, depth };
}

/** A line that holds nothing but whitespace or a comment. */
function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * `existing` (Codex's config.toml) with the gitglasses server set to
 * `launch`: an existing [mcp_servers.gitglasses] table and its sub-tables are
 * replaced where they stand, or the table is appended. Everything else is
 * kept byte for byte, including the comments that end the old table, which
 * usually introduce the next one. A definition in another form (a dotted key
 * or an inline table) cannot be replaced safely and raises
 * CodexConfigConflict.
 */
export function mergeCodexConfig(
  existing: string,
  launch: McpLaunch,
): { content: string; replaced: boolean } {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing === '' ? [] : existing.split(/\r?\n/);
  const block = codexServerToml(launch).replace(/\n$/, '').split('\n');

  const kept: string[] = [];
  let insertAt: number | undefined;
  let inServer = false;
  let table: string[] = [];
  let scan: TomlScan = { depth: 0 };
  // The server table's lines since its last header, and whether each one
  // starts outside any string, array or inline table.
  let dropped: { line: string; topLevel: boolean }[] = [];
  const keepTrailingComments = (): void => {
    let start = dropped.length;
    while (start > 0 && dropped[start - 1].topLevel && isCommentOrBlank(dropped[start - 1].line)) {
      start--;
    }
    kept.push(...dropped.slice(start).map((entry) => entry.line));
    dropped = [];
  };
  for (const line of lines) {
    const topLevel = scan.string === undefined && scan.depth === 0;
    scan = scanTomlLine(line, scan);
    if (topLevel) {
      const header = tableHeader(line);
      if (header) {
        table = header.keys;
        const server =
          !header.array &&
          header.keys.length >= 2 &&
          header.keys[0] === 'mcp_servers' &&
          header.keys[1] === MCP_SERVER_NAME;
        if (inServer && !server) keepTrailingComments();
        dropped = [];
        inServer = server;
        if (inServer && insertAt === undefined) insertAt = kept.length;
        if (inServer) continue;
      } else if (!inServer) {
        // A server defined through keys of another table.
        const key = assignedKey(line);
        const full = key && [...table, ...key];
        if (full && full[0] === 'mcp_servers' && full[1] === MCP_SERVER_NAME) {
          throw new CodexConfigConflict(
            `the ${MCP_SERVER_NAME} server is defined as "${line.trim()}"`,
          );
        }
      }
    }
    if (inServer) dropped.push({ line, topLevel });
    else kept.push(line);
  }
  if (inServer) keepTrailingComments();

  const replaced = insertAt !== undefined;
  let result: string[];
  if (insertAt !== undefined) {
    // Keep a blank line between the table and whatever follows it.
    const after = kept.slice(insertAt);
    const separator = after.length > 0 && after[0].trim() !== '' ? [''] : [];
    result = [...kept.slice(0, insertAt), ...block, ...separator, ...after];
  } else {
    while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
    result = kept.length > 0 ? [...kept, '', ...block] : [...block];
  }
  while (result.length > 0 && result[result.length - 1] === '') result.pop();
  return { content: `${result.join(eol)}${eol}`, replaced };
}

// --- confirmation diff ---------------------------------------------------------

/**
 * A unified diff of two small texts, with `context` unchanged lines around
 * each change, for showing what a write will do before it happens.
 */
export function unifiedDiff(before: string, after: string, label: string, context = 2): string {
  const a = before === '' ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  // Longest common subsequence table, from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: { kind: ' ' | '-' | '+'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      ops.push({ kind: '+', text: b[j++] });
    } else {
      ops.push({ kind: '-', text: a[i++] });
    }
  }
  const shown = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.kind === ' ') return;
    const last = Math.min(ops.length - 1, index + context);
    for (let k = Math.max(0, index - context); k <= last; k++) shown[k] = true;
  });
  const lines = [`--- ${label}`, `+++ ${label}`];
  let previous = -1;
  ops.forEach((op, index) => {
    if (!shown[index]) return;
    if (previous >= 0 && index > previous + 1) lines.push('...');
    lines.push(`${op.kind}${op.text}`);
    previous = index;
  });
  return lines.join('\n');
}
