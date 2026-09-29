import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPatch } from 'diff';
import { build } from 'esbuild';
import { _electron, type ElectronApplication } from 'playwright-core';
import type { AppEvent, AppSnapshot, Change, FileDiff } from '../src/app/contracts.js';

// Real renderer, isolated hidden Electron window, and an in-memory IPC fixture.
// This never loads the application backend, user profile, workspace, or model.
const appRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'xuwu-diff-ui-'));
const evidenceRoot = path.join(appRoot, 'evidence', 'file-diff-ui');
const startedAt = new Date().toISOString();
const session = {
  id: 'fixture-session',
  title: '逐行文件差异验证',
  createdAt: startedAt,
  updatedAt: startedAt,
};
const snapshot: AppSnapshot = {
  sessions: [session],
  current: session,
  items: [],
  messages: [],
  changes: [],
  model: { name: 'fixture', provider: '本地显示验证', configured: false },
  warnings: [],
  run: null,
};
type FixtureWindow = Window & {
  __snapshot: AppSnapshot;
  __diff: FileDiff;
  __listener?: (event: AppEvent) => void;
  __commands: string[];
};
const diffResult = (before: string, after: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  before,
  after,
  patch: createPatch('fixture.txt', before, after, '处理前', '处理后', { context: 3 }),
  expectedHash: 'fixture-hash',
  beforeState: 'text',
  afterState: 'text',
  beforeFormat: 'UTF-8 · LF',
  afterFormat: 'UTF-8 · LF',
  ...extra,
});
let electronApp: ElectronApplication | undefined;
const checks: string[] = [];
const errors: string[] = [];
try {
  await mkdir(evidenceRoot, { recursive: true });
  await build({
    entryPoints: ['src/ui/app.ts'],
    outfile: path.join(temporaryRoot, 'app.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome130',
  });
  await copyFile('src/ui/index.html', path.join(temporaryRoot, 'index.html'));
  await copyFile('src/ui/styles.css', path.join(temporaryRoot, 'styles.css'));
  const mainPath = path.join(temporaryRoot, 'main.cjs');
  await writeFile(
    mainPath,
    `const { app, BrowserWindow } = require('electron');
app.setPath('userData', ${JSON.stringify(path.join(temporaryRoot, 'profile'))});
app.whenReady().then(() => { globalThis.window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true } }); globalThis.window.loadURL('about:blank'); });
app.on('window-all-closed', () => app.quit());`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  electronApp = await _electron.launch({ args: [mainPath], cwd: appRoot, env, timeout: 60000 });
  const page = await electronApp.firstWindow({ timeout: 60000 });
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((initial) => {
    const fixture = window as unknown as FixtureWindow;
    fixture.__snapshot = initial;
    fixture.__commands = [];
    window.xuwu = {
      async invoke(command) {
        fixture.__commands.push(command);
        if (command === 'snapshot') return fixture.__snapshot;
        if (command === 'changes.diff') return fixture.__diff;
        throw new Error(`No backend actions in this fixture: ${command}`);
      },
      onEvent(listener) {
        fixture.__listener = listener;
        return () => {
          fixture.__listener = undefined;
        };
      },
      async importDropped() {
        throw new Error('No filesystem actions in this fixture');
      },
    };
  }, snapshot);
  await page.goto(pathToFileURL(path.join(temporaryRoot, 'index.html')).href);
  console.log('Isolated renderer loaded');
  await page.waitForFunction(() => (window as unknown as FixtureWindow).__listener !== undefined);
  const show = async (name: string, result: FileDiff, kind: Change['kind'] = 'modified') => {
    console.log(`Checking ${name}`);
    if (await page.locator('#diff-dialog').evaluate((node) => (node as HTMLDialogElement).open)) {
      await page.locator('#close-diff').click();
    }
    snapshot.changes = [{ path: name, kind, isDirectory: false, canApply: false }];
    await page.evaluate(
      ({ next, result }) => {
        const fixture = window as unknown as FixtureWindow;
        fixture.__snapshot = next;
        fixture.__diff = result;
        fixture.__listener?.({ type: 'snapshot', snapshot: next });
      },
      { next: snapshot, result },
    );
    await page.locator('.diff-link').click();
    await page.waitForFunction(() => (document.getElementById('diff-dialog') as HTMLDialogElement).open);
    assert.equal(await page.locator('#diff-title').innerText(), name);
  };
  const cell = (side: 'before' | 'after', line: number) =>
    page.locator(`.diff-cell[data-side="${side}"][data-line="${line}"]`);

  const beforeLines = Array.from(
    { length: 100 },
    (_, index) => `  "field_${String(index + 1).padStart(3, '0')}": "未修改的内容 ${index + 1}",`,
  );
  beforeLines[7] = '  "summary": "旧摘要",';
  const longSummary = '  "summary": "' + '新增的业务说明，逐行比对保持两侧对齐。'.repeat(24) + '",';
  const htmlText =
    '<img id="diff-injected" src="invalid" onerror="window.diffInjected=true"><script>window.diffInjected=true</script>';
  const afterLines: string[] = [];
  for (let line = 1; line <= beforeLines.length; line++) {
    if (line === 5) afterLines.push('  "new_source": "SRC-04",', '  "new_label": "文档解析方案",');
    if (line === 18) continue;
    afterLines.push(
      line === 8
        ? longSummary
        : line === 36
          ? htmlText
          : line === 90
            ? '  "review": "已完成",'
            : beforeLines[line - 1],
    );
  }
  await show(
    'bank-credit-upload.json',
    diffResult(beforeLines.join('\n') + '\n', afterLines.join('\n') + '\n'),
  );
  assert.equal(await page.locator('#diff-added').innerText(), '+ 5 行新增');
  assert.equal(await page.locator('#diff-removed').innerText(), '- 4 行删除');
  assert.equal(await cell('after', 5).locator('.diff-marker').innerText(), '+');
  assert.equal(await cell('before', 18).locator('.diff-marker').innerText(), '-');
  assert.equal(await cell('before', 8).locator('.diff-marker').innerText(), '-');
  assert.equal(await cell('after', 10).locator('.diff-marker').innerText(), '+');
  assert.equal(
    await cell('after', 5).evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgb(218, 245, 223)',
  );
  assert.equal(
    await cell('before', 8).evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgb(255, 225, 232)',
  );
  checks.push(
    'insertions, deletions, and replacements show correct totals, green/pink backgrounds, and plus/minus markers',
  );

  const insertion = cell('after', 5).locator('..');
  assert.equal(await insertion.locator('[data-side="before"].diff-placeholder').count(), 1);
  const deletion = cell('before', 18).locator('..');
  assert.equal(await deletion.locator('[data-side="after"].diff-placeholder').count(), 1);
  const context = cell('before', 5).locator('..');
  assert.equal(await context.locator('[data-side="after"]').getAttribute('data-line'), '7');
  assert.equal(await context.locator('[data-side="after"] .diff-line-number').innerText(), '7');
  assert.equal(await context.locator('[data-side="before"] .diff-line-number').innerText(), '5');
  assert.equal(await context.locator('.diff-context').count(), 2);
  checks.push(
    'placeholder cells preserve insertion/deletion alignment and context retains independent old/new line numbers',
  );

  const replacement = cell('before', 8).locator('..');
  const boxes = await replacement.locator('.diff-cell').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    }),
  );
  assert.equal(boxes.length, 2);
  assert.ok(Math.abs(boxes[0].top - boxes[1].top) < 1 && Math.abs(boxes[0].bottom - boxes[1].bottom) < 1);
  assert.ok(boxes[0].height > 100, 'Long changed line must wrap and expand both cells');
  const nextBoxes = await cell('before', 9)
    .locator('..')
    .locator('.diff-cell')
    .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
  assert.ok(nextBoxes.every((top) => Math.abs(top - boxes[0].bottom) < 1));
  checks.push(
    'long wrapped replacement expands both columns equally and the following context starts on the same row',
  );
  assert.ok((await page.locator('.diff-hunk').count()) >= 3);
  assert.equal(await cell('before', 50).count(), 0);
  assert.ok((await page.locator('.diff-row').count()) < beforeLines.length);
  checks.push('separated changes use hunk headings and hide distant unchanged lines');
  assert.equal(await cell('after', 37).locator('.diff-code').textContent(), htmlText);
  assert.equal(await page.locator('#diff-injected, #diff-rows img, #diff-rows script').count(), 0);
  assert.equal(
    await page.evaluate(() => (window as Window & { diffInjected?: boolean }).diffInjected),
    undefined,
  );
  checks.push('HTML and script-looking file contents remain inert text');
  await page.screenshot({ path: path.join(evidenceRoot, 'highlighted-diff.png') });

  const headingsBefore = await page.locator('.diff-column-headings').boundingBox();
  const scroll = await page.locator('#diff-scroll').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return { top: node.scrollTop, height: node.scrollHeight, client: node.clientHeight };
  });
  assert.ok(scroll.top > 0 && scroll.height > scroll.client);
  const headingsAfter = await page.locator('.diff-column-headings').boundingBox();
  assert.deepEqual(headingsAfter, headingsBefore);
  for (const selector of ['#diff-title', '#close-diff', '.diff-column-headings', '#restore-file']) {
    assert.equal(await page.locator(selector).isVisible(), true);
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 900);
  }
  assert.equal(await page.locator('#restore-file').isEnabled(), true);
  assert.equal(await page.locator('#diff-dialog').evaluate((node) => node.scrollTop), 0);
  assert.equal(await page.locator('#diff-scroll .diff-column-headings').count(), 0);
  checks.push(
    'one shared scrollbar preserves both columns and leaves headings, close, and restore controls visible',
  );
  await page.screenshot({ path: path.join(evidenceRoot, 'scrolled-diff.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !(document.getElementById('diff-dialog') as HTMLDialogElement).open);
  checks.push('Escape closes the diff dialog');

  await show('no-final-newline.txt', diffResult('same\nold', 'same\nnew'));
  assert.equal(await page.locator('.diff-no-newline').count(), 2);
  assert.equal(await cell('before', 2).locator('.diff-code').textContent(), 'old');
  assert.equal(await cell('after', 2).locator('.diff-code').textContent(), 'new');
  assert.equal(await page.locator('#diff-added').innerText(), '+ 1 行新增');
  assert.equal(await page.locator('#diff-removed').innerText(), '- 1 行删除');
  checks.push('missing final newline is annotated on both sides without becoming an extra changed line');
  await page.screenshot({ path: path.join(evidenceRoot, 'no-final-newline.png') });

  await show('new-empty.txt', diffResult('', '', { beforeState: 'missing' }), 'added');
  assert.equal(await page.locator('#diff-before-format').innerText(), '文件不存在');
  assert.match(await page.locator('#diff-after-format').innerText(), /^空文件/);
  assert.match(await page.locator('#diff-status').innerText(), /新增.*空文件/);
  assert.match(await page.locator('#diff-note').innerText(), /移除/);
  await page.screenshot({ path: path.join(evidenceRoot, 'new-empty-file.png') });
  await show('deleted-empty.txt', diffResult('', '', { afterState: 'missing' }), 'deleted');
  assert.match(await page.locator('#diff-before-format').innerText(), /^空文件/);
  assert.equal(await page.locator('#diff-after-format').innerText(), '文件不存在');
  assert.match(await page.locator('#diff-status').innerText(), /删除/);
  checks.push('added and deleted empty files distinguish an absent file from an existing empty file');

  await show('missing-both.txt', diffResult('', '', { beforeState: 'missing', afterState: 'missing' }));
  assert.equal(await page.locator('#diff-before-format').innerText(), '文件不存在');
  assert.equal(await page.locator('#diff-after-format').innerText(), '文件不存在');
  assert.match(await page.locator('#diff-status').innerText(), /(?:两侧|均|都).*不存在/);
  assert.doesNotMatch(await page.locator('#diff-status').innerText(), /新增.*空文件/);
  checks.push('both missing sides receive an explicit absent-file status');

  const notice = '文件过大，暂时无法预览完整差异，请导出文件查看。';
  await show(
    'unavailable.txt',
    diffResult('', '', { beforeState: 'unavailable', afterState: 'unavailable', notice }),
  );
  assert.equal(await page.locator('#diff-status').innerText(), notice);
  assert.equal(await page.locator('#diff-counts').isVisible(), false);
  assert.equal(await page.locator('#diff-before-format').innerText(), '无法预览');
  assert.equal(await page.locator('#diff-after-format').innerText(), '无法预览');
  assert.doesNotMatch(await page.locator('#diff-status').innerText(), /没有.*差异|无差异|内容相同/);
  checks.push('unavailable preview displays the explicit notice without misleading zero-change statistics');
  await page.screenshot({ path: path.join(evidenceRoot, 'unavailable-preview.png') });

  await show('format-only.txt', diffResult('same\n', 'same\n', { afterFormat: 'UTF-16 LE · CRLF' }));
  assert.equal(await page.locator('#diff-before-format').innerText(), 'UTF-8 · LF');
  assert.equal(await page.locator('#diff-after-format').innerText(), 'UTF-16 LE · CRLF');
  assert.match(await page.locator('#diff-status').innerText(), /编码或换行格式/);
  checks.push('format-only changes retain both encoding/newline labels and an explanatory status');
  await page.screenshot({ path: path.join(evidenceRoot, 'format-only.png') });

  await show(
    'large-addition.txt',
    diffResult('', Array.from({ length: 2200 }, (_, index) => `新增记录 ${index + 1}\n`).join(''), {
      beforeState: 'missing',
    }),
    'added',
  );
  assert.ok((await page.locator('#diff-rows > *').count()) <= 2000);
  assert.equal(await page.locator('#diff-added').innerText(), '+ 2200 行新增');
  assert.equal(await page.locator('#diff-removed').innerText(), '- 0 行删除');
  assert.match(await page.locator('#diff-status').innerText(), /2,000.*统计包含全部改动/);
  assert.equal(await cell('after', 2200).count(), 0);
  checks.push(
    'large preview explicitly caps displayed rows at 2000 while preserving all 2200 additions in totals',
  );
  await page.screenshot({ path: path.join(evidenceRoot, 'bounded-preview.png') });

  await show('one-megabyte-line.txt', diffResult('original line\n', 'x'.repeat(1024 * 1024) + '\n'));
  assert.equal((await cell('after', 1).locator('.diff-code').textContent())?.length, 20000);
  assert.match(await cell('after', 1).locator('.diff-line-truncated').innerText(), /20,000.*完整内容请导出/);
  assert.match(await page.locator('#diff-status').innerText(), /超长行仅展示前 20,000 个字符/);
  assert.equal(await page.locator('#diff-added').innerText(), '+ 1 行新增');
  assert.equal(await page.locator('#diff-removed').innerText(), '- 1 行删除');
  assert.equal(await page.locator('#close-diff').isVisible(), true);
  await page.locator('#close-diff').click();
  await page.waitForFunction(() => !(document.getElementById('diff-dialog') as HTMLDialogElement).open);
  checks.push(
    'one-megabyte line previews only 20000 characters with explicit line/status notices, exact totals, and working close control',
  );

  assert.deepEqual(errors, []);
  const commands = await page.evaluate(() => (window as unknown as FixtureWindow).__commands);
  assert.ok(commands.every((command) => command === 'snapshot' || command === 'changes.diff'));
  checks.push('verification uses only mocked snapshot and diff calls with no backend or model requests');
  await writeFile(path.join(evidenceRoot, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, evidenceRoot }, null, 2));
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await electronApp?.close();
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  assert.ok(resolvedTemporaryRoot.startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(resolvedTemporaryRoot).startsWith('xuwu-diff-ui-'));
  await rm(resolvedTemporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
