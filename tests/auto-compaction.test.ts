import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { WorkspaceService } from '../src/workspace/workspace-service.js';
import { createSession } from '../src/agent/create-session.js';
import { budgetedStream, estimateTokens, RunPolicy } from '../src/agent/run-policy.js';
import { compressionWatermark, inputLimit, type RunLimits } from '../src/config.js';
import { LEGACY_LIMITS } from './fixtures/legacy-profile.js';
import { TraceWriter } from '../src/observability/trace.js';

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  disposers.splice(0).forEach((dispose) => dispose());
  for (const root of roots.splice(0)) {
    // A failed fixture must never turn cleanup into deletion outside its temp root.
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xuwu-compaction-'))
      throw new Error(`Unsafe test cleanup path: ${root}`);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(limits: RunLimits = LEGACY_LIMITS) {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-compaction-'));
  roots.push(root);
  const inputs = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const path = join(root, `fixture-${index}.json`);
      await writeFile(path, JSON.stringify({ marker: `KEEP-42-${index}`, data: '中文数据'.repeat(950) }));
      return path;
    }),
  );
  const workspace = await new WorkspaceService(join(root, 'data')).create(randomUUID(), 'test');
  await workspace.importPaths(inputs);
  const trace = new TraceWriter(join(root, 'data'), workspace.id, randomUUID());
  const policy = new RunPolicy({ ...limits }, trace);
  disposers.push(() => policy.close());
  const built = await createSession({
    workspace,
    appRoot: resolve('.'),
    dataRoot: join(root, 'data'),
    limits,
    model: {
      model: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fixture-key',
      contextWindow: limits.contextWindow,
      maxTokens: limits.outputTokens,
    },
    getPolicy: () => policy,
  });
  disposers.push(() => built.session.dispose());
  const defaultKeepRecentTokens = built.session.settingsManager.getCompactionSettings(
    built.session.model,
  ).keepRecentTokens;
  // Let the short initial fixture history compact; the main run restores the real default below.
  built.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 32 } });
  built.session.subscribe((event) => {
    if (event.type === 'compaction_start') policy.requestKind = 'compaction';
    if (event.type === 'compaction_end') policy.requestKind = 'conversation';
  });
  return { root, workspace, trace, policy, defaultKeepRecentTokens, ...built };
}

function stream(content: AssistantMessage['content'], totalTokens = 120) {
  const message: AssistantMessage = {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'xuwu-model',
    model: 'fixture',
    timestamp: Date.now(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: {
      input: totalTokens - 20,
      output: 20,
      totalTokens,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const events = createAssistantMessageEventStream();
  events.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
  events.end(message);
  return events;
}

function summary(context: TranscriptContext) {
  // A controlled summarizer may retain only facts actually present in its input.
  const text = JSON.stringify(context);
  const markers = [...new Set(text.match(/KEEP-42(?:-\d+)?/g) ?? [])];
  return stream([
    {
      type: 'text',
      text: `## Goal\n读取导入的 JSON 文件并保留标记。\n## Progress\n已处理的上下文包含：${markers.join('、')}。\n## Next\n继续依据保留的最新工具结果完成任务，不重复已执行的读取。`,
    },
  ]);
}

async function traceRows(path: string) {
  return (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('automatic context compaction at the real Pi tool-loop boundary', () => {
  it('compacts again after six Chinese JSON reads and continues without replaying tools or resetting usage', async () => {
    const f = await fixture();
    let conversationCalls = 0;
    let summaryCalls = 0;
    const completedCompactions: unknown[] = [];
    const boundaryEstimates: { host: number; pi: number | null }[] = [];
    f.session.subscribe((event) => {
      if (event.type === 'compaction_end' && event.result) completedCompactions.push(event.result);
    });
    const prepare = f.session.agent.prepareNextTurnWithContext!;
    f.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      if (f.policy.toolCalls === 10) {
        const messages = f.sessionManager.buildSessionProjection().messages;
        boundaryEstimates.push({
          host: estimateTokens(normalizeContext({ messages: await f.session.agent.convertToLlm(messages) })),
          pi: f.session.getContextUsage()?.tokens ?? null,
        });
      }
      return prepare(turn, signal);
    };
    f.session.agent.streamFunction = budgetedStream(
      (_model, context) => {
        if (f.policy.requestKind === 'compaction') {
          summaryCalls++;
          return summary(context);
        }
        conversationCalls++;
        if (conversationCalls === 1)
          return stream(
            [{ type: 'text', text: '已记录 KEEP-42。' + '将逐步读取材料并保留所有关键标记。'.repeat(12) }],
            compressionWatermark(LEGACY_LIMITS) + 100,
          );
        if (conversationCalls === 2 || conversationCalls === 3) {
          const start = conversationCalls === 2 ? 0 : 4;
          const end = conversationCalls === 2 ? 4 : 10;
          return stream(
            f.workspace.items.slice(start, end).map((item, index) => ({
              type: 'toolCall' as const,
              id: `read-${start + index}`,
              name: 'read',
              arguments: { path: item.workPath },
            })),
          );
        }
        for (let index = 0; index < 10; index++)
          expect(JSON.stringify(context)).toContain(`KEEP-42-${index}`);
        return stream([{ type: 'text', text: '已读取全部 10 个文件，保留 KEEP-42。' }]);
      },
      () => f.policy,
    );

    await f.session.prompt(
      '记录目标：读取所有导入 JSON 文件，保留 KEEP-42。' + '不得遗漏关键约束。'.repeat(20),
      {
        expandPromptTemplates: false,
      },
    );
    expect(completedCompactions).toHaveLength(1);
    f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: f.defaultKeepRecentTokens } });
    const previousTokens = f.policy.tokens;
    const previousCalls = f.policy.modelCalls;
    await f.session.prompt('继续读取全部文件并完成任务，保留 KEEP-42。', { expandPromptTemplates: false });

    expect(
      boundaryEstimates.some(
        (row) =>
          row.host > inputLimit(LEGACY_LIMITS) &&
          row.pi !== null &&
          row.pi < compressionWatermark(LEGACY_LIMITS),
      ),
    ).toBe(true);
    expect(f.policy.reason).toBeUndefined();
    expect(f.policy.status).toBe('running');
    expect(conversationCalls).toBe(4);
    expect(summaryCalls).toBeGreaterThanOrEqual(2);
    expect(completedCompactions.length).toBeGreaterThanOrEqual(2);
    expect(f.policy.toolCalls).toBe(10);
    expect(f.policy.tokens).toBeGreaterThan(previousTokens);
    expect(f.policy.modelCalls).toBeGreaterThan(previousCalls);
    expect(JSON.stringify(f.session.messages.at(-1))).toContain('已读取全部 10 个文件，保留 KEEP-42');

    const rows = await traceRows(f.trace.path);
    const toolIds = rows.filter((row) => row.type === 'tool_start').map((row) => row.toolCallId);
    expect(toolIds).toHaveLength(10);
    expect(new Set(toolIds).size).toBe(10);
    const responses = rows.filter((row) => row.type === 'model_response');
    expect(f.policy.tokens).toBe(responses.reduce((total, row) => total + row.tokens, 0));
    expect(f.policy.modelCalls).toBe(conversationCalls + summaryCalls);
    expect(
      rows
        .filter((row) => row.type === 'model_request')
        .every((row) => row.inputEstimate <= inputLimit(LEGACY_LIMITS)),
    ).toBe(true);
    expect(rows.some((row) => row.type === 'budget_check' && row.allowed === false)).toBe(false);
  }, 60000);

  it('keeps an explicit model-call budget in force when automatic compaction needs a request', async () => {
    const limits = { ...LEGACY_LIMITS, maxModelCalls: 4 };
    const f = await fixture(limits);
    let conversationCalls = 0;
    let providerCalls = 0;
    f.session.agent.streamFunction = budgetedStream(
      (_model, context) => {
        providerCalls++;
        if (f.policy.requestKind === 'compaction') return summary(context);
        conversationCalls++;
        if (conversationCalls === 1)
          return stream(
            [{ type: 'text', text: '已记录 KEEP-42。' + '需要保留所有任务约束。'.repeat(20) }],
            compressionWatermark(limits) + 100,
          );
        const start = conversationCalls === 2 ? 0 : 4;
        const end = conversationCalls === 2 ? 4 : 10;
        return stream(
          f.workspace.items.slice(start, end).map((item, index) => ({
            type: 'toolCall' as const,
            id: `budget-read-${start + index}`,
            name: 'read',
            arguments: { path: item.workPath },
          })),
        );
      },
      () => f.policy,
    );
    await f.session.prompt('记录目标 KEEP-42。' + '不得遗漏关键约束。'.repeat(20), {
      expandPromptTemplates: false,
    });
    f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: f.defaultKeepRecentTokens } });
    await f.session.prompt('继续读取全部文件。', { expandPromptTemplates: false }).catch(() => {});

    expect(f.policy.status).toBe('budget_exhausted');
    expect(f.policy.reason).toContain('MODEL_LIMIT');
    expect(providerCalls).toBe(4);
    expect(f.policy.modelCalls).toBe(4);
    expect(f.policy.toolCalls).toBe(10);
    const rows = await traceRows(f.trace.path);
    expect(
      rows.some((row) => row.type === 'budget_check' && row.kind === 'compaction' && row.allowed === false),
    ).toBe(true);
    expect(f.policy.tokens).toBe(
      rows.filter((row) => row.type === 'model_response').reduce((total, row) => total + row.tokens, 0),
    );
  }, 60000);

  it('stops an oversized single input without sending it to the provider or looping recovery', async () => {
    const f = await fixture();
    let providerCalls = 0;
    let compactionAttempts = 0;
    f.session.subscribe((event) => {
      if (event.type === 'compaction_start') compactionAttempts++;
    });
    f.session.agent.streamFunction = budgetedStream(
      () => {
        providerCalls++;
        return stream([{ type: 'text', text: '此请求不应抵达 provider。' }]);
      },
      () => f.policy,
    );
    await f.session.prompt('中'.repeat(60000), { expandPromptTemplates: false }).catch(() => {});

    expect(f.policy.reason).toContain('CONTEXT_LIMIT');
    expect(f.policy.controller.signal.aborted).toBe(true);
    expect(providerCalls).toBe(0);
    expect(f.policy.modelCalls).toBe(0);
    expect(f.policy.tokens).toBe(0);
    expect(compactionAttempts).toBeLessThanOrEqual(1);
    expect(f.policy.toolCalls).toBe(0);
  }, 60000);

  it.each(['summary failure', 'cancellation'] as const)(
    'restores compaction settings after %s',
    async (outcome) => {
      const f = await fixture();
      let conversationCalls = 0;
      let interruptedSummaries = 0;
      let settingsDuringSummary:
        | ReturnType<typeof f.session.settingsManager.getCompactionSettings>
        | undefined;
      f.session.agent.streamFunction = budgetedStream(
        (_model, context) => {
          if (f.policy.requestKind === 'compaction') {
            if (conversationCalls === 1) return summary(context);
            interruptedSummaries++;
            settingsDuringSummary = f.session.settingsManager.getCompactionSettings(f.session.model);
            if (outcome === 'summary failure') throw new Error('FIXTURE_SUMMARY_FAILED');
            f.policy.stop('cancelled', 'FIXTURE_CANCELLED');
            return summary(context);
          }
          conversationCalls++;
          if (conversationCalls === 1)
            return stream(
              [{ type: 'text', text: '已记录 KEEP-42。' + '需要保留所有任务约束。'.repeat(20) }],
              compressionWatermark(LEGACY_LIMITS) + 100,
            );
          const start = conversationCalls === 2 ? 0 : 4;
          const end = conversationCalls === 2 ? 4 : 10;
          return stream(
            f.workspace.items.slice(start, end).map((item, index) => ({
              type: 'toolCall' as const,
              id: `interrupted-read-${start + index}`,
              name: 'read',
              arguments: { path: item.workPath },
            })),
          );
        },
        () => f.policy,
      );
      await f.session.prompt('记录目标 KEEP-42。' + '不得遗漏关键约束。'.repeat(20), {
        expandPromptTemplates: false,
      });
      f.session.settingsManager.applyOverrides({
        compaction: { keepRecentTokens: f.defaultKeepRecentTokens },
      });
      const settingsBefore = f.session.settingsManager.getCompactionSettings(f.session.model);
      await f.session.prompt('继续读取全部文件。', { expandPromptTemplates: false }).catch(() => {});

      expect(interruptedSummaries).toBe(1);
      expect(settingsDuringSummary?.reserveTokens).toBe(LEGACY_LIMITS.contextWindow);
      expect(settingsDuringSummary!.keepRecentTokens).toBeLessThan(settingsBefore.keepRecentTokens);
      expect(f.session.settingsManager.getCompactionSettings(f.session.model)).toEqual(settingsBefore);
      expect(f.policy.status).toBe(outcome === 'summary failure' ? 'failed' : 'cancelled');
      expect(f.policy.reason).toContain(
        outcome === 'summary failure' ? 'CONTEXT_COMPACTION_FAILED' : 'FIXTURE_CANCELLED',
      );
      expect(f.policy.controller.signal.aborted).toBe(true);
      expect(conversationCalls).toBe(3);
      expect(f.policy.toolCalls).toBe(10);
    },
    60000,
  );
});
