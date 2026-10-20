// A minimal MCP client for the e2e suites: starts the bundled server exactly
// as the editor registration says to (command, arguments and environment),
// then speaks newline-delimited JSON-RPC over its stdio.

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpServiceState {
  status: { state: string; host?: string; gitRoots?: string[] };
  launch?: McpLaunch;
}

export function mcpServiceState(): Thenable<McpServiceState> {
  return vscode.commands.executeCommand<McpServiceState>('_gitglasses.mcp.status');
}

/** A JSON-RPC response, with the result fields the suites read. */
export interface McpResponse {
  id?: number;
  error?: unknown;
  result?: {
    tools?: { name: string }[];
    content?: { text?: string }[];
    isError?: boolean;
  };
}

export interface McpSession {
  request(method: string, params: unknown): Promise<McpResponse>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  stderr(): string;
  close(): void;
}

const TIMEOUT_MS = 30_000;

/** Starts the server in `cwd` and completes the MCP handshake. */
export async function startMcpServer(launch: McpLaunch, cwd: string): Promise<McpSession> {
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, (message: McpResponse) => void>();
  let buffered = '';
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as McpResponse;
      if (message.id === undefined) continue;
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const exited = new Promise<never>((_, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`MCP server exited with ${code}: ${stderr}`)));
  });
  // Observed by every request; an exit after close() is expected.
  exited.catch(() => undefined);

  const request = (method: string, params: unknown): Promise<McpResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: no answer in ${TIMEOUT_MS} ms; stderr: ${stderr}`));
      }, TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      exited.catch((error: unknown) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gitglasses-e2e', version: '0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    request,
    async callTool(name, args) {
      const response = await request('tools/call', { name, arguments: args });
      if (response.error) throw new Error(`${name} failed: ${JSON.stringify(response.error)}`);
      const text = (response.result?.content ?? []).map((part) => part.text ?? '').join('\n');
      if (response.result?.isError) throw new Error(`${name} returned an error: ${text}`);
      return text;
    },
    stderr: () => stderr,
    close: () => {
      child.stdin.end();
      child.kill();
    },
  };
}
