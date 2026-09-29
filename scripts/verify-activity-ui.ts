import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { _electron, type ElectronApplication } from 'playwright-core';
import type { AppEvent, AppSnapshot, ChatMessage } from '../src/app/contracts.js';

// Real renderer with synthetic state, in a hidden window with a disposable profile.
// This does not load the application backend, user files, credentials or a model.
const appRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'filebuddy-activity-ui-'));
const evidenceRoot = path.join(appRoot, 'evidence', 'activity-ui');
const startedAt = new Date().toISOString();
const session = {
  id: 'activity-session',
  title: '整理文档，查看处理进展',
  createdAt: startedAt,
  updatedAt: startedAt,
};
const message = (id: string, role: ChatMessage['role'], text: string): ChatMessage => ({
  id,
  role,
  text,
  createdAt: startedAt,
});
const snapshot: AppSnapshot = {
  sessions: [session],
  current: session,
  items: [],
  messages: [
    message('user-1', 'user', '整理这些文档，找出需要补充的内容。'),
    message('activity-1', 'notice', '已开始处理任务，正在准备材料与上下文。'),
  ],
  changes: [],
  model: { name: '合成状态', provider: '本地显示验证', configured: true },
  warnings: [],
  run: {
    id: 'activity-run',
    status: 'running',
    startedAt,
    elapsedMs: 0,
    modelCalls: 1,
    toolCalls: 0,
    tokens: 0,
    tokenLimit: null,
    lastActivity: '正在准备材料与上下文',
  },
};
type FixtureWindow = Window & {
  __snapshot: AppSnapshot;
  __listener?: (event: AppEvent) => void;
  __commands: string[];
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
app.whenReady().then(() => { globalThis.window = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { nodeIntegration: false, contextIsolation: true } }); globalThis.window.loadURL('about:blank'); });
app.on('window-all-closed', () => app.quit());`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  console.log('Launching isolated activity renderer');
  electronApp = await _electron.launch({ args: [mainPath], cwd: appRoot, env, timeout: 60000 });
  console.log('Isolated Electron connected');
  const page = await electronApp.firstWindow({ timeout: 60000 });
  console.log('Isolated window ready');
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.addInitScript((initial) => {
    const fixture = window as unknown as FixtureWindow;
    fixture.__snapshot = initial;
    fixture.__commands = [];
    window.xuwu = {
      async invoke(command) {
        fixture.__commands.push(command);
        if (command !== 'snapshot') throw new Error(`No backend actions in this fixture: ${command}`);
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
  await page.goto(pathToFileURL(path.join(temporaryRoot, 'index.html')).href, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  console.log('Local activity page loaded');
  await page.waitForFunction(() => (window as unknown as FixtureWindow).__listener !== undefined);
  console.log('Renderer subscribed to synthetic events');
  const publish = async (next = snapshot) =>
    page.evaluate((value) => {
      const fixture = window as unknown as FixtureWindow;
      fixture.__snapshot = value;
      fixture.__listener?.({ type: 'snapshot', snapshot: value });
    }, next);
  const delta = async (text: string, runId = 'activity-run') => {
    const event: AppEvent = { type: 'text_delta', text, runId };
    await page.evaluate((value) => {
      (window as unknown as FixtureWindow).__listener?.(value);
    }, event);
  };
  const row = (id: string) => page.locator(`[data-message-id="${id}"]`);
  const body = (id: string) => row(id).locator('.message-text');

  assert.equal(await row('activity-1').isVisible(), true);
  assert.equal(await row('activity-1').locator('.message-meta strong').innerText(), '运行状态');
  assert.equal(await row('activity-1').locator('.message-source').innerText(), '程序生成');
  assert.equal(await page.locator('#welcome').isVisible(), false);
  assert.equal(await page.locator('[data-testid="message-assistant"]').count(), 0);
  checks.push('start notice is immediately visible and clearly marked as program-generated');
  await page.screenshot({ path: path.join(evidenceRoot, '01-start.png') });

  for (let call = 1; call <= 48; call++) {
    snapshot.run!.toolCalls = call;
    snapshot.run!.modelCalls = Math.ceil(call / 3);
    snapshot.run!.lastActivity = '正在继续处理任务';
    if (call % 16 === 0)
      snapshot.messages.push(
        message(`tools-${call}`, 'notice', `本轮记录：读取 ${call} 次。正在继续处理任务。`),
      );
    await publish();
    assert.equal(await page.locator('[data-testid="message-notice"]').count(), 1 + Math.floor(call / 16));
  }
  assert.match(await body('tools-48').innerText(), /本轮记录：读取 48 次/);
  assert.equal(await page.locator('[data-testid="message-assistant"]').count(), 0);
  assert.equal(await page.locator('#stream-message').isVisible(), false);
  checks.push('48 tool-only snapshots retain four aggregated statuses without creating a row per tool call');
  snapshot.messages.at(-1)!.text = '本轮记录：读取 48 次。正在等待模型响应。';
  snapshot.run!.lastActivity = '正在等待模型响应';
  await publish();
  assert.equal(await row('tools-48').count(), 1);
  assert.match(await body('tools-48').innerText(), /正在等待模型响应/);
  checks.push('updating an existing status keeps one visible row with its stable message id');
  await page.screenshot({ path: path.join(evidenceRoot, '02-tool-only.png') });

  const firstText = '我已找到相关文档，接下来核对需要补充的内容。';
  await delta(firstText.slice(0, 9));
  await delta(firstText.slice(9));
  await page.waitForFunction(
    (expected) => document.getElementById('stream-text')?.textContent === expected,
    firstText,
  );
  snapshot.messages.push(message('activity-2', 'notice', '本轮记录：读取 48 次。正在接收模型回复。'));
  snapshot.run!.lastActivity = '正在接收模型回复';
  await publish();
  assert.equal(await page.locator('#stream-text').innerText(), firstText);
  assert.equal(await page.locator('#stream-message .message-meta strong').innerText(), 'FileBuddy');
  assert.equal(await page.locator('#stream-message .message-avatar').innerText(), 'FB');
  assert.equal(await row('activity-2').isVisible(), true);
  checks.push('inserting a status during streamed model text preserves the visible text');

  const secondText = '已核对主要条目，正在整理修改建议。';
  await delta(secondText);
  snapshot.messages.push(message('assistant-1', 'assistant', firstText));
  await publish();
  assert.equal(await body('assistant-1').innerText(), firstText);
  assert.equal(await page.locator('#stream-text').innerText(), secondText);
  await publish();
  assert.equal(await page.locator('#stream-text').innerText(), secondText);
  snapshot.messages.push(message('assistant-2', 'assistant', secondText));
  await publish();
  assert.equal(await page.locator('#stream-message').isVisible(), false);
  assert.equal(await row('assistant-1').count(), 1);
  assert.equal(await row('assistant-2').count(), 1);
  assert.deepEqual(await page.locator('.message.assistant .message-meta strong').allTextContents(), [
    'FileBuddy',
    'FileBuddy',
  ]);
  assert.deepEqual(await page.locator('.message.assistant .message-avatar').allTextContents(), ['FB', 'FB']);
  checks.push(
    'stream fragments transfer to history once, including interleaved notices and repeated snapshots',
  );
  checks.push('both streamed and saved model messages retain the FileBuddy identity');

  const partial = '我已整理出需要补充的说明。';
  await delta(partial);
  snapshot.messages.push(message('assistant-partial', 'assistant', partial));
  snapshot.messages.push(
    message('activity-end', 'notice', '本轮记录：读取 48 次。你已停止本轮任务，已提交的修改保留。'),
  );
  snapshot.run!.status = 'cancelled';
  snapshot.run!.lastActivity = '用户停止了本轮任务';
  await publish();
  assert.equal(await body('assistant-partial').innerText(), partial);
  assert.equal(await row('activity-end').isVisible(), true);
  assert.equal(await page.locator('#stream-message').isVisible(), false);
  checks.push('stopping keeps saved model text and statuses and clears the transient stream');
  await page.locator('#message-scroll').evaluate((node) => {
    node.scrollTo({ top: node.scrollHeight, behavior: 'instant' });
  });
  await page.screenshot({ path: path.join(evidenceRoot, '03-stopped.png') });

  const otherSession = { ...session, id: 'other-session', title: '另一工作会话' };
  const otherSnapshot: AppSnapshot = {
    ...snapshot,
    sessions: [session, otherSession],
    current: otherSession,
    messages: [],
    run: null,
  };
  await publish(otherSnapshot);
  assert.equal(await page.locator('#message-list .message').count(), 0);
  assert.equal(await page.locator('#stream-message').isVisible(), false);
  assert.equal(await page.locator('#welcome').isVisible(), true);
  await publish();
  assert.equal(await body('assistant-partial').innerText(), partial);
  assert.equal(await row('activity-end').isVisible(), true);
  checks.push('switching sessions clears the previous conversation; returning restores its history');

  assert.deepEqual(await page.evaluate(() => (window as unknown as FixtureWindow).__commands), ['snapshot']);
  assert.deepEqual(errors, []);
  checks.push('rendering requires no extra IPC polling and reports no browser errors');
  await writeFile(
    path.join(evidenceRoot, 'checks.json'),
    JSON.stringify({ ok: true, checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, checks, evidenceRoot }, null, 2));
} catch (error) {
  await writeFile(
    path.join(evidenceRoot, 'checks.json'),
    JSON.stringify({ ok: false, checks, errors, failure: String(error) }, null, 2),
  );
  throw error;
} finally {
  await electronApp?.close();
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  assert.ok(resolvedTemporaryRoot.startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(resolvedTemporaryRoot).startsWith('filebuddy-activity-ui-'));
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
