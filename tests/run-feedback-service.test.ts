import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { createSession } from '../src/agent/create-session.js';
import { AgentService } from '../src/app/agent-service.js';
import { ActivityLog } from '../src/app/activity-log.js';
import { resolveConfig } from '../src/config.js';
import type { AgentWorkspace } from '../src/tools/tools.js';
import type { RunPolicy } from '../src/agent/run-policy.js';

vi.mock('../src/agent/create-session.js', () => ({ createSession: vi.fn() }));

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(blockActivityStorage = false) {
  const root = await mkdtemp(join(tmpdir(), 'filebuddy-feedback-'));
  roots.push(root);
  let emit: (event: AgentSessionEvent) => void = () => {};
  let complete!: () => void;
  let fail!: (error: Error) => void;
  let started!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const promptDone = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const sendCustomMessage = vi.fn(async (_message: unknown) => {});
  const branch: unknown[] = [];
  const session = {
    messages: [],
    agent: { convertToLlm: (messages: unknown[]) => messages },
    systemPrompt: 'fixture',
    sendCustomMessage,
    subscribe: (listener: typeof emit) => {
      emit = listener;
      return () => {};
    },
    abort: async () => {
      complete();
    },
    dispose: () => {},
    prompt: async (text: string) => {
      branch.push({
        type: 'message',
        id: 'user',
        message: { role: 'user', content: text, timestamp: Date.now() },
      });
      emit({
        type: 'message_end',
        message: { role: 'user', content: text, timestamp: Date.now() },
      } as AgentSessionEvent);
      started();
      await promptDone;
    },
  };
  // openSession calls abort only on the previous session; this new session has not run yet.
  vi.mocked(createSession).mockResolvedValue({
    session,
    sessionManager: { getBranch: () => branch },
    resources: { describe: () => [] },
  } as unknown as Awaited<ReturnType<typeof createSession>>);
  const service = new AgentService({
    dataRoot: root,
    appRoot: root,
    config: resolveConfig({ model: { apiKey: 'fixture' }, run: { progressSilenceMs: 100 } }),
    onEvent: vi.fn(),
  });
  const workspace = { id: 'session', items: [], execute: async () => [] } as unknown as AgentWorkspace;
  await service.openSession(workspace);
  if (blockActivityStorage) await writeFile(join(root, 'activity'), 'blocked storage fixture');
  vi.useFakeTimers();
  const task = service.send('整理材料');
  await promptStarted;
  const access = service as unknown as { policy: RunPolicy };
  return {
    root,
    service,
    workspace,
    task,
    complete,
    fail,
    sendCustomMessage,
    branch,
    emit: (event: unknown) => emit(event as AgentSessionEvent),
    tool: (i: number, name = 'read', isError = false) => {
      access.policy.beginTool(name, { path: 'private-file-path' });
      emit({
        type: 'tool_execution_start',
        toolCallId: `t${i}`,
        toolName: name,
        args: { path: 'private-file-path' },
      } as AgentSessionEvent);
      emit({
        type: 'tool_execution_end',
        toolCallId: `t${i}`,
        toolName: name,
        isError,
        result: { content: [{ type: 'text', text: 'private-file-content' }] },
      } as AgentSessionEvent);
    },
  };
}

describe('persisted host feedback through the service lifecycle', () => {
  it('shows an immediate start and aggregates 48 tool-only calls using the configured silence interval', async () => {
    const f = await fixture();
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toHaveLength(1);
    for (let i = 0; i < 48; i++) f.tool(i, i < 2 ? 'list' : i < 13 ? 'search' : 'read');
    await vi.advanceTimersByTimeAsync(99);
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.service.getMessages().at(-1)?.text).toContain('查看目录 2 次、搜索 11 次、读取 35 次');
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toHaveLength(2);
    f.complete();
    await f.task;
    expect(f.service.getRun()?.status).toBe('ready_for_review');
    expect(f.service.getMessages().at(-1)?.text).toContain('请检查回复和工作成果');
    expect(vi.getTimerCount()).toBe(0);
    expect(f.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(f.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'workspace_state', display: false }),
    );
    const saved = await readFile(join(f.root, 'activity', 'session', 'messages.jsonl'), 'utf8');
    expect(saved).not.toContain('private-file');
    const messages = f.service.getMessages();
    await f.service.openSession(f.workspace);
    expect(f.service.getMessages()).toEqual(messages);
    await f.service.dispose();
  });

  it('suppresses fallback while receiving visible text, then resumes without showing reasoning', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(70);
      f.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '正在核对材料。' },
      });
      f.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'private-thinking' },
      });
    }
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toHaveLength(1);
    f.tool(1, 'edit', true);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.service.getMessages().at(-1)?.text).toContain('操作失败 1 次');
    expect(f.service.getMessages().at(-1)?.text).not.toContain('修改 1 次');
    await f.service.stop();
    await f.task;
    expect(f.service.getMessages().at(-1)?.text).toContain('你已停止本轮任务');
    expect(JSON.stringify(f.service.getMessages())).not.toContain('private-thinking');
    const count = f.service.getMessages().length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.service.getMessages()).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.openSession(f.workspace);
    expect(f.service.getMessages().at(-1)?.text).toContain('你已停止本轮任务');
    await f.service.dispose();
  });

  it('preserves failure feedback and isolates the next session', async () => {
    const f = await fixture();
    f.fail(new Error('fixture failure'));
    await f.task;
    expect(f.service.getRun()?.status).toBe('failed');
    expect(f.service.getMessages().at(-1)?.text).toContain('本轮遇到问题');
    await f.service.openSession({ ...f.workspace, id: 'other' } as AgentWorkspace);
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.service.getMessages().filter((m) => m.role === 'notice')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.openSession(f.workspace);
    expect(f.service.getMessages().at(-1)?.text).toContain('本轮遇到问题');
    await f.service.dispose();
  });

  it('recovers records before a truncated write and can append new feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'filebuddy-activity-'));
    roots.push(root);
    new ActivityLog(root, 'session').append('已开始');
    await appendFile(join(root, 'activity', 'session', 'messages.jsonl'), '{"partial":');
    const reopened = new ActivityLog(root, 'session');
    expect(reopened.getMessages().map((m) => m.text)).toEqual(['已开始']);
    reopened.append('已停止');
    expect(new ActivityLog(root, 'session').getMessages().map((m) => m.text)).toEqual(['已开始', '已停止']);
  });

  it('keeps preparation feedback after its user request on reopen without borrowing the next run user', async () => {
    const root = await mkdtemp(join(tmpdir(), 'filebuddy-order-'));
    roots.push(root);
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const log = new ActivityLog(root, 'session');
    log.append('准备中', 'run-a');
    vi.setSystemTime(2000);
    log.anchorToUser('run-a', Date.now());
    vi.setSystemTime(3000);
    log.append('无正文状态', 'run-a');
    vi.setSystemTime(5000);
    log.append('结束', 'run-a');
    const messages = new ActivityLog(root, 'session').getMessages([
      { id: 'user', role: 'user', text: '用户任务', createdAt: new Date(2000).toISOString() },
      { id: 'assistant', role: 'assistant', text: '稍后提供的正文', createdAt: new Date(4000).toISOString() },
    ]);
    expect(messages.map((m) => m.text)).toEqual([
      '用户任务',
      '准备中',
      '无正文状态',
      '稍后提供的正文',
      '结束',
    ]);
    expect(messages.every((m) => !('runId' in m))).toBe(true);
  });

  it('keeps executing and clears timers when feedback storage fails', async () => {
    const f = await fixture(true);
    expect(f.service.getMessages().some((m) => m.text.includes('未能读取或保存'))).toBe(true);
    f.tool(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.service.getMessages().some((m) => m.text.includes('读取 1 次'))).toBe(true);
    f.complete();
    await f.task;
    expect(f.service.getRun()?.status).toBe('ready_for_review');
    expect(vi.getTimerCount()).toBe(0);
    await f.service.dispose();
  });
});
