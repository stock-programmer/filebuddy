import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { loadConfig, resolveConfig, type AppConfig } from '../src/config.js';
import { AgentService } from '../src/app/agent-service.js';
import { AppController } from '../src/app/controller.js';
import { WorkspaceService } from '../src/workspace/workspace-service.js';
import { budgetedStream, type RunPolicy } from '../src/agent/run-policy.js';

const roots: string[] = [];
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of disposers.splice(0)) await dispose();
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xuwu-config-runtime-'))
      throw new Error('Unsafe runtime config test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

async function dataRoot() {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-config-runtime-'));
  roots.push(root);
  return root;
}

async function fixture(config: AppConfig) {
  const root = await dataRoot();
  const workspace = await new WorkspaceService(root, config.workspace).create(
    randomUUID(),
    'configuration test',
  );
  const service = new AgentService({ dataRoot: root, appRoot: resolve('.'), config, onEvent: () => {} });
  disposers.push(() => service.dispose());
  // Reapplying model settings must preserve separately configured request allowances.
  await service.configure(config.model);
  await service.openSession(workspace);
  const internal = service as unknown as { session: AgentSession; policy?: RunPolicy };
  const calls: {
    kind: string;
    contextWindow: number;
    modelMaxTokens: number;
    maxTokens?: number;
    timeoutMs?: number;
  }[] = [];
  internal.session.agent.streamFunction = budgetedStream(
    (model, _context, options) => {
      calls.push({
        kind: internal.policy!.requestKind,
        contextWindow: model.contextWindow,
        modelMaxTokens: model.maxTokens,
        maxTokens: options?.maxTokens,
        timeoutMs: options?.timeoutMs,
      });
      const result: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: '保留目标与关键约束，已记录输入内容并完成本次检查。'.repeat(10) }],
        api: 'openai-completions',
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: result });
      stream.end(result);
      return stream;
    },
    () => internal.policy,
  );
  return { root, workspace, service, calls };
}

describe('effective configuration through real Pi session boundaries', () => {
  it('sends the configured 8192 output allowance and accepts input beyond the former 65536 context cap', async () => {
    const config = loadConfig({
      env: {
        AGENT_MODEL: 'config-fixture',
        AGENT_API_KEY: 'fixture-key',
        AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
        AGENT_CONTEXT_WINDOW: '131072',
        AGENT_MAX_OUTPUT_TOKENS: '8192',
        AGENT_RUN_OUTPUT_TOKENS: '8192',
        AGENT_COMPACTION_OUTPUT_TOKENS: '8192',
        AGENT_REQUEST_IDLE_TIMEOUT_MS: '12345',
        AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS: '23456',
      },
      overrides: { run: { maxTaskCharacters: 50000 } },
    });
    const f = await fixture(config);
    await f.service.send('中'.repeat(43000));
    expect(f.service.getRun()).toMatchObject({ status: 'ready_for_review', modelCalls: 1 });
    expect(f.calls).toEqual([
      {
        kind: 'conversation',
        contextWindow: 131072,
        modelMaxTokens: 8192,
        maxTokens: 8192,
        timeoutMs: 23456,
      },
    ]);
    const rows = (await readFile(f.service.getTracePath()!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows.find((row) => row.type === 'budget_check').inputEstimate).toBeGreaterThan(65536);
    expect(rows.find((row) => row.type === 'run_start').limits).toMatchObject({
      contextWindow: 131072,
      outputTokens: 8192,
      requestFirstContentTimeoutMs: 23456,
      requestIdleTimeoutMs: 12345,
    });
  }, 30000);

  it.each([
    { outputTokens: 1024, compactionOutputTokens: 8192 },
    { outputTokens: 2048, compactionOutputTokens: 1024 },
  ])(
    'preserves conversation $outputTokens and native compaction $compactionOutputTokens allowances after model configuration',
    async ({ outputTokens, compactionOutputTokens }) => {
      const config = resolveConfig({
        model: {
          model: 'config-fixture',
          apiKey: 'fixture-key',
          baseUrl: 'http://127.0.0.1:1/v1',
          contextWindow: 131072,
          maxTokens: 8192,
        },
        run: { outputTokens, compactionOutputTokens },
      });
      const f = await fixture(config);
      await f.service.send('第一轮：保留用户目标和全部关键约束。'.repeat(300));
      await f.service.send('第二轮：继续工作并保留已确认的决定。'.repeat(300));
      await f.service.compact();
      expect(f.service.getRun()).toMatchObject({ status: 'ready_for_review' });
      expect(f.calls.filter((call) => call.kind === 'conversation').map((call) => call.maxTokens)).toEqual([
        outputTokens,
        outputTokens,
      ]);
      const summaries = f.calls.filter((call) => call.kind === 'compaction');
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((call) => call.maxTokens === compactionOutputTokens)).toBe(true);
    },
    30000,
  );

  it('does not reread the environment on configure and keeps the previous configuration after rejection', async () => {
    const root = await dataRoot();
    const config = resolveConfig({
      model: { model: 'initial-fixture', apiKey: 'fixture-key', contextWindow: 131072, maxTokens: 8192 },
      run: { outputTokens: 8192, compactionOutputTokens: 8192 },
    });
    const service = new AgentService({ dataRoot: root, appRoot: resolve('.'), config, onEvent: () => {} });
    disposers.push(() => service.dispose());
    vi.stubEnv('AGENT_MODEL', 'unexpected-env-model');
    vi.stubEnv('AGENT_CONTEXT_WINDOW', 'invalid');
    await service.configure();
    expect(service.getModelInfo().name).toBe('initial-fixture');
    await expect(service.configure({ model: 'rejected-model', contextWindow: 1 })).rejects.toThrow(
      'model.contextWindow',
    );
    expect(service.getModelInfo().name).toBe('initial-fixture');
    await service.configure({ model: 'updated-fixture' });
    expect(service.getModelInfo().name).toBe('updated-fixture');
  });

  it('publishes an allowlisted snapshot without the backend API key or complete configuration', async () => {
    const root = await dataRoot();
    const config = resolveConfig({
      model: {
        model: 'public-fixture',
        apiKey: 'fixture-key-never-for-renderer',
        baseUrl: 'https://example.test/private-api',
      },
    });
    const controller = new AppController(root, resolve('.'), () => {}, config);
    disposers.push(() => controller.dispose());
    const snapshot = await controller.snapshot();
    expect(snapshot.model).toEqual({ name: 'public-fixture', provider: 'example.test', configured: true });
    expect(snapshot).not.toHaveProperty('config');
    expect(JSON.stringify(snapshot)).not.toContain(config.model.apiKey);
    expect(JSON.stringify(snapshot)).not.toContain('/private-api');
  });

  it('uses the configured task character limit for controller sends and draft titles', async () => {
    const root = await dataRoot();
    const config = resolveConfig({ run: { maxTaskCharacters: 50000 } });
    const controller = new AppController(root, resolve('.'), () => {}, config);
    disposers.push(() => controller.dispose());
    controller.current = await controller.workspaces.create(randomUUID());
    const workspaceId = controller.current.id;
    const send = vi.spyOn(controller.agent, 'send').mockResolvedValue(undefined);
    const acceptedText = '甲'.repeat(40000);

    await expect(controller.titleFromDraft(workspaceId, acceptedText)).resolves.toMatchObject({
      current: { id: workspaceId },
    });
    await controller.send(acceptedText);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(acceptedText);

    const oversizedText = '甲'.repeat(config.run.maxTaskCharacters + 1);
    await expect(controller.send(oversizedText)).rejects.toThrow('50000');
    await expect(controller.titleFromDraft(workspaceId, oversizedText)).rejects.toThrow('任务草稿无效');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
