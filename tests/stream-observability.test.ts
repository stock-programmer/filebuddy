import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { budgetedStream, estimateTokens, RunPolicy } from '../src/agent/run-policy.js';
import { LEGACY_LIMITS } from './fixtures/legacy-profile.js';
import { TraceWriter } from '../src/observability/trace.js';
import type { InputTokenCounter } from '../src/agent/kimi-token-count.js';

const epoch = 1_800_000_000_000;
const model: Model<'openai-completions'> = {
  id: 'stream-fixture',
  name: 'stream fixture',
  api: 'openai-completions',
  provider: 'fixture',
  baseUrl: 'https://localhost',
  reasoning: true,
  input: ['text'],
  contextWindow: 65536,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  messages: [{ role: 'user', content: 'private prompt fixture', timestamp: 1 }],
});
function message(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'private final fixture' }],
    model: model.id,
    api: model.api,
    provider: model.provider,
    timestamp: Date.now(),
    stopReason: 'stop',
    usage: {
      input: 30,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 50,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
type SourceStream = ReturnType<typeof createAssistantMessageEventStream>;
function delta(
  stream: SourceStream,
  type: 'text_delta' | 'thinking_delta' | 'toolcall_delta',
  value: string,
) {
  stream.push({ type, contentIndex: 0, delta: value, partial: message() });
}
function finish(stream: SourceStream) {
  const final = message();
  stream.push({ type: 'done', reason: 'stop', message: final });
  stream.end(final);
}
const roots: string[] = [];
const policies: RunPolicy[] = [];
async function policy(overrides: Partial<typeof LEGACY_LIMITS> = {}, onChange = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-stream-'));
  roots.push(root);
  const run = new RunPolicy(
    { ...LEGACY_LIMITS, ...overrides },
    new TraceWriter(root, 'session', 'run'),
    onChange,
  );
  policies.push(run);
  return run;
}
async function rows(run: RunPolicy) {
  return (await readFile(run.trace.path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}
function timestamp(value: string | number | null) {
  return value === null ? null : typeof value === 'number' ? value : Date.parse(value);
}
async function open(run: RunPolicy, source = createAssistantMessageEventStream()) {
  const stream = await budgetedStream(
    () => source,
    () => run,
  )(model, context);
  let result: AssistantMessage | undefined;
  const completed = stream.result().then((value) => {
    result = value;
    return value;
  });
  await vi.advanceTimersByTimeAsync(0);
  return { source, stream, completed, result: () => result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(epoch);
});
afterEach(async () => {
  policies.splice(0).forEach((run) => run.close());
  vi.clearAllTimers();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('model stream timeouts and observable progress', () => {
  it.each(['text_delta', 'thinking_delta', 'toolcall_delta'] as const)(
    'allows ongoing %s beyond both the former 5 minute request and 10 minute run deadlines',
    async (type) => {
      const run = await policy();
      const active = await open(run);
      for (let index = 0; index < 21; index++) {
        await vi.advanceTimersByTimeAsync(30000);
        delta(active.source, type, 'private progress fragment');
        await vi.advanceTimersByTimeAsync(0);
        expect(active.result()).toBeUndefined();
        expect(run.status).toBe('running');
      }
      expect(Date.now() - run.started).toBe(630000);
      finish(active.source);
      expect((await active.completed).stopReason).toBe('stop');
      expect(run.status).toBe('running');
      expect(run.tokens).toBe(50);
      const trace = await rows(run);
      expect(trace.find((row) => row.type === 'model_request').timeouts).toEqual({
        totalMs: null,
        firstContentMs: 90000,
        idleMs: 90000,
      });
      expect(trace.find((row) => row.type === 'model_response').elapsedMs).toBe(630000);
      expect(trace.filter((row) => row.decision === 'request_timeout')).toHaveLength(0);
    },
  );

  it('records first/last event and content timing, event counts, character counts, and phases without payloads', async () => {
    const phases: string[] = [];
    let run: RunPolicy;
    run = await policy({}, () => {
      if (run?.modelProgress) phases.push(run.modelProgress.phase);
    });
    const active = await open(run);
    await vi.advanceTimersByTimeAsync(25);
    active.source.push({ type: 'start', partial: message() });
    await vi.advanceTimersByTimeAsync(15);
    active.source.push({ type: 'thinking_start', contentIndex: 0, partial: message() });
    await vi.advanceTimersByTimeAsync(10);
    delta(active.source, 'thinking_delta', '');
    await vi.advanceTimersByTimeAsync(50);
    delta(active.source, 'thinking_delta', 'private thinking fixture');
    await vi.advanceTimersByTimeAsync(700);
    delta(active.source, 'text_delta', 'private answer fixture');
    await vi.advanceTimersByTimeAsync(500);
    delta(active.source, 'toolcall_delta', 'private tool arguments fixture');
    await vi.advanceTimersByTimeAsync(200);
    finish(active.source);
    await active.completed;
    const trace = await rows(run);
    const responses = trace.filter((row) => row.type === 'model_response');
    expect(responses).toHaveLength(1);
    const metrics = responses[0].streamMetrics;
    expect(metrics).toMatchObject({
      firstEventLatencyMs: 25,
      firstContentLatencyMs: 100,
      measurementScope: 'pi_stream_events',
      idleForMs: 200,
      maxContentGapMs: 700,
      eventCounts: {
        start: 1,
        thinking_start: 1,
        thinking_delta: 2,
        text_delta: 1,
        toolcall_delta: 1,
        done: 1,
      },
      characters: {
        text: 'private answer fixture'.length,
        thinking: 'private thinking fixture'.length,
        toolArguments: 'private tool arguments fixture'.length,
      },
    });
    expect(timestamp(metrics.firstEventAt)).toBe(epoch + 25);
    expect(timestamp(metrics.firstContentAt)).toBe(epoch + 100);
    expect(timestamp(metrics.lastEventAt)).toBe(epoch + 1500);
    expect(timestamp(metrics.lastContentAt)).toBe(epoch + 1300);
    expect(phases).toEqual(expect.arrayContaining(['waiting', 'thinking', 'answering', 'tool_arguments']));
    const updates = trace.filter((row) => row.type === 'model_stream_progress');
    expect(updates.length).toBeGreaterThanOrEqual(3);
    expect(updates.every((row) => row.streamMetrics?.measurementScope === 'pi_stream_events')).toBe(true);
    const request = trace.find((row) => row.type === 'model_request');
    expect([...responses, ...updates].every((row) => row.parentId === request.eventId)).toBe(true);
    const raw = await readFile(run.trace.path, 'utf8');
    for (const secret of [
      'private prompt fixture',
      'private final fixture',
      'private thinking fixture',
      'private answer fixture',
      'private tool arguments fixture',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('terminates a provider that never resolves without relying on its abort handler', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 100, requestIdleTimeoutMs: 50 });
    let signal: AbortSignal | undefined;
    const source: StreamFn = (_model, _context, options) => {
      signal = options?.signal;
      return new Promise(() => {});
    };
    const stream = await budgetedStream(source, () => run)(model, context);
    let result: AssistantMessage | undefined;
    void stream.result().then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(result?.stopReason).toBe('aborted');
    expect(signal?.aborted).toBe(true);
    expect(run.status).toBe('failed');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT');
    expect(run.tokens).toBe(estimateTokens(context) + LEGACY_LIMITS.outputTokens);
    const trace = await rows(run);
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(1);
    const response = trace.find((row) => row.type === 'model_response');
    expect(response.streamMetrics).toMatchObject({
      firstEventAt: null,
      firstEventLatencyMs: null,
      firstContentAt: null,
      firstContentLatencyMs: null,
      lastEventAt: null,
      lastContentAt: null,
      eventCounts: {},
      characters: { text: 0, thinking: 0, toolArguments: 0 },
      idleForMs: 100,
    });
    expect(trace.find((row) => row.decision === 'request_timeout')).toMatchObject({
      timeoutKind: 'first_content',
      timeoutMs: 100,
      timeoutPhase: 'waiting_first_content',
    });
  });

  it('periodically reports same-phase progress without writing one trace row per delta', async () => {
    const run = await policy();
    const active = await open(run);
    for (let index = 0; index < 100; index++) {
      await vi.advanceTimersByTimeAsync(20);
      delta(active.source, 'thinking_delta', 'x');
    }
    finish(active.source);
    await active.completed;
    const trace = await rows(run);
    const updates = trace.filter((row) => row.type === 'model_stream_progress');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.length).toBeLessThanOrEqual(3);
    expect(updates[0].streamMetrics.characters.thinking).toBe(1);
    expect(updates[1].streamMetrics.characters.thinking).toBeGreaterThan(1);
    const response = trace.find((row) => row.type === 'model_response');
    expect(response.streamMetrics.eventCounts.thinking_delta).toBe(100);
    expect(response.streamMetrics.characters.thinking).toBe(100);
  });

  it('does not let start events, usage-only partials or empty deltas postpone first-content timeout', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 100, requestIdleTimeoutMs: 50 });
    const active = await open(run);
    await vi.advanceTimersByTimeAsync(40);
    active.source.push({ type: 'start', partial: message() });
    await vi.advanceTimersByTimeAsync(40);
    delta(active.source, 'thinking_delta', '');
    await vi.advanceTimersByTimeAsync(20);
    expect(active.result()?.stopReason).toBe('aborted');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT');
    const response = (await rows(run)).find((row) => row.type === 'model_response');
    expect(response.streamMetrics.firstContentAt).toBeNull();
    expect(response.streamMetrics.eventCounts).toMatchObject({ start: 1, thinking_delta: 1 });
    expect(timestamp(response.streamMetrics.lastEventAt)).toBe(epoch + 80);
  });

  it('allows a longer first-content wait then switches to the shorter streaming idle limit', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 300, requestIdleTimeoutMs: 100 });
    const active = await open(run);
    await vi.advanceTimersByTimeAsync(250);
    expect(run.status).toBe('running');
    expect(active.result()).toBeUndefined();
    delta(active.source, 'thinking_delta', 'useful content');
    await vi.advanceTimersByTimeAsync(90);
    active.source.push({ type: 'start', partial: message() });
    delta(active.source, 'text_delta', '');
    await vi.advanceTimersByTimeAsync(9);
    expect(active.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(active.result()?.stopReason).toBe('aborted');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT: 模型流式输出连续 0.1 秒');
    const trace = await rows(run);
    expect(trace.find((row) => row.decision === 'request_timeout')).toMatchObject({
      timeoutKind: 'idle',
      timeoutMs: 100,
      timeoutPhase: 'streaming',
    });
    expect(trace.find((row) => row.type === 'model_response').streamMetrics).toMatchObject({
      firstContentLatencyMs: 250,
      idleForMs: 100,
      eventCounts: { thinking_delta: 1, start: 1, text_delta: 1 },
    });
  });

  it('starts first-content and SDK header waits after both official counts finish at payload send', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 100, requestIdleTimeoutMs: 40 });
    type Count = Awaited<ReturnType<InputTokenCounter['countContext']>>;
    let releaseContext!: (value: Count) => void;
    let releasePayload!: (value: Count) => void;
    const contextCount = new Promise<Count>((resolve) => {
      releaseContext = resolve;
    });
    const payloadCount = new Promise<Count>((resolve) => {
      releasePayload = resolve;
    });
    const counter: InputTokenCounter = {
      countContext: vi.fn(() => contextCount),
      countPayload: vi.fn(() => payloadCount),
    };
    let sentAt: number | undefined;
    let sdkTimeout: number | undefined;
    const source = createAssistantMessageEventStream();
    const provider: StreamFn = async (requestModel, _context, options) => {
      sdkTimeout = options?.timeoutMs;
      await options?.onPayload?.({ model: model.id, messages: [], max_tokens: 4096 }, requestModel);
      sentAt = Date.now();
      return source;
    };
    const stream = await budgetedStream(provider, () => run, counter)(model, context);
    let result: AssistantMessage | undefined;
    void stream.result().then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(sentAt).toBeUndefined();
    expect(result).toBeUndefined();
    expect(run.status).toBe('running');
    releaseContext({ tokens: 30, source: 'moonshot_tokenizer', payloadHash: 'context-fixture' });
    await vi.advanceTimersByTimeAsync(0);
    expect(counter.countPayload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(250);
    expect(sentAt).toBeUndefined();
    expect(result).toBeUndefined();
    expect(run.status).toBe('running');
    releasePayload({ tokens: 30, source: 'moonshot_tokenizer', payloadHash: 'payload-fixture' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sentAt).toBe(epoch + 500);
    expect(sdkTimeout).toBe(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result?.stopReason).toBe('aborted');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT: 等待模型首段有效内容超过 0.1 秒');
    const trace = await rows(run);
    expect(trace.find((row) => row.decision === 'request_timeout')).toMatchObject({
      timeoutKind: 'first_content',
      timeoutMs: 100,
      timeoutPhase: 'waiting_first_content',
    });
    expect(trace.filter((row) => row.type === 'model_payload')).toHaveLength(1);
    expect(trace.find((row) => row.type === 'model_response').elapsedMs).toBe(600);
  });

  it.each(['text_delta', 'thinking_delta', 'toolcall_delta'] as const)(
    'refreshes idle timeout on %s and detects a later stall',
    async (type) => {
      const run = await policy({ requestIdleTimeoutMs: 100 });
      const active = await open(run);
      await vi.advanceTimersByTimeAsync(70);
      delta(active.source, type, 'progress');
      await vi.advanceTimersByTimeAsync(99);
      expect(active.result()).toBeUndefined();
      expect(run.status).toBe('running');
      await vi.advanceTimersByTimeAsync(1);
      expect(active.result()?.stopReason).toBe('aborted');
      expect(run.reason).toContain('MODEL_IDLE_TIMEOUT');
      const response = (await rows(run)).find((row) => row.type === 'model_response');
      expect(response.streamMetrics.idleForMs).toBe(100);
      expect(timestamp(response.streamMetrics.lastContentAt)).toBe(epoch + 70);
    },
  );

  it('still detects an idle stream after more than 10 minutes of useful content', async () => {
    const run = await policy();
    const active = await open(run);
    for (let index = 0; index < 21; index++) {
      await vi.advanceTimersByTimeAsync(30000);
      delta(active.source, 'thinking_delta', 'still active');
    }
    await vi.advanceTimersByTimeAsync(89999);
    expect(active.result()).toBeUndefined();
    expect(run.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(active.result()?.stopReason).toBe('aborted');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT');
    expect(run.status).toBe('failed');
    const trace = await rows(run);
    expect(trace.filter((row) => row.decision === 'request_timeout')).toEqual([
      expect.objectContaining({ timeoutKind: 'idle', timeoutMs: 90000 }),
    ]);
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(1);
    expect(trace.find((row) => row.type === 'model_response')).toMatchObject({
      elapsedMs: 720000,
      streamMetrics: { idleForMs: 90000, lastContentAt: new Date(epoch + 630000).toISOString() },
    });
  });

  it('keeps timeout classification when an abort-aware provider rejects', async () => {
    const run = await policy({ requestFirstContentTimeoutMs: 100, requestIdleTimeoutMs: 50 });
    const source: StreamFn = (_model, _context, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('provider abort rejection')), {
          once: true,
        });
      });
    const stream = await budgetedStream(source, () => run)(model, context);
    let result: AssistantMessage | undefined;
    void stream.result().then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(result?.errorMessage).toContain('MODEL_IDLE_TIMEOUT');
    expect(run.reason).toContain('MODEL_IDLE_TIMEOUT');
    expect((await rows(run)).filter((row) => row.type === 'model_response')).toHaveLength(1);
  });

  it('classifies an ordinary provider rejection as an error without inventing a timeout', async () => {
    const run = await policy();
    const stream = await budgetedStream(
      async () => {
        throw new Error('fixture network reset');
      },
      () => run,
    )(model, context);
    const result = await stream.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('fixture network reset');
    const trace = await rows(run);
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(1);
    expect(trace.filter((row) => row.decision === 'request_timeout')).toHaveLength(0);
  });

  it('settles cancellation immediately after a long stream even if the provider ignores abort', async () => {
    const run = await policy();
    const active = await open(run);
    for (let index = 0; index < 21; index++) {
      await vi.advanceTimersByTimeAsync(30000);
      delta(active.source, 'thinking_delta', 'still active');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(active.result()).toBeUndefined();
    run.stop('cancelled', 'USER_CANCELLED: fixture cancellation');
    await vi.advanceTimersByTimeAsync(0);
    expect(active.result()?.stopReason).toBe('aborted');
    expect(run.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(LEGACY_LIMITS.requestIdleTimeoutMs);
    const trace = await rows(run);
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(1);
    expect(trace.filter((row) => row.decision === 'request_timeout')).toHaveLength(0);
  });

  it('preserves an independent partial-result snapshot when a provider mutates its shared message after timeout', async () => {
    const run = await policy({ requestIdleTimeoutMs: 100 });
    const active = await open(run);
    const thinking = { type: 'thinking' as const, thinking: 'content before timeout' };
    const argumentsObject = { path: { name: 'before.txt' } };
    const partial: AssistantMessage = {
      ...message(),
      content: [thinking, { type: 'toolCall', id: 'call-1', name: 'read', arguments: argumentsObject }],
    };
    await vi.advanceTimersByTimeAsync(20);
    active.source.push({ type: 'thinking_delta', contentIndex: 0, delta: thinking.thinking, partial });
    await vi.advanceTimersByTimeAsync(100);
    expect(active.result()?.stopReason).toBe('aborted');
    const settled = await active.completed;
    const snapshot = structuredClone(settled);
    expect(settled.content).toEqual(partial.content);
    expect(settled.content).not.toBe(partial.content);
    const traceSnapshot = await readFile(run.trace.path, 'utf8');

    thinking.thinking += ' content after timeout';
    argumentsObject.path.name = 'after.txt';
    partial.content.push({ type: 'text', text: 'late final answer' });
    active.source.push({ type: 'thinking_delta', contentIndex: 0, delta: ' content after timeout', partial });
    active.source.push({ type: 'done', reason: 'stop', message: partial });
    active.source.end(partial);
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toEqual(snapshot);
    expect(await active.stream.result()).toEqual(snapshot);
    expect(await readFile(run.trace.path, 'utf8')).toBe(traceSnapshot);
    expect((await rows(run)).filter((row) => row.type === 'model_response')).toHaveLength(1);
  });

  it('allows later model requests and tools after multiple requests exceed 10 minutes in total', async () => {
    const run = await policy();
    for (let request = 0; request < 4; request++) {
      const active = await open(run);
      for (let chunk = 0; chunk < 6; chunk++) {
        await vi.advanceTimersByTimeAsync(30000);
        delta(active.source, 'text_delta', 'progress');
      }
      finish(active.source);
      expect((await active.completed).stopReason).toBe('stop');
      expect(() => run.beginTool('read', { path: `file-${request}.txt` })).not.toThrow();
      run.toolSucceeded();
    }
    expect(Date.now() - run.started).toBe(720000);
    const next = await open(run);
    delta(next.source, 'text_delta', 'later request');
    finish(next.source);
    expect((await next.completed).stopReason).toBe('stop');
    expect(run.status).toBe('running');
    expect(run.modelCalls).toBe(5);
    expect(run.toolCalls).toBe(4);
    expect(run.tokens).toBe(250);
    const trace = await rows(run);
    expect(trace.filter((row) => row.type === 'model_response')).toHaveLength(5);
    expect(trace.filter((row) => row.decision === 'request_timeout')).toHaveLength(0);
    expect(trace.filter((row) => row.decision === 'stop')).toHaveLength(0);
  });

  it('ignores late chunks and completion from a timed-out stream while another run is active', async () => {
    const previous = await policy({ requestFirstContentTimeoutMs: 100, requestIdleTimeoutMs: 100 });
    let current = previous;
    const staleSource = createAssistantMessageEventStream();
    const nextSource = createAssistantMessageEventStream();
    let calls = 0;
    const wrapped = budgetedStream(
      () => (++calls === 1 ? staleSource : nextSource),
      () => current,
    );
    const first = await wrapped(model, context);
    const firstEvents: AssistantMessageEvent[] = [];
    const drained = (async () => {
      for await (const event of first) firstEvents.push(event);
    })();
    let firstResult: AssistantMessage | undefined;
    void first.result().then((value) => {
      firstResult = value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(firstResult?.stopReason).toBe('aborted');
    await drained;
    const previousSnapshot = await readFile(previous.trace.path, 'utf8');
    const previousTokens = previous.tokens;
    current = await policy({ requestIdleTimeoutMs: 100 });
    const next = await wrapped(model, context);
    await vi.advanceTimersByTimeAsync(10);
    delta(nextSource, 'thinking_delta', 'new progress');
    await vi.advanceTimersByTimeAsync(10);
    delta(staleSource, 'text_delta', 'LATE PRIVATE CHUNK');
    finish(staleSource);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.modelProgress?.phase).toBe('thinking');
    expect(previous.tokens).toBe(previousTokens);
    expect(await readFile(previous.trace.path, 'utf8')).toBe(previousSnapshot);
    expect(firstEvents.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(firstEvents.some((event) => event.type === 'text_delta')).toBe(false);
    finish(nextSource);
    expect((await next.result()).stopReason).toBe('stop');
    const response = (await rows(current)).find((row) => row.type === 'model_response');
    expect(response.streamMetrics.eventCounts.text_delta ?? 0).toBe(0);
    expect(response.streamMetrics.characters.thinking).toBe('new progress'.length);
  });
});
