import type { WorkspaceConfig } from '../config.js';
import { WorkspaceError } from './path-policy.js';

export function integerArgument(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new WorkspaceError('INVALID_ARGUMENT', `${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  return value;
}

/** Byte-bounded UTF-8 pages keep a UTF-16 column cursor compatible with string.slice. */
export function readTextPage(
  text: string,
  args: { startLine?: unknown; startColumn?: unknown; maxLines?: unknown },
  config: WorkspaceConfig['read'],
) {
  const startLine = integerArgument(args.startLine, 1, 1, Number.MAX_SAFE_INTEGER, 'startLine');
  const startColumn = integerArgument(args.startColumn, 0, 0, Number.MAX_SAFE_INTEGER, 'startColumn');
  const maxLines = integerArgument(args.maxLines, config.defaultLines, 1, config.maxLines, 'maxLines');
  const lines = text.split('\n');
  let content = '';
  let bytes = 0;
  let taken = 0;
  let nextPosition: { startLine: number; startColumn: number } | null = null;
  for (const [index, fullLine] of lines.slice(startLine - 1, startLine - 1 + maxLines).entries()) {
    const column = index === 0 ? startColumn : 0;
    const line = fullLine.slice(column);
    const next = (taken ? '\n' : '') + line;
    const nextBytes = Buffer.byteLength(next);
    if (bytes + nextBytes > config.maxContentBytes) {
      if (!taken) {
        for (const char of line) {
          const charBytes = Buffer.byteLength(char);
          if (bytes + charBytes > config.maxContentBytes) break;
          content += char;
          bytes += charBytes;
        }
        nextPosition = { startLine, startColumn: column + content.length };
      }
      break;
    }
    content += next;
    bytes += nextBytes;
    taken++;
  }
  if (!nextPosition && startLine + taken <= lines.length)
    nextPosition = { startLine: startLine + taken, startColumn: 0 };
  return {
    content,
    startLine,
    startColumn,
    totalLines: lines.length,
    nextLine: nextPosition?.startLine ?? null,
    nextPosition,
    truncated: nextPosition !== null,
  };
}
