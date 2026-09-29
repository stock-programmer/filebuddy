import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppEvent, AppSnapshot, Change } from './contracts.js';
import { AgentService } from './agent-service.js';
import { WorkspaceService, type Workspace } from '../workspace/workspace-service.js';
import { DeliveryService } from '../workspace/delivery-service.js';
import { assertNoLinks, inside } from '../workspace/path-policy.js';
import { TraceWriter } from '../observability/trace.js';
import { loadConfig, type AppConfig } from '../config.js';
import {
  DEFAULT_SESSION_TITLE,
  canAutoNameSession,
  sessionTitleFromTask,
  validateSessionTitle,
} from './session-title.js';

export class AppController {
  readonly workspaces: WorkspaceService;
  readonly agent: AgentService;
  current: Workspace | null = null;
  private cachedChanges: Change[] = [];
  private warnings: string[] = [];
  private pendingRuns = 0;
  private notification?: NodeJS.Timeout;
  private busy = false;
  private titleUpdates: Promise<unknown> = Promise.resolve();
  constructor(
    readonly dataRoot: string,
    appRoot: string,
    private emit: (event: AppEvent) => void,
    config: AppConfig = loadConfig(),
  ) {
    this.workspaces = new WorkspaceService(dataRoot, config.workspace);
    this.agent = new AgentService({
      dataRoot,
      appRoot,
      config,
      onEvent: emit,
      onChange: () => this.notifySoon(),
    });
  }
  async initialize() {
    await mkdir(this.dataRoot, { recursive: true });
    await this.agent.configure();
    try {
      const state = JSON.parse(await readFile(path.join(this.dataRoot, 'state.json'), 'utf8'));
      if (typeof state.currentId === 'string') await this.select(state.currentId);
    } catch {
      /* No selection, or a removed session: start with an empty client. */
    }
  }
  private idle() {
    if (this.pendingRuns || this.busy || this.agent.getRun()?.status === 'running')
      throw new Error('当前任务仍在处理中，请先停止或等待完成。');
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.idle();
    this.busy = true;
    try {
      // Finish accepted title writes before opening or deleting any workspace.
      await this.titleUpdates;
      return await action();
    } finally {
      this.busy = false;
    }
  }
  private selected(): Workspace {
    if (!this.current) throw new Error('请先新建一个会话。');
    return this.current;
  }
  async snapshot(): Promise<AppSnapshot> {
    return {
      sessions: await this.workspaces.list(),
      current: this.current?.summary ?? null,
      items: this.current?.items ?? [],
      messages: this.current ? this.agent.getMessages() : [],
      changes: this.cachedChanges,
      run: this.current ? this.agent.getRun() : null,
      model: this.agent.getModelInfo(),
      warnings: this.warnings,
    };
  }
  private notifySoon() {
    if (this.notification) return;
    this.notification = setTimeout(() => {
      this.notification = undefined;
      void this.publish().catch(() => {});
    }, 100);
  }
  async publish() {
    this.emit({ type: 'snapshot', snapshot: await this.snapshot() });
  }
  private async saveSelection() {
    await writeFile(
      path.join(this.dataRoot, 'state.json'),
      JSON.stringify({ currentId: this.current?.id ?? null }),
      'utf8',
    );
  }
  async create(title?: string) {
    return this.exclusive(async () => this.activate(await this.workspaces.create(randomUUID(), title)));
  }
  async select(id: string) {
    return this.exclusive(async () => this.activate(await this.workspaces.open(id)));
  }
  private queueTitleUpdate(action: () => Promise<void>): Promise<void> {
    const next = this.titleUpdates.then(action);
    this.titleUpdates = next.catch(() => {});
    return next;
  }
  private canAutoName(workspace: Workspace): boolean {
    return canAutoNameSession(
      workspace.summary,
      this.agent.getMessages().some((message) => message.role === 'user'),
    );
  }
  async titleFromDraft(id: string, text: string): Promise<AppSnapshot> {
    if (typeof text !== 'string' || text.length > this.agent.getTaskCharacterLimit())
      throw new Error('任务草稿无效。');
    const workspace = this.current;
    if (!workspace || workspace.id !== id || this.busy || this.pendingRuns) return this.snapshot();
    await this.queueTitleUpdate(async () => {
      await workspace.withLock(async () => {
        if (this.current !== workspace || this.busy || this.pendingRuns || !this.canAutoName(workspace))
          return;
        const draft = sessionTitleFromTask(text);
        const title = draft || DEFAULT_SESSION_TITLE;
        const titleSource = draft ? 'draft' : 'default';
        if (workspace.summary.title === title && workspace.summary.titleSource === titleSource) return;
        workspace.summary.title = title;
        workspace.summary.titleSource = titleSource;
        await workspace.persist();
      });
    });
    await this.publish();
    return this.snapshot();
  }
  async renameSession(id: string, text: string): Promise<AppSnapshot> {
    if (this.busy) throw new Error('会话或文件仍在处理中，请稍后修改名称。');
    const title = validateSessionTitle(text);
    await this.queueTitleUpdate(async () => {
      const workspace = this.current?.id === id ? this.current : await this.workspaces.open(id);
      await workspace.withLock(async () => {
        workspace.summary.title = title;
        workspace.summary.titleSource = 'manual';
        await workspace.persist();
      });
    });
    await this.publish();
    return this.snapshot();
  }
  private async activate(workspace: Workspace) {
    await this.agent.openSession(workspace);
    this.current = workspace;
    this.warnings = [];
    this.cachedChanges = await workspace.changes();
    await this.saveSelection();
    await this.publish();
    return this.snapshot();
  }
  async importPaths(paths: string[]) {
    return this.exclusive(async () => {
      if (!this.current) await this.activate(await this.workspaces.create(randomUUID()));
      const result = await this.selected().importPaths(paths);
      this.warnings = result.warnings;
      this.cachedChanges = await this.selected().changes();
      await this.publish();
      return result;
    });
  }
  async removeItem(id: string) {
    return this.exclusive(async () => {
      await this.selected().removeItem(id);
      this.cachedChanges = await this.selected().changes();
      await this.publish();
    });
  }
  async deleteSession(id: string) {
    return this.exclusive(async () => {
      if (this.current?.id === id) {
        await this.agent.dispose();
        this.current = null;
        this.cachedChanges = [];
        await this.saveSelection();
      }
      await this.workspaces.delete(id);
      const sessionTraceDirectory = path.join(this.dataRoot, 'traces', id);
      await assertNoLinks(sessionTraceDirectory);
      const knownRunIds = (await readdir(sessionTraceDirectory).catch(() => [] as string[]))
        .filter((name) => /^[a-f0-9-]{36}\.jsonl$/.test(name))
        .map((name) => name.slice(0, -6));
      // Session ID was validated by WorkspaceService; remove only this session's host data.
      for (const category of ['sessions', 'traces', 'activity']) {
        const target = path.resolve(this.dataRoot, category, id);
        if (!inside(path.join(this.dataRoot, category), target))
          throw new Error('Invalid session storage path');
        await assertNoLinks(target);
        await rm(target, { recursive: true, force: true });
      }
      const runsDirectory = path.join(this.dataRoot, 'runs');
      for (const name of [...knownRunIds.map((runId) => `${runId}.json`), `${id}.latest.json`]) {
        const file = path.join(runsDirectory, name);
        await assertNoLinks(file);
        await rm(file, { force: true });
      }
      for (const name of await readdir(runsDirectory).catch(() => [] as string[])) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(runsDirectory, name);
        await assertNoLinks(file);
        let record: { tracePath?: unknown };
        try {
          record = JSON.parse(await readFile(file, 'utf8'));
        } catch {
          continue;
        }
        const traceRoot = path.join(this.dataRoot, 'traces', id);
        if (
          name === `${id}.latest.json` ||
          (typeof record.tracePath === 'string' && inside(traceRoot, record.tracePath))
        )
          await rm(file);
      }
      await this.publish();
    });
  }
  async send(text: string) {
    if (this.busy) throw new Error('文件导入或交付中，请稍候再发送。');
    const workspace = this.selected();
    if (!text.trim()) throw new Error('请输入希望如何处理文件。');
    if (text.length > this.agent.getTaskCharacterLimit())
      throw new Error(`单条任务过长，请拆分后发送（最多 ${this.agent.getTaskCharacterLimit()} 字符）。`);
    this.pendingRuns++;
    try {
      await this.titleUpdates;
      await workspace.withLock(async () => {
        if (!this.canAutoName(workspace)) return;
        workspace.summary.title = sessionTitleFromTask(text);
        workspace.summary.titleSource = 'auto';
        await workspace.persist();
      });
      await this.publish();
      await this.agent.send(text.trim());
    } finally {
      this.pendingRuns--;
      if (this.current) this.cachedChanges = await this.current.changes();
      await this.publish();
    }
  }
  async stop() {
    await this.agent.stop();
    await this.publish();
  }
  async compact() {
    return this.exclusive(async () => {
      this.selected();
      await this.agent.compact();
      await this.publish();
    });
  }
  async changes() {
    this.cachedChanges = await this.selected().changes();
    return this.cachedChanges;
  }
  async diff(filePath: string) {
    return this.selected().diff(filePath);
  }
  async restore(filePath: string, expectedHash?: string) {
    return this.exclusive(async () => {
      await this.selected().execute('restore', { path: filePath, expectedHash });
      await this.changes();
      await this.publish();
    });
  }
  delivery() {
    this.idle();
    return new DeliveryService(this.selected());
  }
  async withDelivery<T>(action: (service: DeliveryService) => Promise<T>): Promise<T> {
    return this.exclusive(async () => action(new DeliveryService(this.selected())));
  }
  async export(destination: string) {
    return this.exclusive(async () => {
      const output = await new DeliveryService(this.selected()).export(destination);
      this.recordDelivery('export', { status: 'success' });
      return output;
    });
  }
  async exportTrace(destination: string) {
    const source = this.agent.getTracePath();
    if (!source) throw new Error('此会话还没有可导出的运行记录。');
    await copyFile(source, destination);
    return { path: destination };
  }
  recordDelivery(action: string, result: Record<string, unknown>) {
    const run = this.agent.getRun();
    if (run && this.current)
      new TraceWriter(this.dataRoot, this.current.id, run.id).record('delivery', { action, ...result });
  }
  async dispose() {
    if (this.notification) clearTimeout(this.notification);
    await this.titleUpdates;
    await this.agent.dispose();
  }
}
