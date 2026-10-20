import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  editorAssociationsFor,
  parseTodo,
  rebaseEditorEnabled,
  serializeTodo,
} from '../src/webviews/rebaseTodoLogic';

const TODO = [
  'pick 1111111 first subject',
  'update-ref refs/heads/stack-a',
  '',
  'p 2222222 second subject',
  'fixup 3333333 fixup! first subject',
  '',
  '# Rebase 0000000..3333333 onto 0000000 (4 commands)',
  '#',
  '# Commands:',
  '# p, pick <commit> = use commit',
  '',
].join('\n');

describe('parseTodo', () => {
  it('reads commits, abbreviated commands, update-refs and the range', () => {
    const parsed = parseTodo(TODO);
    expect(parsed.commits).toEqual([
      { action: 'pick', sha: '1111111', summary: 'first subject', refs: ['refs/heads/stack-a'] },
      { action: 'pick', sha: '2222222', summary: 'second subject', refs: [] },
      { action: 'fixup', sha: '3333333', summary: 'fixup! first subject', refs: [] },
    ]);
    expect(parsed.range).toBe('0000000..3333333 onto 0000000');
    expect(parsed.unsupported).toEqual([]);
  });

  it('collects steps the editor cannot show', () => {
    const parsed = parseTodo('pick 1111111 a\nexec make test\nbreak\nfixup -C 2222222 b\n');
    expect(parsed.commits.map((commit) => commit.sha)).toEqual(['1111111']);
    expect(parsed.unsupported).toEqual(['exec make test', 'break', 'fixup -C 2222222 b']);
  });

  it('ignores noop and comment lines in any comment character', () => {
    const parsed = parseTodo('noop\n; Rebase a..b onto c\n');
    expect(parsed.commits).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.range).toBe('a..b onto c');
  });
});

describe('serializeTodo', () => {
  const parsed = parseTodo(TODO);

  it('writes the plan in order, keeping each update-ref after its commit', () => {
    expect(
      serializeTodo(
        [
          { sha: '2222222', action: 'reword' },
          { sha: '1111111', action: 'pick' },
          { sha: '3333333', action: 'fixup' },
        ],
        parsed,
      ),
    ).toBe(
      'reword 2222222 second subject\n' +
        'pick 1111111 first subject\n' +
        'fixup 3333333 fixup! first subject\n' +
        'update-ref refs/heads/stack-a\n',
    );
  });

  it('writes drops last and moves their refs to the commit before', () => {
    expect(
      serializeTodo(
        [
          { sha: '1111111', action: 'drop' },
          { sha: '2222222', action: 'pick' },
          { sha: '3333333', action: 'pick' },
        ],
        parsed,
      ),
    ).toBe(
      'update-ref refs/heads/stack-a\n' +
        'pick 2222222 second subject\n' +
        'pick 3333333 fixup! first subject\n' +
        'drop 1111111 first subject\n',
    );
  });
});

describe('editorAssociationsFor', () => {
  const VIEW = 'gitglasses.rebaseTodo';

  it('adds the todo association when the editor is turned on', () => {
    expect(editorAssociationsFor({ '*.md': 'vscode.markdown.preview.editor' }, true, VIEW)).toEqual(
      {
        '*.md': 'vscode.markdown.preview.editor',
        'git-rebase-todo': VIEW,
      },
    );
    expect(editorAssociationsFor(undefined, true, VIEW)).toEqual({ 'git-rebase-todo': VIEW });
  });

  it('removes only its own association when turned off', () => {
    expect(editorAssociationsFor({ 'git-rebase-todo': VIEW, x: 'y' }, false, VIEW)).toEqual({
      x: 'y',
    });
    expect(editorAssociationsFor({ 'git-rebase-todo': 'other.editor' }, false, VIEW)).toBe(
      undefined,
    );
  });

  it('changes nothing that is already right', () => {
    expect(editorAssociationsFor({ 'git-rebase-todo': VIEW }, true, VIEW)).toBe(undefined);
    expect(editorAssociationsFor(undefined, false, VIEW)).toBe(undefined);
  });
});

describe('rebaseEditorEnabled', () => {
  it('follows the user setting and never a workspace value', () => {
    expect(rebaseEditorEnabled({ globalValue: true })).toBe(true);
    expect(rebaseEditorEnabled({ globalValue: false })).toBe(false);
    expect(rebaseEditorEnabled(undefined)).toBe(false);
    const fromRepository = { workspaceValue: true, workspaceFolderValue: true };
    expect(rebaseEditorEnabled(fromRepository)).toBe(false);
  });

  it('is declared as a user-level setting that Restricted Mode ignores in workspaces', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
    ) as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
      contributes: { configuration: { properties: Record<string, { scope?: string }> } };
    };
    const setting =
      manifest.contributes.configuration.properties['gitglasses.rebaseEditor.enabled'];
    expect(setting.scope).toBe('application');
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(
      'gitglasses.rebaseEditor.enabled',
    );
  });
});
