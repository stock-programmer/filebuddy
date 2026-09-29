import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { compressionWatermark, getRunLimits, inputLimit, loadConfig } from '../src/config.js';

const appRoot = process.cwd();
const config = loadConfig({ envFile: path.join(appRoot, '.env') });
const evidenceRoot = path.join(appRoot, 'evidence');

function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    /\b(CONTEXT_COMPACTION_FAILED|CONTEXT_LIMIT|MODEL_FIRST_CONTENT_TIMEOUT|MODEL_IDLE_TIMEOUT|TOKENIZER_[A-Z_]+|TOKEN_LIMIT|MODEL_LIMIT|TOOL_LIMIT|OUTPUT_LIMIT)\b/.exec(
      message,
    )?.[1];
  if (code) return code;
  if (/429|rate.?limit/i.test(message)) return 'RATE_LIMIT';
  if (/balance|quota|insufficient|credit/i.test(message)) return 'QUOTA_OR_BALANCE';
  if (/401|authentication|unauthorized/i.test(message)) return 'AUTHENTICATION';
  if (/timeout|timed out/i.test(message)) return 'TIMEOUT';
  return /^([A-Z][A-Z0-9_]{2,})(?::|\s|$)/.exec(message)?.[1] ?? 'VERIFICATION_FAILED';
}

async function probeTokenizer() {
  assert.ok(config.model.apiKey, 'CREDENTIALS_MISSING');
  const messages = [{ role: 'user', content: 'Synthetic acceptance fixture. Reply PROBE_OK.' }];
  const variants = [
    { label: 'messages', payload: { model: config.model.model, messages } },
    {
      label: 'messages_tools_output_reasoning',
      payload: {
        model: config.model.model,
        messages,
        tools: [
          {
            type: 'function',
            function: {
              name: 'synthetic_probe',
              description: 'Synthetic fixture tool for verifying tokenizer schema overhead.',
              parameters: {
                type: 'object',
                properties: { marker: { type: 'string', description: 'Synthetic marker' } },
                required: ['marker'],
                additionalProperties: false,
              },
            },
          },
        ],
        max_completion_tokens: 32768,
        reasoning_effort: 'high',
      },
    },
  ];
  const rows: { label: string; status: number; totalTokens: number | null; elapsedMs: number }[] = [];
  for (const variant of variants) {
    const started = Date.now();
    const response = await fetch(
      `${config.model.baseUrl.replace(/\/$/, '')}/tokenizers/estimate-token-count`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.model.apiKey}` },
        body: JSON.stringify(variant.payload),
        signal: AbortSignal.timeout(config.run.requestIdleTimeoutMs),
      },
    );
    const body = (await response.json()) as { data?: { total_tokens?: unknown } };
    const totalTokens = Number.isSafeInteger(body.data?.total_tokens)
      ? Number(body.data?.total_tokens)
      : null;
    rows.push({
      label: variant.label,
      status: response.status,
      totalTokens,
      elapsedMs: Date.now() - started,
    });
  }
  const report = {
    date: new Date().toISOString(),
    syntheticOnly: true,
    chatCompletions: 0,
    rows,
    toolSchemaTokenDifference: rows.every((row) => row.totalTokens !== null)
      ? rows[1].totalTokens! - rows[0].totalTokens!
      : null,
    passed: rows.every((row) => row.status === 200 && row.totalTokens !== null),
  };
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    path.join(evidenceRoot, 'defaults-live-tokenizer-probe.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.ok(report.passed, 'TOKENIZER_PROBE_FAILED');
}

type SafeRow = Record<string, unknown>;
type TraceRow = Record<string, any>;
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const enumValue = (value: unknown) =>
  typeof value === 'string' && /^[a-zA-Z_][a-zA-Z_0-9-]{0,60}$/.test(value) ? value : null;

async function traceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? traceFiles(path.join(directory, entry.name))
        : Promise.resolve(entry.name.endsWith('.jsonl') ? [path.join(directory, entry.name)] : []),
    ),
  );
  return nested.flat();
}

async function readTrace(file: string): Promise<TraceRow[]> {
  return (await readFile(file, 'utf8'))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, i) => ({ ...JSON.parse(line), line: i + 1 }));
}

function summarizeTrace(rows: TraceRow[]) {
  const requests = new Map(
    rows.filter((row) => row.type === 'model_request').map((row) => [row.eventId, row]),
  );
  return {
    requests: requests.size,
    payloads: rows
      .filter((row) => row.type === 'model_payload')
      .map((row) => ({
        kind: enumValue(row.kind),
        contextWindow: number(row.contextWindow),
        modelOutputCapacity: number(row.modelOutputCapacity),
        inputTokens: number(row.inputTokens),
        inputSource: enumValue(row.inputSource),
        requestedOutputLimit: number(row.requestedOutputLimit),
        outputLimit: number(row.outputLimit),
        outputField: enumValue(row.outputField),
        reasoningEffort: enumValue(row.reasoningEffort),
        messageCount: number(row.messageCount),
        toolCount: number(row.toolCount),
      })),
    responses: rows
      .filter((row) => row.type === 'model_response')
      .map((row) => {
        const request = requests.get(row.parentId);
        const usage = row.usage;
        return {
          kind: enumValue(row.kind),
          stopReason: enumValue(row.status),
          source: enumValue(row.source),
          inputEstimate: number(request?.inputEstimate),
          outputLimit: number(request?.outputLimit),
          reasoningEffort: enumValue(request?.reasoningEffort),
          input: number(usage?.input),
          cacheRead: number(usage?.cacheRead),
          cacheWrite: number(usage?.cacheWrite),
          inputWithCache: usage
            ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
            : null,
          output: number(usage?.output),
          reasoning: number(usage?.reasoning),
          totalTokens: number(usage?.totalTokens),
          elapsedMs: number(row.elapsedMs),
          firstContentLatencyMs: number(row.streamMetrics?.firstContentLatencyMs),
          maxContentGapMs: number(row.streamMetrics?.maxContentGapMs),
          errorClass: row.error ? failureCode(row.error) : null,
        };
      }),
    tools: rows
      .filter((row) => row.type === 'tool_end')
      .map((row) => ({
        tool: enumValue(row.tool),
        status: enumValue(row.status),
        elapsedMs: number(row.elapsedMs),
        bytes: number(row.bytes),
      })),
    compactions: rows
      .filter((row) => row.type === 'compaction_end')
      .map((row) => ({
        status: enumValue(row.status),
        aborted: row.aborted === true,
        errorClass: row.error ? failureCode(row.error) : null,
      })),
    boundaries: rows
      .filter((row) => row.type === 'boundary_decision')
      .map((row) => ({
        decision: enumValue(row.decision),
        timeoutKind: enumValue(row.timeoutKind),
        timeoutMs: number(row.timeoutMs),
        timeoutPhase: enumValue(row.timeoutPhase),
        inputEstimate: number(row.inputEstimate),
        watermark: number(row.watermark),
        beforeEstimate: number(row.beforeEstimate),
        afterEstimate: number(row.afterEstimate),
        inputLimit: number(row.inputLimit),
        compacted: typeof row.compacted === 'boolean' ? row.compacted : null,
        reason: row.reason ? failureCode(row.reason) : null,
      })),
  };
}

function payloadsMatchDefaults(summary: ReturnType<typeof summarizeTrace>) {
  return (
    summary.payloads.length > 0 &&
    summary.payloads.every(
      (payload) =>
        payload.contextWindow === config.model.contextWindow &&
        payload.modelOutputCapacity === config.model.maxTokens &&
        payload.inputSource === 'moonshot_tokenizer' &&
        typeof payload.inputTokens === 'number' &&
        payload.outputField === 'max_completion_tokens' &&
        payload.outputLimit === 32768 &&
        payload.reasoningEffort === (payload.kind === 'compaction' ? 'low' : 'high'),
    )
  );
}

async function verifyDefaults({
  longOnly = false,
  compactionOnly = false,
}: { longOnly?: boolean; compactionOnly?: boolean } = {}) {
  assert.ok(config.model.apiKey, 'CREDENTIALS_MISSING');
  const limits = getRunLimits(config);
  // These are acceptance expectations, not defaults used by production modules.
  assert.equal(config.model.contextWindow, 1048576, 'DEFAULT_CONTEXT_NOT_EFFECTIVE');
  assert.equal(config.model.maxTokens, 1048576, 'MODEL_OUTPUT_CAP_NOT_EFFECTIVE');
  assert.equal(limits.outputTokens, 32768, 'DEFAULT_OUTPUT_NOT_EFFECTIVE');
  assert.equal(limits.compactionOutputTokens, 32768, 'DEFAULT_SUMMARY_NOT_EFFECTIVE');
  assert.equal(limits.safetyTokens, 8192, 'DEFAULT_SAFETY_NOT_EFFECTIVE');
  assert.equal(limits.compressionRatio, 0.9, 'DEFAULT_WATERMARK_NOT_EFFECTIVE');
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const privateRoot = await mkdtemp(path.join(tmpdir(), 'xuwu-defaults-live-'));
  const reportFile = path.join(evidenceRoot, `defaults-live-${id}.json`);
  const report: {
    date: string;
    syntheticOnly: boolean;
    effective: SafeRow;
    harness: SafeRow;
    stages: SafeRow[];
    traces: SafeRow[];
    passed: boolean;
    failure?: string;
  } = {
    date: new Date().toISOString(),
    syntheticOnly: true,
    effective: {
      contextWindow: config.model.contextWindow,
      modelOutputCapacity: config.model.maxTokens,
      outputTokens: limits.outputTokens,
      compactionOutputTokens: limits.compactionOutputTokens,
      safetyTokens: limits.safetyTokens,
      compressionRatio: limits.compressionRatio,
      inputLimit: inputLimit(limits),
      watermark: compressionWatermark(limits),
      reasoningEffort: enumValue((limits as unknown as SafeRow).reasoningEffort),
      compactionReasoningEffort: enumValue((limits as unknown as SafeRow).compactionReasoningEffort),
      maxRecentTokens: limits.compaction.maxRecentTokens,
      maxToolFailures: limits.maxToolFailures,
      requestIdleTimeoutMs: limits.requestIdleTimeoutMs,
      requestFirstContentTimeoutMs: number((limits as unknown as SafeRow).requestFirstContentTimeoutMs),
    },
    harness: {
      maxRequestsPerAgentStage: 12,
      perStageDeadlineMs: 15 * 60 * 1000,
      calibrationAttemptsPerSize: 3,
      directLargeRequests: compactionOnly ? 0 : longOnly ? 1 : 2,
      resumeLargeStagesOnly: longOnly,
      compactionOnly,
      autoCompactionEntry: 'AgentService.openSession_and_send',
      altersProductionWindow: false,
      altersProductionOutputBudget: false,
    },
    stages: [],
    traces: [],
    passed: false,
  };
  await mkdir(evidenceRoot, { recursive: true });
  const save = () => writeFile(reportFile, JSON.stringify(report, null, 2));
  const checkpoint = async (stage: SafeRow) => {
    report.stages.push(stage);
    await save();
    console.log(`STAGE ${stage.name}: ${stage.passed ? 'PASS' : 'RECORDED'}`);
  };
  await save();
  const { AppController } = await import('../src/app/controller.js');
  const { AgentService } = await import('../src/app/agent-service.js');
  const { WorkspaceService } = await import('../src/workspace/workspace-service.js');
  const { createSession } = await import('../src/agent/create-session.js');
  const { estimateSessionInput, buildSessionContext } = await import('../src/agent/context-compaction.js');
  const { RunPolicy } = await import('../src/agent/run-policy.js');
  const { TraceWriter } = await import('../src/observability/trace.js');
  const dataRoot = path.join(privateRoot, 'files-data');
  let harnessStopped = false;
  const controller = new AppController(
    dataRoot,
    appRoot,
    (event) => {
      if (
        event.type === 'snapshot' &&
        (event.snapshot.run?.modelCalls ?? 0) >= 12 &&
        event.snapshot.run?.status === 'running'
      ) {
        harnessStopped = true;
        void controller.stop();
      }
    },
    config,
  );
  let longSession: Awaited<ReturnType<typeof createSession>> | undefined;
  let autoService: InstanceType<typeof AgentService> | undefined;
  let inspectionSession: Awaited<ReturnType<typeof createSession>> | undefined;
  let longPolicy: InstanceType<typeof RunPolicy> | undefined;
  let stageTimer: ReturnType<typeof setTimeout> | undefined;
  const boundStage = async (action: () => Promise<void>, stop: () => Promise<void>) => {
    harnessStopped = false;
    stageTimer = setTimeout(
      () => {
        harnessStopped = true;
        void stop();
      },
      15 * 60 * 1000,
    );
    try {
      await action();
      assert.equal(harnessStopped, false, 'HARNESS_BOUND_REACHED');
    } finally {
      clearTimeout(stageTimer);
      stageTimer = undefined;
    }
  };
  try {
    if (!longOnly && !compactionOnly) {
      const marker = `KEEP-${randomUUID().slice(0, 8)}`;
      const original = `# Synthetic acceptance fixture\nproject=ALPHA\ndate=2026-10-01\nmarker=${marker}\n`;
      const source = path.join(privateRoot, 'synthetic-source.txt');
      await writeFile(source, original);
      await controller.initialize();
      await controller.create('合成材料默认配置验收');
      await controller.importPaths([source]);
      await boundStage(
        () =>
          controller.send(
            '这是合成验收文件。请读取唯一导入文件，把 project=ALPHA 改为 project=BETA，把 date=2026-10-01 改为 date=2026-10-15。保留 marker 不变。实际编辑副本，最后简短列出改后的 project、date、marker；不要写回原件。',
          ),
        () => controller.stop(),
      );
      assert.equal(controller.agent.getRun()?.status, 'ready_for_review', 'FILE_RUN_NOT_READY');
      const workFile = path.join(controller.current!.workDir, controller.current!.items[0].workPath);
      const edited = await readFile(workFile, 'utf8');
      assert.ok(
        edited.includes('project=BETA') && edited.includes('date=2026-10-15') && edited.includes(marker),
        'FILE_EDIT_FACTS_MISSING',
      );
      assert.equal(await readFile(source, 'utf8'), original, 'ORIGINAL_FILE_CHANGED');
      const fileTrace = summarizeTrace(await readTrace(controller.agent.getTracePath()!));
      assert.ok(payloadsMatchDefaults(fileTrace), 'FILE_DEFAULT_PAYLOAD_MISMATCH');
      await checkpoint({
        name: 'real_file_read_edit_and_original_protection',
        passed: true,
        trace: fileTrace,
      });
      await boundStage(
        () => controller.compact(),
        () => controller.stop(),
      );
      assert.equal(controller.agent.getRun()?.status, 'ready_for_review', 'MANUAL_SUMMARY_NOT_READY');
      const manualTrace = summarizeTrace(await readTrace(controller.agent.getTracePath()!));
      assert.ok(payloadsMatchDefaults(manualTrace), 'SUMMARY_DEFAULT_PAYLOAD_MISMATCH');
      assert.ok(
        manualTrace.responses.some((row) => row.kind === 'compaction' && row.stopReason === 'stop'),
        'REAL_SUMMARY_RESPONSE_MISSING',
      );
      await boundStage(
        () =>
          controller.send(
            '仅依据压缩后的上下文回答刚才文件最新 project、date 和完整 marker。不要调用工具或重新读取文件，不要修改文件。',
          ),
        () => controller.stop(),
      );
      assert.equal(controller.agent.getRun()?.status, 'ready_for_review', 'POST_SUMMARY_RUN_NOT_READY');
      const answer =
        controller.agent
          .getMessages()
          .filter((message) => message.role === 'assistant')
          .at(-1)?.text ?? '';
      assert.ok(
        ['BETA', '2026-10-15', marker].every((fact) => answer.includes(fact)),
        'POST_SUMMARY_FACTS_MISSING',
      );
      const recallTrace = summarizeTrace(await readTrace(controller.agent.getTracePath()!));
      assert.ok(payloadsMatchDefaults(recallTrace), 'RECALL_DEFAULT_PAYLOAD_MISMATCH');
      assert.equal(recallTrace.tools.length, 0, 'POST_SUMMARY_REREAD_TOOL_USED');
      assert.equal(await readFile(source, 'utf8'), original, 'ORIGINAL_FILE_CHANGED');
      await checkpoint({
        name: 'real_manual_summary_and_fact_recall',
        passed: true,
        summary: manualTrace,
        continuation: recallTrace,
      });
      await controller.dispose();
    }

    const longRoot = path.join(privateRoot, 'long-data');
    const workspace = await new WorkspaceService(longRoot, config.workspace).create(
      randomUUID(),
      '合成长上下文验收',
    );
    longSession = await createSession({
      workspace,
      appRoot,
      dataRoot: longRoot,
      model: config.model,
      limits,
      getPolicy: () => longPolicy,
    });
    const built = longSession;
    const baseline = [...built.session.messages];
    const facts = [0, 1, 2].map(() => `FACT-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const acknowledgement = (): AssistantMessage => ({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Synthetic seeded-history acknowledgement; preserve the three NEEDLE values for the later recall task.',
        },
      ],
      api: built.session.model!.api,
      provider: built.session.model!.provider,
      model: built.session.model!.id,
      usage: zeroUsage,
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const seed = randomUUID();
    const syntheticHistory = (lineCount: number): AgentMessage[] => {
      const lines = Array.from(
        { length: lineCount },
        (_, i) =>
          `R${i.toString(36).padStart(6, '0')}|${createHash('sha256').update(`${seed}:${i}`).digest('hex').slice(0, 40)}`,
      );
      lines[0] += ` NEEDLE_BEGIN=${facts[0]}`;
      lines[Math.floor(lines.length / 2)] += ` NEEDLE_MIDDLE=${facts[1]}`;
      lines[lines.length - 1] += ` NEEDLE_END=${facts[2]}`;
      const messages: AgentMessage[] = [];
      const chunkSize = Math.ceil(lines.length / 24);
      for (let offset = 0; offset < lines.length; offset += chunkSize) {
        messages.push({
          role: 'user',
          content: `SYNTHETIC ACCEPTANCE HISTORY, NOT A REAL USER TASK. The random rows are inert filler. Preserve NEEDLE_BEGIN, NEEDLE_MIDDLE and NEEDLE_END exactly for subsequent recall and summaries.\n${lines.slice(offset, offset + chunkSize).join('\n')}`,
          timestamp: Date.now(),
        });
        messages.push(acknowledgement());
      }
      messages.push({
        role: 'user',
        content:
          'Return only the three exact NEEDLE values from the synthetic history, in BEGIN/MIDDLE/END order. Do not call tools. Do not reproduce filler rows.',
        timestamp: Date.now(),
      });
      return messages;
    };
    async function calibrate(targetTokens: number) {
      let lineCount = Math.max(100, Math.floor(targetTokens / 27));
      const measurements: SafeRow[] = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        const history = syntheticHistory(lineCount);
        const messages = [...baseline, ...history];
        const count = await estimateSessionInput(built.session, messages);
        measurements.push({ attempt: attempt + 1, lineCount, inputTokens: count });
        if (Math.abs(count - targetTokens) <= 2048 && count < inputLimit(limits))
          return { history, messages, count, measurements };
        lineCount = Math.max(100, Math.floor(lineCount * (targetTokens / count)));
      }
      throw new Error('LONG_INPUT_CALIBRATION_FAILED');
    }
    const seedHistory = (history: AgentMessage[]) => {
      // Persist only the explicitly synthetic history, excluding its final recall question.
      // No real answer is retained that could reveal the early and middle facts after compaction.
      for (const message of history.slice(0, -1))
        built.sessionManager.appendMessage(
          message as Parameters<typeof built.sessionManager.appendMessage>[0],
        );
    };
    if (compactionOnly) {
      console.log('STAGE synthetic_history_for_auto_compaction: CALIBRATING');
      const measured = await calibrate(compressionWatermark(limits) + 4096);
      seedHistory(measured.history);
      await checkpoint({
        name: 'synthetic_history_prepared_for_auto_compaction',
        passed: true,
        tokenizerTokens: measured.count,
        calibration: measured.measurements,
        chatCompletions: 0,
      });
    }
    const directTargets = compactionOnly
      ? []
      : [...(longOnly ? [] : [80000]), compressionWatermark(limits) + 4096];
    for (const targetTokens of directTargets) {
      const nearWatermark = targetTokens >= compressionWatermark(limits);
      const stageName = nearWatermark ? 'real_input_near_default_watermark' : 'real_input_above_64k';
      console.log(`STAGE ${stageName}: CALIBRATING`);
      const measured = await calibrate(targetTokens);
      const trace = new TraceWriter(longRoot, workspace.id, randomUUID(), [config.model.apiKey]);
      longPolicy = new RunPolicy(limits, trace);
      const context = await buildSessionContext(built.session, measured.messages);
      let result: AssistantMessage | undefined;
      await boundStage(
        async () => {
          const stream = await built.session.agent.streamFunction(built.session.model!, context, {
            maxTokens: limits.outputTokens,
          });
          result = await stream.result();
        },
        async () => {
          longPolicy?.stop('cancelled', 'HARNESS_DEADLINE');
          await built.session.abort();
        },
      );
      const summary = summarizeTrace(await readTrace(trace.path));
      const returnedText = result!.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      const actualInput = result!.usage.input + result!.usage.cacheRead + result!.usage.cacheWrite;
      await checkpoint({
        name: stageName,
        passed:
          result!.stopReason === 'stop' &&
          facts.every((fact) => returnedText.includes(fact)) &&
          payloadsMatchDefaults(summary) &&
          actualInput > 65536 &&
          (!nearWatermark || actualInput >= compressionWatermark(limits) * 0.97),
        targetTokens,
        tokenizerTokens: measured.count,
        actualInputTokens: actualInput,
        calibration: measured.measurements,
        trace: summary,
        errorClass: result!.errorMessage ? failureCode(result!.errorMessage) : null,
      });
      assert.equal(result!.stopReason, 'stop', 'LONG_INPUT_COMPLETION_FAILED');
      assert.ok(payloadsMatchDefaults(summary), 'LONG_INPUT_DEFAULT_PAYLOAD_MISMATCH');
      assert.ok(
        facts.every((fact) => returnedText.includes(fact)),
        'LONG_INPUT_FACTS_MISSING',
      );
      assert.ok(actualInput > 65536, 'REAL_INPUT_NOT_ABOVE_64K');
      if (nearWatermark) {
        assert.ok(actualInput >= compressionWatermark(limits) * 0.97, 'REAL_INPUT_NOT_NEAR_WATERMARK');
        seedHistory(measured.history);
      }
      longPolicy.close();
    }
    assert.ok(built.sessionManager.getSessionFile(), 'SEEDED_SESSION_NOT_PERSISTED');
    built.session.dispose();
    longSession = undefined;
    // Reopen persisted history through the production service. Its first-turn preflight is
    // responsible for automatic compaction; native prompt() alone skips that application boundary.
    autoService = new AgentService({
      appRoot,
      dataRoot: longRoot,
      config,
      onEvent: () => {},
      onChange: () => {
        const run = autoService?.getRun();
        if (run && run.modelCalls >= 12 && run.status === 'running') {
          harnessStopped = true;
          void autoService?.stop();
        }
      },
    });
    await autoService.openSession(workspace);
    console.log('STAGE real_default_watermark_auto_compaction: RUNNING');
    await boundStage(
      () =>
        autoService!.send(
          'Continue this synthetic acceptance task: return the three exact NEEDLE values from the earlier history in BEGIN/MIDDLE/END order. Do not call tools or reproduce filler.',
        ),
      () => autoService!.stop(),
    );
    const autoSummary = summarizeTrace(await readTrace(autoService.getTracePath()!));
    const autoRun = autoService.getRun();
    const latestText =
      autoService
        .getMessages()
        .filter((message) => message.role === 'assistant')
        .at(-1)?.text ?? '';
    await autoService.dispose();
    inspectionSession = await createSession({
      workspace,
      appRoot,
      dataRoot: longRoot,
      model: config.model,
      limits,
      getPolicy: () => undefined,
    });
    const summaryFactChecks = inspectionSession.sessionManager
      .getBranch()
      .flatMap((entry) =>
        entry.type === 'compaction'
          ? [{ matches: facts.map((fact) => entry.summary.includes(fact)), characters: entry.summary.length }]
          : [],
      );
    const afterTokens = await estimateSessionInput(
      inspectionSession.session,
      inspectionSession.sessionManager.buildSessionProjection().messages,
    );
    const earlyFactsSummarized = summaryFactChecks.some((check) => check.matches[0] && check.matches[1]);
    const thresholdObserved = autoSummary.boundaries.some(
      (row) =>
        (row.decision === 'preflight_compaction' || row.decision === 'between_turn_compaction') &&
        (row.inputEstimate ?? 0) >= compressionWatermark(limits),
    );
    const autoPassed =
      autoSummary.compactions.some((item) => item.status === 'success') &&
      autoRun?.status === 'ready_for_review' &&
      autoSummary.responses.filter((row) => row.kind === 'conversation').at(-1)?.stopReason === 'stop' &&
      autoSummary.responses.some((row) => row.kind === 'compaction' && row.stopReason === 'stop') &&
      facts.every((fact) => latestText.includes(fact)) &&
      earlyFactsSummarized &&
      thresholdObserved &&
      afterTokens < compressionWatermark(limits) &&
      payloadsMatchDefaults(autoSummary);
    await checkpoint({
      name: 'real_default_watermark_auto_compaction_and_continuation',
      passed: autoPassed,
      afterTokens,
      runStatus: enumValue(autoRun?.status),
      errorClass: autoRun?.error ? failureCode(autoRun.error) : null,
      defaultWindowUnchanged: inspectionSession.session.model!.contextWindow === config.model.contextWindow,
      summaryFactChecks,
      trace: autoSummary,
    });
    assert.ok(autoPassed, 'AUTO_COMPACTION_ACCEPTANCE_FAILED');
    assert.ok(
      summaryFactChecks.some((check) => check.matches[0] && check.matches[1]),
      'EARLY_AND_MIDDLE_FACTS_NOT_IN_SUMMARY',
    );
    assert.ok(afterTokens < compressionWatermark(limits), 'POST_COMPACTION_CONTEXT_STILL_HIGH');
    assert.ok(
      autoSummary.boundaries.some(
        (row) =>
          (row.decision === 'preflight_compaction' || row.decision === 'between_turn_compaction') &&
          (row.inputEstimate ?? 0) >= compressionWatermark(limits),
      ),
      'DEFAULT_AUTO_THRESHOLD_NOT_OBSERVED',
    );
    report.passed = true;
  } catch (error) {
    report.failure = failureCode(error);
    process.exitCode = 1;
  } finally {
    if (stageTimer) clearTimeout(stageTimer);
    longPolicy?.close();
    longSession?.session.dispose();
    inspectionSession?.session.dispose();
    await autoService?.dispose();
    await controller.dispose();
    for (const file of await traceFiles(privateRoot)) {
      const rows = await readTrace(file);
      const text = await readFile(file, 'utf8');
      assert.ok(!text.includes(config.model.apiKey), 'CREDENTIAL_IN_TRACE');
      report.traces.push({ file: path.basename(file), ...summarizeTrace(rows) });
    }
    await save();
    // This exact directory was created by mkdtemp above; cleanup cannot target a user workspace.
    assert.equal(path.dirname(privateRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(privateRoot).startsWith('xuwu-defaults-live-'));
    await rm(privateRoot, { recursive: true, force: true });
    console.log(
      `REPORT ${path.relative(appRoot, reportFile)} ${report.passed ? 'PASS' : 'FAIL'}${report.failure ? ` ${report.failure}` : ''}`,
    );
  }
}

async function verifyOutputAboveLegacyCap() {
  assert.ok(config.model.apiKey, 'CREDENTIALS_MISSING');
  const { WorkspaceService } = await import('../src/workspace/workspace-service.js');
  const { createSession } = await import('../src/agent/create-session.js');
  const { buildSessionContext } = await import('../src/agent/context-compaction.js');
  const { RunPolicy } = await import('../src/agent/run-policy.js');
  const { TraceWriter } = await import('../src/observability/trace.js');
  const privateRoot = await mkdtemp(path.join(tmpdir(), 'xuwu-defaults-live-'));
  const reportFile = path.join(
    evidenceRoot,
    `defaults-live-output-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const workspace = await new WorkspaceService(privateRoot, config.workspace).create(
    randomUUID(),
    '合成长输出验收',
  );
  const trace = new TraceWriter(privateRoot, workspace.id, randomUUID(), [config.model.apiKey]);
  const limits = getRunLimits(config);
  const policy = new RunPolicy(limits, trace);
  const built = await createSession({
    workspace,
    appRoot,
    dataRoot: privateRoot,
    model: config.model,
    limits,
    getPolicy: () => policy,
  });
  const report: SafeRow = {
    date: new Date().toISOString(),
    syntheticOnly: true,
    expectedSequenceLength: 2000,
    passed: false,
  };
  const timer = setTimeout(() => policy.stop('cancelled', 'HARNESS_DEADLINE'), 15 * 60 * 1000);
  console.log('STAGE real_output_above_4096: RUNNING');
  try {
    const messages: AgentMessage[] = [
      ...built.session.messages,
      {
        role: 'user',
        content:
          'Synthetic exact-output acceptance test. Return only a valid JSON object with one property named sequence whose value is the complete array of every integer from 1 through 2000 in ascending order. Include every integer exactly once. No ellipses, no ranges, no code fences, no prose, no tools. The array will be parsed and checked automatically.',
        timestamp: Date.now(),
      },
    ];
    const context = await buildSessionContext(built.session, messages);
    const stream = await built.session.agent.streamFunction(built.session.model!, context, {
      maxTokens: limits.outputTokens,
    });
    const response = await stream.result();
    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const summary = summarizeTrace(await readTrace(trace.path));
    report.trace = summary;
    report.stopReason = response.stopReason;
    report.outputTokens = response.usage.output;
    report.responseCharacters = text.length;
    report.errorClass = response.errorMessage ? failureCode(response.errorMessage) : null;
    assert.equal(response.stopReason, 'stop', 'LONG_OUTPUT_NOT_COMPLETE');
    assert.ok(payloadsMatchDefaults(summary), 'LONG_OUTPUT_DEFAULT_PAYLOAD_MISMATCH');
    const parsed = JSON.parse(text) as { sequence?: unknown };
    report.observedSequenceCount = Array.isArray(parsed.sequence) ? parsed.sequence.length : null;
    const exact =
      Array.isArray(parsed.sequence) &&
      parsed.sequence.length === 2000 &&
      parsed.sequence.every((value, index) => value === index + 1);
    report.exactSequence = exact;
    assert.ok(exact, 'LONG_OUTPUT_SEQUENCE_INCOMPLETE');
    assert.ok(response.usage.output > 4096, 'LONG_OUTPUT_DID_NOT_EXCEED_4096');
    report.passed = true;
  } catch (error) {
    report.failure = failureCode(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    policy.close();
    built.session.dispose();
    report.trace = summarizeTrace(await readTrace(trace.path));
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(reportFile, JSON.stringify(report, null, 2));
    assert.equal(path.dirname(privateRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(privateRoot).startsWith('xuwu-defaults-live-'));
    await rm(privateRoot, { recursive: true, force: true });
    console.log(`REPORT ${path.relative(appRoot, reportFile)} ${report.passed ? 'PASS' : 'FAIL'}`);
  }
}

try {
  if (process.argv[2] === '--probe-tokenizer') await probeTokenizer();
  else if (process.argv[2] === '--run') {
    await verifyDefaults();
    if (!process.exitCode) await verifyOutputAboveLegacyCap();
  } else if (process.argv[2] === '--output-only') await verifyOutputAboveLegacyCap();
  else if (process.argv[2] === '--long-only') await verifyDefaults({ longOnly: true });
  else if (process.argv[2] === '--compaction-only')
    await verifyDefaults({ longOnly: true, compactionOnly: true });
  else throw new Error('EXPLICIT_VERIFICATION_MODE_REQUIRED');
} catch (error) {
  process.exitCode = 1;
  console.error(failureCode(error));
}
