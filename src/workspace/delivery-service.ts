import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { Change } from '../app/contracts.js';
import {
  Workspace,
  atomicWrite,
  equalEntry,
  exists,
  hash,
  type Entry,
  type Tree,
} from './workspace-service.js';
import { assertNoLinks, inside, normalizeRelative, WorkspaceError } from './path-policy.js';

interface Preview {
  token: string;
  fingerprint: string;
  deliveredFingerprint: string;
  paths: string[];
  changes: Change[];
  conflicts: { path: string; reason: string }[];
  createdAt: string;
}
interface DeliveryRecord {
  path: string;
  originalPath: string;
  before?: Entry;
  after?: Entry;
  status: 'pending' | 'applied' | 'failed' | 'restored';
  error?: string;
}
interface Delivery {
  id: string;
  createdAt: string;
  records: DeliveryRecord[];
}
const fingerprint = (tree: Tree) =>
  hash(JSON.stringify(Object.fromEntries(Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)))));
async function originalEntry(absolute: string): Promise<Entry | undefined> {
  await assertNoLinks(absolute);
  if (!(await exists(absolute))) return undefined;
  const stat = await fs.stat(absolute);
  return stat.isDirectory()
    ? { kind: 'directory' }
    : { kind: 'file', hash: hash(await fs.readFile(absolute)), size: stat.size };
}

export class DeliveryService {
  readonly root: string;
  constructor(readonly workspace: Workspace) {
    this.root = path.join(workspace.root, 'deliveries');
  }
  private async selected(paths?: string[]): Promise<Change[]> {
    const changes = await this.workspace.changes(this.workspace.manifest.delivered);
    if (!paths) return changes;
    const chosen = new Set(paths.map((p) => normalizeRelative(p)));
    const selected = changes.filter((c) => chosen.has(c.path));
    for (const change of changes) {
      if (
        change.kind === 'added' &&
        change.isDirectory &&
        selected.some((c) => c.path.startsWith(change.path + '/'))
      )
        chosen.add(change.path);
      if (selected.some((c) => c.kind === 'deleted' && c.isDirectory && change.path.startsWith(c.path + '/')))
        chosen.add(change.path);
    }
    return changes.filter((c) => chosen.has(c.path));
  }
  private async conflicts(changes: Change[]): Promise<{ path: string; reason: string }[]> {
    const result: { path: string; reason: string }[] = [];
    const tree = await this.workspace.tree();
    for (const change of changes) {
      if (!change.originalPath) {
        result.push({ path: change.path, reason: change.reason ?? '没有原件映射' });
        continue;
      }
      try {
        const before = this.workspace.manifest.delivered[change.path];
        const actual = await originalEntry(change.originalPath);
        if (!equalEntry(before, actual))
          result.push({
            path: change.path,
            reason: before ? '原件在导入或上次交付后已被修改、移走或替换' : '新建目标已经存在',
          });
        if (before && tree[change.path] && before.kind !== tree[change.path].kind)
          result.push({ path: change.path, reason: '首版不支持写回文件与目录类型互换，请导出到新位置' });
      } catch (e: any) {
        result.push({ path: change.path, reason: e.message });
      }
    }
    return result;
  }
  async preview(paths?: string[]): Promise<Preview> {
    return this.workspace.withLock(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const changes = await this.selected(paths);
      const preview: Preview = {
        token: randomUUID(),
        fingerprint: fingerprint(await this.workspace.tree()),
        deliveredFingerprint: fingerprint(this.workspace.manifest.delivered),
        paths: changes.map((c) => c.path),
        changes,
        conflicts: await this.conflicts(changes),
        createdAt: new Date().toISOString(),
      };
      await atomicWrite(this.root, `preview-${preview.token}.json`, JSON.stringify(preview));
      return preview;
    });
  }
  async apply(
    token: string,
    paths?: string[],
  ): Promise<{ deliveryId: string; applied: string[]; failed: { path: string; error: string }[] }> {
    return this.workspace.withLock(async () => {
      if (!/^[a-f0-9-]{36}$/.test(token))
        throw new WorkspaceError('INVALID_PREVIEW', '请先检查原件写回预览。');
      const previewPath = path.join(this.root, `preview-${token}.json`);
      let preview: Preview;
      try {
        preview = JSON.parse(await fs.readFile(previewPath, 'utf8'));
      } catch {
        throw new WorkspaceError('INVALID_PREVIEW', '预览已失效或已使用。');
      }
      const current = await this.workspace.tree();
      if (
        fingerprint(current) !== preview.fingerprint ||
        fingerprint(this.workspace.manifest.delivered) !== preview.deliveredFingerprint
      )
        throw new WorkspaceError('STALE_PREVIEW', '预览之后工作区或交付基线已变化，请重新预览。');
      if (paths && JSON.stringify([...paths].sort()) !== JSON.stringify([...preview.paths].sort()))
        throw new WorkspaceError('STALE_PREVIEW', '确认选择与预览不一致，请重新预览。');
      const conflicts = await this.conflicts(preview.changes);
      if (conflicts.length)
        throw new WorkspaceError(
          'ORIGINAL_CONFLICT',
          `原件冲突：${conflicts.map((c) => `${c.path}：${c.reason}`).join('；')}`,
        );
      const deliveryId = randomUUID();
      const dir = path.join(this.root, deliveryId);
      await fs.mkdir(path.join(dir, 'backup'), { recursive: true });
      const order = (c: Change) => (c.kind === 'deleted' ? (c.isDirectory ? 3 : 2) : c.isDirectory ? 0 : 1);
      const changes = [...preview.changes].sort(
        (a, b) =>
          order(a) - order(b) ||
          (a.kind === 'deleted' ? b.path.length - a.path.length : a.path.length - b.path.length),
      );
      const delivery: Delivery = {
        id: deliveryId,
        createdAt: new Date().toISOString(),
        records: changes.map((c) => ({
          path: c.path,
          originalPath: c.originalPath!,
          before: this.workspace.manifest.delivered[c.path],
          after: current[c.path],
          status: 'pending',
        })),
      };
      for (const record of delivery.records)
        if (record.before?.kind === 'file') {
          const dest = path.join(dir, 'backup', record.path);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await assertNoLinks(record.originalPath);
          const bytes = await fs.readFile(record.originalPath);
          if (hash(bytes) !== record.before.hash)
            throw new WorkspaceError('ORIGINAL_CONFLICT', '备份前原件发生变化，请重新预览。');
          await fs.writeFile(dest, bytes);
        }
      await atomicWrite(dir, 'delivery.json', JSON.stringify(delivery, null, 2));
      await fs.rm(previewPath);
      const applied: string[] = [],
        failed: { path: string; error: string }[] = [];
      for (const record of delivery.records) {
        try {
          const latest = await originalEntry(record.originalPath);
          if (!equalEntry(latest, record.before))
            throw new WorkspaceError('ORIGINAL_CONFLICT', '提交前原件发生变化。');
          if (!record.after) {
            if (record.before?.kind === 'directory') await fs.rmdir(record.originalPath);
            else await fs.unlink(record.originalPath);
          } else if (record.after.kind === 'directory')
            await fs.mkdir(record.originalPath, { recursive: true });
          else {
            const source = path.join(this.workspace.workDir, record.path);
            await assertNoLinks(source);
            const content = await fs.readFile(source);
            if (hash(content) !== record.after.hash)
              throw new WorkspaceError('STALE_PREVIEW', '提交前工作文件发生变化。');
            await this.writeOriginal(record.originalPath, content, { expected: record.before });
          }
          record.status = 'applied';
          applied.push(record.path);
          if (record.after) this.workspace.manifest.delivered[record.path] = record.after;
          else delete this.workspace.manifest.delivered[record.path];
          await this.workspace.persist();
        } catch (e: any) {
          record.status = 'failed';
          record.error = e.message;
          failed.push({ path: record.path, error: e.message });
        }
        await atomicWrite(dir, 'delivery.json', JSON.stringify(delivery, null, 2));
      }
      return { deliveryId, applied, failed };
    });
  }
  private async writeOriginal(
    absolute: string,
    content: Buffer,
    guard?: { expected: Entry | undefined; code?: string },
  ): Promise<void> {
    await assertNoLinks(absolute);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await assertNoLinks(absolute);
    const temp = path.join(path.dirname(absolute), `.xuwu-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, content, { flag: 'wx' });
      // A guard object also represents "expected absent" for new files. Export intentionally has no guard.
      // Recheck after staging to catch external writes during staging; this is not an OS-level compare-and-swap.
      if (guard && !equalEntry(await originalEntry(absolute), guard.expected))
        throw new WorkspaceError(guard.code ?? 'ORIGINAL_CONFLICT', '提交前原件发生变化，已保留外部修改。');
      await assertNoLinks(absolute);
      await fs.rename(temp, absolute);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
  async restoreDelivery(
    deliveryId: string,
  ): Promise<{ restored: string[]; failed: { path: string; error: string }[] }> {
    return this.workspace.withLock(async () => {
      if (!/^[a-f0-9-]{36}$/.test(deliveryId)) throw new WorkspaceError('INVALID_DELIVERY', '交付 ID 无效。');
      const dir = path.join(this.root, deliveryId);
      const delivery = JSON.parse(await fs.readFile(path.join(dir, 'delivery.json'), 'utf8')) as Delivery;
      const records = delivery.records.filter((r) => r.status === 'applied');
      const restored: string[] = [],
        failed: { path: string; error: string }[] = [];
      // Files first, then empty new directories; deleted directories are recreated before their children.
      records.sort((a, b) => {
        const score = (r: DeliveryRecord) =>
          r.before?.kind === 'directory'
            ? 0
            : r.before?.kind === 'file'
              ? 1
              : r.after?.kind === 'file'
                ? 2
                : 3;
        return (
          score(a) - score(b) || (a.before ? a.path.length - b.path.length : b.path.length - a.path.length)
        );
      });
      for (const record of records) {
        try {
          const actual = await originalEntry(record.originalPath);
          if (!equalEntry(actual, record.after))
            throw new WorkspaceError('RESTORE_CONFLICT', '原件在交付后已被再次修改，未覆盖。');
          if (record.before?.kind === 'directory') await fs.mkdir(record.originalPath, { recursive: true });
          else if (record.before?.kind === 'file')
            await this.writeOriginal(
              record.originalPath,
              await fs.readFile(path.join(dir, 'backup', record.path)),
              { expected: record.after, code: 'RESTORE_CONFLICT' },
            );
          else if (record.after?.kind === 'directory') await fs.rmdir(record.originalPath);
          else await fs.unlink(record.originalPath);
          record.status = 'restored';
          restored.push(record.path);
          if (record.before) this.workspace.manifest.delivered[record.path] = record.before;
          else delete this.workspace.manifest.delivered[record.path];
          await this.workspace.persist();
        } catch (e: any) {
          failed.push({ path: record.path, error: e.message });
        }
        await atomicWrite(dir, 'delivery.json', JSON.stringify(delivery, null, 2));
      }
      return { restored, failed };
    });
  }
  async export(destination: string): Promise<string> {
    return this.workspace.withLock(async () => {
      const absolute = path.resolve(destination);
      if (
        inside(this.workspace.root, absolute) ||
        this.workspace.items.some((i) => inside(i.sourcePath, absolute))
      )
        throw new WorkspaceError('EXPORT_TARGET_DENIED', '导出请选择工作区和原材料范围之外的位置。');
      await assertNoLinks(absolute);
      const tree = await this.workspace.tree();
      const files = Object.entries(tree).filter(([, e]) => e.kind === 'file');
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      if (files.length === 1 && path.extname(absolute).toLowerCase() !== '.zip') {
        await this.writeOriginal(absolute, await fs.readFile(path.join(this.workspace.workDir, files[0][0])));
        return absolute;
      }
      if (path.extname(absolute).toLowerCase() !== '.zip')
        throw new WorkspaceError('ZIP_REQUIRED', '多文件结果必须导出为 .zip 文件。');
      const zip = new AdmZip();
      for (const [rel, entry] of Object.entries(tree)) {
        if (entry.kind === 'directory') zip.addFile(rel + '/', Buffer.alloc(0));
        else {
          const content = await fs.readFile(path.join(this.workspace.workDir, rel));
          if (hash(content) !== entry.hash)
            throw new WorkspaceError('EXPORT_CHANGED', '导出时文件发生变化，请重试。');
          zip.addFile(rel, content);
        }
      }
      await this.writeOriginal(absolute, zip.toBuffer());
      return absolute;
    });
  }
}
