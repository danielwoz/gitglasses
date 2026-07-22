#!/usr/bin/env node
// Entry point: stdio MCP server wired to a lazily spawned gitglasses-engine.

import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EngineClient, resolveEnginePath } from './engine.js';
import { createServer } from './server.js';

const packageRoot = path.resolve(import.meta.dirname, '..');
const enginePath = resolveEnginePath({ packageRoot });

const client = new EngineClient({
  enginePath,
  onLog: (line) => console.error(`[gitglasses-engine] ${line}`),
});

const server = createServer({ client });

function shutdown(code: number): void {
  client.dispose();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => client.dispose());

const transport = new StdioServerTransport();
await server.connect(transport);
