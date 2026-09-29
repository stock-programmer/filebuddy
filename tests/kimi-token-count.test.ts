import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createModelRuntime } from '../src/agent/model-runtime.js';
import { createKimiTokenCounter } from '../src/agent/kimi-token-count.js';
import { resolveConfig } from '../src/config.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

async function fixture() {
  const requests: { path?: string; payload: Record<string, unknown> }[] = [];
  let status = 200;
  let reply: unknown = { data: { total_tokens: 94 } };
  let onRequest: (() => void) | undefined;
  let hold = false;
  let timeoutMs = 5000;
  const held: ServerResponse[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    onRequest?.();
    if (hold) {
      held.push(response);
      return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    held.forEach((response) => response.destroy());
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local tokenizer fixture address');
  const config = resolveConfig({
    model: {
      model: 'kimi-k3',
      apiKey: 'fixture-count-secret',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    },
  });
  const { runtime, model } = await createModelRuntime(config.model);
  const counter = createKimiTokenCounter({
    model,
    apiKey: config.model.apiKey,
    timeoutMs: () => timeoutMs,
    reasoning: 'high',
    stream: (requestModel, context, options) => runtime.streamSimple(requestModel, context, options),
  });
  return {
    counter,
    requests,
    respond: (nextStatus: number, body: unknown) => {
      status = nextStatus;
      reply = body;
    },
    timeout: (value: number) => {
      timeoutMs = value;
    },
    hold: () => {
      hold = true;
      return new Promise<void>((resolve) => {
        onRequest = resolve;
      });
    },
  };
}

const context = normalizeContext({
  messages: [{ role: 'user', content: 'synthetic tokenizer input', timestamp: 1 }],
});

describe('Kimi SDK payload capture and official token-count contract', () => {
  it('captures the real SDK payload without sending a completion and caches only equivalent inputs', async () => {
    const f = await fixture();
    const first = await f.counter.countContext(context);
    expect(first).toMatchObject({ tokens: 94, source: 'moonshot_tokenizer' });
    expect(first.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].path).toBe('/v1/tokenizers/estimate-token-count');
    expect(f.requests[0].payload).toMatchObject({
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'synthetic tokenizer input' }],
    });
    await expect(f.counter.countContext(context)).resolves.toEqual(first);
    await expect(
      f.counter.countPayload({
        ...f.requests[0].payload,
        max_completion_tokens: 1234,
        reasoning_effort: 'low',
      }),
    ).resolves.toEqual(first);
    expect(f.requests).toHaveLength(1);

    f.respond(200, { data: { total_tokens: 185 } });
    const withTools = {
      ...f.requests[0].payload,
      tools: [
        {
          type: 'function',
          function: {
            name: 'fixture_tool',
            description: 'synthetic tool',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    };
    const tools = await f.counter.countPayload(withTools);
    expect(tools.tokens).toBe(185);
    expect(tools.payloadHash).not.toBe(first.payloadHash);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every((request) => request.path === '/v1/tokenizers/estimate-token-count')).toBe(true);
  });

  it('rejects count failures without falling back or leaking response text and credentials', async () => {
    const f = await fixture();
    f.respond(503, { error: 'private-response-body fixture-count-secret https://private.example.test' });
    let failure: unknown;
    try {
      await f.counter.countContext(context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('HTTP 503');
    expect((failure as Error).message).not.toMatch(
      /private-response-body|fixture-count-secret|private\.example/,
    );
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].path).toContain('estimate-token-count');
    f.respond(200, { data: { total_tokens: '94' } });
    await expect(f.counter.countContext(context)).rejects.toThrow('TOKEN_COUNT_RESPONSE');
    expect(f.requests).toHaveLength(2);
  });

  it('propagates cancellation of an in-flight tokenizer request and never sends a completion', async () => {
    const f = await fixture();
    const requested = f.hold();
    const controller = new AbortController();
    const result = f.counter.countContext(context, { signal: controller.signal });
    const rejected = expect(result).rejects.toThrow('fixture-count-cancelled');
    await requested;
    controller.abort(new Error('fixture-count-cancelled'));
    await rejected;
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].path).toBe('/v1/tokenizers/estimate-token-count');
  });

  it('reads the current timeout instead of retaining the value from counter creation', async () => {
    const f = await fixture();
    f.hold();
    f.timeout(50);
    await expect(f.counter.countContext(context)).rejects.toThrow('TOKEN_COUNT_TIMEOUT');
    expect(f.requests.every((request) => request.path === '/v1/tokenizers/estimate-token-count')).toBe(true);
  });
});
