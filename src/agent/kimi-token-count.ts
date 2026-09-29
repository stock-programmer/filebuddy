import type { Model, Api, TranscriptContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { digest } from '../observability/trace.js';
import type { ReasoningEffort } from '../config.js';

export interface InputTokenCount {
  tokens: number;
  source: 'moonshot_tokenizer';
  payloadHash: string;
}
export interface InputTokenCounter {
  countContext(
    context: TranscriptContext,
    options?: { signal?: AbortSignal; reasoning?: ReasoningEffort },
  ): Promise<InputTokenCount>;
  countPayload(payload: unknown, signal?: AbortSignal): Promise<InputTokenCount>;
}

/** Count the SDK's actual input representation without duplicating its message/tool conversion. */
export function createKimiTokenCounter(options: {
  model: Model<Api>;
  apiKey: string;
  stream: StreamFn;
  timeoutMs: number | (() => number);
  reasoning: ReasoningEffort;
}): InputTokenCounter {
  const endpoint = `${options.model.baseUrl.replace(/\/+$/, '')}/tokenizers/estimate-token-count`;
  // Retain one hash and numeric result only, not the potentially million-token input.
  let cached: InputTokenCount | undefined;
  const requestSignal = (signal?: AbortSignal) =>
    AbortSignal.any([
      AbortSignal.timeout(typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
  async function countPayload(payload: unknown, signal?: AbortSignal): Promise<InputTokenCount> {
    signal?.throwIfAborted();
    if (!payload || typeof payload !== 'object') throw new Error('TOKEN_COUNT_PAYLOAD: 无法获取模型请求结构');
    const fields = payload as Record<string, unknown>;
    if (fields.model !== options.model.id || !Array.isArray(fields.messages))
      throw new Error('TOKEN_COUNT_PAYLOAD: 模型请求结构与计数模型不一致');
    const input = {
      model: fields.model,
      messages: fields.messages,
      ...(Array.isArray(fields.tools) ? { tools: fields.tools } : {}),
    };
    const payloadHash = digest(input);
    if (cached?.payloadHash === payloadHash) return cached;
    let response: Response;
    const combined = requestSignal(signal);
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify(input),
        signal: combined,
      });
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      throw new Error(
        combined.aborted
          ? 'TOKEN_COUNT_TIMEOUT: 官方 token 计数请求超时'
          : 'TOKEN_COUNT_NETWORK: 官方 token 计数请求未完成',
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`TOKEN_COUNT_HTTP: 官方 token 计数失败（HTTP ${response.status}）`);
    }
    let body: { data?: { total_tokens?: unknown } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      if (combined.aborted) throw new Error('TOKEN_COUNT_TIMEOUT: 官方 token 计数请求超时');
      throw new Error('TOKEN_COUNT_RESPONSE: 官方 token 计数返回无效数据');
    }
    signal?.throwIfAborted();
    const tokens = body?.data?.total_tokens;
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens < 0)
      throw new Error('TOKEN_COUNT_RESPONSE: 官方 token 计数返回无效 token 数');
    cached = { tokens, source: 'moonshot_tokenizer', payloadHash };
    return cached;
  }
  return {
    countPayload,
    async countContext(context, request = {}) {
      request.signal?.throwIfAborted();
      let captured: unknown;
      // The public onPayload callback runs before the SDK sends chat/completions.
      // Stop there with a fixed sentinel; this is preparation, never a completion request.
      try {
        await (
          await options.stream(options.model, context, {
            maxTokens: 1,
            reasoning: request.reasoning ?? options.reasoning,
            signal: requestSignal(request.signal),
            onPayload: (payload) => {
              captured = payload;
              throw new Error('TOKEN_COUNT_CAPTURE_ONLY');
            },
          })
        ).result();
      } catch {
        // Providers may return an error stream or reject. Neither raw error is safe diagnostics.
        request.signal?.throwIfAborted();
      }
      request.signal?.throwIfAborted();
      if (!captured) throw new Error('TOKEN_COUNT_PAYLOAD: 无法准备模型请求以执行官方 token 计数');
      return countPayload(captured, request.signal);
    },
  };
}
