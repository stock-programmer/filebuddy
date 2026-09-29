import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppController } from '../src/app/controller.js';
import type { ChatMessage } from '../src/app/contracts.js';
import {
  DEFAULT_SESSION_TITLE,
  MAX_SESSION_TITLE_LENGTH,
  sessionTitleFromTask,
  validateSessionTitle,
} from '../src/app/session-title.js';

const fixtures: { root: string; controller: AppController }[] = [];
afterEach(async () => {
  for (const { root, controller } of fixtures.splice(0)) {
    await controller.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'filebuddy-session-title-'));
  const controller = new AppController(root, process.cwd(), () => {});
  const result = { root, controller };
  fixtures.push(result);
  let messages: ChatMessage[] = [];
  vi.spyOn(controller.agent, 'openSession').mockImplementation(async () => {
    messages = [];
  });
  vi.spyOn(controller.agent, 'getMessages').mockImplementation(() => messages);
  vi.spyOn(controller.agent, 'send').mockImplementation(async (text) => {
    messages.push({ id: String(messages.length), role: 'user', text, createdAt: new Date().toISOString() });
  });
  await controller.create();
  return {
    ...result,
    setMessages: (value: ChatMessage[]) => {
      messages = value;
    },
  };
}

describe('session naming', () => {
  it('normalizes whitespace and truncates automatic names without splitting Unicode characters', () => {
    expect(sessionTitleFromTask(' \n 整理\t\t季度   报告 \r\n')).toBe('整理 季度 报告');
    expect(sessionTitleFromTask('😀'.repeat(17))).toBe('😀'.repeat(16));
    expect(validateSessionTitle('  手动\n名称  ')).toBe('手动 名称');
    expect(validateSessionTitle('😀'.repeat(MAX_SESSION_TITLE_LENGTH))).toHaveLength(160);
    expect(() => validateSessionTitle('😀'.repeat(MAX_SESSION_TITLE_LENGTH + 1))).toThrow('80');
    expect(() => validateSessionTitle(' \n\t ')).toThrow('不能为空');
  });

  it('keeps creation optional and treats explicitly provided names as manual', async () => {
    const { controller } = await fixture();
    expect(controller.current?.summary).toMatchObject({
      title: DEFAULT_SESSION_TITLE,
      titleSource: 'default',
    });
    await controller.create('  已命名\n工作  ');
    const id = controller.current!.id;
    await controller.titleFromDraft(id, '不要覆盖已有名称');
    await controller.send('不要覆盖已有名称');
    expect((await controller.workspaces.open(id)).summary).toMatchObject({
      title: '已命名 工作',
      titleSource: 'manual',
    });
  });

  it('persists the first task draft and resets its empty draft to the default title', async () => {
    const { controller } = await fixture();
    const id = controller.current!.id;
    const draft = '请把这个文件夹里面所有的季度报告整理成表格';
    await controller.titleFromDraft(id, draft);
    expect((await controller.workspaces.open(id)).summary).toMatchObject({
      title: sessionTitleFromTask(draft),
      titleSource: 'draft',
    });
    await controller.titleFromDraft(id, ' \n ');
    expect((await controller.workspaces.open(id)).summary).toMatchObject({
      title: DEFAULT_SESSION_TITLE,
      titleSource: 'default',
    });
  });

  it('finalizes from the complete first send and keeps the name across later prompts and reopen', async () => {
    const { controller } = await fixture();
    const id = controller.current!.id;
    await controller.titleFromDraft(id, '初始草稿');
    const firstTask = '整理全部年度报告并生成汇总表供审核';
    await controller.send(firstTask);
    await controller.titleFromDraft(id, '之后继续补充内容');
    await controller.send('之后继续补充内容');
    expect((await controller.workspaces.open(id)).summary).toMatchObject({
      title: sessionTitleFromTask(firstTask),
      titleSource: 'auto',
    });
    await controller.select(id);
    await controller.titleFromDraft(id, '重新打开后的输入');
    expect(controller.current!.summary.title).toBe(sessionTitleFromTask(firstTask));
  });

  it('derives a title on send even when no draft update arrived', async () => {
    const { controller } = await fixture();
    await controller.send('直接发送第一条任务');
    expect(controller.current!.summary).toMatchObject({ title: '直接发送第一条任务', titleSource: 'auto' });
  });

  it('preserves manually renamed default titles and supports renaming a different session', async () => {
    const { controller } = await fixture();
    const firstId = controller.current!.id;
    await controller.renameSession(firstId, DEFAULT_SESSION_TITLE);
    await controller.titleFromDraft(firstId, '不得覆盖手动设置');
    await controller.send('不得覆盖手动设置');
    expect(controller.current!.summary).toMatchObject({
      title: DEFAULT_SESSION_TITLE,
      titleSource: 'manual',
    });
    await controller.create();
    const selectedId = controller.current!.id;
    await controller.renameSession(firstId, '  原会话\n新名字  ');
    expect(controller.current!.id).toBe(selectedId);
    expect((await controller.workspaces.open(firstId)).summary).toMatchObject({
      title: '原会话 新名字',
      titleSource: 'manual',
    });
    await expect(controller.renameSession(firstId, '  ')).rejects.toThrow('不能为空');
    await expect(controller.renameSession(firstId, '字'.repeat(81))).rejects.toThrow('80');
  });

  it.each([
    { title: '之前自定义的会话', hasHistory: false, expected: '之前自定义的会话' },
    { title: DEFAULT_SESSION_TITLE, hasHistory: true, expected: DEFAULT_SESSION_TITLE },
    { title: DEFAULT_SESSION_TITLE, hasHistory: false, expected: '新的任务内容' },
  ])(
    'handles old manifests with title $title and history $hasHistory',
    async ({ title, hasHistory, expected }) => {
      const { controller, setMessages } = await fixture();
      const workspace = controller.current!;
      workspace.summary.title = title;
      delete workspace.summary.titleSource;
      await workspace.persist();
      if (hasHistory)
        setMessages([{ id: 'old', role: 'user', text: '老任务', createdAt: new Date().toISOString() }]);
      await controller.titleFromDraft(workspace.id, '新的任务内容');
      await controller.send('新的任务内容');
      expect((await controller.workspaces.open(workspace.id)).summary.title).toBe(expected);
    },
  );

  it('ignores delayed drafts for a noncurrent session', async () => {
    const { controller } = await fixture();
    const firstId = controller.current!.id;
    await controller.create();
    await controller.titleFromDraft(firstId, '上一会话的延迟草稿');
    expect((await controller.workspaces.open(firstId)).summary.title).toBe(DEFAULT_SESSION_TITLE);
    expect(controller.current!.summary.title).toBe(DEFAULT_SESSION_TITLE);
  });

  it('serializes in-flight draft persistence with immediate send and manual rename', async () => {
    const { root, controller } = await fixture();
    const workspace = controller.current!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = workspace.withLock(() => blocked);
    const draft = controller.titleFromDraft(workspace.id, '过时草稿');
    const send = controller.send('以实际发送的完整任务命名');
    const rename = controller.renameSession(workspace.id, '人工确认的名称');
    release();
    await Promise.all([lock, draft, send, rename]);
    const manifest = JSON.parse(
      await readFile(path.join(root, 'workspaces', workspace.id, 'manifest.json'), 'utf8'),
    );
    expect(manifest.summary).toMatchObject({ title: '人工确认的名称', titleSource: 'manual' });
    expect(controller.agent.send).toHaveBeenCalledWith('以实际发送的完整任务命名');
  });

  it('finishes an accepted rename before selecting that session again', async () => {
    const { controller } = await fixture();
    const workspace = controller.current!;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = workspace.withLock(() => blocked);
    const rename = controller.renameSession(workspace.id, '选中前保存的名称');
    const select = controller.select(workspace.id);
    release();
    await Promise.all([lock, rename, select]);
    expect(controller.current!.summary).toMatchObject({ title: '选中前保存的名称', titleSource: 'manual' });
  });
});
