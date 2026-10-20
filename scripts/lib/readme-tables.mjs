// Renders the extension README's generated sections from the manifest: one
// row per setting, and the palette commands grouped by feature area. The
// sections sit between `<!-- name:start -->` and `<!-- name:end -->` markers.

/** Feature areas for the commands table, matched by command id in order. */
export const COMMAND_AREAS = [
  ['Blame and annotations', /^gitglasses\.(toggle|clearAnnotations|switchMode|blame)/],
  [
    'History and the Commit Graph',
    /^gitglasses\.(show(Graph|FileHistory|LineHistory|CommitDetails)|diffWith|openFileAtRevision|openCommitDiff$|graph\.|timeline\.)/,
  ],
  ['Search', /^gitglasses\.search/],
  [
    'Branches, changes and worktrees',
    /^gitglasses\.(gitCommands|interactiveRebase|rebase\.|stage|unstage|home\.|worktrees?\.|branch|tag|stash|remote\.|commit\.)/,
  ],
  [
    'Pull requests, issues and remotes',
    /^gitglasses\.(openOnRemote|copyRemoteUrl|openCommitOnRemote|[a-z]*Integration|startWork|launchpad\.|suggestChange)/,
  ],
  ['Patches', /^gitglasses\.(createPatch|applyPatch|patch)/],
  ['AI', /^gitglasses\.ai\./],
  ['Workspace and setup', /^gitglasses\./],
];

function escapeCell(text) {
  return String(text)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

/** Markdown setting references (`#gitglasses.x#`) as code. */
function settingRefs(text) {
  return text.replace(/`?#([\w.]+)#`?/g, '`$1`');
}

function defaultCell(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value === '' ? '`""`' : `\`"${value}"\``;
  return `\`${JSON.stringify(value)}\``;
}

export function settingsTable(manifest) {
  const properties = manifest.contributes?.configuration?.properties ?? {};
  const rows = ['| Setting | Default | Description |', '| --- | --- | --- |'];
  for (const [key, spec] of Object.entries(properties)) {
    let description = settingRefs(spec.markdownDescription ?? spec.description ?? '');
    const deprecation = spec.markdownDeprecationMessage ?? spec.deprecationMessage;
    if (deprecation) description = `**Deprecated.** ${settingRefs(deprecation)} ${description}`;
    if (Array.isArray(spec.enum) && spec.enum.length > 0) {
      const sentence = /[.!?)]$/.test(description.trim())
        ? description.trim()
        : `${description.trim()}.`;
      description = `${sentence} One of ${spec.enum.map((value) => `\`${value}\``).join(', ')}.`;
    }
    rows.push(`| \`${key}\` | ${defaultCell(spec.default)} | ${escapeCell(description)} |`);
  }
  return rows.join('\n');
}

/** Commands the palette shows (not hidden with `when: false`), by area. */
export function commandsTable(manifest) {
  const hidden = new Set(
    (manifest.contributes?.menus?.commandPalette ?? [])
      .filter((entry) => entry.when === 'false')
      .map((entry) => entry.command),
  );
  const byArea = new Map(COMMAND_AREAS.map(([area]) => [area, []]));
  for (const command of manifest.contributes?.commands ?? []) {
    if (hidden.has(command.command)) continue;
    const area = COMMAND_AREAS.find(([, pattern]) => pattern.test(command.command))?.[0];
    if (!area) continue;
    const title = command.category ? `${command.category}: ${command.title}` : command.title;
    const notes = [];
    if (/isWorkspaceTrusted/.test(command.enablement ?? '')) notes.push('trusted workspace');
    byArea
      .get(area)
      .push(`| ${escapeCell(title)} | \`${command.command}\` | ${notes.join(', ')} |`);
  }
  const sections = [];
  for (const [area, rows] of byArea) {
    if (rows.length === 0) continue;
    sections.push(
      [`#### ${area}`, '', '| Command | Id | Needs |', '| --- | --- | --- |', ...rows].join('\n'),
    );
  }
  return sections.join('\n\n');
}

function replaceSection(readme, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from < 0 || to < from) throw new Error(`README has no ${start} … ${end} section`);
  return `${readme.slice(0, from + start.length)}\n${body}\n${readme.slice(to)}`;
}

/** The README with its generated sections rewritten from the manifest. */
export function renderReadmeTables(readme, manifest) {
  let out = replaceSection(readme, 'settings', settingsTable(manifest));
  out = replaceSection(out, 'commands', commandsTable(manifest));
  return out;
}
