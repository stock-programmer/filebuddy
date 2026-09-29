import type { RunView } from './contracts.js';

const toolLabels: Record<string, { active: string; completed: string }> = {
  list: { active: '查看目录', completed: '查看目录' },
  read: { active: '读取文件', completed: '读取' },
  search: { active: '搜索内容', completed: '搜索' },
  write: { active: '写入文件', completed: '写入' },
  edit: { active: '修改文件', completed: '修改' },
  mkdir: { active: '创建目录', completed: '创建目录' },
  move: { active: '移动文件', completed: '移动' },
  copy: { active: '复制文件', completed: '复制' },
  delete: { active: '移入回收区', completed: '移入回收区' },
  restore: { active: '恢复文件', completed: '恢复' },
  changes: { active: '检查文件变更', completed: '检查变更' },
};

/** Summarize observed events, without model output, tool arguments or file contents. */
export class RunFeedback {
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private ended = false;
  private lastVisibleAt = Date.now();
  private lastNotice = '';
  private stage = '正在准备材料索引与上下文';
  private active = new Map<string, string>();
  private completed = new Map<string, number>();
  private failures = 0;

  constructor(
    private readonly silenceMs: number,
    private readonly getRun: () => RunView | null,
    private readonly publish: (text: string) => void,
    compactOnly: boolean,
  ) {
    if (compactOnly) this.stage = '正在整理上下文';
    this.notice(compactOnly ? '已开始整理上下文。' : '已开始处理任务，正在准备材料与上下文。');
    this.schedule();
  }

  textReceived(text: string): void {
    if (text.trim()) this.lastVisibleAt = Date.now();
  }

  toolStarted(id: string, name: string): void {
    this.active.set(id, name);
  }

  toolEnded(id: string, isError: boolean): void {
    const name = this.active.get(id);
    if (!name) return;
    this.active.delete(id);
    if (isError) this.failures++;
    else {
      const label = toolLabels[name]?.completed ?? '文件操作';
      this.completed.set(label, (this.completed.get(label) ?? 0) + 1);
    }
    this.stage = '正在继续处理任务';
  }

  phase(text: string): void {
    this.stage = text;
    this.notice(`${text}。`);
  }

  private notice(text: string): void {
    this.lastVisibleAt = Date.now();
    if (this.closed || text === this.lastNotice) return;
    this.lastNotice = text;
    this.publish(text);
  }

  private summary(): string {
    const parts = [...this.completed].map(([label, count]) => `${label} ${count} 次`);
    if (this.failures) parts.push(`操作失败 ${this.failures} 次`);
    return parts.length ? `本轮记录：${parts.join('、')}。` : '';
  }

  private current(run: RunView): string {
    const activeName = [...this.active.values()].at(-1);
    if (activeName) return `正在${toolLabels[activeName]?.active ?? '执行文件操作'}`;
    const progress = run.modelProgress;
    if (!progress || progress.phase === 'finished') return this.stage;
    const phaseLabels = {
      waiting: '正在等待模型响应',
      thinking: '模型正在处理任务，尚未提供新的文字说明',
      answering: '正在接收模型回复',
      tool_arguments: '模型正在准备文件操作',
      receiving: '正在接收模型响应',
    };
    return `${progress.kind === 'compaction' ? '正在整理上下文；' : ''}${phaseLabels[progress.phase]}`;
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(
      () => {
        const run = this.getRun();
        if (!run || run.status !== 'running') {
          this.close();
          return;
        }
        if (Date.now() - this.lastVisibleAt >= this.silenceMs)
          this.notice(`${this.summary()}${this.current(run)}。`);
        this.schedule();
      },
      Math.max(1, this.silenceMs - (Date.now() - this.lastVisibleAt)),
    );
    this.timer.unref?.();
  }

  finish(run: RunView): void {
    if (this.ended) return;
    this.ended = true;
    const endings: Record<RunView['status'], string> = {
      idle: '本轮已结束。',
      running: '本轮已停止。',
      ready_for_review: '本轮已结束，请检查回复和工作成果。',
      cancelled: '你已停止本轮任务，已提交的修改保留。',
      failed: '本轮遇到问题，已停止。已提交的修改保留，请查看底部原因。',
      budget_exhausted: '本轮已达到设置的用量上限，已提交的修改保留。',
      waiting_user: '本轮已暂停，请检查回复和底部提示后继续。',
    };
    // The timer may already have observed cancellation; always preserve the final outcome.
    this.closed = false;
    try {
      this.notice(`${this.summary()}${endings[run.status]}`);
    } finally {
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
