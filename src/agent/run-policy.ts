import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ModelProgress, RunStatus } from '../app/contracts.js';
import { digest, type TraceWriter } from '../observability/trace.js';
import { abortable, ModelStreamMetrics } from '../observability/model-stream.js';
import {
  MIN_OUTPUT_TOKENS,
  validateBudget,
  inputLimit,
  compressionWatermark,
  type RunLimits,
} from '../config.js';
import type { InputTokenCounter } from './kimi-token-count.js';

/** Conservative mixed Chinese/ASCII approximation; usage, when present, corrects the reservation. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  let ascii = 0;
  let other = 0;
  for (const char of text) char.codePointAt(0)! < 128 ? ascii++ : other++;
  return Math.ceil(ascii / 2.5 + other * 1.6) + 16;
}
export class RunPolicy {
  readonly controller = new AbortController();
  readonly started = Date.now();
  modelCalls = 0;
  toolCalls = 0;
  tokens = 0;
  failures = 0;
  status: RunStatus = 'running';
  reason?: string;
  lastInputEstimate = 0;
  requestKind: 'conversation' | 'compaction' = 'conversation';
  modelProgress?: ModelProgress;
  private lastFailure = '';
  private repeatCount = 0;
  constructor(
    readonly limits: RunLimits,
    readonly trace: TraceWriter,
    readonly onChange: () => void = () => {},
  ) {
    for (const name of ['tokenLimit', 'maxModelCalls', 'maxToolCalls', 'maxToolFailures'] as const)
      validateBudget(limits[name], name);
  }

  // Kept for callers that close a policy after settling. No run deadline is scheduled.
  close() {}
  stop(status: RunStatus, reason: string) {
    if (this.status !== 'running') return;
    this.status = status;
    this.reason = reason;
    this.trace.record('boundary_decision', { decision: 'stop', status, reason });
    this.controller.abort(reason);
    this.onChange();
  }
  checkActive() {
    if (this.controller.signal.aborted || this.status !== 'running')
      throw new Error(this.reason ?? 'RUN_STOPPED');
  }
  beginTool(name: string, args: unknown): void {
    this.checkActive();
    if (this.limits.maxToolCalls !== null && this.toolCalls >= this.limits.maxToolCalls) {
      this.stop('budget_exhausted', 'TOOL_LIMIT: 已达到本轮设置的工具调用上限');
      throw new Error(this.reason);
    }
    if (
      this.repeatCount >= this.limits.maxRepeatedFailures &&
      this.lastFailure.startsWith(`${name}:${digest(args)}:`)
    ) {
      this.stop(
        'failed',
        `REPEATED_FAILURE: 连续 ${this.limits.maxRepeatedFailures} 次相同失败，停止原样重试`,
      );
      throw new Error(this.reason);
    }
    this.toolCalls++;
    this.onChange();
  }
  toolFailed(name: string, args: unknown, code: string) {
    const fingerprint = `${name}:${digest(args)}:${code}`;
    this.repeatCount = fingerprint === this.lastFailure ? this.repeatCount + 1 : 1;
    this.lastFailure = fingerprint;
    this.failures++;
    if (this.limits.maxToolFailures !== null && this.failures >= this.limits.maxToolFailures)
      this.stop('failed', 'FAILURE_LIMIT: 工具累计失败次数达到上限');
  }
  toolSucceeded() {
    this.lastFailure = '';
    this.repeatCount = 0;
  }
  get hasUnresolvedToolFailure() {
    return this.repeatCount > 0;
  }
  resultByteLimit() {
    if (this.limits.tokenLimit === null) return this.limits.maxToolResultBytes;
    return Math.max(
      this.limits.minToolResultBytes,
      Math.min(
        this.limits.maxToolResultBytes,
        Math.floor((this.limits.tokenLimit - this.tokens) * this.limits.resultBytesPerToken),
      ),
    );
  }
}

const zeroUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Wrap the actual Pi provider entrance, including native compaction and retry calls. */
export function budgetedStream(
  base: StreamFn,
  getPolicy: () => RunPolicy | undefined,
  tokenCounter?: InputTokenCounter,
): StreamFn {
  return (model, context, options) => {
    const out = createAssistantMessageEventStream();
    const fail = (reason: string, aborted: boolean) => {
      const message: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: aborted ? 'aborted' : 'error',
        errorMessage: reason,
        timestamp: Date.now(),
      };
      out.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
      out.end(message);
    };
    const policy = getPolicy();
    if (!policy) {
      fail('RUN_REQUIRED: 模型请求必须属于一个受策略管理的运行', false);
      return out;
    }
    let reservation = 0;
    let providerAllowed = !tokenCounter;
    let requestId: string | undefined;
    let modelCall = 0;
    const requestKind = policy.requestKind;
    const reasoning = model.reasoning
      ? requestKind === 'compaction'
        ? policy.limits.compactionReasoningEffort
        : policy.limits.reasoningEffort
      : undefined;
    const start = Date.now();
    const metrics = new ModelStreamMetrics(start);
    let timeoutKind: 'first_content' | 'idle' | undefined;
    let partial: AssistantMessage | undefined;
    void (async () => {
      let contentTimer: ReturnType<typeof setTimeout> | undefined;
      let lastPublished = start;
      let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
      let signal: AbortSignal | undefined;
      const publishProgress = () => {
        if (!requestId) return;
        // Summaries can overlap. An older request must not replace a newer request's UI.
        if (policy.modelProgress && policy.modelProgress.modelCall > modelCall) return;
        const stats = metrics.snapshot();
        policy.modelProgress = {
          requestId,
          modelCall,
          kind: requestKind,
          phase: metrics.phase,
          startedAt: new Date(start).toISOString(),
          firstEventAt: stats.firstEventAt ?? undefined,
          firstContentAt: stats.firstContentAt ?? undefined,
          lastEventAt: stats.lastEventAt ?? undefined,
          lastContentAt: stats.lastContentAt ?? undefined,
          eventCounts: stats.eventCounts,
          characters: stats.characters,
        };
        policy.onChange();
        lastPublished = Date.now();
      };
      const expire = () => {
        if (timeoutKind || policy.status !== 'running' || signal?.aborted) return;
        const waitingFirstContent = metrics.firstContent === undefined;
        timeoutKind = waitingFirstContent ? 'first_content' : 'idle';
        const timeoutMs = waitingFirstContent
          ? policy.limits.requestFirstContentTimeoutMs
          : policy.limits.requestIdleTimeoutMs;
        policy.trace.record(
          'boundary_decision',
          {
            decision: 'request_timeout',
            timeoutKind,
            timeoutMs,
            timeoutPhase: waitingFirstContent ? 'waiting_first_content' : 'streaming',
            streamMetrics: metrics.snapshot(),
          },
          requestId,
        );
        policy.stop(
          'failed',
          waitingFirstContent
            ? `MODEL_IDLE_TIMEOUT: 等待模型首段有效内容超过 ${timeoutMs / 1000} 秒`
            : `MODEL_IDLE_TIMEOUT: 模型流式输出连续 ${timeoutMs / 1000} 秒未返回有效内容`,
        );
      };
      const resetContentTimer = () => {
        if (contentTimer) clearTimeout(contentTimer);
        const timeoutMs =
          metrics.firstContent === undefined
            ? policy.limits.requestFirstContentTimeoutMs
            : policy.limits.requestIdleTimeoutMs;
        contentTimer = setTimeout(expire, timeoutMs);
        contentTimer.unref?.();
      };
      try {
        policy.checkActive();
        signal = AbortSignal.any([policy.controller.signal, ...(options?.signal ? [options.signal] : [])]);
        signal.throwIfAborted();
        const counted = tokenCounter
          ? await tokenCounter.countContext(context, { signal, reasoning })
          : undefined;
        let input = counted?.tokens ?? estimateTokens(context);
        policy.lastInputEstimate = input;
        const requestOutput =
          requestKind === 'compaction' ? policy.limits.compactionOutputTokens : policy.limits.outputTokens;
        const configuredOutput = Math.floor(
          Math.min(options?.maxTokens ?? requestOutput, requestOutput, model.maxTokens),
        );
        let output = configuredOutput;
        if (policy.limits.tokenLimit !== null)
          output = Math.min(output, policy.limits.tokenLimit - policy.tokens - input);
        const modelLimitReached =
          policy.limits.maxModelCalls !== null && policy.modelCalls >= policy.limits.maxModelCalls;
        const allowed =
          input <= inputLimit(policy.limits) && output >= MIN_OUTPUT_TOKENS && !modelLimitReached;
        policy.trace.record('budget_check', {
          inputEstimate: input,
          inputSource: counted?.source ?? 'estimate',
          outputReservation: Math.max(0, output),
          used: policy.tokens,
          limit: policy.limits.tokenLimit,
          modelCalls: policy.modelCalls,
          maxModelCalls: policy.limits.maxModelCalls,
          inputLimit: inputLimit(policy.limits),
          watermark: compressionWatermark(policy.limits),
          allowed,
          kind: requestKind,
        });
        if (!allowed) {
          const reason =
            input > inputLimit(policy.limits)
              ? 'CONTEXT_LIMIT: 当前输入超出请求窗口，请压缩上下文后继续'
              : modelLimitReached
                ? 'MODEL_LIMIT: 已达到本轮设置的模型请求上限'
                : configuredOutput < MIN_OUTPUT_TOKENS
                  ? `OUTPUT_LIMIT: 单次模型输出上限不足 ${MIN_OUTPUT_TOKENS} token，请调整模型输出配置`
                  : 'TOKEN_LIMIT: 本轮设置的 token 预算不足';
          policy.stop('budget_exhausted', reason);
          fail(reason, false);
          return;
        }
        reservation = input + output;
        // Reserve synchronously before any provider request so overlapping summary calls share one ledger.
        policy.tokens += reservation;
        modelCall = ++policy.modelCalls;
        policy.onChange();
        requestId = policy.trace.record('model_request', {
          model: model.id,
          provider: model.provider,
          kind: requestKind,
          inputEstimate: input,
          inputSource: counted?.source ?? 'estimate',
          outputLimit: output,
          reasoningEffort: reasoning,
          requestHash: digest(context),
          messageCount: context.messages.length,
          modelCall,
          maxRetries: 0,
          timeouts: {
            totalMs: null,
            firstContentMs: policy.limits.requestFirstContentTimeoutMs,
            idleMs: policy.limits.requestIdleTimeoutMs,
          },
        });
        signal.throwIfAborted();
        publishProgress();
        // Custom streams without payload hooks still need a bound if they never return.
        // Officially counted requests start their first-content wait only after final counting.
        if (!tokenCounter) resetContentTimer();
        const stream = await abortable(
          base(model, context, {
            ...options,
            maxTokens: output,
            reasoning,
            maxRetries: 0,
            onPayload: async (payload, requestModel) => {
              const replacement = await options?.onPayload?.(payload, requestModel);
              const effectivePayload = replacement === undefined ? payload : replacement;
              const fields =
                effectivePayload && typeof effectivePayload === 'object'
                  ? (effectivePayload as Record<string, unknown>)
                  : {};
              const finalCount = tokenCounter
                ? await tokenCounter.countPayload(effectivePayload, signal)
                : undefined;
              if (finalCount) {
                let approvedOutput = output;
                if (policy.limits.tokenLimit !== null)
                  approvedOutput = Math.min(
                    approvedOutput,
                    policy.limits.tokenLimit - (policy.tokens - reservation) - finalCount.tokens,
                  );
                const contextExceeded =
                  finalCount.tokens > inputLimit(policy.limits) ||
                  finalCount.tokens + approvedOutput + policy.limits.safetyTokens >
                    requestModel.contextWindow;
                if (contextExceeded || approvedOutput < MIN_OUTPUT_TOKENS) {
                  const reason = contextExceeded
                    ? 'CONTEXT_LIMIT: 官方计数确认最终请求超过可用上下文'
                    : 'TOKEN_LIMIT: 最终请求的官方计数超过本轮剩余预算';
                  policy.stop('budget_exhausted', reason);
                  throw new Error(reason);
                }
                // Pi's independent chars/4 clamp must not silently lower an officially counted allowance.
                // Only restore the output already approved by this run's context and cumulative budget.
                fields.max_completion_tokens = approvedOutput;
                delete fields.max_tokens;
                policy.tokens += finalCount.tokens + approvedOutput - reservation;
                reservation = finalCount.tokens + approvedOutput;
                input = finalCount.tokens;
                output = approvedOutput;
                policy.lastInputEstimate = input;
              }
              const outputField =
                typeof fields.max_completion_tokens === 'number'
                  ? 'max_completion_tokens'
                  : typeof fields.max_tokens === 'number'
                    ? 'max_tokens'
                    : undefined;
              const effectiveOutput = outputField ? (fields[outputField] as number) : undefined;
              const effectiveReasoning = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
                String(fields.reasoning_effort),
              )
                ? fields.reasoning_effort
                : undefined;
              policy.trace.record(
                'model_payload',
                {
                  kind: requestKind,
                  contextWindow: requestModel.contextWindow,
                  modelOutputCapacity: requestModel.maxTokens,
                  requestedOutputLimit: output,
                  inputTokens: finalCount?.tokens,
                  inputSource: finalCount?.source,
                  inputHash: finalCount?.payloadHash,
                  outputLimit: effectiveOutput,
                  outputField,
                  reasoningEffort: effectiveReasoning,
                  messageCount: Array.isArray(fields.messages) ? fields.messages.length : undefined,
                  toolCount: Array.isArray(fields.tools) ? fields.tools.length : undefined,
                  payloadHash: digest(effectivePayload),
                },
                requestId,
              );
              if (
                effectiveOutput !== undefined &&
                (!Number.isSafeInteger(effectiveOutput) || effectiveOutput < 1 || effectiveOutput > output)
              )
                throw new Error('OUTPUT_LIMIT: 最终请求输出上限超出已预留预算');
              signal?.throwIfAborted();
              providerAllowed = true;
              resetContentTimer();
              return effectivePayload;
            },
            // The installed OpenAI-compatible SDK clears this timer at response headers.
            // Body streaming is governed by the resettable content-idle timer above.
            timeoutMs: policy.limits.requestFirstContentTimeoutMs,
            signal,
          }),
          signal,
        );
        let terminal: AssistantMessage | undefined;
        let terminalEvent: Parameters<typeof out.push>[0] | undefined;
        iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = await abortable(iterator.next(), signal);
          if (next.done) break;
          const event = next.value;
          const hadEvent = metrics.firstEvent !== undefined;
          const previousPhase = metrics.phase;
          const hadContent = metrics.firstContent !== undefined;
          const contentReceived = metrics.observe(event);
          if ('partial' in event) partial = event.partial;
          if (contentReceived) resetContentTimer();
          if (
            !hadEvent ||
            (!hadContent && contentReceived) ||
            previousPhase !== metrics.phase ||
            Date.now() - lastPublished >= 1000
          ) {
            policy.trace.record(
              'model_stream_progress',
              {
                phase: metrics.phase,
                kind: requestKind,
                streamMetrics: metrics.snapshot(),
              },
              requestId,
            );
            publishProgress();
          }
          if (event.type === 'done' || event.type === 'error') {
            terminal = event.type === 'done' ? event.message : event.error;
            terminalEvent = event;
            // A terminal event is sufficient; do not wait for a broken producer to close.
            break;
          }
          out.push(event);
        }
        terminal ??= await abortable(stream.result(), signal);
        clearTimeout(contentTimer);
        if (terminal.errorMessage) terminal.errorMessage = policy.trace.redact(terminal.errorMessage);
        const usage = terminal.usage;
        // Pi usage is normalized: totalTokens includes cache; reasoning is a subset of output.
        const reported =
          usage?.totalTokens > 0
            ? usage.totalTokens
            : (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
        const failed = terminal.stopReason === 'error' || terminal.stopReason === 'aborted';
        const charged =
          reported > 0
            ? reported
            : failed
              ? providerAllowed
                ? reservation
                : 0
              : input + estimateTokens(terminal.content);
        policy.tokens += charged - reservation;
        policy.trace.record(
          'model_response',
          {
            status: terminal.stopReason,
            elapsedMs: Date.now() - start,
            tokens: charged,
            source:
              reported > 0
                ? 'provider_usage'
                : failed
                  ? providerAllowed
                    ? 'reservation_unknown_actual'
                    : 'preflight_rejected'
                  : 'estimate',
            usage: reported > 0 ? usage : undefined,
            outputHash: digest(terminal.content),
            error: terminal.errorMessage,
            kind: requestKind,
            used: policy.tokens,
            streamMetrics: metrics.snapshot(),
          },
          requestId,
        );
        if (
          policy.limits.tokenLimit !== null &&
          policy.tokens >= policy.limits.tokenLimit &&
          policy.status === 'running'
        )
          policy.stop('budget_exhausted', 'TOKEN_LIMIT: 本轮累计 token 已达到设置的预算');
        policy.onChange();
        // Publish the terminal event only after accounting: consumers may immediately start the next call.
        if (terminalEvent) out.push(terminalEvent);
        out.end(terminal);
      } catch (error) {
        if (!providerAllowed) {
          policy.tokens -= reservation;
          reservation = 0;
        }
        // Unknown provider consumption conservatively keeps its input+output reservation.
        const aborted = signal?.aborted || policy.controller.signal.aborted;
        const reason = policy.trace.redact(timeoutKind ? policy.reason : error);
        policy.trace.record(
          'model_response',
          {
            status: aborted ? 'aborted' : 'error',
            elapsedMs: Date.now() - start,
            tokens: reservation,
            source: providerAllowed ? 'reservation_unknown_actual' : 'preflight_rejected',
            error: reason,
            timeoutKind,
            kind: requestKind,
            used: policy.tokens,
            streamMetrics: metrics.snapshot(),
          },
          requestId,
        );
        if (partial && aborted) {
          const result: AssistantMessage = {
            ...structuredClone(partial),
            usage: zeroUsage(),
            stopReason: 'aborted',
            errorMessage: reason,
          };
          out.push({ type: 'error', reason: 'aborted', error: result });
          out.end(result);
        } else fail(reason, Boolean(aborted));
      } finally {
        if (contentTimer) clearTimeout(contentTimer);
        // Cleanup is best-effort: a broken producer may throw or never finish return().
        try {
          if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => {});
        } catch {
          /* The host result has already settled. */
        }
        metrics.phase = 'finished';
        publishProgress();
      }
    })();
    return out;
  };
}
