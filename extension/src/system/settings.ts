// Reads the tunable page sizes from settings. Both are read per request, so a
// changed setting applies to the next page without a reload.

import * as vscode from 'vscode';
import { GRAPH_PAGE_SIZE, PAGE_SIZE, clampPageSize } from '../views/viewLogic';

const VIEW_BOUNDS = { min: 10, max: 1000 };
const GRAPH_BOUNDS = { min: 50, max: 5000 };

/** Commits per page in the Commits and File History views. */
export function viewPageSize(): number {
  const configured = vscode.workspace.getConfiguration('gitglasses').get('views.pageSize');
  return clampPageSize(configured, PAGE_SIZE, VIEW_BOUNDS);
}

/** Rows per page in the commit graph and the visual file history. */
export function graphPageSize(): number {
  const configured = vscode.workspace.getConfiguration('gitglasses').get('graph.pageSize');
  return clampPageSize(configured, GRAPH_PAGE_SIZE, GRAPH_BOUNDS);
}
