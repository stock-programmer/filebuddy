import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { AppController } from '../src/app/controller.js';
import { loadConfig } from '../src/config.js';

const appRoot = process.cwd();
const config = loadConfig({ envFile: path.join(appRoot, '.env') });
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
const privateRoot = path.join(appRoot, 'evidence', 'private', runId);
const sourceRoot = path.join(privateRoot, 'originals', 'docs');
const dataRoot = path.join(privateRoot, 'data');
await mkdir(path.join(sourceRoot, '子目录'), { recursive: true });
const originalFiles = {
  '项目说明.md': '# 项目说明\n\n项目代号：青禾\n交付日期：2026-10-01\n\n\n\n保留标记 KEEP-42\n',
  '子目录/清单.txt': '\ufeff项目代号：青禾\r\n交付日期：2026-10-01\r\n\r\n\r\n保留标记 KEEP-42\r\n',
};
for (const [name, content] of Object.entries(originalFiles))
  await writeFile(path.join(sourceRoot, name), content, 'utf8');
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const record = (name: string, detail?: unknown) => {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}`);
};
const controller = new AppController(
  dataRoot,
  appRoot,
  (event) => {
    if (event.type === 'activity') console.log(`ACTIVITY ${event.text}`);
  },
  config,
);
let restored: AppController | undefined;
try {
  await controller.initialize();
  await controller.create('真实模型验收');
  await controller.importPaths([sourceRoot]);
  const sessionId = controller.current!.id;
  const root = controller.current!.items[0].workPath;
  record('import', { roots: controller.current!.items.length });
  await controller.send(
    '请使用 text-cleanup 技能清理所有导入的文本：把项目代号“青禾”改成“星河”，将连续多个空行合并为一个空行。必须保留 KEEP-42、原来的日期、UTF-8 BOM 和 CRLF 换行格式。请实际修改文件，完成后简要说明。',
  );
  assert.equal(
    controller.agent.getRun()?.status,
    'ready_for_review',
    controller.agent.getRun()?.error ?? 'run failed',
  );
  const first = await readFile(path.join(controller.current!.workDir, root, '项目说明.md'), 'utf8');
  const bom = await readFile(path.join(controller.current!.workDir, root, '子目录', '清单.txt'));
  assert.match(first, /星河/);
  assert.doesNotMatch(first, /青禾/);
  assert.match(first, /KEEP-42/);
  assert.doesNotMatch(first, /\n{3,}/);
  assert.equal(bom.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.ok(bom.toString('utf8').includes('\r\n'));
  record('real_model_round_1_edit_and_encoding');
  await controller.send(
    '继续修改刚才的结果：将所有文本中的交付日期从 2026-10-01 改为 2026-10-15，并在导入目录内新建 summary.txt，写出当前项目代号、交付日期和 KEEP-42。不要改变其他内容。',
  );
  assert.equal(
    controller.agent.getRun()?.status,
    'ready_for_review',
    controller.agent.getRun()?.error ?? 'run failed',
  );
  const summary = await readFile(path.join(controller.current!.workDir, root, 'summary.txt'), 'utf8');
  for (const expected of ['星河', '2026-10-15', 'KEEP-42'])
    assert.ok(summary.includes(expected), `Missing ${expected}`);
  record('real_model_round_2_continuation_and_create');
  for (const [name, content] of Object.entries(originalFiles))
    assert.equal(await readFile(path.join(sourceRoot, name), 'utf8'), content);
  record('originals_unchanged_before_confirmation');
  const tracePath = controller.agent.getTracePath()!;
  const traceText = await readFile(tracePath, 'utf8');
  assert.ok(traceText.includes('model_request'));
  assert.ok(traceText.includes('tool_'));
  assert.ok(traceText.includes('budget'));
  const previousTrace = (await readdir(path.dirname(tracePath))).filter((x) => x.endsWith('.jsonl'));
  let allTrace = '';
  for (const f of previousTrace) allTrace += await readFile(path.join(path.dirname(tracePath), f), 'utf8');
  assert.ok(allTrace.includes('skill_load'), 'No real skill loading event');
  if (config.model.apiKey) assert.ok(!allTrace.includes(config.model.apiKey));
  record('trace_includes_model_tool_skill_budget_and_redacts_key');
  await controller.export(path.join(privateRoot, 'result.zip'));
  record('zip_export');
  await controller.dispose();
  restored = new AppController(dataRoot, appRoot, () => {}, config);
  await restored.initialize();
  assert.equal(restored.current?.id, sessionId);
  assert.ok(restored.agent.getMessages().length >= 4);
  await restored.send('延续刚才的工作，只回答当前项目代号、交付日期和需要保留的标记，不要修改文件。');
  const answer =
    restored.agent
      .getMessages()
      .filter((x) => x.role === 'assistant')
      .at(-1)?.text ?? '';
  for (const expected of ['星河', '2026-10-15', 'KEEP-42'])
    assert.ok(answer.includes(expected), `Restore answer missing ${expected}`);
  record('restart_restores_history_and_real_model_continues');
  await restored.compact();
  await restored.send('请根据压缩后的上下文复述此前要求保留的标记与最新交付日期，不要修改文件。');
  const compactAnswer =
    restored.agent
      .getMessages()
      .filter((x) => x.role === 'assistant')
      .at(-1)?.text ?? '';
  assert.ok(compactAnswer.includes('KEEP-42'));
  assert.ok(compactAnswer.includes('2026-10-15'));
  record('real_compaction_and_post_compaction_context');
  const delivery = restored.delivery();
  const preview = await delivery.preview();
  assert.equal(preview.conflicts.length, 0);
  await writeFile(path.join(sourceRoot, '项目说明.md'), '外部用户已修改。\n', 'utf8');
  let conflictBlocked = false;
  try {
    const result = await delivery.apply(preview.token);
    conflictBlocked = result.failed.length > 0;
  } catch {
    conflictBlocked = true;
  }
  assert.ok(conflictBlocked);
  assert.equal(await readFile(path.join(sourceRoot, '项目说明.md'), 'utf8'), '外部用户已修改。\n');
  record('writeback_rechecks_external_conflict');
  await writeFile(path.join(sourceRoot, '项目说明.md'), originalFiles['项目说明.md'], 'utf8');
  const fresh = await delivery.preview();
  assert.equal(fresh.conflicts.length, 0);
  const applied = await delivery.apply(fresh.token);
  assert.equal(applied.failed.length, 0);
  assert.match(await readFile(path.join(sourceRoot, '项目说明.md'), 'utf8'), /星河/);
  assert.ok((await readFile(path.join(sourceRoot, 'summary.txt'), 'utf8')).includes('2026-10-15'));
  record('confirmed_writeback_fixture_only', { applied: applied.applied.length });
} catch (error) {
  checks.push({
    name: 'verification_error',
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  await restored?.dispose();
  await controller.dispose();
  const report = {
    runId,
    date: new Date().toISOString(),
    model: config.model.model,
    provider: new URL(config.model.baseUrl).hostname,
    checks,
    passed: checks.every((c) => c.ok),
    evidenceDirectory: path.relative(appRoot, privateRoot),
  };
  await mkdir(path.join(appRoot, 'evidence'), { recursive: true });
  await writeFile(path.join(appRoot, 'evidence', 'live-verification.json'), JSON.stringify(report, null, 2));
  console.log(`Report: evidence/live-verification.json (${report.passed ? 'PASS' : 'FAIL'})`);
}
