import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Change, FileDiff, ImportedItem, SessionSummary } from '../app/contracts.js';
import { DEFAULT_CONFIG, type WorkspaceConfig } from '../config.js';
import {
  DEFAULT_SESSION_TITLE,
  MAX_SESSION_TITLE_LENGTH,
  normalizeSessionTitle,
} from '../app/session-title.js';
import { FileService } from './file-service.js';
import {
  assertNoLinks,
  assertPublicPath,
  checkAbort,
  inside,
  normalizeRelative,
  resolveSafe,
  sensitiveName,
  WorkspaceError,
} from './path-policy.js';

export type Entry = { kind: 'file' | 'directory'; hash?: string; size?: number };
export type Tree = Record<string, Entry>;
export interface Manifest {
  version: 1;
  summary: SessionSummary;
  items: ImportedItem[];
  baseline: Tree;
  delivered: Tree;
}
export const hash = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const equalEntry = (a?: Entry, b?: Entry): boolean => a?.kind === b?.kind && a?.hash === b?.hash;
export function formatBytes(bytes: number): string {
  const mib = 1024 * 1024;
  return bytes % mib === 0 ? `${bytes / mib} MiB` : `${bytes} 字节`;
}
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch (e: any) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
export async function scanTree(root: string, prefix = ''): Promise<Tree> {
  const tree: Tree = {};
  const abs = await resolveSafe(root, prefix, true);
  if (!(await exists(abs))) return tree;
  async function visit(current: string, rel: string): Promise<void> {
    await assertNoLinks(current);
    const stat = await fs.lstat(current);
    if (stat.isDirectory()) {
      if (rel) tree[rel] = { kind: 'directory' };
      for (const name of (await fs.readdir(current)).sort())
        await visit(path.join(current, name), rel ? `${rel}/${name}` : name);
    } else {
      tree[rel] = { kind: 'file', hash: hash(await fs.readFile(current)), size: stat.size };
    }
  }
  await visit(abs, prefix);
  return tree;
}
export async function atomicWrite(
  root: string,
  relative: string,
  content: Buffer | string,
  signal?: AbortSignal,
): Promise<void> {
  const dest = await resolveSafe(root, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await resolveSafe(root, relative);
  const temp = `${dest}.xuwu-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { flag: 'wx' });
    checkAbort(signal);
    await resolveSafe(root, relative);
    await fs.rename(temp, dest);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export class Workspace {
  readonly workDir: string;
  readonly baseDir: string;
  readonly fileService: FileService;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly id: string,
    readonly root: string,
    public manifest: Manifest,
    readonly config: WorkspaceConfig = DEFAULT_CONFIG.workspace,
  ) {
    this.workDir = path.join(root, 'work');
    this.baseDir = path.join(root, 'base');
    this.fileService = new FileService(this);
  }
  get items(): ImportedItem[] {
    return this.manifest.items;
  }
  get summary(): SessionSummary {
    return this.manifest.summary;
  }
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  async persist(): Promise<void> {
    this.summary.updatedAt = new Date().toISOString();
    await atomicWrite(this.root, 'manifest.json', JSON.stringify(this.manifest, null, 2));
  }
  async importPaths(inputs: string[]): Promise<{ items: ImportedItem[]; warnings: string[] }> {
    return this.withLock(async () => {
      const warnings: string[] = [];
      const valid = inputs.filter((p) => {
        if (
          typeof p !== 'string' ||
          !path.isAbsolute(p) ||
          /^\\\\|^\/\//.test(p) ||
          /^[a-z]:[^\\/]/i.test(p)
        ) {
          warnings.push(`${String(p)}：只支持本机绝对路径，不支持网络、设备或盘符相对路径。`);
          return false;
        }
        return true;
      });
      const candidates = [...new Set(valid.map((p) => path.resolve(p)))].sort((a, b) => a.length - b.length);
      const accepted: string[] = [];
      for (const source of candidates) {
        if (accepted.some((parent) => inside(parent, source))) {
          warnings.push(`${source}：已合并到选中的父目录。`);
          continue;
        }
        if (this.items.some((i) => inside(i.sourcePath, source) || inside(source, i.sourcePath))) {
          warnings.push(`${source}：与已有材料重叠，已跳过。`);
          continue;
        }
        if (inside(this.root, source) || inside(source, this.root)) {
          warnings.push(`${source}：不能导入应用工作区或其父目录。`);
          continue;
        }
        try {
          await assertNoLinks(source);
          const stat = await fs.stat(source);
          if (!stat.isDirectory() && !stat.isFile()) throw new Error('不是普通文件或目录');
          assertPublicPath(path.basename(source));
          const id = `i-${randomUUID()}`;
          const workPath = `${id}/${path.basename(source) || 'root'}`;
          normalizeRelative(workPath);
          const item: ImportedItem = {
            id,
            name: path.basename(source),
            sourcePath: source,
            workPath,
            kind: stat.isDirectory() ? 'directory' : 'file',
            fileCount: 0,
            warnings: [],
          };
          let bytes = 0;
          const existingBytes = Object.values(this.manifest.baseline).reduce((n, e) => n + (e.size ?? 0), 0);
          const existingFiles = Object.values(this.manifest.baseline).filter((e) => e.kind === 'file').length;
          const importOne = async (src: string, rel: string): Promise<void> => {
            try {
              if (sensitiveName(path.basename(src))) throw new Error('敏感文件或系统目录默认跳过');
              await assertNoLinks(src);
              const st = await fs.lstat(src);
              if (st.isDirectory()) {
                await fs.mkdir(await resolveSafe(this.baseDir, rel), { recursive: true });
                await fs.mkdir(await resolveSafe(this.workDir, rel), { recursive: true });
                for (const name of (await fs.readdir(src)).sort())
                  await importOne(path.join(src, name), `${rel}/${name}`);
              } else {
                if (
                  st.size > this.config.import.maxFileBytes ||
                  existingBytes + bytes + st.size > this.config.import.maxTotalBytes ||
                  existingFiles + item.fileCount >= this.config.import.maxFiles
                )
                  throw new Error(
                    `超过导入限制：单文件 ${formatBytes(this.config.import.maxFileBytes)}、总计 ${formatBytes(this.config.import.maxTotalBytes)}、${this.config.import.maxFiles} 文件`,
                  );
                const content = await fs.readFile(src);
                try {
                  await atomicWrite(this.baseDir, rel, content);
                  await atomicWrite(this.workDir, rel, content);
                } catch (error) {
                  await fs.rm(await resolveSafe(this.baseDir, rel), { force: true });
                  await fs.rm(await resolveSafe(this.workDir, rel), { force: true });
                  throw error;
                }
                bytes += content.length;
                item.fileCount++;
              }
            } catch (e: any) {
              item.warnings.push(`${src}：${e.message}`);
            }
          };
          await importOne(source, workPath);
          if (!(await exists(path.join(this.workDir, workPath)))) {
            warnings.push(...item.warnings);
            continue;
          }
          this.items.push(item);
          const imported = await scanTree(this.baseDir, workPath);
          Object.assign(this.manifest.baseline, imported);
          Object.assign(this.manifest.delivered, imported);
          accepted.push(source);
          warnings.push(...item.warnings);
        } catch (e: any) {
          warnings.push(`${source}：${e.message}`);
        }
      }
      await this.persist();
      return { items: this.items, warnings };
    });
  }
  async removeItem(itemId: string): Promise<void> {
    return this.withLock(async () => {
      const item = this.items.find((i) => i.id === itemId);
      if (!item) throw new WorkspaceError('NOT_FOUND', '材料不存在');
      for (const root of [this.workDir, this.baseDir]) {
        const target = await resolveSafe(root, item.id);
        await fs.rm(target, { recursive: true, force: true });
      }
      this.manifest.items = this.items.filter((i) => i.id !== itemId);
      for (const tree of [this.manifest.baseline, this.manifest.delivered])
        for (const key of Object.keys(tree))
          if (key === item.workPath || key.startsWith(item.workPath + '/')) delete tree[key];
      await this.persist();
    });
  }
  originalPath(relative: string): string | undefined {
    const rel = normalizeRelative(relative);
    const item = this.items.find(
      (i) => rel === i.workPath || (i.kind === 'directory' && rel.startsWith(i.workPath + '/')),
    );
    if (!item) return undefined;
    const suffix = rel.slice(item.workPath.length);
    return path.join(item.sourcePath, ...suffix.split('/').filter(Boolean));
  }
  async tree(): Promise<Tree> {
    const tree = await scanTree(this.workDir);
    for (const item of this.items) delete tree[item.id];
    return tree;
  }
  async changes(baseline: Tree = this.manifest.baseline): Promise<Change[]> {
    const current = await this.tree();
    return this.compare(baseline, current);
  }
  compare(baseline: Tree, current: Tree): Change[] {
    return [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort().flatMap((p) => {
      const before = baseline[p],
        after = current[p];
      if (equalEntry(before, after)) return [];
      const originalPath = this.originalPath(p);
      return [
        {
          path: p,
          kind: !before ? 'added' : !after ? 'deleted' : 'modified',
          isDirectory: (after ?? before).kind === 'directory',
          originalPath,
          canApply: !!originalPath,
          ...(!originalPath ? { reason: '该路径没有授权的原件映射，仅可导出' } : {}),
        } as Change,
      ];
    });
  }
  async diff(relative: string): Promise<FileDiff> {
    const rel = normalizeRelative(relative);
    let expectedHash: string | undefined;
    type Side = { text: string; state: FileDiff['beforeState']; format?: string; reason?: string };
    const limit = this.config.diff.maxFileBytes;
    const unavailable = (reason: string): Side => ({ text: '', state: 'unavailable', reason });
    const read = async (root: string): Promise<Side> => {
      const abs = await resolveSafe(root, rel);
      if (!(await exists(abs))) return { text: '', state: 'missing' };
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return unavailable('该路径是目录或非普通文件');
      if (stat.size > limit) {
        if (root === this.workDir) {
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(abs)) digest.update(chunk);
          expectedHash = digest.digest('hex');
        }
        return unavailable(`文件超过 ${formatBytes(limit)} 差异显示限制`);
      }
      const b = await fs.readFile(abs);
      if (root === this.workDir) expectedHash = hash(b);
      if (b.length > limit) return unavailable(`文件超过 ${formatBytes(limit)} 差异显示限制`);
      if (b.includes(0)) return unavailable('二进制或非 UTF-8 文件');
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
        const endings = [
          ...(text.includes('\r\n') ? ['CRLF'] : []),
          ...(/(?<!\r)\n/.test(text) ? ['LF'] : []),
          ...(/\r(?!\n)/.test(text) ? ['CR'] : []),
        ];
        const format = [
          b.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 'UTF-8 BOM' : 'UTF-8',
          endings.length > 1 ? `混合换行（${endings.join(' / ')}）` : (endings[0] ?? '无换行'),
          ...(endings.length && !/[\r\n]$/.test(text) ? ['末尾无换行'] : []),
        ].join(' · ');
        return { text, state: 'text', format };
      } catch {
        return unavailable('二进制或非 UTF-8 文件');
      }
    };
    const before = await read(this.baseDir),
      after = await read(this.workDir);
    const result: FileDiff = {
      before: before.text,
      after: after.text,
      patch: '',
      expectedHash,
      beforeState: before.state,
      afterState: after.state,
      beforeFormat: before.format,
      afterFormat: after.format,
    };
    if (before.state === 'unavailable' || after.state === 'unavailable') {
      result.notice = [
        ...(before.reason ? [`更改前：${before.reason}`] : []),
        ...(after.reason ? [`更改后：${after.reason}`] : []),
        '无法显示逐行差异。',
      ].join('；');
      return result;
    }
    if (/\r(?!\n)/.test(before.text) || /\r(?!\n)/.test(after.text)) {
      result.notice = '文件含 CR 换行，暂不支持准确的逐行预览，请导出后比较。';
      return result;
    }
    const lineCount = (text: string) => (text ? text.split('\n').length - Number(text.endsWith('\n')) : 0);
    if (lineCount(before.text) + lineCount(after.text) > this.config.diff.maxTotalLines) {
      result.notice = `文件总行数超过 ${this.config.diff.maxTotalLines.toLocaleString('en-US')} 行，未生成逐行差异。请导出文件后使用本地工具比较。`;
      return result;
    }
    const { createPatch } = await import('diff');
    const patch = createPatch(rel, before.text, after.text, undefined, undefined, {
      timeout: this.config.diff.timeoutMs,
      maxEditLength: this.config.diff.maxEditLength,
    });
    if (patch === undefined) {
      result.notice = '差异计算超过时间或改动数量限制，未生成逐行差异。请导出文件后使用本地工具比较。';
    } else {
      result.patch = patch;
      if (before.text === after.text && before.format && after.format && before.format !== after.format)
        result.notice = '文本内容相同，文件格式有变化；请查看两侧的格式说明。';
    }
    return result;
  }
  execute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<any> {
    return this.withLock(() => this.fileService.execute(name, args, signal));
  }
}

export class WorkspaceService {
  constructor(
    readonly dataRoot: string,
    readonly config: WorkspaceConfig = DEFAULT_CONFIG.workspace,
  ) {}
  private location(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new WorkspaceError('INVALID_SESSION', '会话 ID 无效');
    return path.join(this.dataRoot, 'workspaces', id);
  }
  async create(id: string, title?: string): Promise<Workspace> {
    const customTitle = title === undefined ? '' : normalizeSessionTitle(title);
    const initialTitle = customTitle
      ? Array.from(customTitle).slice(0, MAX_SESSION_TITLE_LENGTH).join('')
      : DEFAULT_SESSION_TITLE;
    const root = this.location(id);
    await fs.mkdir(path.join(this.dataRoot, 'workspaces'), { recursive: true });
    await fs.mkdir(root);
    await Promise.all(['work', 'base', 'trash'].map((n) => fs.mkdir(path.join(root, n))));
    const now = new Date().toISOString();
    const ws = new Workspace(
      id,
      root,
      {
        version: 1,
        summary: {
          id,
          title: initialTitle,
          titleSource: customTitle ? 'manual' : 'default',
          createdAt: now,
          updatedAt: now,
        },
        items: [],
        baseline: {},
        delivered: {},
      },
      this.config,
    );
    await ws.persist();
    return ws;
  }
  async open(id: string): Promise<Workspace> {
    const root = this.location(id);
    await assertNoLinks(root);
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
    if (manifest.version !== 1 || manifest.summary.id !== id)
      throw new WorkspaceError('INVALID_MANIFEST', '工作区清单不匹配');
    return new Workspace(id, root, manifest, this.config);
  }
  async list(): Promise<SessionSummary[]> {
    const dir = path.join(this.dataRoot, 'workspaces');
    await fs.mkdir(dir, { recursive: true });
    const all = await Promise.all(
      (await fs.readdir(dir)).map(async (id) => {
        try {
          return (await this.open(id)).summary;
        } catch {
          return null;
        }
      }),
    );
    return all.filter((x): x is SessionSummary => !!x).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async delete(id: string): Promise<void> {
    const root = this.location(id);
    await assertNoLinks(root);
    await fs.rm(root, { recursive: true, force: true });
  }
}
