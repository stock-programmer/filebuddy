import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../src/app/agent-service.js';
import type { AppEvent } from '../src/app/contracts.js';
import { budgetedStream, type RunPolicy } from '../src/agent/run-policy.js';
import { resolveConfig } from '../src/config.js';
import { WorkspaceService } from '../src/workspace/workspace-service.js';

const roots: string[] = [];
const services: AgentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('filebuddy-progress-'))
      throw new Error('Unsafe progress test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

function response(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'xuwu-model',
    model: 'fixture',
    timestamp: Date.now(),
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('visible progress through real Pi sessions and AgentService', () => {
  it('keeps silent tool work visible, orders delayed replies and restores feedback outside model context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'filebuddy-progress-'));
    roots.push(root);
    const dataRoot = join(root, 'data');
    const original = join(root, 'original.txt');
    const originalText = '代号：青禾\n保留 KEEP-42\n';
    await writeFile(original, originalText);
    const workspace = await new WorkspaceService(dataRoot).create(randomUUID(), 'progress fixture');
    await workspace.importPaths([original]);
    const events: AppEvent[] = [];
    const service = new AgentService({
      dataRoot,
      appRoot: resolve('.'),
      onEvent: (event) => events.push(event),
      config: resolveConfig({
        model: {
          model: 'fixture',
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'fixture-key',
          contextWindow: 65536,
          maxTokens: 4096,
        },
        run: { outputTokens: 4096, compactionOutputTokens: 4096, progressSilenceMs: 25 },
      }),
    });
    services.push(service);
    await service.openSession(workspace);
    const access = service as unknown as { session: AgentSession; policy?: RunPolicy };
    const contexts: string[] = [];
    let calls = 0;
    let finishReply: (() => void) | undefined;
    const finalText = '已读取材料并找到 KEEP-42，文件未修改。';
    const privateThinking = 'PRIVATE_THINKING_FIXTURE';
    access.session.agent.streamFunction = budgetedStream(
      (_model, context) => {
        calls++;
        contexts.push(JSON.stringify(context.messages));
        const output = createAssistantMessageEventStream();
        if (calls <= 2) {
          const result = response([
            calls === 1
              ? {
                  type: 'toolCall',
                  id: 'read-material',
                  name: 'read',
                  arguments: { path: workspace.items[0].workPath },
                }
              : {
                  type: 'toolCall',
                  id: 'search-marker',
                  name: 'search',
                  arguments: { query: 'KEEP-42' },
                },
          ]);
          output.push({ type: 'done', reason: 'toolUse', message: result });
          output.end(result);
          return output;
        }
        const partial = response([{ type: 'thinking', thinking: privateThinking }]);
        output.push({ type: 'start', partial });
        output.push({ type: 'thinking_start', contentIndex: 0, partial });
        output.push({ type: 'thinking_delta', contentIndex: 0, delta: privateThinking, partial });
        finishReply = () => {
          finishReply = undefined;
          const completed = {
            ...partial,
            content: [...partial.content, { type: 'text' as const, text: finalText }],
          };
          output.push({ type: 'text_start', contentIndex: 1, partial: completed });
          output.push({ type: 'text_delta', contentIndex: 1, delta: finalText, partial: completed });
          output.push({ type: 'done', reason: 'stop', message: completed });
          output.end(completed);
        };
        return output;
      },
      () => access.policy,
    );

    const task = '读取材料并搜索 KEEP-42，报告找到的内容。';
    const running = service.send(task);
    try {
      await vi.waitFor(
        () => {
          expect(calls).toBe(3);
          expect(
            service
              .getMessages()
              .some(
                (message) =>
                  message.role === 'notice' &&
                  message.text.includes('读取 1 次') &&
                  message.text.includes('搜索 1 次') &&
                  message.text.includes('尚未提供新的文字说明'),
              ),
          ).toBe(true);
        },
        { timeout: 5000, interval: 10 },
      );
      const during = service.getMessages();
      const startIndex = during.findIndex(
        (message) => message.role === 'notice' && message.text.includes('已开始处理任务'),
      );
      const userIndex = during.findIndex((message) => message.role === 'user' && message.text === task);
      expect(userIndex).toBeGreaterThanOrEqual(0);
      expect(startIndex).toBeGreaterThan(userIndex);
      expect(during.some((message) => message.role === 'assistant')).toBe(false);
      expect(service.getRun()).toMatchObject({ status: 'running', toolCalls: 2 });
      expect(
        JSON.parse(contexts[2]).filter((message: { role: string }) => message.role === 'toolResult'),
      ).toHaveLength(2);
      expect(contexts[2]).toContain('KEEP-42');
      finishReply!();
      await running;

      const completed = service.getMessages();
      const finalIndex = completed.findIndex(
        (message) => message.role === 'assistant' && message.text === finalText,
      );
      const silentIndex = completed.findIndex(
        (message) => message.role === 'notice' && message.text.includes('尚未提供新的文字说明'),
      );
      expect(finalIndex).toBeGreaterThan(silentIndex);
      expect(silentIndex).toBeGreaterThan(startIndex);
      expect(events.some((event) => event.type === 'text_delta' && event.text === finalText)).toBe(true);
      expect(service.getRun()).toMatchObject({ status: 'ready_for_review', toolCalls: 2, modelCalls: 3 });
      expect(JSON.stringify(completed)).not.toContain(privateThinking);
      for (const notice of completed.filter((message) => message.role === 'notice'))
        for (const context of contexts) expect(context).not.toContain(notice.text);
      expect(await readFile(original, 'utf8')).toBe(originalText);

      await service.openSession(workspace);
      expect(service.getMessages()).toEqual(completed);
      expect(service.getRun()?.status).toBe('ready_for_review');
      const restoredContext = JSON.stringify(access.session.messages);
      for (const notice of completed.filter((message) => message.role === 'notice'))
        expect(restoredContext).not.toContain(notice.text);
    } finally {
      finishReply?.();
      await running;
    }
  }, 60000);
});
