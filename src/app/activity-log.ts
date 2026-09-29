import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from './contracts.js';

/** Host feedback belongs to the UI transcript, never to Pi's model context. */
export class ActivityLog {
  private readonly file: string;
  private readonly messages: (ChatMessage & { runId?: string })[] = [];
  private readonly userTimes = new Map<string, number>();
  private needsNewline = false;
  private persistenceWarning?: ChatMessage;

  constructor(dataRoot: string, sessionId: string) {
    this.file = join(dataRoot, 'activity', sessionId, 'messages.jsonl');
    if (!existsSync(this.file)) return;
    let saved: string;
    try {
      saved = readFileSync(this.file, 'utf8');
    } catch {
      this.warnPersistence();
      return;
    }
    this.needsNewline = saved.length > 0 && !saved.endsWith('\n');
    for (const line of saved.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (
          message.kind === 'user_anchor' &&
          typeof message.runId === 'string' &&
          Number.isFinite(message.timestamp)
        ) {
          this.userTimes.set(message.runId, message.timestamp);
          continue;
        }
        if (
          message.role === 'notice' &&
          typeof message.id === 'string' &&
          typeof message.text === 'string' &&
          typeof message.createdAt === 'string' &&
          Number.isFinite(Date.parse(message.createdAt))
        )
          this.messages.push(message);
      } catch {
        // A partially written last record must not hide earlier feedback after a crash.
      }
    }
  }

  append(text: string, runId?: string): void {
    const message = {
      id: randomUUID(),
      role: 'notice',
      text,
      createdAt: new Date().toISOString(),
      runId,
    } satisfies ChatMessage & { runId?: string };
    this.persist(message);
    this.messages.push(message);
  }

  anchorToUser(runId: string, timestamp: number): void {
    if (this.userTimes.has(runId)) return;
    this.persist({ kind: 'user_anchor', runId, timestamp });
    this.userTimes.set(runId, timestamp);
  }

  private persist(record: unknown): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${this.needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`, 'utf8');
      this.needsNewline = false;
    } catch {
      // Feedback storage must not interrupt file work or escape a timer callback.
      this.needsNewline = true;
      this.warnPersistence();
    }
  }

  private warnPersistence(): void {
    this.persistenceWarning ??= {
      id: randomUUID(),
      role: 'notice',
      createdAt: new Date().toISOString(),
      text: '部分运行状态未能读取或保存，重新打开后可能缺失。',
    };
  }

  getMessages(conversation: ChatMessage[] = []): ChatMessage[] {
    const notices = this.messages.map(({ runId, ...message }) => ({
      message,
      // Preparation can precede Pi accepting the user input. Keep that input above its feedback.
      time: Math.max(Date.parse(message.createdAt), (runId && this.userTimes.get(runId)) || 0),
    }));
    return [
      ...conversation.map((message) => ({ message, time: Date.parse(message.createdAt) })),
      ...notices,
      ...(this.persistenceWarning
        ? [{ message: this.persistenceWarning, time: Date.parse(this.persistenceWarning.createdAt) }]
        : []),
    ]
      .sort((a, b) => a.time - b.time)
      .map(({ message }) => ({ ...message }));
  }
}
