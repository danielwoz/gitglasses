// What an agent sees before it calls anything: the tool list, each tool's
// schema and its annotations. Driven through a real MCP Client over an
// in-memory transport, so it exercises registration rather than the handlers.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';

type Tool = {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string }>; required?: string[] };
  annotations?: Record<string, unknown>;
};

let tools: Map<string, Tool>;

beforeAll(async () => {
  const server = createServer({ client: {} as never, env: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  tools = new Map((listed.tools as Tool[]).map((tool) => [tool.name, tool]));
});

describe('tool registration', () => {
  it('exposes a tool for uncommitted changes and one for refs', () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining(['git_diff', 'git_refs', 'git_commit_show']),
    );
  });

  it('carries annotations on every tool, and marks only apply_patch as writing', () => {
    for (const tool of tools.values()) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
    expect(tools.get('apply_patch')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    for (const name of ['git_diff', 'git_refs', 'git_status', 'git_blame']) {
      expect(tools.get(name)?.annotations, name).toMatchObject({ readOnlyHint: true });
    }
  });

  // The provider is GitHub and the host is operator-configured, so there is
  // nothing for a caller to choose.
  it('list_my_prs takes no arguments', () => {
    const schema = tools.get('list_my_prs')!.inputSchema;
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  it('says where repoPath may point', () => {
    for (const tool of tools.values()) {
      const repoPath = tool.inputSchema.properties?.repoPath;
      if (repoPath) expect(repoPath.description, tool.name).toContain('GITGLASSES_ALLOWED_ROOTS');
    }
  });

  it('says how commit message matching behaves', () => {
    const search = tools.get('git_log_search')!;
    expect(search.inputSchema.properties?.text?.description).toContain('Case-insensitive');
    expect(search.description).toContain('AND');
  });

  it('says that git_commit_show accepts any revision, not only a sha', () => {
    const description = tools.get('git_commit_show')!.inputSchema.properties?.sha?.description;
    expect(description).toContain('HEAD~3');
    expect(description).toContain('branch or tag');
  });

  it('offers a cursor wherever the engine returns one', () => {
    for (const name of ['git_log_search', 'git_file_history', 'git_graph_summary']) {
      expect(tools.get(name)?.inputSchema.properties?.cursor, name).toBeDefined();
    }
  });
});
