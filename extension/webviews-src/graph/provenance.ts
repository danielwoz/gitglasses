// The graph's declared provenance: the marks the host sends for loaded
// commits, and the toolbar filter that dims the commits it leaves out. Rows
// keep their place in the graph, so its lanes stay intact.

import type { GraphRow, ProvenanceMark } from './ipc';
import {
  PROVENANCE_FILTERS,
  type ProvenanceFilter,
  isProvenanceFilter,
} from '../../src/provenance/provenanceLogic';

export class GraphProvenance {
  /** Provenance is shown (gitglasses.provenance.enabled). */
  enabled = false;
  filter: ProvenanceFilter = 'all';
  readonly marks = new Map<string, ProvenanceMark>();

  constructor(
    private readonly select: HTMLSelectElement,
    onFilterChange: () => void,
  ) {
    for (const option of PROVENANCE_FILTERS) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.append(element);
    }
    select.hidden = true;
    select.addEventListener('change', () => {
      this.setFilter(select.value);
      onFilterChange();
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.select.hidden = !enabled;
    if (!enabled) this.marks.clear();
  }

  setFilter(value: unknown): void {
    this.filter = isProvenanceFilter(value) ? value : 'all';
    this.select.value = this.filter;
  }

  /** Takes the marks of a batch of commits; null drops a commit's mark. */
  merge(marks: Record<string, ProvenanceMark | null>): void {
    if (!this.enabled) return;
    for (const [sha, mark] of Object.entries(marks)) {
      if (mark) this.marks.set(sha, mark);
      else this.marks.delete(sha);
    }
  }

  /** What the renderer needs, or undefined while provenance is off. */
  renderState():
    { marks: ReadonlyMap<string, ProvenanceMark>; filter: ProvenanceFilter } | undefined {
    return this.enabled ? { marks: this.marks, filter: this.filter } : undefined;
  }

  /** The row's declared provenance in words, for its tooltip and screen
   *  readers. */
  describe(row: GraphRow): string | undefined {
    return this.enabled ? this.marks.get(row.sha)?.text : undefined;
  }
}
