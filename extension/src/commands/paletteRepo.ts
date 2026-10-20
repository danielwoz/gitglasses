// Which repository the Git Commands palette acts on (no vscode imports).
//
// The GitGlasses views follow one selected repository; the file in the
// editor belongs to its own. When the two differ the palette does not pick
// silently: it asks, offering the editor's repository first.

export type PaletteRepoChoice<R> =
  { kind: 'use'; repo: R } | { kind: 'ask'; editor: R; selected: R } | { kind: 'none' };

/** `same` tells whether two candidates are one repository (by repo id: two
 *  spellings of a root are the same repository). */
export function choosePaletteRepo<R>(
  selected: R | undefined,
  editor: R | undefined,
  same: (a: R, b: R) => boolean,
): PaletteRepoChoice<R> {
  if (editor && selected && !same(editor, selected)) {
    return { kind: 'ask', editor, selected };
  }
  const repo = editor ?? selected;
  return repo ? { kind: 'use', repo } : { kind: 'none' };
}

/** The palette's title, which always names the repository it acts on. */
export function paletteTitle(repoName: string): string {
  return `Git Commands — ${repoName}`;
}
