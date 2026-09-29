import type { RunView } from '../app/contracts.js';

const statusLabels: Record<RunView['status'], string> = {
  idle: '准备就绪',
  running: '正在处理',
  waiting_user: '等待你的补充',
  ready_for_review: '已停稳，请检查成果',
  cancelled: '已停止，工作副本已保留',
  budget_exhausted: '本次预算已用完，工作副本已保留',
  failed: '处理遇到问题，工作副本已保留',
};

function secondsSince(timestamp: string, now: number): number {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 1000)) : 0;
}

/** Render only request metadata; reasoning text never crosses this interface. */
export function runActivity(run: RunView, now = Date.now()): string {
  if (run.error) return run.error;
  const progress = run.modelProgress;
  if (run.status !== 'running' || !progress || progress.phase === 'finished')
    return run.lastActivity || statusLabels[run.status];

  const labels = {
    waiting: '等待模型首段内容',
    thinking: '模型正在推理',
    answering: '正在生成正文',
    tool_arguments: '正在生成工具参数',
    receiving: '正在接收模型响应',
  };
  const parts = [`${progress.kind === 'compaction' ? '压缩上下文：' : ''}${labels[progress.phase]}`];
  const counts = [
    ['推理', progress.characters.thinking],
    ['正文', progress.characters.text],
    ['工具参数', progress.characters.toolArguments],
  ] as const;
  const received = counts
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count.toLocaleString('zh-CN')} 字符`);
  if (received.length) parts.push(`已接收${received.join('、')}`);

  if (progress.lastContentAt) {
    parts.push(`${secondsSince(progress.lastContentAt, now)} 秒前收到内容`);
  } else {
    parts.push(`已等待 ${secondsSince(progress.startedAt, now)} 秒`);
    if (progress.lastEventAt)
      parts.push(`${secondsSince(progress.lastEventAt, now)} 秒前收到流事件，尚无内容`);
  }
  return parts.join(' · ');
}

export function runElapsedMs(run: RunView, now = Date.now()): number {
  const started = Date.parse(run.startedAt);
  return run.status === 'running' && Number.isFinite(started)
    ? Math.max(run.elapsedMs, now - started, 0)
    : run.elapsedMs;
}

export function runTokenUsage(run: RunView): { summary: string; detail: string } {
  const used = `${Math.round(run.tokens / 100) / 10}k`;
  const exact = run.tokens.toLocaleString('zh-CN');
  const accounting = '含估算和请求预留';
  if (run.tokenLimit === null) {
    return {
      summary: `累计 ${used} token · 未设置预算上限`,
      detail: `累计统计 ${exact} tokens（${accounting}），未设置预算上限`,
    };
  }
  return {
    summary: `${used} / ${Math.round(run.tokenLimit / 100) / 10}k token`,
    detail: `累计统计 ${exact} / ${run.tokenLimit.toLocaleString('zh-CN')} tokens（${accounting}）`,
  };
}
