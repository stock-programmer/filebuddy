import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { AgentService } from '../src/app/agent-service.js';
import { budgetedStream, type RunPolicy } from '../src/agent/run-policy.js';
import { loadConfig } from '../src/config.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const model: Model<'openai-completions'> = {
  id: 'fixture',
  name: 'fixture',
  api: 'openai-completions',
  provider: 'fixture',
  baseUrl: 'https://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65536,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe('run budget configuration through service persistence', () => {
  it.each([
    { configured: false, tokenLimit: null, status: 'ready_for_review' },
    { configured: true, tokenLimit: 100000, status: 'budget_exhausted' },
  ] as const)(
    'honors configured=$configured on a new run and saves its effective policy',
    async ({ configured, tokenLimit, status }) => {
      vi.stubEnv('AGENT_RUN_TOKEN_LIMIT', configured ? '100000' : '');
      vi.stubEnv('AGENT_RUN_MAX_MODEL_CALLS', configured ? '20' : '');
      vi.stubEnv('AGENT_RUN_MAX_TOOL_CALLS', configured ? '40' : '');
      const dataRoot = await mkdtemp(join(tmpdir(), 'xuwu-service-budget-'));
      roots.push(dataRoot);
      const service = new AgentService({
        dataRoot,
        appRoot: dataRoot,
        config: loadConfig(),
        onEvent: () => {},
      });
      const access = service as unknown as {
        policy: RunPolicy;
        runTask(text: string, compactOnly: boolean): Promise<void>;
      };
      const messages: AssistantMessage[] = [];
      const completed: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'fixture result' }],
        model: model.id,
        api: model.api,
        provider: model.provider,
        timestamp: 1,
        stopReason: 'stop',
        usage: {
          input: 119980,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const wrapped = budgetedStream(
        () => {
          const stream = createAssistantMessageEventStream();
          stream.push({ type: 'done', reason: 'stop', message: completed });
          stream.end(completed);
          return stream;
        },
        () => access.policy,
      );
      Object.assign(service, {
        workspace: { id: 'session', items: [], execute: async () => [] },
        resources: { describe: () => [] },
        session: {
          messages,
          agent: { convertToLlm: (messages: unknown[]) => messages },
          systemPrompt: 'fixture',
          sendCustomMessage: async () => {},
          abort: async () => {},
          prompt: async () => {
            messages.push(
              await (
                await wrapped(
                  model,
                  normalizeContext({
                    messages: [{ role: 'user', content: 'continue', timestamp: 1 }],
                  }),
                )
              ).result(),
            );
          },
        },
        // A historical failed run must not reimpose its old default on the next run.
        run: { id: 'previous', status: 'budget_exhausted', tokens: 63980, tokenLimit: 100000 },
      });
      await access.runTask('continue', false);
      expect(service.getRun()).toMatchObject({ tokenLimit, status, tokens: 120000, modelCalls: 1 });
      const saved = JSON.parse(await readFile(join(dataRoot, 'runs', 'session.latest.json'), 'utf8'));
      expect(saved.run).toMatchObject({ tokenLimit, status, tokens: 120000 });
      const trace = (await readFile(saved.tracePath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(trace.find((row) => row.type === 'run_start').limits).toMatchObject({
        tokenLimit,
        maxModelCalls: configured ? 20 : null,
        maxToolCalls: configured ? 40 : null,
      });
      expect(trace.find((row) => row.type === 'budget_check')).toMatchObject({
        limit: tokenLimit,
        allowed: true,
      });
    },
  );
});
