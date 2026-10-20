import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { FIXTURE } from '../fixture';
import { activateExtension, poll, workspaceRoot } from './helpers';
import { mcpServiceState, startMcpServer, type McpSession } from './mcpClient';

// The MCP server the extension bundles and registers with the editor's agents:
// what the registration says to start, and that starting exactly that, with
// the editor's own binary as Node, serves the workspace repository.
describe('bundled MCP server', () => {
  // The definition provider API arrived in VS Code 1.101; older releases (the
  // engines floor is 1.90) have no registration, only the commands.
  const [major, minor] = vscode.version.split('.').map(Number);
  const hasProviderApi = major > 1 || minor >= 101;
  let session: McpSession | undefined;

  after(() => session?.close());

  it('is registered with the editor, allowed to run git in the trusted workspace', async () => {
    await activateExtension();
    const state = await poll(async () => {
      const current = await mcpServiceState();
      return current?.launch ? current : undefined;
    }, 'the MCP service never reported a launch');
    if (hasProviderApi) {
      assert.deepStrictEqual(state.status, {
        state: 'registered',
        host: 'vscode',
        gitRoots: [workspaceRoot().fsPath],
        folders: 1,
      });
    } else {
      assert.strictEqual(state.status.state, 'noHost');
    }
    const launch = state.launch!;
    assert.strictEqual(launch.command, process.execPath, "not the editor's own binary");
    assert.strictEqual(launch.env.ELECTRON_RUN_AS_NODE, '1');
    assert.match(launch.args[0], /dist[\\/]mcp[\\/]cli\.js$/);
    assert.strictEqual(launch.env.GITGLASSES_ALLOWED_ROOTS, workspaceRoot().fsPath);
    assert.ok(launch.env.GITGLASSES_ENGINE, 'no engine path');
  });

  it("starts with the editor's own Node and lists its tools", async () => {
    const { launch } = await mcpServiceState();
    session = await startMcpServer(launch!, workspaceRoot().fsPath);
    const listed = await session.request('tools/list', {});
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
    for (const name of ['git_blame', 'git_status', 'git_compare', 'git_log_search']) {
      assert.ok(tools.includes(name), `tools/list lacks ${name}: ${tools.join(', ')}`);
    }
  });

  it('reads the workspace repository through the extension engine, git included', async () => {
    assert.ok(session, 'the server did not start');
    const root = workspaceRoot().fsPath;
    // Earlier suites commit, stage and revert, so only the shape is fixed.
    const status = await session.callTool('git_status', { repoPath: root });
    assert.match(status, /^branch: \S+/, `git_status: ${status}`);

    const compare = await session.callTool('git_compare', {
      repoPath: root,
      base: 'HEAD~2',
      includeDiff: true,
    });
    assert.ok(compare.includes('HEAD is 2 commits ahead of HEAD~2 and 0 behind'), compare);
    assert.ok(compare.includes(`R  ${FIXTURE.renameSource} -> ${FIXTURE.renameTarget}`), compare);
    assert.ok(compare.includes('\ndiff:\n'), `the diff, which needs git, is missing: ${compare}`);

    // File history runs git, which the trusted workspace allows.
    const history = await session.callTool('git_file_history', {
      repoPath: root,
      file: FIXTURE.blameFile,
      limit: 5,
    });
    assert.ok(history.includes(FIXTURE.authorName), history);
  });
});
