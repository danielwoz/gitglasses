#!/usr/bin/env node
// Entry point: stdio MCP server wired to lazily spawned gitglasses-engine
// processes. Repositories inside the directories passed with --allow (or
// GITGLASSES_ALLOWED_ROOTS) are served by a full engine; repositories that are
// served only because they sit inside the client's workspace roots or a
// directory passed with --read get an engine started with --restricted, which
// runs no git.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { createEngineClient, resolveEnginePath } from './engine.js';
import { createServer } from './server.js';

/**
 * How long requests already read when stdin ends may take to be answered
 * before the server exits without their answers.
 */
const ANSWER_GRACE_MS = 10_000;

// An editor's own Node runs this script with ELECTRON_RUN_AS_NODE set. The
// engine and the git it runs must not inherit it: an editor started from
// there (core.editor, a hook) would come up as plain Node instead.
delete process.env.ELECTRON_RUN_AS_NODE;

const { values } = parseArgs({
  options: {
    allow: { type: 'string', multiple: true },
    read: { type: 'string', multiple: true },
  },
});

const packageRoot = path.resolve(import.meta.dirname, '..');
const enginePath = resolveEnginePath({ packageRoot });
const onLog = (line: string): void => console.error(`[gitglasses-engine] ${line}`);

const client = createEngineClient({ enginePath, onLog });
const restrictedClient = createEngineClient({ enginePath, onLog, restricted: true });

const server = createServer({
  client,
  restrictedClient,
  allow: values.allow ?? [],
  read: values.read ?? [],
});

/** `error` as a single line, so each report is one line of the client's log. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s*\n\s*/g, ' ');
}

function dispose(): void {
  client.dispose();
  restrictedClient.dispose();
}

// Several of the triggers below can report the same disconnect (stdin's 'end'
// and 'close', the transport's close, a failed write to stdout); only the
// first one shuts down.
let exiting = false;
function shutdown(code: number): void {
  if (exiting) return;
  exiting = true;
  dispose();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => dispose());

/** Exits with 0 once everything already written to stdout has gone out. */
function exitAfterOutput(): void {
  process.stdout.write('', () => shutdown(0));
}

const transport = new StdioServerTransport();

// Requests read and neither answered nor cancelled yet. Protocol.connect keeps
// an onmessage set before it and calls it ahead of its own handling.
const unanswered = new Set<RequestId>();
let stdinEnded = false;
function answered(id: RequestId): void {
  unanswered.delete(id);
  if (stdinEnded && unanswered.size === 0) exitAfterOutput();
}
transport.onmessage = (message) => {
  if (isJSONRPCRequest(message)) {
    unanswered.add(message.id);
  } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
    // The server sends nothing for a request the client has cancelled.
    const id = message.params?.requestId;
    if (typeof id === 'string' || typeof id === 'number') answered(id);
  }
};
const send = transport.send.bind(transport);
transport.send = async (message) => {
  await send(message);
  if (
    (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
    message.id !== undefined
  ) {
    answered(message.id);
  }
};

// Errors on the connection, one line each. After a line that is not a
// JSON-RPC message the server goes on serving; once more than 10 MiB of input
// is waiting to be read as one message, the transport closes and reads no
// more of stdin.
server.server.onerror = (error) => console.error(`gitglasses-mcp: ${errorText(error)}`);

// A transport that has closed answers nothing, while the engines already
// started would keep the process running; exiting lets the client see the
// server stop. A close once stdin has ended is the client disconnecting.
server.server.onclose = () => {
  if (process.stdin.readableEnded) {
    shutdown(0);
    return;
  }
  console.error('gitglasses-mcp: connection closed after an error; exiting');
  shutdown(1);
};

// The end of stdin is how a client disconnects, and the transport does not
// watch for it. Requests already read still get their answers, for a client
// that writes its requests and closes stdin straight away; after
// ANSWER_GRACE_MS the server exits without the rest.
function endOfInput(): void {
  if (stdinEnded) return;
  stdinEnded = true;
  if (unanswered.size === 0) {
    exitAfterOutput();
    return;
  }
  setTimeout(() => {
    console.error(
      `gitglasses-mcp: stdin ended with ${unanswered.size} request(s) unanswered; exiting`,
    );
    shutdown(0);
  }, ANSWER_GRACE_MS);
}
process.stdin.on('end', endOfInput);
process.stdin.on('close', () => (process.stdin.errored ? shutdown(1) : endOfInput()));

// A client that has closed its end of stdout can no longer be answered; once
// stdin has ended, that is the client disconnecting.
process.stdout.on('error', (error) => {
  if (stdinEnded) {
    shutdown(0);
    return;
  }
  console.error(`gitglasses-mcp: ${errorText(error)}`);
  shutdown(1);
});

// Started without top-level await, so the same source also bundles as the
// CommonJS script the GitGlasses extension runs with the editor's own Node.
server.connect(transport).catch((error: unknown) => {
  console.error(`gitglasses-mcp: ${errorText(error)}`);
  shutdown(1);
});
