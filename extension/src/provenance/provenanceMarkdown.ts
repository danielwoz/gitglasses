// The declared-provenance line of the blame hover, as markdown. Pure, so it
// is unit-testable. Every part of it comes from the repository (trailers,
// identities, notes) and is escaped; the session link is rendered for the
// user to open and never fetched.

import { escapeMarkdown, markdownLinkDestination } from '../system/markdown';
import type { ProvenanceSummary } from './provenanceLogic';

export function provenanceHoverLine(summary: ProvenanceSummary): string {
  const icon = summary.agent ? '$(sparkle)' : '$(person)';
  let line =
    `${icon} **${escapeMarkdown(summary.label)}** ` +
    `(declared via ${escapeMarkdown(summary.via)})`;
  if (summary.sessionUrl) {
    line +=
      ` · [session link](${markdownLinkDestination(summary.sessionUrl)} ` +
      `"The agent session, as the commit declares it")`;
  }
  return line;
}
