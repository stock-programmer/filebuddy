import { describe, expect, it } from 'vitest';
import type { ModelProgress, RunView } from '../src/app/contracts.js';
import { runActivity, runElapsedMs, runTokenUsage } from '../src/ui/run-progress.js';

const startedAt = '2026-09-27T10:00:00.000Z';
const now = Date.parse(startedAt) + 15000;
const progress: ModelProgress = {
  requestId: 'request-2',
  modelCall: 2,
  kind: 'conversation',
  phase: 'waiting',
  startedAt,
  eventCounts: {},
  characters: { text: 0, thinking: 0, toolArguments: 0 },
};
const run: RunView = {
  id: 'run-1',
  status: 'running',
  startedAt,
  elapsedMs: 1000,
  modelCalls: 2,
  toolCalls: 1,
  tokens: 100,
  tokenLimit: 100000,
  lastActivity: '正在执行 read',
};

function view(change: Partial<ModelProgress> = {}): RunView {
  return { ...run, modelProgress: { ...progress, ...change } };
}

describe('model progress displayed in the run strip', () => {
  it('shows cumulative usage without a cap for unbudgeted runs even above the old default', () => {
    const usage = runTokenUsage({ ...run, tokens: 125000, tokenLimit: null });
    expect(usage.summary).toBe('累计 125k token · 未设置预算上限');
    expect(usage.detail).toBe('累计统计 125,000 tokens（含估算和请求预留），未设置预算上限');
  });

  it('preserves the limit for saved or explicitly budgeted runs', () => {
    const usage = runTokenUsage({ ...run, tokens: 63980 });
    expect(usage.summary).toBe('64k / 100k token');
    expect(usage.detail).toBe('累计统计 63,980 / 100,000 tokens（含估算和请求预留）');
    expect(runTokenUsage({ ...run, tokenLimit: 800 }).summary).toBe('0.1k / 0.8k token');
  });

  it('replaces a prior tool activity immediately while waiting for a new request', () => {
    expect(runActivity(view(), now)).toBe('等待模型首段内容 · 已等待 15 秒');
  });

  it('distinguishes protocol activity from receiving model content', () => {
    expect(runActivity(view({ lastEventAt: '2026-09-27T10:00:12.000Z' }), now)).toBe(
      '等待模型首段内容 · 已等待 15 秒 · 3 秒前收到流事件，尚无内容',
    );
  });

  it('shows reasoning counts and advances time since the last content without a new snapshot', () => {
    const snapshot = view({
      phase: 'thinking',
      characters: { text: 0, thinking: 10482, toolArguments: 0 },
      lastContentAt: '2026-09-27T10:00:10.000Z',
    });
    expect(runActivity(snapshot, now)).toBe('模型正在推理 · 已接收推理 10,482 字符 · 5 秒前收到内容');
    expect(runActivity(snapshot, now + 2000)).toContain('7 秒前收到内容');
  });

  it('names answer, tool argument and compaction phases using received character counts', () => {
    expect(runActivity(view({ phase: 'answering' }), now)).toContain('正在生成正文');
    expect(
      runActivity(
        view({ phase: 'tool_arguments', characters: { text: 10, thinking: 20, toolArguments: 30 } }),
        now,
      ),
    ).toContain('正在生成工具参数 · 已接收推理 20 字符、正文 10 字符、工具参数 30 字符');
    expect(runActivity(view({ kind: 'compaction', phase: 'thinking' }), now)).toContain(
      '压缩上下文：模型正在推理',
    );
  });

  it('keeps tool and end states authoritative when a request is finished', () => {
    expect(runActivity(view({ phase: 'finished' }), now)).toBe('正在执行 read');
    expect(
      runActivity(
        { ...view({ phase: 'thinking' }), status: 'ready_for_review', lastActivity: '已完成' },
        now,
      ),
    ).toBe('已完成');
    expect(
      runActivity({ ...view({ phase: 'thinking' }), status: 'failed', error: 'MODEL_IDLE_TIMEOUT' }, now),
    ).toBe('MODEL_IDLE_TIMEOUT');
  });

  it('accepts saved runs from before progress metadata existed', () => {
    expect(runActivity(run, now)).toBe('正在执行 read');
    expect(runActivity({ ...run, lastActivity: '', status: 'cancelled' }, now)).toBe(
      '已停止，工作副本已保留',
    );
  });

  it('updates the live elapsed clock and preserves the final elapsed value', () => {
    expect(runElapsedMs(run, now)).toBe(15000);
    expect(runElapsedMs({ ...run, status: 'failed', elapsedMs: 129000 }, now + 1000000)).toBe(129000);
    expect(runElapsedMs({ ...run, startedAt: 'invalid' }, now)).toBe(1000);
  });
});
