import { parsePatch } from 'diff';

export interface DiffLine {
  number: number;
  text: string;
  kind: 'context' | 'removed' | 'added';
  noNewline?: boolean;
}

export type DiffRow =
  | { kind: 'hunk'; oldStart: number; newStart: number; header: string }
  | { kind: 'line'; before?: DiffLine; after?: DiffLine };

export function buildDiffRows(patch: string): {
  rows: DiffRow[];
  added: number;
  removed: number;
} {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;

  for (const file of parsePatch(patch)) {
    for (const hunk of file.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      const before: DiffLine[] = [];
      const after: DiffLine[] = [];
      let previous: DiffLine[] = [];

      const flushChanges = () => {
        for (let index = 0; index < Math.max(before.length, after.length); index++) {
          rows.push({ kind: 'line', before: before[index], after: after[index] });
        }
        before.length = 0;
        after.length = 0;
      };

      // parsePatch uses one-based starts even for empty sides; unified headers use zero.
      const oldHeaderStart = hunk.oldStart - (hunk.oldLines === 0 ? 1 : 0);
      const newHeaderStart = hunk.newStart - (hunk.newLines === 0 ? 1 : 0);
      rows.push({
        kind: 'hunk',
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        header: `@@ -${oldHeaderStart},${hunk.oldLines} +${newHeaderStart},${hunk.newLines} @@`,
      });

      for (const raw of hunk.lines) {
        if (raw.startsWith('\\')) {
          for (const line of previous) line.noNewline = true;
          continue;
        }

        const text = raw.slice(1).replace(/\r$/, '');
        if (raw.startsWith('-')) {
          const line: DiffLine = { number: oldLine++, text, kind: 'removed' };
          before.push(line);
          previous = [line];
          removed++;
        } else if (raw.startsWith('+')) {
          const line: DiffLine = { number: newLine++, text, kind: 'added' };
          after.push(line);
          previous = [line];
          added++;
        } else {
          flushChanges();
          const left: DiffLine = { number: oldLine++, text, kind: 'context' };
          const right: DiffLine = { number: newLine++, text, kind: 'context' };
          rows.push({ kind: 'line', before: left, after: right });
          previous = [left, right];
        }
      }
      flushChanges();
    }
  }

  return { rows, added, removed };
}
