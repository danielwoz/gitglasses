// Writes the MCP server into other agents' configuration: Codex's
// config.toml directly, Claude Code's through its own CLI. No vscode import;
// the commands confirm with the user before calling any of this.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  claudeAddJsonArgs,
  claudeRemoveArgs,
  isAlreadyExistsOutput,
  mergeCodexConfig,
  unifiedDiff,
  type McpLaunch,
} from './mcpLogic';

/** Codex's configuration file: $CODEX_HOME/config.toml, by default ~/.codex. */
export function codexConfigPath(env: Record<string, string | undefined>, home: string): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(codexHome ? codexHome : path.join(home, '.codex'), 'config.toml');
}

/** What writing the server into Codex's configuration would change. */
export interface CodexPlan {
  file: string;
  /** The file as read, '' when it does not exist. */
  before: string;
  existed: boolean;
  after: string;
  /** An earlier gitglasses table is replaced rather than a new one added. */
  replaced: boolean;
  diff: string;
}

/** Reads the file and plans the change; throws CodexConfigConflict. */
export function planCodexWrite(file: string, launch: McpLaunch, label = file): CodexPlan {
  let before = '';
  let existed = false;
  try {
    before = fs.readFileSync(file, 'utf8');
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { content, replaced } = mergeCodexConfig(before, launch);
  return {
    file,
    before,
    existed,
    after: content,
    replaced,
    diff: unifiedDiff(before, content, label),
  };
}

/** The file changed after the plan was made, so the plan no longer applies. */
export class ConfigChangedError extends Error {}

/**
 * Applies a plan the user confirmed: the file must still read as planned,
 * and it is replaced in one rename so Codex never reads half of it. A new
 * file is private to the user, as it may come to hold tokens.
 */
export function writeCodexConfig(plan: CodexPlan): void {
  let current = '';
  try {
    current = fs.readFileSync(plan.file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (plan.existed) throw new ConfigChangedError(`${plan.file} was removed`);
  }
  if (current !== plan.before) throw new ConfigChangedError(`${plan.file} changed meanwhile`);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  const mode = plan.existed ? fs.statSync(plan.file).mode & 0o777 : 0o600;
  const temporary = `${plan.file}.gitglasses-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, plan.after, { mode });
    fs.renameSync(temporary, plan.file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** A command's combined output and whether it exited successfully. */
export interface RunResult {
  ok: boolean;
  output: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

/** Runs a program without a shell, so no argument is ever interpreted. */
export const runProgram: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 60_000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        resolve({ ok: !error, output: output || (error ? String(error.message) : '') });
      },
    );
  });

/**
 * Adds the server to Claude Code's user configuration with
 * `claude mcp add-json`, replacing a gitglasses server already there.
 */
export async function addToClaudeCode(
  claude: string,
  launch: McpLaunch,
  run: Runner = runProgram,
): Promise<RunResult & { replaced: boolean }> {
  const first = await run(claude, claudeAddJsonArgs(launch));
  if (first.ok || !isAlreadyExistsOutput(first.output)) return { ...first, replaced: false };
  const removed = await run(claude, claudeRemoveArgs());
  if (!removed.ok) return { ...removed, replaced: false };
  return { ...(await run(claude, claudeAddJsonArgs(launch))), replaced: true };
}
