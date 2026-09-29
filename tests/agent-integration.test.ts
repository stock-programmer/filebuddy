import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { WorkspaceService } from '../src/workspace/workspace-service.js';
import { createSession } from '../src/agent/create-session.js';
import { budgetedStream, RunPolicy } from '../src/agent/run-policy.js';
import { LEGACY_LIMITS } from './fixtures/legacy-profile.js';
import { createTools } from '../src/tools/tools.js';
import { TraceWriter } from '../src/observability/trace.js';

const roots: string[] = [];
const disposers: (() => void)[] = [];
afterEach(async () => {
  disposers.splice(0).forEach((fn) => fn());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-agent-'));
  roots.push(root);
  const input = join(root, 'original.txt');
  await writeFile(input, '代号：青禾\n保留 KEEP-42\n');
  const workspace = await new WorkspaceService(join(root, 'data')).create(randomUUID(), 'test');
  await workspace.importPaths([input]);
  const trace = new TraceWriter(join(root, 'data'), workspace.id, randomUUID());
  const policy = new RunPolicy(LEGACY_LIMITS, trace);
  disposers.push(() => policy.close());
  const built = await createSession({
    workspace,
    appRoot: resolve('.'),
    dataRoot: join(root, 'data'),
    limits: LEGACY_LIMITS,
    model: {
      model: 'fixture',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'fixture-key',
      contextWindow: 65536,
      maxTokens: 4096,
    },
    getPolicy: () => policy,
  });
  disposers.push(() => built.session.dispose());
  return { root, input, workspace, trace, policy, ...built };
}
function response(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'xuwu-model',
    model: 'fixture',
    timestamp: Date.now(),
    stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function stream(content: AssistantMessage['content']) {
  const result = response(content);
  const output = createAssistantMessageEventStream();
  output.push({
    type: 'done',
    reason: result.stopReason === 'toolUse' ? 'toolUse' : 'stop',
    message: result,
  });
  output.end(result);
  return output;
}

describe('Pi session wiring with real file tools and controlled model streams', () => {
  it('executes the real tool loop, progressively loads skills, protects originals and recovers persisted messages', async () => {
    const f = await fixture();
    const relative = f.workspace.items[0].workPath;
    let call = 0;
    let initialContext: TranscriptContext | undefined;
    f.session.agent.streamFunction = budgetedStream(
      (_model, context) => {
        call++;
        initialContext ??= context;
        if (call === 1)
          return stream([
            {
              type: 'toolCall',
              id: 'skill',
              name: 'read',
              arguments: { path: resolve('skills/text-cleanup/SKILL.md') },
            },
          ]);
        if (call === 2)
          return stream([{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: relative } }]);
        if (call === 3) {
          const tool = context.messages
            .filter((message) => message.role === 'toolResult' && message.toolCallId === 'read')
            .at(-1)!;
          if (tool.role !== 'toolResult') throw new Error('Missing read result');
          const result = JSON.parse(
            tool.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join(''),
          );
          return stream([
            {
              type: 'toolCall',
              id: 'edit',
              name: 'edit',
              arguments: { path: relative, oldText: '青禾', newText: '星河', expectedHash: result.hash },
            },
          ]);
        }
        return stream([{ type: 'text', text: '已修改为星河并保留 KEEP-42。' }]);
      },
      () => f.policy,
    );
    await f.session.prompt('使用 text-cleanup 技能把青禾改为星河，保留 KEEP-42。', {
      expandPromptTemplates: false,
    });
    expect(call).toBe(4);
    expect(f.policy.toolCalls).toBe(3);
    expect(await readFile(join(f.workspace.workDir, relative), 'utf8')).toContain('星河');
    expect(await readFile(f.input, 'utf8')).toContain('青禾');
    expect(JSON.stringify(initialContext)).toContain('text-cleanup');
    expect(JSON.stringify(initialContext)).not.toContain('对批量任务先在一个文件验证规则');
    expect(await readFile(f.trace.path, 'utf8')).toContain('skill_load');
    f.session.dispose();
    const restored = await createSession({
      workspace: f.workspace,
      appRoot: resolve('.'),
      dataRoot: join(f.root, 'data'),
      limits: LEGACY_LIMITS,
      model: {
        model: 'fixture',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'fixture-key',
        contextWindow: 65536,
        maxTokens: 4096,
      },
      getPolicy: () => f.policy,
    });
    disposers.push(() => restored.session.dispose());
    expect(
      restored.sessionManager
        .getBranch()
        .some((entry) => entry.type === 'message' && entry.message.role === 'user'),
    ).toBe(true);
    expect(JSON.stringify(restored.session.messages)).toContain('KEEP-42');
  }, 60000);

  it('registers only safe tools and refuses skill escape or repeated host access', async () => {
    const f = await fixture();
    expect(f.session.getActiveToolNames().sort()).toEqual([
      'changes',
      'copy',
      'delete',
      'edit',
      'list',
      'mkdir',
      'move',
      'read',
      'restore',
      'search',
      'write',
    ]);
    expect(f.resources.getAgentsFiles().agentsFiles).toEqual([]);
    expect(f.resources.getExtensions().extensions).toEqual([]);
    const tools = createTools(f.workspace, f.resources, () => f.policy);
    const read = tools.find((t) => t.name === 'read')!;
    const execute = (args: any) => read.execute('bad', args, undefined, undefined, {} as any);
    const outside = { path: join(f.root, 'host-secret.txt') };
    await writeFile(outside.path, 'sensitive-fixture');
    await expect(execute(outside)).rejects.toThrow();
    await expect(execute(outside)).rejects.toThrow();
    await expect(execute(outside)).rejects.toThrow('REPEATED_FAILURE');
    expect(f.policy.status).toBe('failed');
    expect(await readFile(f.trace.path, 'utf8')).not.toContain('sensitive-fixture');
  }, 60000);

  it('routes native Pi compaction through the same request gate and records its usage', async () => {
    const f = await fixture();
    let calls = 0;
    f.session.agent.streamFunction = budgetedStream(
      () => {
        calls++;
        return stream([
          {
            type: 'text',
            text: '# Goal\n保留 KEEP-42，代号星河。\n# Progress\n文件已修改。\n# Next\n等待用户下一轮。',
          },
        ]);
      },
      () => f.policy,
    );
    f.session.subscribe((event) => {
      if (event.type === 'compaction_start') {
        f.policy.requestKind = 'compaction';
        f.trace.record('compaction_start');
      }
      if (event.type === 'compaction_end') {
        f.policy.requestKind = 'conversation';
        f.trace.record('compaction_end');
      }
    });
    await f.session.prompt('任务目标是代号星河，必须保留 KEEP-42。', { expandPromptTemplates: false });
    await f.session.prompt('继续保留所有关键约束。', { expandPromptTemplates: false });
    const before = calls;
    const beforeTokens = f.policy.tokens;
    f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 32 } });
    await f.session.compact('保留任务目标与 KEEP-42');
    expect(calls).toBeGreaterThan(before);
    expect(f.policy.tokens).toBeGreaterThan(beforeTokens);
    const events = (await readFile(f.trace.path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((row) => row.type === 'model_request' && row.kind === 'compaction')).toBe(true);
    expect(f.sessionManager.getBranch().some((entry) => entry.type === 'compaction')).toBe(true);
  }, 60000);

  it('waits for a timed-out tool to settle before ending its call', async () => {
    const f = await fixture();
    const run = new RunPolicy({ ...LEGACY_LIMITS, toolTimeoutMs: 10 }, f.trace);
    disposers.push(() => run.close());
    let settled = false;
    const workspace = {
      ...f.workspace,
      id: f.workspace.id,
      root: f.workspace.root,
      workDir: f.workspace.workDir,
      baseDir: f.workspace.baseDir,
      items: f.workspace.items,
      summary: f.workspace.summary,
      execute: async (_name: string, _args: Record<string, unknown>, signal?: AbortSignal) =>
        new Promise((_, reject) => {
          signal!.addEventListener(
            'abort',
            () =>
              setTimeout(() => {
                settled = true;
                reject(new Error('operation settled after cancellation'));
              }, 25),
            { once: true },
          );
        }),
    };
    const read = createTools(workspace, f.resources, () => run).find((tool) => tool.name === 'read')!;
    const start = Date.now();
    await expect(
      read.execute('timeout', { path: 'fixture.txt' }, undefined, undefined, {} as any),
    ).rejects.toThrow();
    expect(settled).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
    expect(run.status).toBe('failed');
    expect(await readFile(f.trace.path, 'utf8')).toContain('tool_timeout');
  }, 60000);
});
