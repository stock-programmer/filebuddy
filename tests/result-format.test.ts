import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { formatToolResult } from '../src/tools/result-format.js';
import { readTextPage } from '../src/workspace/text-page.js';

describe('byte-limited structured tool results', () => {
  it('iterates all 100 long search matches without losing the continuation cursor or any record', () => {
    const matches = Array.from({ length: 100 }, (_, index) => ({
      path: `directory/file-${index}.txt`,
      line: index + 1,
      text: '搜索命中😀\\"'.repeat(20),
    }));
    let offset = 0;
    const received: typeof matches = [];
    while (offset < matches.length) {
      const serialized = formatToolResult({ matches: matches.slice(offset), nextOffset: null }, 1024, offset);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(1024);
      const page = JSON.parse(serialized);
      expect(page.matches.length).toBeGreaterThan(0);
      received.push(...page.matches);
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBe(offset + page.matches.length);
      offset = page.nextOffset;
    }
    expect(received).toEqual(matches);
  });

  it.each(['entries', 'changes'])('keeps %s metadata and resumes after the last serialized item', (key) => {
    const items = Array.from({ length: 30 }, (_, index) => ({ path: `file-${index}.txt`, kind: 'modified' }));
    const page = JSON.parse(formatToolResult({ [key]: items, total: 100, nextOffset: 50 }, 256, 20));
    expect(page.total).toBe(100);
    expect(page[key].length).toBeGreaterThan(0);
    expect(page[key].length).toBeLessThan(items.length);
    expect(page.nextOffset).toBe(20 + page[key].length);
  });

  it('reads escaped Unicode text across outer JSON byte limits with complete lossless continuation', () => {
    const original = '目录\\sub\\file"\u0001\t😀'.repeat(500);
    let position = { startLine: 1, startColumn: 0 };
    let recovered = '';
    let pages = 0;
    for (;;) {
      const filePage = {
        path: 'unicode.txt',
        hash: 'fixture-hash',
        ...readTextPage(original, position, DEFAULT_CONFIG.workspace.read),
      };
      const serialized = formatToolResult(filePage, 512);
      expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(512);
      const result = JSON.parse(serialized);
      expect(result.hash).toBe('fixture-hash');
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content).not.toContain('\uFFFD');
      recovered += result.content;
      if (result.nextPosition === null) break;
      expect(result.nextPosition).toEqual({
        startLine: 1,
        startColumn: position.startColumn + result.content.length,
      });
      position = result.nextPosition;
      expect(++pages).toBeLessThan(original.length);
    }
    expect(pages).toBeGreaterThan(1);
    expect(recovered).toBe(original);
  });

  it('moves the read cursor across newlines when the final JSON budget ends inside a later line', () => {
    const source = 'one\n' + '后续😀\\'.repeat(200);
    const full = {
      path: 'lines.txt',
      hash: 'fixture-hash',
      ...readTextPage(source, {}, DEFAULT_CONFIG.workspace.read),
    };
    const page = JSON.parse(formatToolResult(full, 512));
    expect(page.content.startsWith('one\n')).toBe(true);
    expect(page.nextPosition.startLine).toBe(2);
    expect(page.nextPosition.startColumn).toBe(page.content.slice(4).length);
    const next = readTextPage(source, page.nextPosition, DEFAULT_CONFIG.workspace.read);
    expect(page.content + next.content).toBe(source);
  });

  it('rejects a budget that cannot fit one structured item instead of returning a cursor that makes no progress', () => {
    expect(() =>
      formatToolResult(
        { matches: [{ path: 'x'.repeat(1000), line: 1, text: 'match' }], nextOffset: null },
        512,
      ),
    ).toThrow('TOOL_RESULT_ITEM_TOO_LARGE');
    const result = {
      path: 'x'.repeat(1000),
      hash: 'hash',
      ...readTextPage('😀', {}, DEFAULT_CONFIG.workspace.read),
    };
    expect(() => formatToolResult(result, 512)).toThrow('TOOL_RESULT_ITEM_TOO_LARGE');
  });
});
