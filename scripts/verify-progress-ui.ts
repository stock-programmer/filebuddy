import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron, type ElectronApplication } from 'playwright-core';
import type { AppEvent, AppSnapshot, ModelProgress } from '../src/app/contracts.js';

// This exercises the real renderer in a hidden, isolated window. No application
// backend, user workspace, credentials or model connection is created.
const appRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'xuwu-progress-ui-'));
const evidenceRoot = path.join(appRoot, 'evidence', 'model-progress-ui');
const startedAt = new Date(Date.now() - 15000).toISOString();
const progress: ModelProgress = {
  requestId: 'fixture-request',
  modelCall: 2,
  kind: 'conversation',
  phase: 'waiting',
  startedAt,
  eventCounts: {},
  characters: { text: 0, thinking: 0, toolArguments: 0 },
};
const session = {
  id: 'fixture-session',
  title: '模型进度显示验证',
  createdAt: startedAt,
  updatedAt: startedAt,
};
const snapshot: AppSnapshot = {
  sessions: [session],
  current: session,
  items: [],
  messages: [{ id: 'fixture-user', role: 'user', text: '整理材料并检查结果。', createdAt: startedAt }],
  changes: [],
  model: { name: 'fixture', provider: '本地显示验证', configured: true },
  warnings: [],
  run: {
    id: 'fixture-run',
    status: 'running',
    startedAt,
    elapsedMs: 15000,
    modelCalls: 2,
    toolCalls: 1,
    tokens: 42325,
    tokenLimit: null,
    lastActivity: '正在执行 read',
    modelProgress: progress,
  },
};
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((initial) => {
    const fixture = window as unknown as {
      __snapshot: AppSnapshot;
      __listener?: (event: AppEvent) => void;
      __invocations: number;
    };
    fixture.__snapshot = initial;
    fixture.__invocations = 0;
    window.xuwu = {
      async invoke() {
        fixture.__invocations++;
        return fixture.__snapshot;
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
  await page.waitForFunction(() =>
    document.getElementById('run-activity')?.textContent?.includes('等待模型首段内容'),
  );
  checks.push('new request replaces old read activity');
  assert.match(await page.locator('#run-stats').innerText(), /累计 42\.3k token · 未设置预算上限/);
  assert.match((await page.locator('#run-stats').getAttribute('title')) ?? '', /含估算和请求预留/);
  checks.push('unbudgeted run displays cumulative accounting without a token cap');
  await page.screenshot({ path: path.join(evidenceRoot, 'waiting.png') });

  const publish = async () =>
    page.evaluate((next) => {
      const fixture = window as unknown as {
        __snapshot: AppSnapshot;
        __listener?: (event: AppEvent) => void;
      };
      fixture.__snapshot = next;
      fixture.__listener?.({ type: 'snapshot', snapshot: next });
    }, snapshot);
  progress.phase = 'thinking';
  progress.characters.thinking = 10482;
  progress.lastContentAt = new Date(Date.now() - 5000).toISOString();
  progress.lastEventAt = progress.lastContentAt;
  progress.eventCounts = { start: 1, thinking_delta: 100 };
  await publish();
  const thinkingText = await page.locator('#run-activity').innerText();
  assert.match(thinkingText, /模型正在推理.*10,482 字符.*秒前收到内容/);
  await page.screenshot({ path: path.join(evidenceRoot, 'thinking.png') });
  await page.waitForFunction(
    (previous) => document.getElementById('run-activity')?.textContent !== previous,
    thinkingText,
    { timeout: 5000 },
  );
  assert.equal(await page.evaluate(() => (window as unknown as { __invocations: number }).__invocations), 1);
  checks.push('thinking characters and idle age update without additional IPC');
  const bounds = await page.locator('#run-activity').evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  assert.ok(
    bounds.scrollHeight <= bounds.clientHeight && bounds.scrollWidth <= bounds.clientWidth,
    'Progress text must not be clipped',
  );
  checks.push('full progress text fits the visible activity area');

  snapshot.run!.tokenLimit = 100000;
  await publish();
  assert.match(await page.locator('#run-stats').innerText(), /42\.3k \/ 100k token/);
  assert.doesNotMatch(await page.locator('#run-stats').innerText(), /未设置预算上限/);
  await page.screenshot({ path: path.join(evidenceRoot, 'explicit-budget.png') });
  checks.push('saved or explicitly budgeted run retains its configured cap');

  progress.phase = 'finished';
  snapshot.run!.lastActivity = '正在执行 read';
  await publish();
  assert.equal(await page.locator('#run-activity').innerText(), '正在执行 read');
  checks.push('tool activity replaces finished model progress');
  snapshot.run!.status = 'ready_for_review';
  snapshot.run!.lastActivity = '本轮已停稳，请检查实际文件变更';
  snapshot.run!.elapsedMs = 129000;
  await publish();
  const finalStats = await page.locator('#run-stats').innerText();
  await page.screenshot({ path: path.join(evidenceRoot, 'finished.png') });
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#run-stats').innerText(), finalStats);
  assert.equal(await page.locator('#run-activity').innerText(), snapshot.run!.lastActivity);
  checks.push('finished run keeps final activity and elapsed time');
  delete snapshot.run!.modelProgress;
  await publish();
  assert.equal(await page.locator('#run-activity').innerText(), snapshot.run!.lastActivity);
  checks.push('legacy snapshot without progress remains readable');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidenceRoot, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, evidenceRoot }, null, 2));
} finally {
  await electronApp?.close();
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  assert.ok(resolvedTemporaryRoot.startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(resolvedTemporaryRoot).startsWith('xuwu-progress-ui-'));
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
