#!/usr/bin/env node
// Entry point: stdio MCP server wired to lazily spawned gitglasses-engine
// processes. Repositories inside the directories passed with --allow (or
// GITGLASSES_ALLOWED_ROOTS) are served by a full engine; repositories that are
// served only because they sit inside the client's workspace roots get an
// engine started with --restricted, which runs no git.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEngineClient, resolveEnginePath } from './engine.js';
import { createServer } from './server.js';

// An editor's own Node runs this script with ELECTRON_RUN_AS_NODE set. The
// engine and the git it runs must not inherit it: an editor started from
// there (core.editor, a hook) would come up as plain Node instead.
delete process.env.ELECTRON_RUN_AS_NODE;

const { values } = parseArgs({
  options: { allow: { type: 'string', multiple: true } },
});

const packageRoot = path.resolve(import.meta.dirname, '..');
const enginePath = resolveEnginePath({ packageRoot });
const onLog = (line: string): void => console.error(`[gitglasses-engine] ${line}`);

const client = createEngineClient({ enginePath, onLog });
const restrictedClient = createEngineClient({ enginePath, onLog, restricted: true });

const server = createServer({ client, restrictedClient, allow: values.allow ?? [] });

function dispose(): void {
  client.dispose();
  restrictedClient.dispose();
}

function shutdown(code: number): void {
  dispose();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => dispose());

// Started without top-level await, so the same source also bundles as the
// CommonJS script the GitGlasses extension runs with the editor's own Node.
server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error(`gitglasses-mcp: ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
