// Release sections of extension/CHANGELOG.md. The version checks, the VSIX
// inspection and the GitHub release notes all read the changelog through
// this one parser, so a section the checks accept is exactly the section the
// release notes are taken from.

/**
 * The body of `version`'s section, from its heading to the next `## `
 * heading, without surrounding blank lines; undefined when there is no
 * heading for it. A heading is `## [x.y.z]`, `## x.y.z` or either with a `v`
 * prefix, optionally followed by a date.
 */
export function changelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^##\\s+(?:\\[v?${escaped}\\]|v?${escaped})(?:\\s|$)`);
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return undefined;
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  return lines
    .slice(start + 1, next < 0 ? lines.length : next)
    .join('\n')
    .trim();
}

/** True when the changelog has a non-empty section for `version`. */
export function hasChangelogEntry(changelog, version) {
  return Boolean(changelogSection(changelog, version));
}
