// Commands that give the MCP server to agents outside the editor's own
// registration: Claude Code, Codex, and anything configured with JSON. None
// of them writes anything before the user has confirmed exactly what.

import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConfigChangedError,
  addToClaudeCode,
  codexConfigPath,
  planCodexWrite,
  writeCodexConfig,
  type CodexPlan,
} from './mcpConfigWriters';
import {
  CodexConfigConflict,
  MCP_SERVER_NAME,
  codexServerToml,
  findOnPath,
  launchGitRoots,
  launchReadRoots,
  mcpServersJson,
  serverEntry,
  type McpLaunch,
} from './mcpLogic';
import type { McpRegistration } from './mcpRegistration';

const PREVIEW_SCHEME = 'gitglasses-mcp-preview';

/** Lines of a diff shown in a confirmation dialog; the diff editor has all. */
const DIALOG_DIFF_LINES = 40;

/** Read-only documents holding proposed file contents, for the diff editor. */
class PreviewDocuments implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  show(name: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: PREVIEW_SCHEME, path: `/${name}` });
    this.contents.set(uri.path, content);
    this.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** `file` with the home directory written as ~, as people read their config paths. */
function displayPath(file: string): string {
  const home = os.homedir();
  const relative = path.relative(home, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? `~${path.sep}${relative}`
    : file;
}

/** What the agent will run, for a confirmation dialog. */
function describeLaunch(launch: McpLaunch): string {
  const roots = launchGitRoots(launch);
  const read = launchReadRoots(launch);
  return [
    `Runs: ${launch.command}${launch.env.ELECTRON_RUN_AS_NODE ? ' (as Node)' : ''}`,
    `Script: ${launch.args[0]}`,
    `Engine: ${launch.env.GITGLASSES_ENGINE}`,
    roots.length > 0
      ? `Git runs in: ${roots.join(', ')}`
      : "Git runs nowhere: the agent's own project is read without running git.",
    ...(read.length > 0 ? [`Also read without git: ${read.join(', ')}`] : []),
  ].join('\n');
}

function shortened(diff: string): string {
  const lines = diff.split('\n');
  return lines.length <= DIALOG_DIFF_LINES
    ? diff
    : [
        ...lines.slice(0, DIALOG_DIFF_LINES),
        `… ${lines.length - DIALOG_DIFF_LINES} more lines in the diff editor`,
      ].join('\n');
}

async function openUntitled(content: string, language: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(document, { preview: true });
}

export interface McpCommandOptions {
  registration: McpRegistration;
  log: (line: string) => void;
}

export function registerMcpCommands(options: McpCommandOptions): vscode.Disposable[] {
  const { registration, log } = options;
  const previews = new PreviewDocuments();

  /**
   * Where the agent may run git: nowhere unless the user picks this
   * workspace's folders, which is offered only in a trusted workspace.
   * Without git, Claude Code and Codex read the project they work in, which
   * the server learns from them; `readFolders` also names this workspace's
   * folders for agents that share no folders with the server (desktop apps
   * start it from / or the home directory). Undefined when the user cancels.
   */
  const chooseRoots = async (
    readFolders: boolean,
  ): Promise<{ allow: string[]; read: string[] } | undefined> => {
    const roots = registration.gitRoots();
    const read = readFolders ? registration.folderRoots() : [];
    if (roots.length === 0) return { allow: [], read };
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: '$(lock) Read only, without running git',
          description: 'recommended',
          detail: readFolders
            ? "Blame, history, status, diffs and branch comparisons of this workspace's folders " +
              'and of any folders the agent shares'
            : "Blame, history, status, diffs and branch comparisons of the agent's project",
          roots: { allow: [], read },
        },
        {
          label: '$(unlock) Also run git in this workspace',
          description: roots.map((root) => path.basename(root)).join(', '),
          detail: 'Adds file history, patches and code search; serves only these folders',
          roots: { allow: roots, read: [] },
        },
      ],
      {
        title: 'GitGlasses MCP Server: where may the agent run git?',
        placeHolder: 'git runs repository hooks and filters: allow it only where you trust them',
        ignoreFocusOut: true,
      },
    );
    return picked?.roots;
  };

  const chooseLaunch = async (readFolders = false): Promise<McpLaunch | undefined> => {
    const roots = await chooseRoots(readFolders);
    if (roots === undefined) return undefined;
    const launch = await registration.launch(roots.allow, roots.read);
    if (!launch) {
      void vscode.window.showErrorMessage(
        'GitGlasses: the MCP server cannot be started here; see the GitGlasses output for why.',
      );
    }
    return launch;
  };

  const addToClaude = async (): Promise<void> => {
    const launch = await chooseLaunch();
    if (!launch) return;
    const entry = JSON.stringify({ type: 'stdio', ...serverEntry(launch) });
    const claude = findOnPath('claude', { env: process.env, platform: process.platform, isFile });
    if (!claude) {
      // Nothing is written; the user adds the JSON themselves.
      await openUntitled(`${JSON.stringify(JSON.parse(entry), null, 2)}\n`, 'json');
      const choice = await vscode.window.showInformationMessage(
        "GitGlasses: Claude Code's CLI (claude) is not on PATH. Add this server yourself: " +
          `run claude mcp add-json --scope user ${MCP_SERVER_NAME} '<this JSON>', or add it ` +
          'under "mcpServers" in ~/.claude.json.',
        'Copy JSON',
      );
      if (choice === 'Copy JSON') await vscode.env.clipboard.writeText(entry);
      return;
    }
    const confirmed = await vscode.window.showInformationMessage(
      'Add the GitGlasses MCP server to Claude Code?',
      {
        modal: true,
        detail:
          `This runs ${claude} mcp add-json --scope user ${MCP_SERVER_NAME} …, which makes ` +
          'it available in all your projects and replaces any gitglasses server already in ' +
          `your Claude Code user configuration.\n\n${describeLaunch(launch)}`,
      },
      'Add',
    );
    if (confirmed !== 'Add') return;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Adding GitGlasses to Claude Code…',
      },
      () => addToClaudeCode(claude, launch),
    );
    log(`MCP server: claude mcp add-json ${result.ok ? 'succeeded' : 'failed'}: ${result.output}`);
    if (result.ok) {
      void vscode.window.showInformationMessage(
        `GitGlasses: ${result.replaced ? 'updated in' : 'added to'} Claude Code for all your ` +
          'projects. New Claude Code sessions load it; /mcp in a session lists it.',
      );
      return;
    }
    const choice = await vscode.window.showErrorMessage(
      `GitGlasses: claude mcp add-json failed: ${result.output || 'no output'}`,
      'Show JSON',
    );
    if (choice === 'Show JSON')
      await openUntitled(`${JSON.stringify(JSON.parse(entry), null, 2)}\n`, 'json');
  };

  const addToCodex = async (): Promise<void> => {
    const launch = await chooseLaunch();
    if (!launch) return;
    const file = codexConfigPath(process.env, os.homedir());
    const shown = displayPath(file);
    let plan: CodexPlan;
    try {
      plan = planCodexWrite(file, launch, shown);
    } catch (error) {
      if (!(error instanceof CodexConfigConflict)) {
        void vscode.window.showErrorMessage(
          `GitGlasses: could not read ${shown}: ${String(error)}`,
        );
        return;
      }
      await openUntitled(codexServerToml(launch), 'toml');
      void vscode.window.showWarningMessage(
        `GitGlasses: ${shown} already defines the gitglasses server in a form this command ` +
          `does not rewrite (${error.message}). Replace it with the table shown by hand.`,
      );
      return;
    }
    if (plan.after === plan.before) {
      void vscode.window.showInformationMessage(
        `GitGlasses: ${shown} already has this MCP server.`,
      );
      return;
    }
    const before = plan.existed
      ? vscode.Uri.file(file)
      : previews.show('config.toml (none yet)', '');
    const after = previews.show('config.toml (with GitGlasses)', plan.after);
    await vscode.commands.executeCommand(
      'vscode.diff',
      before,
      after,
      `${shown} ↔ with GitGlasses`,
      {
        preview: true,
      },
    );
    const linked = plan.target !== file;
    const confirmed = await vscode.window.showWarningMessage(
      `Write the GitGlasses MCP server to ${shown}?`,
      {
        modal: true,
        detail:
          (linked
            ? `${shown} is a link; the change is written to ${displayPath(plan.target)}, ` +
              'and the link stays.\n'
            : '') +
          `${plan.replaced ? 'The existing gitglasses table is replaced' : 'A gitglasses table is added'}; ` +
          `nothing else in the file changes.\n\n${shortened(plan.diff)}`,
      },
      'Write',
    );
    if (confirmed !== 'Write') return;
    try {
      writeCodexConfig(plan);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A link into a read-only tree, as home-manager makes them.
      const readOnlyLink = linked && (code === 'EACCES' || code === 'EPERM' || code === 'EROFS');
      const message =
        error instanceof ConfigChangedError
          ? `${shown} changed while you were looking; run the command again.`
          : readOnlyLink
            ? `${shown} links to ${displayPath(plan.target)}, which cannot be written ` +
              '(a dotfile manager may own it). Add the table shown where you manage that file.'
            : `could not write ${shown}: ${String(error)}`;
      void vscode.window.showErrorMessage(`GitGlasses: ${message}`);
      if (readOnlyLink) await openUntitled(codexServerToml(launch), 'toml');
      return;
    }
    log(`MCP server: wrote ${plan.target}`);
    void vscode.window.showInformationMessage(
      `GitGlasses: added to Codex in ${shown}. New Codex sessions load it.`,
    );
  };

  const copyConfig = async (): Promise<void> => {
    const launch = await chooseLaunch(true);
    if (!launch) return;
    const json = mcpServersJson(launch);
    await vscode.env.clipboard.writeText(json);
    const choice = await vscode.window.showInformationMessage(
      'GitGlasses: MCP server config copied. Paste it into your agent\'s "mcpServers" ' +
        'settings (Claude Desktop, Windsurf, Kiro, Theia AI and others). Its paths change ' +
        'when GitGlasses updates; copy it again then.',
      'Show Config',
    );
    if (choice === 'Show Config') await openUntitled(json, 'json');
  };

  return [
    previews,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, previews),
    vscode.commands.registerCommand('gitglasses.mcp.addToClaudeCode', addToClaude),
    vscode.commands.registerCommand('gitglasses.mcp.addToCodex', addToCodex),
    vscode.commands.registerCommand('gitglasses.mcp.copyConfig', copyConfig),
  ];
}
