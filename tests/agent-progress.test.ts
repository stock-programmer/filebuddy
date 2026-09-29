import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../src/app/agent-service.js';
import type { ModelProgress, RunView } from '../src/app/contracts.js';

function serviceFixture() {
  const onEvent = vi.fn();
  const service = new AgentService({ dataRoot: 'unused', appRoot: 'unused', onEvent });
  const progress: ModelProgress = {
    requestId: 'request-1',
    modelCall: 1,
    kind: 'conversation',
    phase: 'thinking',
    startedAt: new Date().toISOString(),
    eventCounts: { thinking_delta: 3 },
    characters: { text: 0, thinking: 12, toolArguments: 0 },
  };
  const run: RunView = {
    id: 'run-1',
    status: 'running',
    startedAt: progress.startedAt,
    elapsedMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    tokens: 0,
    tokenLimit: 100000,
    lastActivity: '正在理解任务',
  };
  Object.assign(service, {
    run,
    policy: {
      started: Date.now(),
      status: 'running',
      modelCalls: 1,
      toolCalls: 0,
      tokens: 120,
      modelProgress: progress,
    },
  });
  return { service, onEvent, progress };
}

describe('service progress bridge', () => {
  it('publishes immutable metadata snapshots as the underlying stream continues', () => {
    const { service, progress } = serviceFixture();
    const snapshot = service.getRun()!;
    expect(snapshot.modelProgress).toEqual(progress);
    progress.eventCounts.thinking_delta++;
    progress.characters.thinking += 4;
    expect(snapshot.modelProgress?.eventCounts.thinking_delta).toBe(3);
    expect(snapshot.modelProgress?.characters.thinking).toBe(12);
    expect(service.getRun()?.modelProgress?.characters.thinking).toBe(16);
  });

  it('keeps reasoning content out of UI events while forwarding answer text', () => {
    const { service, onEvent } = serviceFixture();
    const receiver = service as unknown as { handleEvent(event: AgentSessionEvent): void };
    receiver.handleEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'private reasoning fixture' },
    } as AgentSessionEvent);
    expect(onEvent).not.toHaveBeenCalled();
    receiver.handleEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '已处理' },
    } as AgentSessionEvent);
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'text_delta', text: '已处理', runId: 'run-1' });
  });
});
