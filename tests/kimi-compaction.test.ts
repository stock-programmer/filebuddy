import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveConfig, getRunLimits, compressionWatermark } from '../src/config.js';
import { createSession } from '../src/agent/create-session.js';
import { estimateSessionInput } from '../src/agent/context-compaction.js';
import { RunPolicy } from '../src/agent/run-policy.js';
import { TraceWriter } from '../src/observability/trace.js';
import { WorkspaceService } from '../src/workspace/workspace-service.js';

describe('Kimi official counts at the real Pi compaction boundary', () => {
  it('counts initial prompt/tools, ignores Pi overestimation, and compacts only above the official watermark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'xuwu-kimi-compaction-'));
    const tokenPayloads: Record<string, any>[] = [];
    const chatPayloads: Record<string, any>[] = [];
    let conversationCalls = 0;
    let summaryCalls = 0;
    let completedSummaries = 0;
    let watermark = 0;
    let contextWindow = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url?.endsWith('/tokenizers/estimate-token-count')) {
        tokenPayloads.push(payload);
        const summary = payload.messages.some(
          (message: any) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('context summarization assistant'),
        );
        const tokens =
          summary || completedSummaries > 0 ? 1000 : watermark + (conversationCalls >= 2 ? 1 : -1);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: { total_tokens: tokens } }));
        return;
      }
      chatPayloads.push(payload);
      const summary = payload.reasoning_effort === 'low';
      if (summary) summaryCalls++;
      else conversationCalls++;
      const tool = !summary && conversationCalls <= 2;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool
        ? {
            role: 'assistant',
            content: '已记录工作区约束并继续检查。'.repeat(1000),
            tool_calls: [
              {
                index: 0,
                id: `list-${conversationCalls}`,
                type: 'function',
                function: { name: 'list', arguments: JSON.stringify({ path: '.', limit: 1 }) },
              },
            ],
          }
        : {
            role: 'assistant',
            content: summary
              ? '## Goal\n保留全部目标和关键约束。\n## Progress\n已列出工作区两次。\n## Next\n完成最终回复。'
              : '完成。',
          };
      const chunk = (value: unknown, reason: string | null, usage?: unknown) => ({
        id: `completion-${chatPayloads.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'kimi-k3',
        choices: [{ index: 0, delta: value, finish_reason: reason }],
        ...(usage ? { usage } : {}),
      });
      response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
      // Deliberately stale/high usage would trip Pi's independent native threshold.
      response.write(
        `data: ${JSON.stringify(
          chunk({}, tool ? 'tool_calls' : 'stop', {
            prompt_tokens: summary ? 1000 : contextWindow - 100,
            completion_tokens: 20,
            total_tokens: summary ? 1020 : contextWindow - 80,
          }),
        )}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local compaction fixture address');
    const config = resolveConfig({
      model: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-key' },
    });
    const limits = getRunLimits(config);
    watermark = compressionWatermark(limits);
    contextWindow = config.model.contextWindow;
    const workspace = await new WorkspaceService(root, config.workspace).create('session');
    const trace = new TraceWriter(root, 'session', 'run');
    const policy = new RunPolicy(limits, trace);
    const built = await createSession({
      workspace,
      dataRoot: root,
      appRoot: resolve('.'),
      model: config.model,
      limits,
      getPolicy: () => policy,
    });
    const compactionStarts: number[] = [];
    built.session.subscribe((event) => {
      if (event.type === 'compaction_start') {
        policy.requestKind = 'compaction';
        compactionStarts.push(conversationCalls);
      } else if (event.type === 'compaction_end') {
        policy.requestKind = 'conversation';
        if (event.result) completedSummaries++;
      }
    });
    try {
      const text = '保留目标和关键约束，依次检查工作区并完成任务。'.repeat(1200);
      const initial = await estimateSessionInput(built.session, [
        ...built.session.messages,
        { role: 'user', content: [{ type: 'text', text }], timestamp: 1 },
      ]);
      expect(initial).toBe(watermark - 1);
      expect(tokenPayloads[0].tools.length).toBeGreaterThan(0);
      expect(
        tokenPayloads[0].messages.some((message: any) => message.role === 'system' && message.content),
      ).toBe(true);
      await built.session.prompt(text, { expandPromptTemplates: false });
      expect(policy.reason).toBeUndefined();
      expect(policy.status).toBe('running');
      expect(conversationCalls).toBe(3);
      expect(summaryCalls).toBeGreaterThan(0);
      expect(compactionStarts).toEqual([2]);
      expect(completedSummaries).toBe(1);
      expect(built.session.settingsManager.getCompactionSettings(built.session.model).enabled).toBe(false);
      expect(chatPayloads[0].messages).toEqual(tokenPayloads[0].messages);
      expect(chatPayloads[0].tools).toEqual(tokenPayloads[0].tools);
      const rows = (await readFile(trace.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows.find((row) => row.type === 'model_payload')).toMatchObject({
        inputSource: 'moonshot_tokenizer',
        inputTokens: initial,
      });
      expect(
        rows.filter((row) => row.type === 'boundary_decision' && row.decision === 'between_turn_compaction'),
      ).toHaveLength(1);
    } finally {
      built.session.dispose();
      policy.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xuwu-kimi-compaction-'))
        throw new Error('Unsafe Kimi compaction cleanup path');
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
