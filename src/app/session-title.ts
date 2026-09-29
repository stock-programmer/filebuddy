import type { SessionSummary } from './contracts.js';

export const DEFAULT_SESSION_TITLE = '新的文件任务';
export const AUTO_SESSION_TITLE_LENGTH = 16;
export const MAX_SESSION_TITLE_LENGTH = 80;

export function normalizeSessionTitle(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function sessionTitleFromTask(text: string): string {
  return Array.from(normalizeSessionTitle(text)).slice(0, AUTO_SESSION_TITLE_LENGTH).join('');
}

export function canAutoNameSession(summary: SessionSummary, hasUserMessages = false): boolean {
  if (hasUserMessages) return false;
  if (summary.titleSource) return summary.titleSource === 'default' || summary.titleSource === 'draft';
  // Older manifests have no source flag. Preserve their existing custom names.
  return summary.title === DEFAULT_SESSION_TITLE;
}

export function validateSessionTitle(text: string): string {
  const title = normalizeSessionTitle(text);
  if (!title) throw new Error('会话名称不能为空。');
  if (Array.from(title).length > MAX_SESSION_TITLE_LENGTH)
    throw new Error(`会话名称最多 ${MAX_SESSION_TITLE_LENGTH} 个字符。`);
  return title;
}
