// Starts the gitglasses-mcp CLI the way an MCP client does (stdio,
// newline-delimited JSON-RPC) and checks the handshake and the tool list,
// optionally followed by one tool call.

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 20000;
/** How long the server gets to exit once its input ends, before it is killed. */
const EXIT_TIMEOUT_MS = 5000;

/**
 * Resolves with the server info, the tool names and, when `call` names a tool
 * ({ name, arguments }), the text it returned; rejects on any failure,
 * including a tool result marked as an error. `command` and `args` start the
 * server in place of `node <cliPath>`, as an editor's own Node would.
 * Settles once the server has exited; the engine it started may still be
 * shutting down, so a caller removing the engine should retry.
 */
export function smokeTestMcpServer(
  cliPath,
  { version, env = {}, cwd, call, command = process.execPath, args = [] } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, cliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      cwd,
    });
    const pending = new Map();
    let buffered = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Once its input ends the server exits on its own and stops its engine.
      // One that fails, or has not exited within EXIT_TIMEOUT_MS, is killed.
      const killTimer = setTimeout(() => child.kill(), error ? 0 : EXIT_TIMEOUT_MS);
      const giveUpTimer = setTimeout(settle, 2 * EXIT_TIMEOUT_MS);
      function settle() {
        clearTimeout(killTimer);
        clearTimeout(giveUpTimer);
        if (error) reject(error);
        else resolve(value);
      }
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
        settle();
      } else {
        child.once('close', settle);
      }
      child.stdin.end();
    };
    const timer = setTimeout(
      () => finish(new Error(`no answer within ${TIMEOUT_MS} ms; stderr: ${stderr}`)),
      TIMEOUT_MS,
    );
    const request = (id, method, params) =>
      new Promise((answer) => {
        pending.set(id, answer);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(new Error(`server exited with ${code}; stderr: ${stderr}`)));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        pending.get(message.id)?.(message);
      }
    });

    (async () => {
      const init = await request(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'gitglasses-release-smoke', version: '0' },
      });
      if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
      const { serverInfo } = init.result;
      if (serverInfo?.name !== 'gitglasses') throw new Error(`server name is ${serverInfo?.name}`);
      if (version !== undefined && serverInfo.version !== version) {
        throw new Error(`server reports version ${serverInfo.version}, expected ${version}`);
      }
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      const listed = await request(2, 'tools/list', {});
      if (listed.error) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
      const tools = listed.result.tools.map((tool) => tool.name);
      if (tools.length === 0) throw new Error('the server lists no tools');
      let text;
      if (call) {
        const called = await request(3, 'tools/call', call);
        if (called.error) throw new Error(`${call.name} failed: ${JSON.stringify(called.error)}`);
        text = called.result.content.map((part) => part.text ?? '').join('\n');
        if (called.result.isError) throw new Error(`${call.name} returned an error: ${text}`);
      }
      finish(undefined, { serverInfo, tools, text });
    })().catch((error) => finish(error));
  });
}
