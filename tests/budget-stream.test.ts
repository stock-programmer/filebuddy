import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { budgetedStream, estimateTokens, RunPolicy } from '../src/agent/run-policy.js';
import { loadConfig } from '../src/config.js';
import { LEGACY_LIMITS } from './fixtures/legacy-profile.js';
import { TraceWriter } from '../src/observability/trace.js';

const model: Model<'openai-completions'> = {
  id: 'test',
  name: 'test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: 'https://localhost',
  reasoning: false,
  input: ['text'],
  contextWindow: 65536,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: TranscriptContext = normalizeContext({
  messages: [{ role: 'user', content: '请整理文字', timestamp: 1 }],
});
function message(total = 100, failed = false): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '完成' }],
    model: 'test',
    api: 'openai-completions',
    provider: 'test',
    timestamp: 1,
    stopReason: failed ? 'error' : 'stop',
    errorMessage: failed ? 'network disconnected' : undefined,
    usage: {
      input: total ? 30 : 0,
      output: total ? 20 : 0,
      cacheRead: total ? 50 : 0,
      cacheWrite: 0,
      totalTokens: total,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function completed(result: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (result.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: result });
  else stream.push({ type: 'done', reason: 'stop', message: result });
  stream.end(result);
  return stream;
}
const roots: string[] = [];
const policies: RunPolicy[] = [];
async function policy(overrides: Partial<typeof LEGACY_LIMITS> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-budget-'));
  roots.push(root);
  const value = new RunPolicy({ ...LEGACY_LIMITS, ...overrides }, new TraceWriter(root, 'session', 'run'));
  policies.push(value);
  return value;
}
afterEach(async () => {
  policies.splice(0).forEach((p) => p.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('budget adapter around actual Pi stream contract', () => {
  it('allows the previously blocked next request when no run budget is configured', async () => {
    const run = await policy();
    run.tokens = 63980;
    const nextContext = normalizeContext({
      messages: [{ role: 'user', content: '文件'.repeat(12450), timestamp: 1 }],
    });
    const input = estimateTokens(nextContext);
    expect(input).toBeGreaterThan(39000);
    expect(input).toBeLessThan(41000);
    expect(input).toBeGreaterThan(100000 - run.tokens);
    let calls = 0;
    const wrapped = budgetedStream(
      () => {
        calls++;
        return completed(message(42000));
      },
      () => run,
    );
    const result = await (await wrapped(model, nextContext)).result();
    expect(result.stopReason).toBe('stop');
    expect(calls).toBe(1);
    expect(run.tokens).toBe(105980);
    expect(run.status).toBe('running');
    expect(run.controller.signal.aborted).toBe(false);
    const trace = (await readFile(run.trace.path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(trace.find((row) => row.type === 'budget_check')).toMatchObject({
      used: 63980,
      inputEstimate: input,
      outputReservation: 4096,
      limit: null,
      allowed: true,
    });
  });

  it('keeps counting successful work past all former default run caps', async () => {
    const run = await policy();
    const wrapped = budgetedStream(
      () => completed(message(6000)),
      () => run,
    );
    for (let index = 0; index < 21; index++) {
      expect((await (await wrapped(model, context)).result()).stopReason).toBe('stop');
    }
    for (let index = 0; index < 41; index++) {
      run.beginTool('read', { path: `file-${index}.txt` });
      run.toolSucceeded();
    }
    expect(run.limits).toMatchObject({ tokenLimit: null, maxModelCalls: null, maxToolCalls: null });
    expect(run.tokens).toBe(126000);
    expect(run.modelCalls).toBe(21);
    expect(run.toolCalls).toBe(41);
    expect(run.status).toBe('running');
    expect(run.controller.signal.aborted).toBe(false);
    const trace = (await readFile(run.trace.path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(21);
    expect(trace.some((row) => row.type === 'boundary_decision' && row.decision === 'stop')).toBe(false);
  });

  it('still enforces an explicitly configured model request cap', async () => {
    const run = await policy({ maxModelCalls: 2 });
    let calls = 0;
    const wrapped = budgetedStream(
      () => {
        calls++;
        return completed(message());
      },
      () => run,
    );
    await (await wrapped(model, context)).result();
    await (await wrapped(model, context)).result();
    const result = await (await wrapped(model, context)).result();
    expect(calls).toBe(2);
    expect(run.modelCalls).toBe(2);
    expect(run.tokens).toBe(200);
    expect(run.status).toBe('budget_exhausted');
    expect(result.errorMessage).toContain('MODEL_LIMIT');
  });

  it('still enforces an explicitly configured tool call cap', async () => {
    const run = await policy({ maxToolCalls: 2 });
    run.beginTool('read', { path: 'one.txt' });
    run.toolSucceeded();
    run.beginTool('read', { path: 'two.txt' });
    run.toolSucceeded();
    expect(() => run.beginTool('read', { path: 'three.txt' })).toThrow('TOOL_LIMIT');
    expect(run.toolCalls).toBe(2);
    expect(run.status).toBe('budget_exhausted');
  });

  it('allows different tool failures without a total cap while retaining repeated-failure protection', async () => {
    const run = await policy({ maxToolFailures: null });
    for (let index = 0; index < 7; index++) {
      const args = { path: `missing-${index}.txt` };
      run.beginTool('read', args);
      run.toolFailed('read', args, 'NOT_FOUND');
    }
    expect(run.failures).toBe(7);
    expect(run.status).toBe('running');
    const repeated = { path: 'repeated.txt' };
    for (let index = 0; index < run.limits.maxRepeatedFailures; index++) {
      run.beginTool('read', repeated);
      run.toolFailed('read', repeated, 'NOT_FOUND');
    }
    expect(() => run.beginTool('read', repeated)).toThrow('REPEATED_FAILURE');
    expect(run.status).toBe('failed');
  });

  it('still stops at an explicitly configured cumulative tool-failure cap', async () => {
    const run = await policy({ maxToolFailures: 2 });
    run.beginTool('read', { path: 'one.txt' });
    run.toolFailed('read', { path: 'one.txt' }, 'NOT_FOUND');
    expect(run.status).toBe('running');
    run.beginTool('read', { path: 'two.txt' });
    run.toolFailed('read', { path: 'two.txt' }, 'NOT_FOUND');
    expect(run.failures).toBe(2);
    expect(run.reason).toContain('FAILURE_LIMIT');
    expect(run.status).toBe('failed');
    expect(() => run.beginTool('read', { path: 'three.txt' })).toThrow('FAILURE_LIMIT');
  });

  it('still enforces a configured token cap after actual usage is known', async () => {
    const run = await policy({ tokenLimit: 1000, outputTokens: 500 });
    const wrapped = budgetedStream(
      () => completed(message(1200)),
      () => run,
    );
    await (await wrapped(model, context)).result();
    expect(run.modelCalls).toBe(1);
    expect(run.tokens).toBe(1200);
    expect(run.status).toBe('budget_exhausted');
    expect(run.reason).toContain('TOKEN_LIMIT');
  });

  it('keeps tool result payloads bounded without treating usage as an implicit run cap', async () => {
    const unbounded = await policy();
    unbounded.tokens = 1000000;
    expect(unbounded.resultByteLimit()).toBe(16384);
    const bounded = await policy({ tokenLimit: 1000 });
    expect(bounded.resultByteLimit()).toBe(1500);
    bounded.tokens = 1000;
    expect(bounded.resultByteLimit()).toBe(512);
  });

  it.each([null, 100000])(
    'identifies an insufficient output setting with token cap %s',
    async (tokenLimit) => {
      const run = await policy({ tokenLimit, outputTokens: 128 });
      let calls = 0;
      const wrapped = budgetedStream(
        () => {
          calls++;
          return completed(message());
        },
        () => run,
      );
      const result = await (await wrapped(model, context)).result();
      expect(calls).toBe(0);
      expect(run.tokens).toBe(0);
      expect(result.errorMessage).toContain('OUTPUT_LIMIT');
      expect(result.errorMessage).not.toContain('TOKEN_LIMIT');
    },
  );

  it('accounts normalized usage once, enforces output/retry options, and shares a ledger with summaries', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 180000, requestIdleTimeoutMs: 120000 });
    const optionsSeen: unknown[] = [];
    const wrapped = budgetedStream(
      (_model, _context, options) => {
        optionsSeen.push(options);
        return completed(message(100));
      },
      () => run,
    );
    await (await wrapped(model, context)).result();
    expect(run.tokens).toBe(100);
    run.requestKind = 'compaction';
    await (await wrapped(model, context, { maxTokens: 8000, timeoutMs: 300000 })).result();
    await (await wrapped(model, context)).result();
    expect(run.tokens).toBe(300);
    expect(run.modelCalls).toBe(3);
    expect(optionsSeen[1]).toMatchObject({ maxRetries: 0, maxTokens: 4096, timeoutMs: 180000 });
    expect(optionsSeen.every((options) => (options as { timeoutMs: number }).timeoutMs === 180000)).toBe(
      true,
    );
    const trace = (await readFile(run.trace.path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(trace.filter((row) => row.type === 'model_request' && row.kind === 'compaction')).toHaveLength(2);
    expect(trace.filter((row) => row.type === 'model_request')).toEqual([
      expect.objectContaining({ timeouts: { totalMs: null, firstContentMs: 180000, idleMs: 120000 } }),
      expect.objectContaining({ timeouts: { totalMs: null, firstContentMs: 180000, idleMs: 120000 } }),
      expect.objectContaining({ timeouts: { totalMs: null, firstContentMs: 180000, idleMs: 120000 } }),
    ]);
  });
  it('blocks oversized complete context before any provider call', async () => {
    const run = await policy({ contextWindow: 8192 });
    let called = false;
    const wrapped = budgetedStream(
      () => {
        called = true;
        return completed(message());
      },
      () => run,
    );
    const result = await (
      await wrapped(
        model,
        normalizeContext({ messages: [{ role: 'user', content: '中文'.repeat(20000), timestamp: 1 }] }),
      )
    ).result();
    expect(called).toBe(false);
    expect(result.stopReason).toBe('error');
    expect(run.status).toBe('budget_exhausted');
    expect(run.modelCalls).toBe(0);
  });
  it('retains reservations for unknown failed usage and refuses an unbudgeted retry', async () => {
    const run = await policy({ tokenLimit: 800, outputTokens: 500 });
    let calls = 0;
    const wrapped = budgetedStream(
      () => {
        calls++;
        return completed(message(0, true));
      },
      () => run,
    );
    await (await wrapped(model, context)).result();
    expect(run.tokens).toBe(estimateTokens(context) + 500);
    await (await wrapped(model, context)).result();
    expect(calls).toBe(1);
    expect(run.status).toBe('budget_exhausted');
  });
  it('returns a protocol error when the provider throws without losing reserved consumption', async () => {
    const run = await policy();
    const wrapped = budgetedStream(
      async () => {
        throw new Error('connection reset');
      },
      () => run,
    );
    const result = await (await wrapped(model, context)).result();
    expect(result.stopReason).toBe('error');
    expect(run.tokens).toBeGreaterThan(4096);
    expect(await readFile(run.trace.path, 'utf8')).toContain('reservation_unknown_actual');
  });
  it('propagates cancellation and prevents subsequent model requests', async () => {
    const run = await policy();
    let calls = 0;
    const source: StreamFn = (_model, _context, options) => {
      calls++;
      const stream = createAssistantMessageEventStream();
      options!.signal!.addEventListener(
        'abort',
        () => {
          const result = { ...message(0), stopReason: 'aborted' as const, errorMessage: 'cancelled' };
          stream.push({ type: 'error', reason: 'aborted', error: result });
          stream.end(result);
        },
        { once: true },
      );
      return stream;
    };
    const wrapped = budgetedStream(source, () => run);
    const stream = await wrapped(model, context);
    run.stop('cancelled', 'test cancellation');
    expect((await stream.result()).stopReason).toBe('aborted');
    await (await wrapped(model, context)).result();
    expect(calls).toBe(1);
  });

  it('redacts configured credentials even when a provider echoes a nonstandard key', async () => {
    const run = await policy();
    const secret = 'fixture_random_key_without_prefix_9238';
    const trace = new TraceWriter(run.trace.dataRoot, 'redacted', 'run', [secret]);
    const protectedRun = new RunPolicy(LEGACY_LIMITS, trace);
    policies.push(protectedRun);
    const wrapped = budgetedStream(
      () => completed({ ...message(0, true), errorMessage: `Invalid credential ${secret}` }),
      () => protectedRun,
    );
    const result = await (await wrapped(model, context)).result();
    expect(result.errorMessage).not.toContain(secret);
    expect(await readFile(trace.path, 'utf8')).not.toContain(secret);
    trace.record('tool_start', {
      args: { content: 'sensitive file body', sourcePath: 'C:\\private\\file.txt', apiKey: secret },
    });
    const body = await readFile(trace.path, 'utf8');
    expect(body).not.toContain('sensitive file body');
    expect(body).not.toContain('C:\\private');
  });
});

describe('explicit run budget settings', () => {
  const settings = [
    ['AGENT_RUN_TOKEN_LIMIT', 'tokenLimit'],
    ['AGENT_RUN_MAX_MODEL_CALLS', 'maxModelCalls'],
    ['AGENT_RUN_MAX_TOOL_CALLS', 'maxToolCalls'],
    ['AGENT_RUN_MAX_TOOL_FAILURES', 'maxToolFailures'],
  ] as const;

  it('leaves every run cap unset when no setting is provided', () => {
    expect(loadConfig({ env: {} }).run).toMatchObject({
      tokenLimit: null,
      maxModelCalls: null,
      maxToolCalls: null,
      maxToolFailures: null,
    });
  });

  it.each(settings)('%s accepts a positive safe integer and treats blank as unset', (name, field) => {
    for (const raw of ['', '   ']) expect(loadConfig({ env: { [name]: raw } }).run[field]).toBeNull();
    for (const value of [1, 100000, Number.MAX_SAFE_INTEGER]) {
      expect(loadConfig({ env: { [name]: ` ${value} ` } }).run[field]).toBe(value);
    }
  });

  it.each(settings)('%s rejects invalid caps instead of silently ignoring them', (name) => {
    for (const raw of ['0', '-1', '1.5', 'Infinity', 'NaN', 'invalid', '9007199254740992']) {
      expect(() => loadConfig({ env: { [name]: raw } })).toThrow(name);
    }
  });

  it.each(settings)('%s also rejects invalid programmatic limits', async (_name, field) => {
    const run = await policy();
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new RunPolicy({ ...LEGACY_LIMITS, [field]: value }, run.trace)).toThrow(field);
    }
  });
});
