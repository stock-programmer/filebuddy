function envelope(originalBytes: number, preview = '') {
  return {
    truncated: true,
    originalBytes,
    instruction: '结果过大，请减少 limit/maxLines，或按 nextOffset/nextPosition 续读。',
    preview,
  };
}

/** The largest valid byte count must fit even when there is no room for a preview. */
export const MIN_TOOL_RESULT_BYTES = Buffer.byteLength(JSON.stringify(envelope(Number.MAX_SAFE_INTEGER)));

/** Fit structured pages after JSON escaping, without losing the continuation cursor. */
export function formatToolResult(result: unknown, maxBytes: number, offset = 0): string {
  const original = JSON.stringify(result);
  if (Buffer.byteLength(original) <= maxBytes) return original;
  if (!result || typeof result !== 'object') return truncateToolResult(original, maxBytes);
  const record = result as Record<string, unknown>;
  const fit = (length: number, page: (end: number) => Record<string, unknown>) => {
    let low = 0;
    let high = length;
    let best: string | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = JSON.stringify(page(middle));
      if (Buffer.byteLength(candidate) <= maxBytes) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    return best;
  };
  for (const key of ['entries', 'matches', 'changes']) {
    const items = record[key];
    if (!Array.isArray(items)) continue;
    const json = fit(items.length, (end) => ({
      ...record,
      [key]: items.slice(0, end),
      nextOffset: end < items.length ? offset + end : record.nextOffset,
    }));
    // Returning the same offset with an empty page would trap the agent in a continuation loop.
    if (!json || (items.length > 0 && JSON.parse(json)[key].length === 0))
      throw new Error('TOOL_RESULT_ITEM_TOO_LARGE: 结果预算不足以容纳一条记录，请提高工具结果预算。');
    return json;
  }
  if (
    typeof record.content === 'string' &&
    Number.isSafeInteger(record.startLine) &&
    Number.isSafeInteger(record.startColumn)
  ) {
    const content = record.content;
    const json = fit(content.length, (end) => {
      if (end === content.length) return record;
      if (/[\uD800-\uDBFF]/u.test(content[end - 1] ?? '')) end--;
      const prefix = content.slice(0, end);
      const lines = prefix.split('\n');
      const nextPosition = {
        startLine: Number(record.startLine) + lines.length - 1,
        startColumn: (lines.length === 1 ? Number(record.startColumn) : 0) + lines.at(-1)!.length,
      };
      return { ...record, content: prefix, nextPosition, nextLine: nextPosition.startLine, truncated: true };
    });
    if (!json || (content.length > 0 && JSON.parse(json).content.length === 0))
      throw new Error('TOOL_RESULT_ITEM_TOO_LARGE: 结果预算不足以容纳文件元数据与正文，请提高工具结果预算。');
    return json;
  }
  return truncateToolResult(original, maxBytes);
}

export function truncateToolResult(original: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(original);
  if (originalBytes <= maxBytes) return original;
  let json = JSON.stringify(envelope(originalBytes));
  if (Buffer.byteLength(json) > maxBytes) throw new Error('TOOL_RESULT_LIMIT_TOO_SMALL');
  let low = 0;
  let high = original.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    // Keep UTF-16 surrogate pairs intact before JSON escaping and byte measurement.
    const end = /[\uD800-\uDBFF]/u.test(original[middle - 1] ?? '') ? middle - 1 : middle;
    const candidate = JSON.stringify(envelope(originalBytes, original.slice(0, end)));
    if (Buffer.byteLength(candidate) <= maxBytes) {
      low = middle;
      json = candidate;
    } else high = middle - 1;
  }
  return json;
}
