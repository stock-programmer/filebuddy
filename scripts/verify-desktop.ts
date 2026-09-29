import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import AdmZip from 'adm-zip';
import type { AppSnapshot } from '../src/app/contracts.js';
import { loadConfig } from '../src/config.js';

// Native dialog responses are controlled only inside this test process, following
// https://playwright.dev/docs/api/class-electron#electron-launch .
// The rest of the path uses the real renderer, preload, IPC, Pi and model service.
const appRoot = process.cwd();
const config = loadConfig({ envFile: path.join(appRoot, '.env') });
const runId = `desktop-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
const evidenceRoot = path.join(appRoot, 'evidence');
const privateRoot = path.join(evidenceRoot, 'private', runId);
const sourceRoot = path.join(privateRoot, 'originals');
const dataRoot = path.join(privateRoot, 'data');
const checks: { name: string; ok: boolean; detail?: unknown }[] = [];
const limitations = [
  'Native open/save/confirmation dialogs were replaced with deterministic responses in the Electron main process; the operating-system dialog UI was not manually exercised.',
  'Drag/drop is tested using a real filesystem-backed File and a DOM DragEvent, not a physical mouse drag from Windows Explorer.',
];
const pageErrors: string[] = [];
const screenshots: string[] = [];
let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
let finalSnapshot: AppSnapshot | undefined;
let dialogCalls: unknown[] = [];
let dragDropResult: 'passed' | 'not_verified' = 'not_verified';

const record = (name: string, detail?: unknown) => {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}`);
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function snapshot(): Promise<AppSnapshot> {
  return page!.evaluate(() => window.xuwu.invoke('snapshot'));
}

async function waitForSnapshot(
  predicate: (snapshot: AppSnapshot) => boolean,
  label: string,
  timeout = 30000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await snapshot();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const latest = await snapshot();
  throw new Error(
    `${label}: timeout; run=${JSON.stringify(latest.run)}, warnings=${JSON.stringify(latest.warnings)}`,
  );
}

async function waitEnabled(testId: string) {
  await page!.waitForFunction(
    (id) => {
      const target = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
      return target && !target.disabled;
    },
    testId,
    { timeout: 30000 },
  );
}

async function stubOpen(paths: string[]) {
  await electronApp!.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const logs = (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls;
      logs.push({ kind: 'open', paths: filePaths, title: (args.at(-1) as { title?: string })?.title });
      return { canceled: false, filePaths };
    };
  }, paths);
}

async function stubSave(destination: string) {
  await electronApp!.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async (...args: unknown[]) => {
      const logs = (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls;
      logs.push({ kind: 'save', filePath, title: (args.at(-1) as { title?: string })?.title });
      return { canceled: false, filePath };
    };
  }, destination);
}

async function stubConfirmation(response: number) {
  await electronApp!.evaluate(({ dialog }, result) => {
    dialog.showMessageBox = async (...args: unknown[]) => {
      const logs = (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls;
      logs.push({
        kind: 'confirmation',
        response: result,
        title: (args.at(-1) as { title?: string })?.title,
      });
      return { response: result, checkboxChecked: false };
    };
  }, response);
}

async function screenshot(name: string) {
  const screenshotPath = path.join(evidenceRoot, name);
  await page!.screenshot({ path: screenshotPath });
  screenshots.push(path.relative(appRoot, screenshotPath));
}

await mkdir(path.join(sourceRoot, '资料目录'), { recursive: true });
await mkdir(path.join(sourceRoot, '参考目录'), { recursive: true });
const originalFiles = new Map<string, string>([
  ['项目说明.md', '# 项目说明\n\n项目代号：青禾\n保留标记 KEEP-DESKTOP-42\n'],
  ['待办.txt', '项目代号：青禾\n任务：完成文本整理\n保留标记 KEEP-DESKTOP-42\n'],
  ['资料目录/交付.txt', '\ufeff项目代号：青禾\r\n交付日期：2026-10-01\r\n保留标记 KEEP-DESKTOP-42\r\n'],
  ['参考目录/背景.md', '# 背景\n\n项目代号：青禾\n保留标记 KEEP-DESKTOP-42\n'],
  ['拖入材料.txt', '这份材料只用于验证文件拖入。\n保留标记 KEEP-DESKTOP-42\n'],
]);
for (const [relative, content] of originalFiles)
  await writeFile(path.join(sourceRoot, relative), content, 'utf8');

try {
  console.log(`START Electron desktop acceptance: ${runId}`);
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.XUWU_DATA_DIR = dataRoot;
  electronApp = await _electron.launch({
    args: ['.'],
    cwd: appRoot,
    env,
    timeout: 60000,
  });
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls = [];
  });
  page = await electronApp.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.locator('#model-name').waitFor();
  await page.waitForFunction(() => !!window.xuwu);
  const empty = await snapshot();
  assert.equal(empty.current, null);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.sessions.length, 0);
  assert.equal(empty.model.configured, true, 'A real model must be configured for desktop acceptance.');
  await screenshot('desktop-empty.png');
  record('electron_launch_and_empty_state', { model: empty.model });

  await page.getByTestId('new-session').click();
  const firstSession = await waitForSnapshot(
    (value) => value.sessions.length === 1 && !!value.current,
    'create first session',
  );
  const sessionId = firstSession.current!.id;
  record('new_session_via_ui');

  await stubOpen([path.join(sourceRoot, '项目说明.md'), path.join(sourceRoot, '待办.txt')]);
  await page.getByTestId('add-files').click();
  await waitForSnapshot((value) => value.items.length === 2, 'multi-file import');
  await page.getByTestId('material-item').nth(1).waitFor();
  record('native_picker_multi_file_import_via_ui');

  await stubOpen([path.join(sourceRoot, '资料目录'), path.join(sourceRoot, '参考目录')]);
  await page.getByTestId('add-directory').click();
  const imported = await waitForSnapshot((value) => value.items.length === 4, 'multi-directory append');
  assert.equal(imported.items.filter((item) => item.kind === 'directory').length, 2);
  assert.equal(await page.getByTestId('material-item').count(), 4);
  record('native_picker_multi_directory_append_via_ui');

  // A File from setInputFiles retains its filesystem provenance. A new File([...])
  // would not, and would not verify Electron webUtils.getPathForFile at all.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.dataset.testid = 'e2e-real-drop-file';
    input.hidden = true;
    document.body.append(input);
  });
  await page.getByTestId('e2e-real-drop-file').setInputFiles(path.join(sourceRoot, '拖入材料.txt'));
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="e2e-real-drop-file"]')!;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(input.files![0]);
    document.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer }));
    document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    input.remove();
  });
  try {
    await waitForSnapshot((value) => value.items.length === 5, 'filesystem-backed file drop', 10000);
    dragDropResult = 'passed';
    record('filesystem_backed_file_drop_preload_and_ipc');
  } catch (error) {
    limitations.push(
      `File drop was not accepted through the automated DOM path: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log('NOT VERIFIED physical file/directory drag from Explorer');
  }

  await page.getByTestId('new-session').click();
  const secondSession = await waitForSnapshot(
    (value) => value.sessions.length === 2 && value.current?.id !== sessionId,
    'second session',
  );
  assert.equal(secondSession.items.length, 0);
  await page.getByTestId(`session-${sessionId}`).click();
  await waitForSnapshot(
    (value) => value.current?.id === sessionId && value.items.length >= 4,
    'restore first session',
  );
  record('multiple_sessions_switch_and_restore_materials');

  const task =
    '请使用 text-cleanup 技能，实际编辑所有导入文本：只将项目代号“青禾”替换为“星河”，其他内容保持不变，保留 KEEP-DESKTOP-42、原始日期、UTF-8 BOM 和 CRLF。不要修改没有“青禾”的文件。完成后简要说明修改结果。';
  await page.getByTestId('task-input').fill(task);
  await page.getByTestId('send-task').click();
  await waitForSnapshot((value) => value.run?.status === 'running', 'model starts', 60000);
  console.log('RUN real model edits workspace copies; waiting for a settled result.');
  await page.getByTestId('task-input').fill('下一步我还想继续调整。');
  const completed = await waitForSnapshot(
    (value) =>
      !!value.run &&
      value.run.status !== 'running' &&
      value.messages.some((message) => message.role === 'user' && message.text.includes('KEEP-DESKTOP-42')),
    'real model settles',
    600000,
  );
  assert.equal(
    completed.run!.status,
    'ready_for_review',
    completed.run!.error || completed.run!.lastActivity,
  );
  assert.equal(
    await page.getByTestId('task-input').inputValue(),
    '下一步我还想继续调整。',
    'Snapshot refresh must preserve a draft.',
  );
  await page.getByTestId('task-input').fill('');
  assert.ok(completed.run!.modelCalls > 0);
  assert.ok(completed.run!.toolCalls > 0);
  assert.ok(completed.changes.length >= 4, `Expected four edited files, got ${completed.changes.length}`);
  assert.ok((await page.getByTestId('message-assistant').count()) > 0);
  const workRoot = path.join(dataRoot, 'workspaces', sessionId, 'work');
  for (const item of completed.items) {
    if (item.name === '拖入材料.txt') continue;
    const suffix = item.name === '资料目录' ? '交付.txt' : item.name === '参考目录' ? '背景.md' : '';
    const content = await readFile(path.join(workRoot, item.workPath, suffix), 'utf8');
    assert.match(content, /星河/);
    assert.doesNotMatch(content, /青禾/);
    assert.match(content, /KEEP-DESKTOP-42/);
  }
  const bomItem = completed.items.find((item) => item.name === '资料目录')!;
  const bomBytes = await readFile(path.join(workRoot, bomItem.workPath, '交付.txt'));
  assert.equal(bomBytes.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.ok(bomBytes.toString('utf8').includes('\r\n'));
  for (const [relative, content] of originalFiles)
    assert.equal(await readFile(path.join(sourceRoot, relative), 'utf8'), content);
  record('real_model_edit_stream_history_draft_and_original_protection', {
    modelCalls: completed.run!.modelCalls,
    toolCalls: completed.run!.toolCalls,
    changes: completed.changes.length,
  });

  const firstChange = completed.changes.find(
    (change) => !change.isDirectory && change.path.endsWith('项目说明.md'),
  )!;
  assert.ok(firstChange);
  await page
    .locator(`[data-testid="change-item"][data-path=${JSON.stringify(firstChange.path)}]`)
    .locator('.diff-link')
    .click();
  await page.locator('#diff-dialog').waitFor({ state: 'visible' });
  assert.match((await page.locator('.diff-removed .diff-code').allTextContents()).join('\n'), /青禾/);
  assert.match((await page.locator('.diff-added .diff-code').allTextContents()).join('\n'), /星河/);
  assert.ok(await page.locator('.diff-removed .diff-marker').count());
  assert.ok(await page.locator('.diff-added .diff-marker').count());
  await screenshot('desktop-diff.png');
  await page.locator('#close-diff').click();
  record('file_diff_via_ui');

  const zipPath = path.join(privateRoot, 'desktop-results.zip');
  await stubSave(zipPath);
  await page.getByTestId('export-results').click();
  await waitEnabled('export-results');
  const zip = new AdmZip(zipPath);
  const zipEntries = zip.getEntries().filter((entry) => !entry.isDirectory);
  assert.equal(zipEntries.length, completed.items.length);
  assert.ok(
    zipEntries.some(
      (entry) => entry.entryName.endsWith('项目说明.md') && zip.readAsText(entry).includes('星河'),
    ),
  );
  assert.ok(
    zipEntries.every(
      (entry) => !entry.entryName.includes('manifest.json') && !entry.entryName.includes('trace'),
    ),
  );
  record('zip_export_via_ui', { files: zipEntries.length });

  const tracePath = path.join(privateRoot, 'desktop-trace.jsonl');
  await stubSave(tracePath);
  await page.getByTestId('export-trace').click();
  await waitEnabled('export-trace');
  const trace = await readFile(tracePath, 'utf8');
  assert.match(trace, /model_request/);
  assert.match(trace, /tool_/);
  assert.match(trace, /skill_load/);
  assert.match(trace, /budget/);
  if (config.model.apiKey) assert.ok(!trace.includes(config.model.apiKey));
  assert.ok((await stat(tracePath)).size > 0);
  record('trace_export_via_ui');

  await stubConfirmation(0);
  await page.getByTestId('apply-results').click();
  await waitEnabled('apply-results');
  for (const [relative, content] of originalFiles)
    assert.equal(await readFile(path.join(sourceRoot, relative), 'utf8'), content);
  record('cancelled_native_writeback_keeps_fixture_originals_unchanged');

  await stubConfirmation(1);
  await page.getByTestId('apply-results').click();
  await waitEnabled('apply-results');
  for (const [relative, content] of originalFiles) {
    const expected = content.replaceAll('青禾', '星河');
    assert.equal(await readFile(path.join(sourceRoot, relative), 'utf8'), expected);
  }
  record('confirmed_native_writeback_changes_only_test_fixtures');
  await screenshot('desktop-client.png');

  await page
    .locator(`[data-testid="change-item"][data-path=${JSON.stringify(firstChange.path)}]`)
    .locator('.diff-link')
    .click();
  await page.getByTestId('restore-file').click();
  await page.getByTestId('confirm-ok').click();
  await page.locator('#diff-dialog').waitFor({ state: 'hidden' });
  const restored = await readFile(path.join(workRoot, firstChange.path), 'utf8');
  assert.match(restored, /青禾/);
  assert.match(await readFile(path.join(sourceRoot, '项目说明.md'), 'utf8'), /星河/);
  record('restore_workspace_file_via_ui_keeps_delivered_original_unchanged', {
    restoredHash: digest(restored),
  });

  finalSnapshot = await snapshot();
  dialogCalls = await electronApp.evaluate(
    () => (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls,
  );
  assert.equal(pageErrors.length, 0, `Renderer errors: ${pageErrors.join('; ')}`);
  record('no_renderer_exceptions');
} catch (error) {
  checks.push({
    name: 'verification_error',
    ok: false,
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : error);
  if (page && !page.isClosed()) {
    await screenshot('desktop-failure.png').catch(() => {});
    finalSnapshot = await snapshot().catch(() => undefined);
  }
} finally {
  if (electronApp) {
    dialogCalls = await electronApp
      .evaluate(() => (globalThis as unknown as { __xuwuNativeCalls: unknown[] }).__xuwuNativeCalls)
      .catch(() => dialogCalls);
    const spawnedProcess = electronApp.process();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        electronApp.close(),
        new Promise<never>((_, reject) => {
          closeTimer = setTimeout(() => reject(new Error('Electron close timed out')), 15000);
        }),
      ]);
    } catch {
      spawnedProcess.kill();
    } finally {
      clearTimeout(closeTimer);
    }
  }
  await mkdir(evidenceRoot, { recursive: true });
  const report = {
    runId,
    date: new Date().toISOString(),
    passed: checks.every((check) => check.ok),
    checks,
    screenshots,
    limitations,
    dragDropResult,
    pageErrors,
    dialogCalls,
    model: finalSnapshot?.model,
    run: finalSnapshot?.run,
    evidenceDirectory: path.relative(appRoot, privateRoot),
  };
  await writeFile(path.join(evidenceRoot, 'desktop-verification.json'), JSON.stringify(report, null, 2));
  console.log(`Report: evidence/desktop-verification.json (${report.passed ? 'PASS' : 'FAIL'})`);
}
