import { getCurrentSystemPrompt, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  estimateTokens as estimatePiTokens,
  type AgentSession,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import { estimateTokens, type RunPolicy } from './run-policy.js';
import { compressionWatermark, inputLimit } from '../config.js';
import type { InputTokenCounter } from './kimi-token-count.js';

const sessionCounters = new WeakMap<
  AgentSession,
  { counter: InputTokenCounter; signal: () => AbortSignal | undefined }
>();

/** Include pending initial prompt/tool declarations as well as the persisted conversation. */
export async function buildSessionContext(session: AgentSession, messages: AgentMessage[]) {
  const converted = await session.agent.convertToLlm(messages);
  // Pi materializes its initial prompt/tool declarations only when the first prompt starts.
  // Later projections already carry those declarations; do not count them twice.
  return normalizeContext({
    messages: converted,
    ...(getCurrentSystemPrompt(converted) ? {} : { systemPrompt: session.systemPrompt }),
    ...(getCurrentTools(converted).length ? {} : { tools: session.agent.state?.tools }),
  });
}

/** Match the conversion and normalization at Pi's provider entrance. */
export async function estimateSessionInput(session: AgentSession, messages: AgentMessage[]) {
  const context = await buildSessionContext(session, messages);
  const registered = sessionCounters.get(session);
  return registered
    ? (await registered.counter.countContext(context, { signal: registered.signal() })).tokens
    : estimateTokens(context);
}

/** Keep Pi's native compaction/continuation, but trigger it using the host request estimate. */
export function installContextCompaction(
  session: AgentSession,
  manager: SessionManager,
  getPolicy: () => RunPolicy | undefined,
  tokenCounter?: InputTokenCounter,
) {
  if (tokenCounter)
    sessionCounters.set(session, { counter: tokenCounter, signal: () => getPolicy()?.controller.signal });
  const prepare = session.agent.prepareNextTurnWithContext;
  if (!prepare) throw new Error('Pi next-turn compaction hook is unavailable');
  session.agent.prepareNextTurnWithContext = async (turn, signal) => {
    const policy = getPolicy();
    if (!policy) return prepare(turn, signal);
    policy.checkActive();
    const messages = manager.buildSessionProjection().messages;
    const before = await estimateSessionInput(session, messages);
    const settings = session.settingsManager.getCompactionSettings(session.model);
    if ((!settings.enabled && !tokenCounter) || before < compressionWatermark(policy.limits))
      return prepare(turn, signal);

    policy.trace.record('boundary_decision', {
      decision: 'between_turn_compaction',
      inputEstimate: before,
      watermark: compressionWatermark(policy.limits),
      used: policy.tokens,
    });
    let compacted = false;
    let failure: string | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'compaction_end') {
        compacted = Boolean(event.result) && !event.aborted;
        failure = event.errorMessage;
      }
    });
    // Pi uses a different token estimate. A zero native threshold selects its existing
    // automatic path at this safe boundary. Never call compact() here: it aborts the run.
    // Summary requests remain capped and charged by the same budgetedStream policy.
    // Pi also uses chars/4 to choose the retained tail. Scale that allowance down
    // when it underestimates this transcript, or a Chinese-heavy tail can remain
    // over the host limit even after a successful summary. Pi keeps tool groups intact.
    const nativeEstimate = messages.reduce((sum, message) => sum + estimatePiTokens(message), 0);
    session.settingsManager.applyOverrides({
      compaction: {
        enabled: true,
        reserveTokens: session.model!.contextWindow,
        keepRecentTokens: Math.min(
          settings.keepRecentTokens,
          Math.max(
            policy.limits.compaction.minRecentTokens,
            Math.floor((settings.keepRecentTokens * nativeEstimate) / before),
          ),
        ),
      },
    });
    try {
      const update = await prepare(turn, signal);
      policy.checkActive();
      const after = await estimateSessionInput(session, manager.buildSessionProjection().messages);
      policy.trace.record('boundary_decision', {
        decision: 'between_turn_compaction_result',
        beforeEstimate: before,
        afterEstimate: after,
        compacted,
        inputLimit: inputLimit(policy.limits),
        used: policy.tokens,
      });
      if (!compacted) {
        policy.stop('failed', `CONTEXT_COMPACTION_FAILED: 自动压缩未完成，已停止本轮。${failure ?? ''}`);
      } else if (after > inputLimit(policy.limits) || after >= before) {
        policy.stop('failed', 'CONTEXT_LIMIT: 自动压缩后输入仍过大或未缩减，请缩小文件读取范围后继续');
      }
      policy.checkActive();
      return update;
    } finally {
      unsubscribe();
      session.settingsManager.applyOverrides({ compaction: settings });
    }
  };
}
