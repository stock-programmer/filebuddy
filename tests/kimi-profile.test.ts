import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeContext, type AssistantMessage } from '@earendil-works/pi-ai';
import { getRunLimits, resolveConfig } from '../src/config.js';
import { createModelRuntime } from '../src/agent/model-runtime.js';
import { budgetedStream, RunPolicy } from '../src/agent/run-policy.js';
import { TraceWriter } from '../src/observability/trace.js';
import type { InputTokenCounter } from '../src/agent/kimi-token-count.js';

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xuwu-kimi-profile-'))
      throw new Error('Unsafe profile test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

async function endpoint() {
  const payloads: Record<string, any>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: unknown) => ({
      id: 'fixture-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'kimi-k3',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    for (const data of [
      chunk({ role: 'assistant', reasoning_content: 'private returned reasoning fixture' }, null),
      chunk({ content: 'done' }, null),
      chunk({}, 'stop', { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }),
    ])
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return { payloads, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

describe('Kimi K3 provider payload', () => {
  it('sends independent 32K high/low request budgets through the real Pi adapter and preserves reasoning replay', async () => {
    const local = await endpoint();
    const secret = 'fixture-api-key-never-in-trace';
    const config = resolveConfig({ model: { baseUrl: local.baseUrl, apiKey: secret } });
    const { runtime, model } = await createModelRuntime(config.model);
    expect(model).toMatchObject({
      id: 'kimi-k3',
      reasoning: true,
      contextWindow: 1048576,
      maxTokens: 1048576,
      compat: {
        maxTokensField: 'max_completion_tokens',
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
      },
    });
    const root = await mkdtemp(join(tmpdir(), 'xuwu-kimi-profile-'));
    roots.push(root);
    const trace = new TraceWriter(root, 'session', 'run', [secret]);
    const policy = new RunPolicy(getRunLimits(config), trace);
    const previous: AssistantMessage = {
      role: 'assistant',
      model: model.id,
      provider: model.provider,
      api: model.api,
      timestamp: 1,
      content: [
        // This signature is emitted by Pi when reasoning_content arrives from the provider.
        {
          type: 'thinking',
          thinking: 'private replay reasoning fixture',
          thinkingSignature: 'reasoning_content',
        },
        { type: 'toolCall', id: 'call_fixture', name: 'read', arguments: { path: 'fixture.txt' } },
      ],
      stopReason: 'toolUse',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const context = normalizeContext({
      messages: [
        { role: 'user', content: 'private user fixture', timestamp: 1 },
        previous,
        {
          role: 'toolResult',
          toolCallId: 'call_fixture',
          toolName: 'read',
          content: [{ type: 'text', text: 'private file fixture' }],
          isError: false,
          timestamp: 2,
        },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read a fixture file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
      ],
    });
    const system = context.messages.find((message) => message.role === 'system');
    expect(system?.toolsAdded).toEqual([
      expect.objectContaining({ name: 'read', parameters: expect.objectContaining({ required: ['path'] }) }),
    ]);
    const wrapped = budgetedStream(
      (selected, transcript, options) => runtime.streamSimple(selected, transcript, options),
      () => policy,
    );
    let hookCalls = 0;
    let transcript = context;
    try {
      for (const kind of ['conversation', 'compaction'] as const) {
        policy.requestKind = kind;
        const result = await (
          await wrapped(model, transcript, {
            apiKey: secret,
            onPayload: (payload) => {
              hookCalls++;
              return { ...(payload as Record<string, unknown>), temperature: 0 };
            },
          })
        ).result();
        expect(result.stopReason).toBe('stop');
        expect(result.content).toContainEqual(
          expect.objectContaining({ type: 'thinking', thinking: 'private returned reasoning fixture' }),
        );
        transcript = normalizeContext({
          // The normalized transcript already carries tool declarations in its leading system message.
          messages: [
            ...context.messages,
            result,
            { role: 'user', content: 'Summarize the preceding work.', timestamp: 3 },
          ],
        });
      }
      expect(hookCalls).toBe(2);
      expect(local.payloads).toHaveLength(2);
      expect(local.payloads.map((payload) => payload.reasoning_effort)).toEqual(['high', 'low']);
      for (const payload of local.payloads) {
        expect(payload.max_completion_tokens).toBe(32768);
        expect(payload).not.toHaveProperty('max_tokens');
        expect(payload.temperature).toBe(0);
        expect(payload.tools).toEqual([
          expect.objectContaining({
            type: 'function',
            function: expect.objectContaining({
              name: 'read',
              parameters: expect.objectContaining({
                properties: { path: { type: 'string' } },
                required: ['path'],
              }),
            }),
          }),
        ]);
        expect(payload.messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe(
          'private replay reasoning fixture',
        );
      }
      expect(
        local.payloads[1].messages.filter((message: any) => message.role === 'assistant').at(-1)
          .reasoning_content,
      ).toBe('private returned reasoning fixture');
      const raw = await readFile(trace.path, 'utf8');
      for (const privateText of [
        secret,
        'private user fixture',
        'private file fixture',
        'private replay reasoning fixture',
        'private returned reasoning fixture',
      ])
        expect(raw).not.toContain(privateText);
      const payloadRows = raw
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((row) => row.type === 'model_payload');
      expect(payloadRows).toEqual([
        expect.objectContaining({
          kind: 'conversation',
          outputLimit: 32768,
          outputField: 'max_completion_tokens',
          reasoningEffort: 'high',
        }),
        expect.objectContaining({
          kind: 'compaction',
          outputLimit: 32768,
          outputField: 'max_completion_tokens',
          reasoningEffort: 'low',
        }),
      ]);
    } finally {
      policy.close();
    }
  }, 30000);

  it('keeps a custom generic provider on its explicit compatibility profile', async () => {
    const { model } = await createModelRuntime(resolveConfig({ model: { model: 'generic-fixture' } }).model);
    expect(model).toMatchObject({
      reasoning: false,
      compat: { supportsReasoningEffort: false, maxTokensField: 'max_tokens' },
    });
  });

  it.each([
    { tokenLimit: null, expectedOutput: 32768 },
    { tokenLimit: 1124, expectedOutput: 1024 },
  ])(
    'uses official input counts to restore only the approved $expectedOutput output tokens',
    async ({ tokenLimit, expectedOutput }) => {
      const local = await endpoint();
      const config = resolveConfig({
        model: { baseUrl: local.baseUrl, apiKey: 'fixture-key' },
        run: { tokenLimit },
      });
      const { runtime, model } = await createModelRuntime(config.model);
      const root = await mkdtemp(join(tmpdir(), 'xuwu-kimi-profile-'));
      roots.push(root);
      const policy = new RunPolicy(getRunLimits(config), new TraceWriter(root, 'session', 'counted'));
      const context = normalizeContext({
        messages: [
          { role: 'user', content: 'short fixture input', timestamp: 1 },
          {
            role: 'assistant',
            model: model.id,
            api: model.api,
            provider: model.provider,
            timestamp: 2,
            content: [{ type: 'text', text: 'previous answer' }],
            stopReason: 'stop',
            usage: {
              input: 1048500,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 1048505,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          { role: 'user', content: 'continue', timestamp: 3 },
        ],
      });
      const count = { tokens: 100, source: 'moonshot_tokenizer' as const, payloadHash: 'fixture-input-hash' };
      const counter: InputTokenCounter = { countContext: async () => count, countPayload: async () => count };
      let beforeGate: number | undefined;
      const wrapped = budgetedStream(
        (selected, transcript, options) => runtime.streamSimple(selected, transcript, options),
        () => policy,
        counter,
      );
      try {
        const result = await (
          await wrapped(model, context, {
            onPayload: (payload) => {
              beforeGate = (payload as any).max_completion_tokens;
            },
          })
        ).result();
        expect(result.stopReason).toBe('stop');
        expect(beforeGate).toBeLessThan(expectedOutput);
        expect(local.payloads).toHaveLength(1);
        expect(local.payloads[0].max_completion_tokens).toBe(expectedOutput);
        const rows = (await readFile(policy.trace.path, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(rows.find((row) => row.type === 'model_payload')).toMatchObject({
          inputTokens: 100,
          inputSource: 'moonshot_tokenizer',
          outputLimit: expectedOutput,
        });
      } finally {
        policy.close();
      }
    },
  );
});
