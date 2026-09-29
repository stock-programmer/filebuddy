import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AppSnapshot } from '../src/app/contracts.js';

// Run after `npm run build`. These checks use the built renderer, preload, IPC,
// controller and persistence. Model access is disabled, and the app receives an
// isolated data/profile directory; existing sessions and credentials are unused.
const appRoot = process.cwd();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'xuwu-session-title-ui-'));
const dataRoot = path.join(temporaryRoot, 'data');
const evidenceRoot = path.join(appRoot, 'evidence', 'session-title-ui');
const checks: string[] = [];
const errors: string[] = [];
const screenshots: string[] = [];
interface DeletionDialog {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}
interface DeletionFixture {
  calls: DeletionDialog[];
  resolve?: (result: { response: number; checkboxChecked: boolean }) => void;
}
const deletionDialogs: DeletionDialog[] = [];
let electronApp: ElectronApplication | undefined;
let page!: Page;

const env = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
);
delete env.ELECTRON_RUN_AS_NODE;
env.XUWU_DATA_DIR = dataRoot;
env.AGENT_API_KEY = '';
env.AGENT_BASE_URL = 'http://127.0.0.1:1/v1';
env.AGENT_MODEL = 'session-title-ui-offline';
env.AGENT_CONTEXT_WINDOW = '65536';
env.AGENT_MAX_OUTPUT_TOKENS = '4096';
env.AGENT_RUN_OUTPUT_TOKENS = '4096';
env.AGENT_COMPACTION_OUTPUT_TOKENS = '4096';

function record(name: string) {
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function snapshot(): Promise<AppSnapshot> {
  return page.evaluate(() => window.xuwu.invoke('snapshot'));
}

async function waitForSnapshot(predicate: (value: AppSnapshot) => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await snapshot();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: timeout; snapshot=${JSON.stringify(await snapshot())}`);
}

async function expectTitle(id: string, title: string, active = true) {
  await waitForSnapshot(
    (value) => value.sessions.find((session) => session.id === id)?.title === title,
    `session title: ${title}`,
  );
  await page.waitForFunction(
    ({ id: expectedId, title: expectedTitle, active: isActive }) => {
      const entry = document.querySelector(`[data-testid="session-${expectedId}"] .session-name`);
      return (
        entry?.textContent === expectedTitle &&
        (!isActive || document.getElementById('session-title')?.textContent === expectedTitle)
      );
    },
    { id, title, active },
  );
}

async function createSession() {
  const count = (await snapshot()).sessions.length;
  await page.getByTestId('new-session').click();
  const value = await waitForSnapshot(
    (next) => next.sessions.length === count + 1 && next.current !== null,
    'new session',
  );
  return value.current!.id;
}

async function selectSession(id: string) {
  await page.getByTestId(`session-${id}`).click();
  await waitForSnapshot((value) => value.current?.id === id, 'select session');
  await page.waitForFunction(
    (expectedId) =>
      document.querySelector(`[data-testid="session-${expectedId}"]`)?.getAttribute('aria-current') ===
      'page',
    id,
  );
}

async function openRename(id: string) {
  await page.getByTestId(`rename-session-${id}`).click();
  await page.locator('#rename-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#rename-input').isVisible(), true);
}

async function rename(id: string, title: string) {
  await openRename(id);
  await page.locator('#rename-input').fill(title);
  await page.locator('#rename-save').click();
  await page.locator('#rename-dialog').waitFor({ state: 'hidden' });
}

async function screenshot(name: string) {
  const destination = path.join(evidenceRoot, name);
  await page.screenshot({ path: destination });
  screenshots.push(path.relative(appRoot, destination));
}

async function launch() {
  electronApp = await _electron.launch({ args: ['.'], cwd: appRoot, env, timeout: 60000 });
  page = await electronApp.firstWindow({ timeout: 45000 });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#model-name').waitFor();
  await page.waitForFunction(() => Boolean(window.xuwu));
  assert.equal((await snapshot()).model.configured, false, 'The verification must remain offline.');
}

async function deferDeletionDialogs() {
  await electronApp!.evaluate(({ dialog }) => {
    const fixture = globalThis as unknown as { __sessionDeletion: DeletionFixture };
    fixture.__sessionDeletion = { calls: [] };
    dialog.showMessageBox = async (...args: unknown[]) => {
      fixture.__sessionDeletion.calls.push(args.at(-1) as DeletionDialog);
      return new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
        fixture.__sessionDeletion.resolve = resolve;
      });
    };
  });
}

async function expectDeletionDialog(count: number, title: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const calls = await electronApp!.evaluate(
      () => (globalThis as unknown as { __sessionDeletion: DeletionFixture }).__sessionDeletion.calls,
    );
    if (calls.length === count) {
      const options = calls.at(-1)!;
      assert.equal(options.title, '删除会话');
      assert.equal(options.message, `删除会话“${title}”？`);
      assert.deepEqual(options.buttons, ['取消', '删除会话']);
      assert.equal(options.defaultId, 0);
      assert.equal(options.cancelId, 0);
      assert.match(options.detail, /无法撤销/);
      assert.match(options.detail, /原始文件不受影响/);
      deletionDialogs.push(options);
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('The delete action did not request native confirmation.');
}

async function answerDeletion(response: number) {
  await electronApp!.evaluate((_electron, answer) => {
    const fixture = (globalThis as unknown as { __sessionDeletion: DeletionFixture }).__sessionDeletion;
    if (!fixture.resolve) throw new Error('No pending deletion confirmation');
    fixture.resolve({ response: answer, checkboxChecked: false });
    delete fixture.resolve;
  }, response);
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('#new-session')?.disabled);
}

try {
  await mkdir(evidenceRoot, { recursive: true });
  await launch();
  assert.equal((await snapshot()).sessions.length, 0);
  const first = await createSession();
  await expectTitle(first, '新的文件任务');
  assert.equal(await page.locator('#rename-dialog').isVisible(), false);
  record('new session keeps the default title without a naming prompt');

  const task = '  整理\n季度报告   并提取关键数据供会议使用 📄';
  const expectedDraft = Array.from(task.replace(/\s+/gu, ' ').trim()).slice(0, 16).join('');
  await page.locator('#task-input').fill(task);
  await expectTitle(first, expectedDraft);
  assert.equal((await snapshot()).messages.length, 0);
  assert.equal((await snapshot()).run, null);
  assert.equal(await page.locator('#send-task').isDisabled(), true);
  await screenshot('auto-title.png');
  record('typing before sending persists the normalized first 16 characters in sidebar and heading');

  await page.locator('#task-input').fill('修订后的任务');
  await expectTitle(first, '修订后的任务');
  await page.locator('#task-input').fill('   \n  ');
  await expectTitle(first, '新的文件任务');
  const unicodeTask = '📄🧭🌱🚀🗂😀🌞📘🛠🌈🔍🧪📊🔔🎯💡追加';
  const expectedUnicode = Array.from(unicodeTask).slice(0, 16).join('');
  await page.locator('#task-input').fill(unicodeTask);
  await expectTitle(first, expectedUnicode);
  assert.equal(Array.from((await snapshot()).current!.title).length, 16);
  record('editable draft handles clear, whitespace and Unicode without splitting surrogate pairs');

  await openRename(first);
  assert.equal(await page.locator('#rename-input').inputValue(), expectedUnicode);
  await page.locator('#rename-input').fill('不会被保存的取消名称');
  await page.locator('#rename-cancel').click();
  await expectTitle(first, expectedUnicode);
  await openRename(first);
  await page.locator('#rename-input').fill('不会被保存的 Escape 名称');
  await page.locator('#rename-input').press('Escape');
  await page.locator('#rename-dialog').waitFor({ state: 'hidden' });
  await expectTitle(first, expectedUnicode);
  record('cancel and Escape preserve the existing name');

  await openRename(first);
  await page.locator('#rename-input').fill('   ');
  if (await page.locator('#rename-save').isEnabled()) await page.locator('#rename-save').click();
  assert.equal(await page.locator('#rename-dialog').isVisible(), true);
  await expectTitle(first, expectedUnicode);
  await screenshot('rename-empty.png');
  await page.locator('#rename-cancel').click();
  record('blank manual names cannot be saved');

  const manual = '季度材料整理 · 手动命名';
  await rename(first, `  ${manual}  `);
  await expectTitle(first, manual);
  await page.locator('#task-input').fill('后续输入不会覆盖手动设置的会话名称');
  await page.waitForTimeout(800);
  await expectTitle(first, manual);
  record('manual rename synchronizes heading and sidebar and survives subsequent typing');

  const second = await createSession();
  await expectTitle(second, '新的文件任务');
  await page.locator('#task-input').fill('第二个工作会话');
  await expectTitle(second, '第二个工作会话');
  const inactiveName = '归档材料 · 无需切换即可改名';
  await rename(first, inactiveName);
  await expectTitle(first, inactiveName, false);
  assert.equal((await snapshot()).current!.id, second);
  await expectTitle(second, '第二个工作会话');
  record('an inactive session can be renamed without changing the selected session');

  const longUnicodeName = '📄'.repeat(80);
  await rename(first, longUnicodeName);
  await expectTitle(first, longUnicodeName, false);
  await openRename(first);
  await page.locator('#rename-input').fill('📄'.repeat(81));
  if (await page.locator('#rename-save').isEnabled()) await page.locator('#rename-save').click();
  assert.equal(await page.locator('#rename-dialog').isVisible(), true);
  await expectTitle(first, longUnicodeName, false);
  await page.locator('#rename-cancel').click();
  await rename(first, inactiveName);
  record('manual names accept 80 Unicode characters and reject 81');

  const third = await createSession();
  await expectTitle(third, '新的文件任务');
  await selectSession(second);
  // Switch before the draft debounce can settle. A delayed draft must stay tied
  // to its source session, whether the UI flushes it or drops it on navigation.
  await page.locator('#task-input').fill('只属于第二个会话的未发送问题');
  await page.getByTestId(`session-${third}`).click();
  await waitForSnapshot((value) => value.current?.id === third, 'switch during draft debounce');
  await page.waitForTimeout(800);
  await expectTitle(third, '新的文件任务');
  assert.notEqual(await page.locator('#task-input').inputValue(), '只属于第二个会话的未发送问题');
  const secondBeforeRestart = (await snapshot()).sessions.find((session) => session.id === second)!.title;
  assert.notEqual(secondBeforeRestart, inactiveName);
  await selectSession(first);
  await expectTitle(first, inactiveName);
  await screenshot('renamed-sessions.png');
  const sidebarScreenshot = path.join(evidenceRoot, 'sidebar.png');
  await page.locator('aside.sidebar').screenshot({ path: sidebarScreenshot });
  screenshots.push(path.relative(appRoot, sidebarScreenshot));
  record('switching sessions cannot apply a stale draft or composer text to another session');

  await openRename(first);
  await screenshot('rename-dialog.png');
  await page.locator('#rename-cancel').click();
  await electronApp!.close();
  electronApp = undefined;
  // Seed an explicitly local transcript while the app is closed. This makes the
  // deletion check exercise removal of visible history without sending a task or
  // calling any model. SessionManager owns the fixture's on-disk message format.
  const history = SessionManager.continueRecent(
    path.join(dataRoot, 'workspaces', first, 'work'),
    path.join(dataRoot, 'sessions', first),
  );
  history.appendMessage({ role: 'user', content: '用于删除验收的本地历史记录', timestamp: Date.now() });
  history.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: '本条是本地测试记录，没有调用模型。' }],
    api: 'openai-completions',
    provider: 'local-fixture',
    model: 'session-deletion-offline',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  });
  await launch();
  assert.equal((await snapshot()).current!.id, first);
  await expectTitle(first, inactiveName);
  await expectTitle(second, secondBeforeRestart, false);
  await selectSession(second);
  await expectTitle(second, secondBeforeRestart);
  await selectSession(first);
  await expectTitle(first, inactiveName);
  await screenshot('reopened.png');
  record('manual and automatic session names persist across application restart and selection');

  const originalPath = path.join(temporaryRoot, '删除会话保留原件.txt');
  const originalContent = 'DELETE-SESSION-KEEP-ORIGINAL\n此文件是隔离的测试原件，删除会话后必须保留。\n';
  await writeFile(originalPath, originalContent, 'utf8');
  await electronApp!.evaluate(({ dialog }, sourcePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourcePath] });
  }, originalPath);
  await page.getByTestId('add-files').click();
  await waitForSnapshot(
    (value) => value.items.length === 1 && value.messages.length === 2,
    'deletion fixture',
  );
  await page.getByTestId('material-item').waitFor();
  await page.getByTestId('message-assistant').waitFor();
  assert.equal(await page.locator('.session-delete').count(), 3);
  for (const id of [first, second, third]) {
    assert.equal(await page.getByTestId(`delete-session-${id}`).getAttribute('aria-label'), '删除会话');
  }
  await screenshot('delete-session-buttons.png');
  await deferDeletionDialogs();
  await page.getByTestId(`delete-session-${second}`).click();
  await expectDeletionDialog(1, secondBeforeRestart);
  const beforeDecision = await snapshot();
  assert.equal(beforeDecision.sessions.length, 3);
  assert.equal(beforeDecision.current!.id, first);
  assert.equal(beforeDecision.items.length, 1);
  assert.equal(beforeDecision.messages.length, 2);
  assert.equal(await readFile(originalPath, 'utf8'), originalContent);
  record('every row has a delete button and no data is deleted before explicit confirmation');

  await answerDeletion(0);
  assert.equal((await snapshot()).sessions.length, 3);
  assert.equal((await snapshot()).current!.id, first);
  await expectTitle(second, secondBeforeRestart, false);
  record('cancelling a named-session deletion retains the target and current selection');

  await page.getByTestId(`delete-session-${second}`).click();
  await expectDeletionDialog(2, secondBeforeRestart);
  await answerDeletion(1);
  const afterInactiveDelete = await waitForSnapshot(
    (value) => value.sessions.length === 2 && !value.sessions.some((session) => session.id === second),
    'inactive session deletion',
  );
  assert.equal(afterInactiveDelete.current!.id, first);
  assert.equal(afterInactiveDelete.items.length, 1);
  assert.equal(afterInactiveDelete.messages.length, 2);
  assert.deepEqual(afterInactiveDelete.sessions.map((session) => session.id).sort(), [first, third].sort());
  await page.getByTestId(`session-${second}`).waitFor({ state: 'detached' });
  await expectTitle(first, inactiveName);
  record('confirming an inactive row deletes only that session without changing the current session');

  await page.getByTestId('delete-session').click();
  await expectDeletionDialog(3, inactiveName);
  await answerDeletion(0);
  assert.equal((await snapshot()).current!.id, first);
  assert.equal((await snapshot()).sessions.length, 2);
  record('the footer delete entry shares the named confirmation and cancel behavior');

  await page.getByTestId(`delete-session-${first}`).click();
  await expectDeletionDialog(4, inactiveName);
  assert.equal((await snapshot()).current!.id, first);
  await answerDeletion(1);
  const afterCurrentDelete = await waitForSnapshot(
    (value) => value.current === null && value.sessions.length === 1,
    'current session deletion',
  );
  assert.equal(afterCurrentDelete.sessions[0].id, third);
  assert.deepEqual(afterCurrentDelete.items, []);
  assert.deepEqual(afterCurrentDelete.messages, []);
  assert.deepEqual(afterCurrentDelete.changes, []);
  assert.equal(afterCurrentDelete.run, null);
  await page.getByTestId(`session-${first}`).waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('material-item').count(), 0);
  assert.equal(await page.locator('#message-list .message').count(), 0);
  assert.equal(await page.locator('#task-input').inputValue(), '');
  assert.equal(await page.locator('#session-title').innerText(), '用一句话，开始整理');
  assert.equal(await page.getByTestId('delete-session').isDisabled(), true);
  assert.equal(await readFile(originalPath, 'utf8'), originalContent);
  await screenshot('deleted-current-session.png');
  record(
    'deleting the current session clears its visible history and materials while preserving the original',
  );

  await electronApp!.close();
  electronApp = undefined;
  await launch();
  const afterDeletionRestart = await snapshot();
  assert.equal(afterDeletionRestart.current, null);
  assert.deepEqual(
    afterDeletionRestart.sessions.map((session) => session.id),
    [third],
  );
  assert.equal(await page.locator('.session-delete').count(), 1);
  assert.equal(await readFile(originalPath, 'utf8'), originalContent);
  await screenshot('deletion-after-restart.png');
  record('deleted sessions stay deleted after restarting and the remaining session and original survive');

  const stateFile = JSON.parse(await readFile(path.join(dataRoot, 'state.json'), 'utf8'));
  assert.equal(stateFile.currentId, null);
  assert.deepEqual(errors, []);
  record('no renderer errors and all writes remain in the isolated application data directory');
  const report = {
    ok: true,
    checkedAt: new Date().toISOString(),
    checks,
    errors,
    screenshots,
    deletionDialogs,
    limitations: [
      'No task was sent to a model; first-send title freezing is covered by backend tests.',
      'Deletion confirmation uses the real IPC handler with native dialog responses controlled inside the test; the operating-system dialog UI is not visually tested.',
      'The deletion transcript is a locally seeded fixture, not model-generated output.',
    ],
  };
  await writeFile(path.join(evidenceRoot, 'checks.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidenceRoot }, null, 2));
} catch (error) {
  await writeFile(
    path.join(evidenceRoot, 'checks.json'),
    JSON.stringify({ ok: false, checks, errors, screenshots, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await electronApp?.close();
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  assert.ok(resolvedTemporaryRoot.startsWith(path.resolve(tmpdir()) + path.sep));
  assert.ok(path.basename(resolvedTemporaryRoot).startsWith('xuwu-session-title-ui-'));
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
}
