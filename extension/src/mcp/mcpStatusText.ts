// How the Home view words the MCP server's status. Pure, so the wording for
// every state is unit-tested.

import type { McpStatus } from './mcpRegistration';

export interface McpStatusSummary {
  /** Beside the section title. */
  description: string;
  /** The first line inside the section. */
  detail: string;
  /** Codicon for that line. */
  icon: string;
  tooltip: string;
}

const WHAT =
  "GitGlasses' MCP server gives AI agents the blame, history, branch comparisons, status " +
  "and diffs of this workspace's repositories, read by the GitGlasses engine.";

function gitLine(gitRoots: readonly string[]): string {
  return gitRoots.length > 0
    ? `Git runs in: ${gitRoots.join(', ')}`
    : 'Git runs nowhere: repositories are read without running git, so nothing a repository configures can run.';
}

export function mcpStatusSummary(status: McpStatus, gitRoots: readonly string[]): McpStatusSummary {
  switch (status.state) {
    case 'registered': {
      const agents = status.host === 'cursor' ? "Cursor's agent" : 'agents in VS Code';
      // VS Code starts no MCP server in Restricted Mode; it asks for trust first.
      if (status.host === 'vscode' && !status.trusted) {
        return {
          description: 'available to VS Code agents',
          detail: 'VS Code starts it once you trust this folder',
          icon: 'workspace-untrusted',
          tooltip: `${WHAT}\n\nRegistered with ${agents}. VS Code starts MCP servers only in a trusted folder, and asks for trust when an agent needs it; git then runs in the workspace's folders.`,
        };
      }
      return {
        description:
          status.host === 'cursor' ? "available to Cursor's agent" : 'available to VS Code agents',
        detail:
          gitRoots.length > 0
            ? `Ready for ${agents}, with git in this workspace`
            : `Ready for ${agents}, read-only without git`,
        icon: 'pass',
        tooltip: `${WHAT}\n\nRegistered with ${agents}; no setup needed.\n${gitLine(gitRoots)}`,
      };
    }
    case 'off':
      return {
        description: 'off',
        detail: 'Turned off by gitglasses.mcp.enabled',
        icon: 'circle-slash',
        tooltip: `${WHAT}\n\nThe editor registration is turned off; agents configured with the commands below still have it.`,
      };
    case 'noFolder':
      return {
        description: 'open a folder',
        detail: 'Open a folder to give agents its history',
        icon: 'info',
        tooltip: `${WHAT}\n\nIt is registered once the window has a folder open.`,
      };
    case 'noHost':
      return {
        description: 'add it to your agent',
        detail: 'This editor has no MCP registration; add it below',
        icon: 'info',
        tooltip: `${WHAT}\n\nThis editor cannot register MCP servers for its agents (VS Code 1.101 or newer and Cursor can). Add it to an agent's own configuration below.`,
      };
    case 'unavailable':
      return {
        description: 'unavailable',
        detail: `Not available: ${status.reason}`,
        icon: 'warning',
        tooltip: `${WHAT}\n\nIt cannot start: ${status.reason}. See the GitGlasses output for details.`,
      };
  }
}
