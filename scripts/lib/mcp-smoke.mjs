// Starts the gitglasses-mcp CLI the way an MCP client does (stdio,
// newline-delimited JSON-RPC) and checks the handshake and the tool list.

import { spawn } from 'node:child_process';

const TIMEOUT_MS = 20000;

/** Resolves with the server info and tool names; rejects on any failure. */
export function smokeTestMcpServer(cliPath, { version, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const pending = new Map();
    let buffered = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${TIMEOUT_MS} ms; stderr: ${stderr}`)), TIMEOUT_MS);
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
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const listed = await request(2, 'tools/list', {});
      if (listed.error) throw new Error(`tools/list failed: ${JSON.stringify(listed.error)}`);
      const tools = listed.result.tools.map((tool) => tool.name);
      if (tools.length === 0) throw new Error('the server lists no tools');
      finish(undefined, { serverInfo, tools });
    })().catch((error) => finish(error));
  });
}
