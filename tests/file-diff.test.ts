import { createPatch } from 'diff';
import { describe, expect, it } from 'vitest';
import { buildDiffRows, type DiffRow } from '../src/ui/file-diff.js';

function compare(before: string, after: string, context = 4) {
  return buildDiffRows(createPatch('example.txt', before, after, undefined, undefined, { context }));
}

function lines(rows: DiffRow[]) {
  return rows.filter((row): row is Extract<DiffRow, { kind: 'line' }> => row.kind === 'line');
}

describe('side-by-side file diff rows', () => {
  it('leaves an empty left cell for insertions and preserves the following line numbers', () => {
    const result = compare('first\nsecond\nthird\n', 'first\ninserted\nsecond\nthird\n');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(lines(result.rows)).toEqual([
      {
        kind: 'line',
        before: { number: 1, text: 'first', kind: 'context' },
        after: { number: 1, text: 'first', kind: 'context' },
      },
      { kind: 'line', before: undefined, after: { number: 2, text: 'inserted', kind: 'added' } },
      {
        kind: 'line',
        before: { number: 2, text: 'second', kind: 'context' },
        after: { number: 3, text: 'second', kind: 'context' },
      },
      {
        kind: 'line',
        before: { number: 3, text: 'third', kind: 'context' },
        after: { number: 4, text: 'third', kind: 'context' },
      },
    ]);
  });

  it.each([
    ['first\nold one\nold two\nlast\n', 'first\nnew\nlast\n', 2, 1],
    ['first\nold\nlast\n', 'first\nnew one\nnew two\nlast\n', 1, 2],
  ])('aligns replacement blocks of unequal lengths', (before, after, removed, added) => {
    const result = compare(before, after);
    const rendered = lines(result.rows);
    expect(result.removed).toBe(removed);
    expect(result.added).toBe(added);
    expect(rendered).toHaveLength(4);
    expect(rendered[1].before).toMatchObject({ number: 2, kind: 'removed' });
    expect(rendered[1].after).toMatchObject({ number: 2, kind: 'added' });
    expect(rendered[2][removed > added ? 'after' : 'before']).toBeUndefined();
    expect(rendered[3].before).toMatchObject({ number: removed + 2, text: 'last', kind: 'context' });
    expect(rendered[3].after).toMatchObject({ number: added + 2, text: 'last', kind: 'context' });
  });

  it('keeps distant changes in separate hunks with absolute line numbers', () => {
    const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after.splice(1, 0, 'inserted near start');
    after[26] = 'changed near end';
    const result = compare(`${before.join('\n')}\n`, `${after.join('\n')}\n`);
    const hunks = result.rows.filter((row) => row.kind === 'hunk');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(hunks[1]).toMatchObject({ oldStart: 22, newStart: 23 });
    expect(hunks[1].header).toBe('@@ -22,9 +23,9 @@');
    const changed = lines(result.rows).find((row) => row.after?.text === 'changed near end');
    expect(changed?.before).toEqual({ number: 26, text: 'line 26', kind: 'removed' });
    expect(changed?.after).toEqual({ number: 27, text: 'changed near end', kind: 'added' });
    expect(result).toMatchObject({ added: 2, removed: 1 });
  });

  it('represents new and deleted files without inventing lines on the absent side', () => {
    const added = compare('', 'one\ntwo\n');
    expect(added.rows[0]).toMatchObject({ header: '@@ -0,0 +1,2 @@' });
    expect(added).toMatchObject({ added: 2, removed: 0 });
    expect(lines(added.rows).every((row) => !row.before)).toBe(true);
    expect(lines(added.rows).map((row) => row.after?.number)).toEqual([1, 2]);

    const deleted = compare('one\ntwo\n', '');
    expect(deleted.rows[0]).toMatchObject({ header: '@@ -1,2 +0,0 @@' });
    expect(deleted).toMatchObject({ added: 0, removed: 2 });
    expect(lines(deleted.rows).every((row) => !row.after)).toBe(true);
    expect(lines(deleted.rows).map((row) => row.before?.number)).toEqual([1, 2]);
  });

  it('distinguishes a real empty line from an empty file', () => {
    expect(compare('', '')).toEqual({ rows: [], added: 0, removed: 0 });
    expect(buildDiffRows('')).toEqual({ rows: [], added: 0, removed: 0 });
    const result = compare('', '\n');
    expect(lines(result.rows)).toEqual([
      { kind: 'line', before: undefined, after: { number: 1, text: '', kind: 'added' } },
    ]);
    expect(result).toMatchObject({ added: 1, removed: 0 });
  });

  it('attaches missing-final-newline markers without counting them as changed lines', () => {
    const result = compare('same', 'same\n');
    expect(result).toMatchObject({ added: 1, removed: 1 });
    expect(lines(result.rows)).toEqual([
      {
        kind: 'line',
        before: { number: 1, text: 'same', kind: 'removed', noNewline: true },
        after: { number: 1, text: 'same', kind: 'added' },
      },
    ]);

    const noNewlineOnEitherSide = lines(compare('old', 'new').rows)[0];
    expect(noNewlineOnEitherSide.before?.noNewline).toBe(true);
    expect(noNewlineOnEitherSide.after?.noNewline).toBe(true);
    const unchangedLastLine = lines(compare('old\ntail', 'new\ntail').rows)[1];
    expect(unchangedLastLine.before).toMatchObject({ number: 2, kind: 'context', noNewline: true });
    expect(unchangedLastLine.after).toMatchObject({ number: 2, kind: 'context', noNewline: true });
  });

  it('removes CRLF terminators from visible code and keeps format-only changes', () => {
    const result = compare('same\r\n', 'same\n');
    expect(result).toMatchObject({ added: 1, removed: 1 });
    const row = lines(result.rows)[0];
    expect(row.before).toEqual({ number: 1, text: 'same', kind: 'removed' });
    expect(row.after).toEqual({ number: 1, text: 'same', kind: 'added' });
  });

  it('preserves source text, indentation, Unicode and HTML as literal strings', () => {
    const content = '  <script>alert("中文 + - @@")</script>  ';
    const result = compare('', `${content}\n`);
    expect(lines(result.rows)[0].after?.text).toBe(content);
  });
});
