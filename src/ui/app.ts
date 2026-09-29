import type { AppCommand, AppEvent, AppSnapshot, Change, ChatMessage } from '../app/contracts.js';
import { runActivity, runElapsedMs, runTokenUsage } from './run-progress.js';
import { buildDiffRows, type DiffLine } from './file-diff.js';
import type { FileDiff } from '../app/contracts.js';
import { canAutoNameSession, MAX_SESSION_TITLE_LENGTH, normalizeSessionTitle } from '../app/session-title.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing UI element: ${id}`);
  return node as T;
};
const button = (id: string) => $<HTMLButtonElement>(id);
const input = $<HTMLTextAreaElement>('task-input');
const diffDialog = $<HTMLDialogElement>('diff-dialog');
const confirmDialog = $<HTMLDialogElement>('confirm-dialog');
const renameDialog = $<HTMLDialogElement>('rename-dialog');
const renameInput = $<HTMLInputElement>('rename-input');
$('rename-hint').textContent = `最多 ${MAX_SESSION_TITLE_LENGTH} 个字。修改后，将保留你设置的名称。`;
let state: AppSnapshot | null = null;
let busy = 0;
let streaming = '';
let streamingRunId: string | null = null;
let selectedChanges = new Set<string>();
let lastSessionId: string | null = null;
let knownChanges = new Set<string>();
let activeDiff: { path: string; expectedHash?: string } | null = null;
let latestDeliveryId: string | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let confirmResolve: ((value: boolean) => void) | null = null;
const taskDrafts = new Map<string, string>();
let draftTitleTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraftTitle: { id: string; text: string } | undefined;
let titleSave: Promise<void> = Promise.resolve();
let composing = false;
let renameSessionId: string | null = null;
let renaming = false;

function scheduleDraftTitle() {
  clearTimeout(draftTitleTimer);
  const session = state?.current;
  if (session) taskDrafts.set(session.id, input.value);
  if (!session || composing || !canAutoNameSession(session, !!state?.messages.some((m) => m.role === 'user')))
    return;
  pendingDraftTitle = { id: session.id, text: input.value };
  draftTitleTimer = setTimeout(() => void flushDraftTitle(), 400);
}

function flushDraftTitle(): Promise<void> {
  clearTimeout(draftTitleTimer);
  const draft = pendingDraftTitle;
  pendingDraftTitle = undefined;
  if (draft) {
    titleSave = titleSave.then(async () => {
      try {
        const snapshot: AppSnapshot = await window.xuwu.invoke('session.titleFromDraft', draft);
        if (state?.current?.id === draft.id && snapshot.current?.id === draft.id) updateSnapshot(snapshot);
      } catch (error) {
        notify(`会话名称未能保存：${errorText(error)}`, true);
      }
    });
  }
  return titleSave;
}

function showRename(id: string, title: string) {
  renameSessionId = id;
  renameInput.value = title;
  $('rename-error').textContent = '';
  renameInput.removeAttribute('aria-invalid');
  renameDialog.showModal();
  renameInput.focus();
  renameInput.select();
}

async function saveRename() {
  if (!renameSessionId || renaming) return;
  const title = normalizeSessionTitle(renameInput.value);
  const error = !title
    ? '请输入会话名称。'
    : Array.from(title).length > MAX_SESSION_TITLE_LENGTH
      ? `会话名称最多 ${MAX_SESSION_TITLE_LENGTH} 个字。`
      : '';
  if (error) {
    $('rename-error').textContent = error;
    renameInput.setAttribute('aria-invalid', 'true');
    renameInput.focus();
    return;
  }
  renaming = true;
  busy++;
  button('rename-save').disabled = true;
  button('rename-cancel').disabled = true;
  renameInput.disabled = true;
  renderControls();
  try {
    await flushDraftTitle();
    updateSnapshot(await window.xuwu.invoke('session.rename', { id: renameSessionId, title }));
    renameDialog.close();
    notify('会话名称已修改。');
  } catch (error) {
    $('rename-error').textContent = errorText(error);
  } finally {
    renaming = false;
    busy--;
    button('rename-save').disabled = false;
    button('rename-cancel').disabled = false;
    renameInput.disabled = false;
    renderControls();
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function notify(text: string, error = false) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    error ? 9500 : 5000,
  );
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function command(commandName: AppCommand, payload?: Record<string, unknown>) {
  busy++;
  renderControls();
  try {
    await flushDraftTitle();
    const result = await window.xuwu.invoke(commandName, payload);
    if (result && Array.isArray(result.sessions) && 'current' in result)
      updateSnapshot(result as AppSnapshot);
    else if (commandName !== 'changes.diff') await refresh();
    return result;
  } catch (error) {
    notify(errorText(error), true);
    return undefined;
  } finally {
    busy--;
    renderControls();
  }
}

async function refresh() {
  updateSnapshot(await window.xuwu.invoke('snapshot'));
}

function isRunning() {
  return state?.run?.status === 'running';
}

function displayPath(workPath: string): string {
  const item = state?.items.find(
    (candidate) => workPath === candidate.workPath || workPath.startsWith(`${candidate.workPath}/`),
  );
  return item ? `${item.name}${workPath.slice(item.workPath.length)}` : workPath;
}

function renderControls() {
  const running = isRunning();
  const locked = busy > 0;
  button('new-session').disabled = locked || running;
  button('add-files').disabled = locked || running;
  button('add-directory').disabled = locked || running;
  button('delete-session').disabled = !state?.current || locked || running;
  button('compact-session').disabled =
    !state?.current || !state?.messages.length || locked || running || !state?.model.configured;
  button('export-trace').disabled = !state?.current || locked;
  button('export-results').disabled = !state?.items.length || locked || running;
  button('apply-results').disabled = selectedChanges.size === 0 || locked || running;
  button('restore-delivery').disabled = locked || running;
  button('stop-run').hidden = !running;
  button('stop-run').disabled = false;
  button('send-task').disabled = !input.value.trim() || !state?.model.configured || locked;
  button('send-task').replaceChildren(
    document.createTextNode(running ? '加入队列 ' : '开始处理 '),
    element('span', '', '↑'),
  );
  $('composer-hint').textContent = running
    ? '新要求会排队，当前处理结束后继续'
    : '支持持续对话，随时调整要求';
  $('restore-delivery').hidden = !latestDeliveryId;
  button('restore-file').disabled = locked || running;
  document
    .querySelectorAll<HTMLButtonElement>('.session-entry, .session-rename, .session-delete, .remove-material')
    .forEach((node) => {
      node.disabled = locked || (running && !node.classList.contains('session-rename'));
    });
}

function renderSessions() {
  const list = $('session-list');
  list.replaceChildren();
  $('session-count').textContent = String(state!.sessions.length);
  if (!state!.sessions.length) list.append(element('div', 'session-empty', '从一个新的想法开始'));
  for (const session of state!.sessions) {
    const row = element('div', 'session-row');
    row.classList.toggle('active', state!.current?.id === session.id);
    const entry = element('button', 'session-entry');
    entry.dataset.testid = `session-${session.id}`;
    entry.title = session.title;
    entry.classList.toggle('active', state!.current?.id === session.id);
    entry.setAttribute('aria-current', state!.current?.id === session.id ? 'page' : 'false');
    entry.append(element('span', 'session-symbol', '▱'), element('span', 'session-name', session.title));
    entry.addEventListener('click', () => void command('session.select', { id: session.id }));
    const rename = element('button', 'session-rename', '✎');
    rename.dataset.testid = `rename-session-${session.id}`;
    rename.setAttribute('aria-label', '修改会话名称');
    rename.title = `修改“${session.title}”的名称`;
    rename.addEventListener('click', () => showRename(session.id, session.title));
    const remove = element('button', 'session-delete');
    remove.dataset.testid = `delete-session-${session.id}`;
    remove.setAttribute('aria-label', '删除会话');
    remove.title = `删除“${session.title}”`;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    lines.setAttribute('d', 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7');
    icon.append(lines);
    remove.append(icon);
    remove.addEventListener('click', () => void deleteSession(session.id));
    row.append(entry, rename, remove);
    list.append(row);
  }
  $('session-title').textContent = state!.current?.title || '用一句话，开始整理';
  $('session-title').title = state!.current?.title || '';
}

async function deleteSession(id: string) {
  const result: AppSnapshot | undefined = await command('session.delete', { id });
  if (result && !result.sessions.some((session) => session.id === id)) notify('会话已删除。');
}

function renderMaterials() {
  const list = $('materials');
  list.replaceChildren();
  $('item-count').textContent = String(state!.items.length);
  if (!state!.items.length)
    list.append(element('div', 'material-empty', '还没有添加材料\n添加文本文件或一个目录'));
  for (const item of state!.items) {
    const row = element('div', 'material');
    row.dataset.testid = 'material-item';
    const icon = element(
      'span',
      `file-symbol${item.kind === 'directory' ? ' folder' : ''}`,
      item.kind === 'directory' ? '▱' : 'TXT',
    );
    icon.setAttribute('aria-hidden', 'true');
    const info = element('div', 'material-info');
    const name = element('div', 'material-name', item.name);
    name.title = item.sourcePath;
    const detail = element(
      'div',
      'material-detail',
      item.kind === 'directory' ? `${item.fileCount} 个文件 · 工作副本` : '已添加 · 工作副本',
    );
    detail.title = `原件：${item.sourcePath}\n副本：${item.workPath}`;
    info.append(name, detail);
    for (const warning of item.warnings || []) info.append(element('div', 'material-warning', warning));
    const remove = element('button', 'remove-material', '×');
    remove.setAttribute('aria-label', `移除材料 ${item.name}`);
    remove.title = '移除当前会话中的材料';
    remove.addEventListener('click', async () => {
      if (
        await confirmAction(
          '移除这份材料？',
          `“${item.name}”的工作副本及相关变更将从本次会话移除，原件保持不变。`,
          '移除材料',
        )
      )
        await command('files.remove', { id: item.id });
    });
    row.append(icon, info, remove);
    list.append(row);
  }
}

function renderMessage(message: ChatMessage) {
  const row = element('article', `message ${message.role}`);
  row.dataset.testid = `message-${message.role}`;
  row.dataset.messageId = message.id;
  const avatar = element(
    'div',
    `message-avatar ${message.role}-avatar`,
    message.role === 'assistant' ? 'FB' : message.role === 'user' ? '我' : 'i',
  );
  const body = element('div', 'message-body');
  const meta = element('div', 'message-meta');
  const date = new Date(message.createdAt);
  const time = Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  meta.append(
    element(
      'strong',
      '',
      message.role === 'assistant' ? 'FileBuddy' : message.role === 'user' ? '你' : '运行状态',
    ),
    ...(message.role === 'notice' ? [element('span', 'message-source', '程序生成')] : []),
    element('span', '', time),
  );
  body.append(meta, element('div', 'message-text', message.text));
  row.append(avatar, body);
  return row;
}

function renderMessages() {
  const scroll = $('message-scroll');
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  $('welcome').hidden = state!.messages.length > 0 || streaming.length > 0;
  $('message-list').replaceChildren(...state!.messages.map(renderMessage));
  renderStream();
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
}

function renderStream() {
  $('stream-message').hidden = !streaming;
  $('stream-text').textContent = streaming;
  if (streaming) $('welcome').hidden = true;
}

function renderRun() {
  const run = state!.run;
  $('run-strip').hidden = !run;
  if (!run) return;
  const now = Date.now();
  const activity = runActivity(run, now);
  $('run-activity').textContent = activity;
  $('run-activity').title = activity;
  const seconds = Math.round(runElapsedMs(run, now) / 1000);
  const tokens = runTokenUsage(run);
  $('run-stats').textContent = `${run.toolCalls} 次工具 · ${tokens.summary} · ${seconds}s`;
  $('run-stats').title = `模型调用 ${run.modelCalls} 次，工具调用 ${run.toolCalls} 次，${tokens.detail}`;
  $('status-dot').className = `status-dot ${run.status}`;
}

function renderChanges() {
  const list = $('changes-list');
  list.replaceChildren();
  const changes = state!.changes;
  const applicable = changes.filter((change) => change.canApply);
  const available = new Set(applicable.map((change) => change.path));
  for (const path of selectedChanges) if (!available.has(path)) selectedChanges.delete(path);
  for (const path of available) if (!knownChanges.has(path)) selectedChanges.add(path);
  knownChanges = available;
  $('change-count').textContent = String(changes.length);
  $('result-empty').hidden = changes.length > 0;
  $('selection-row').hidden = applicable.length === 0;
  $('results-summary').textContent = changes.length
    ? `${changes.filter((c) => c.kind === 'added').length} 项新增 · ${changes.filter((c) => c.kind === 'modified').length} 项修改 · ${changes.filter((c) => c.kind === 'deleted').length} 项删除`
    : '每一处变更，都可以检查。';
  for (const change of changes) {
    const row = element('div', 'change');
    row.dataset.testid = 'change-item';
    row.dataset.path = change.path;
    const checkbox = element('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = !change.canApply || isRunning();
    checkbox.checked = selectedChanges.has(change.path);
    checkbox.setAttribute('aria-label', `选择变更 ${displayPath(change.path)}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedChanges.add(change.path);
      else selectedChanges.delete(change.path);
      renderSelection();
      renderControls();
    });
    const main = element('div', 'change-main');
    const title = element('button', 'change-title', displayPath(change.path));
    title.title = change.originalPath || change.path;
    title.addEventListener('click', () => void showDiff(change));
    const detail = element('div', 'change-detail');
    const kind = element(
      'span',
      `change-kind ${change.kind}`,
      { added: '新增', modified: '修改', deleted: '删除' }[change.kind],
    );
    const diff = element('button', 'diff-link', change.isDirectory ? '目录' : '查看差异 ↗');
    diff.disabled = change.isDirectory;
    diff.addEventListener('click', () => void showDiff(change));
    detail.append(kind, diff);
    main.append(title, detail);
    if (!change.canApply)
      main.append(element('div', 'change-reason', change.reason || '新位置没有原件映射，可通过导出保存'));
    row.append(checkbox, main);
    list.append(row);
  }
  renderSelection();
}

function renderSelection() {
  const applicable = state!.changes.filter((change) => change.canApply);
  const all = $<HTMLInputElement>('select-all-changes');
  all.checked = applicable.length > 0 && selectedChanges.size === applicable.length;
  all.indeterminate = selectedChanges.size > 0 && selectedChanges.size < applicable.length;
  all.disabled = isRunning() || busy > 0;
  $('selected-count').textContent = `${selectedChanges.size} 项`;
  $('delivery-note').textContent = selectedChanges.size
    ? `已选 ${selectedChanges.size} 项，写回前将再次确认并备份。`
    : '原文件由你掌握，确认后才会写回。';
}

function updateSnapshot(snapshot: AppSnapshot) {
  const previousMessages = new Set(state?.messages.map((message) => message.id) || []);
  const newSession = snapshot.current?.id || null;
  if (newSession !== lastSessionId) {
    if (lastSessionId) taskDrafts.set(lastSessionId, input.value);
    input.value = newSession ? taskDrafts.get(newSession) || '' : '';
    input.style.height = '59px';
    input.style.height = `${Math.min(130, Math.max(59, input.scrollHeight))}px`;
    selectedChanges = new Set();
    knownChanges = new Set();
    latestDeliveryId = null;
    lastSessionId = newSession;
    streaming = '';
    streamingRunId = null;
  }
  if (streaming) {
    for (const message of snapshot.messages) {
      if (
        message.role === 'assistant' &&
        !previousMessages.has(message.id) &&
        streaming.startsWith(message.text)
      ) {
        streaming = streaming.slice(message.text.length);
      }
    }
  }
  state = snapshot;
  for (const id of taskDrafts.keys()) {
    if (!snapshot.sessions.some((session) => session.id === id)) taskDrafts.delete(id);
  }
  // Finalized history is authoritative; transient stream only belongs to a live run.
  if (snapshot.run?.status !== 'running' || (streamingRunId && snapshot.run?.id !== streamingRunId)) {
    streaming = '';
    streamingRunId = null;
  }
  renderSessions();
  renderMaterials();
  renderMessages();
  renderChanges();
  renderRun();
  $('warnings').replaceChildren(...snapshot.warnings.map((warning) => element('div', '', warning)));
  $('model-name').textContent = snapshot.model.configured
    ? `${snapshot.model.provider} · ${snapshot.model.name}`
    : '尚未配置模型 · 请在本地 .env 中设置';
  $('model-name').title = snapshot.model.configured
    ? `使用 ${snapshot.model.provider} 的 ${snapshot.model.name}`
    : '配置模型后重新启动客户端';
  $('model-dot').classList.toggle('unconfigured', !snapshot.model.configured);
  renderControls();
}

async function ensureSession() {
  if (!state?.current) {
    const draft = input.value;
    await command('session.create');
    input.value = draft;
    scheduleDraftTitle();
  }
  return !!state?.current;
}

async function pickFiles(kind: 'file' | 'directory') {
  if (!(await ensureSession())) return;
  await command('files.pick', { kind });
}

async function sendTask() {
  const text = input.value.trim();
  if (!text || !state?.model.configured || busy > 0) return;
  busy++;
  renderControls();
  try {
    if (!(await ensureSession())) return;
    await flushDraftTitle();
    const wasRunning = isRunning();
    input.value = '';
    if (state?.current) taskDrafts.delete(state.current.id);
    input.style.height = '59px';
    const promise = window.xuwu.invoke('chat.send', { text });
    if (wasRunning) notify('已加入队列，当前任务结束后继续处理。');
    await promise;
    await refresh();
  } catch (error) {
    if (!input.value) input.value = text;
    notify(errorText(error), true);
  } finally {
    busy--;
    renderControls();
  }
}

async function showDiff(change: Change) {
  if (change.isDirectory) {
    notify('目录变更请检查对应文件，导出会保留目录结构。');
    return;
  }
  const result: FileDiff | undefined = await command('changes.diff', { path: change.path });
  if (!result) return;
  activeDiff = {
    path: change.path,
    expectedHash: result.expectedHash,
  };
  $('diff-title').textContent = displayPath(change.path);
  renderDiff(result);
  $('diff-note').textContent =
    change.kind === 'added' ? '恢复操作将移除这个新增的工作副本。' : '恢复仅影响工作副本，原件保持不变。';
  if (!diffDialog.open) diffDialog.showModal();
  $('diff-scroll').scrollTop = 0;
}

const maxDiffLineCharacters = 20000;

function diffCell(line: DiffLine | undefined, side: 'before' | 'after'): HTMLElement {
  const cell = element('div', `diff-cell ${line ? `diff-${line.kind}` : 'diff-placeholder'}`);
  cell.dataset.side = side;
  if (!line) {
    cell.setAttribute('aria-label', '此侧无对应行');
    return cell;
  }
  cell.dataset.line = String(line.number);
  const number = element('span', 'diff-line-number', String(line.number));
  number.setAttribute('aria-label', `第 ${line.number} 行`);
  const marker = element(
    'span',
    'diff-marker',
    line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : '',
  );
  marker.setAttribute(
    'aria-label',
    line.kind === 'added' ? '新增' : line.kind === 'removed' ? '删除' : '未改动',
  );
  const content = element('div', 'diff-content');
  // File content is untrusted text, including HTML and script-looking lines.
  content.append(element('code', 'diff-code', line.text.slice(0, maxDiffLineCharacters)));
  if (line.text.length > maxDiffLineCharacters)
    content.append(
      element('span', 'diff-line-truncated', '此行仅显示前 20,000 个字符，完整内容请导出查看。'),
    );
  if (line.noNewline) content.append(element('span', 'diff-no-newline', '文件末尾无换行'));
  cell.append(number, marker, content);
  return cell;
}

function renderDiff(result: FileDiff) {
  const model = buildDiffRows(result.patch);
  const rows = $('diff-rows');
  const fragment = document.createDocumentFragment();
  // A bounded preview keeps very large edits from creating an unresponsive dialog.
  const visibleRows = model.rows.slice(0, 2000);
  const hasLongLines = visibleRows.some(
    (row) =>
      row.kind === 'line' &&
      Math.max(row.before?.text.length ?? 0, row.after?.text.length ?? 0) > maxDiffLineCharacters,
  );
  for (const row of visibleRows) {
    if (row.kind === 'hunk') {
      const header = element('div', 'diff-hunk', row.header);
      header.setAttribute('aria-label', `差异片段：处理前第 ${row.oldStart} 行，处理后第 ${row.newStart} 行`);
      fragment.append(header);
    } else {
      const node = element('div', 'diff-row');
      node.append(diffCell(row.before, 'before'), diffCell(row.after, 'after'));
      fragment.append(node);
    }
  }
  rows.replaceChildren(fragment);
  $('diff-added').textContent = `+ ${model.added} 行新增`;
  $('diff-removed').textContent = `- ${model.removed} 行删除`;
  $('diff-counts').hidden = !!result.notice;
  const sideDescription = (side: 'before' | 'after') => {
    const status = side === 'before' ? result.beforeState : result.afterState;
    const text = side === 'before' ? result.before : result.after;
    const format = side === 'before' ? result.beforeFormat : result.afterFormat;
    return status === 'missing'
      ? '文件不存在'
      : status === 'unavailable'
        ? '无法预览'
        : text === ''
          ? `空文件${format ? ` · ${format}` : ''}`
          : format || '';
  };
  $('diff-before-format').textContent = sideDescription('before');
  $('diff-after-format').textContent = sideDescription('after');
  const notice = $('diff-status');
  notice.textContent =
    result.notice ||
    (model.rows.length > visibleRows.length
      ? '改动较多，当前仅展示前 2,000 条差异行；上方统计包含全部改动。可导出结果查看完整文件。'
      : model.rows.length === 0
        ? result.beforeState === 'missing' && result.afterState === 'missing'
          ? '两侧文件均不存在，请关闭后刷新变更列表。'
          : result.beforeState === 'missing'
            ? '新增了一个空文件。'
            : result.afterState === 'missing'
              ? '文件已删除，导入时为空文件。'
              : result.beforeFormat !== result.afterFormat
                ? '文本内容相同，文件编码或换行格式发生变化，请查看两侧格式标记。'
                : '两份文件的文本内容相同。'
        : '仅显示改动及附近上下文，其余未改动内容已省略。');
  if (hasLongLines) notice.textContent += ' 超长行仅展示前 20,000 个字符。';
  notice.classList.toggle(
    'diff-status-warning',
    !!result.notice || model.rows.length > visibleRows.length || hasLongLines,
  );
}

function confirmAction(title: string, description: string, action: string): Promise<boolean> {
  if (confirmResolve) confirmResolve(false);
  $('confirm-title').textContent = title;
  $('confirm-description').textContent = description;
  $('confirm-ok').textContent = action;
  if (!confirmDialog.open) confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function finishConfirm(value: boolean) {
  confirmDialog.close();
  confirmResolve?.(value);
  confirmResolve = null;
}

function resultLocation(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const value = result as Record<string, unknown>;
    return typeof value.path === 'string'
      ? value.path
      : typeof value.filePath === 'string'
        ? value.filePath
        : undefined;
  }
  return undefined;
}

button('new-session').addEventListener('click', () => void command('session.create'));
button('add-files').addEventListener('click', () => void pickFiles('file'));
button('add-directory').addEventListener('click', () => void pickFiles('directory'));
button('send-task').addEventListener('click', () => void sendTask());
button('stop-run').addEventListener('click', () => void command('chat.stop'));
button('delete-session').addEventListener('click', async () => {
  if (!state?.current) return;
  await deleteSession(state.current.id);
});
button('compact-session').addEventListener('click', async () => {
  notify('正在整理历史上下文，保留任务目标、约束和当前进度…');
  const result = await command('session.compact');
  if (result !== undefined) notify('上下文整理完成，可以继续对话。');
});
button('export-trace').addEventListener('click', async () => {
  const result = await command('trace.export');
  const location = resultLocation(result);
  if (location) notify(`运行记录已导出至\n${location}`);
});
button('export-results').addEventListener('click', async () => {
  const result = await command('results.export');
  const location = resultLocation(result);
  if (location) notify(`工作文件已导出至\n${location}`);
});
button('apply-results').addEventListener('click', async () => {
  if (!selectedChanges.size) return;
  const result = await command('results.apply', { paths: [...selectedChanges] });
  if (!result || result.cancelled || result.canceled) return;
  const deliveryId = result.id || result.deliveryId || result.batchId;
  if (typeof deliveryId === 'string') latestDeliveryId = deliveryId;
  if (result.failed?.length)
    notify(
      `已写回 ${result.applied?.length || 0} 项，${result.failed.length} 项未完成：${result.failed.map((item: { path: string; error: string }) => `${item.path}：${item.error}`).join('；')}。已提交的结果已保留备份。`,
      true,
    );
  else if (result.errors?.length)
    notify(
      `部分写回未完成：${result.errors.map((item: unknown) => (typeof item === 'string' ? item : JSON.stringify(item))).join('；')}`,
      true,
    );
  else notify('所选变更已写回原件，写回前版本已备份。');
  renderControls();
});
button('restore-delivery').addEventListener('click', async () => {
  if (!latestDeliveryId) return;
  if (
    !(await confirmAction(
      '恢复原件？',
      '将原件恢复到最近一次写回之前的版本。应用会先检查原件是否又被修改，遇到冲突时停止。',
      '恢复原件',
    ))
  )
    return;
  const result = await command('delivery.restore', { id: latestDeliveryId });
  if (result !== undefined) {
    if (result.failed?.length)
      notify(
        `部分原件未能恢复：${result.failed.map((item: { path: string; error: string }) => `${item.path}：${item.error}`).join('；')}`,
        true,
      );
    else {
      latestDeliveryId = null;
      notify('已恢复写回前的原件。');
    }
    renderControls();
  }
});
$<HTMLInputElement>('select-all-changes').addEventListener('change', (event) => {
  selectedChanges = (event.target as HTMLInputElement).checked
    ? new Set(state?.changes.filter((change) => change.canApply).map((change) => change.path))
    : new Set();
  renderChanges();
  renderControls();
});
button('close-diff').addEventListener('click', () => diffDialog.close());
button('restore-file').addEventListener('click', async () => {
  if (!activeDiff) return;
  const target = activeDiff;
  if (
    !(await confirmAction(
      '恢复这份工作副本？',
      `“${displayPath(target.path)}”将恢复到导入时的状态。本次会话中的相关修改会被撤销。`,
      '恢复副本',
    ))
  )
    return;
  const result = await command('workspace.restore', target);
  if (result !== undefined) {
    diffDialog.close();
    notify('工作副本已恢复。');
  }
});
button('confirm-cancel').addEventListener('click', () => finishConfirm(false));
button('confirm-ok').addEventListener('click', () => finishConfirm(true));
confirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  finishConfirm(false);
});
$('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void saveRename();
});
button('rename-cancel').addEventListener('click', () => renameDialog.close());
renameDialog.addEventListener('cancel', (event) => {
  if (renaming) event.preventDefault();
});
renameDialog.addEventListener('close', () => {
  renameSessionId = null;
});
renameInput.addEventListener('input', () => {
  $('rename-error').textContent = '';
  renameInput.removeAttribute('aria-invalid');
});
input.addEventListener('input', () => {
  input.style.height = '59px';
  input.style.height = `${Math.min(130, Math.max(59, input.scrollHeight))}px`;
  scheduleDraftTitle();
  renderControls();
});
input.addEventListener('compositionstart', () => {
  composing = true;
  clearTimeout(draftTitleTimer);
  pendingDraftTitle = undefined;
});
input.addEventListener('compositionend', () => {
  composing = false;
  scheduleDraftTitle();
});
input.addEventListener('keydown', (event) => {
  if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void sendTask();
  }
});
document.querySelectorAll<HTMLButtonElement>('[data-suggestion]').forEach((node) =>
  node.addEventListener('click', () => {
    input.value = node.dataset.suggestion || '';
    input.focus();
    scheduleDraftTitle();
    renderControls();
  }),
);

let dragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = isRunning() ? 'none' : 'copy';
});
document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('drop-overlay').hidden = true;
});
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  if (isRunning()) {
    notify('请等待当前任务结束或停止处理后，再添加材料。');
    return;
  }
  if (!(await ensureSession())) return;
  busy++;
  renderControls();
  try {
    await window.xuwu.importDropped(files);
    await refresh();
  } catch (error) {
    notify(errorText(error), true);
  } finally {
    busy--;
    renderControls();
  }
});

function onEvent(event: AppEvent) {
  if (event.type === 'snapshot') updateSnapshot(event.snapshot);
  else if (event.type === 'activity') {
    if (state?.run) state.run.lastActivity = event.text;
    $('run-activity').textContent = event.text;
    $('run-activity').title = event.text;
  } else if (event.type === 'text_delta') {
    if (streamingRunId !== event.runId) {
      streaming = '';
      streamingRunId = event.runId;
    }
    streaming += event.text;
    if (!renderTimer)
      renderTimer = setTimeout(() => {
        const scroll = $('message-scroll');
        const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
        renderStream();
        if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
        renderTimer = undefined;
      }, 35);
  }
}

if (window.xuwu) {
  window.xuwu.onEvent(onEvent);
  // Keep waiting/last-received ages moving without fetching or rebuilding the whole snapshot.
  const runClock = setInterval(() => {
    if (state?.run?.status === 'running') renderRun();
  }, 1000);
  window.addEventListener('beforeunload', () => clearInterval(runClock), { once: true });
  void refresh().catch((error) => notify(`无法载入工作区：${errorText(error)}`, true));
} else {
  notify('客户端连接不可用，请通过桌面应用启动。', true);
  $('model-name').textContent = '未连接桌面服务';
  document.querySelectorAll<HTMLButtonElement>('button').forEach((node) => {
    node.disabled = true;
  });
}
