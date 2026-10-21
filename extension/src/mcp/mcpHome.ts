// The Home view's MCP Server section: whether the editor's agents have the
// server, and the ways to give it to other agents.

import * as vscode from 'vscode';
import type { ViewNode } from '../views/viewBase';
import { mcpStatusSummary } from './mcpStatusText';
import type { McpStatus } from './mcpRegistration';

function action(label: string, icon: string, command: string, args?: unknown[]): ViewNode {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.contextValue = 'gitglassesHomeAction';
  item.command = { command, title: label, arguments: args };
  return { item };
}

function line(label: string, icon: string, tooltip?: string): ViewNode {
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.tooltip = tooltip;
  item.contextValue = 'gitglassesMessage';
  return { item };
}

/** The section, collapsed: its description carries the status at a glance. */
export function mcpHomeSection(status: McpStatus, gitRoots: readonly string[]): ViewNode[] {
  const summary = mcpStatusSummary(status, gitRoots);
  const children: ViewNode[] = [
    line(summary.detail, summary.icon, summary.tooltip),
    action('Add to Claude Code…', 'add', 'gitglasses.mcp.addToClaudeCode'),
    action('Add to Codex…', 'add', 'gitglasses.mcp.addToCodex'),
    action('Copy Config for Other Agents', 'copy', 'gitglasses.mcp.copyConfig'),
    action('MCP Settings…', 'settings-gear', 'workbench.action.openSettings', ['gitglasses.mcp']),
  ];
  const section = new vscode.TreeItem('MCP Server', vscode.TreeItemCollapsibleState.Collapsed);
  section.id = 'gitglasses.home.mcp';
  section.iconPath = new vscode.ThemeIcon('plug');
  section.description = summary.description;
  section.tooltip = summary.tooltip;
  section.contextValue = 'gitglassesHomeSection';
  return [{ item: section, children: () => children }];
}
