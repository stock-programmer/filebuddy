import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace, Tree } from './workspace-service.js';
import { atomicWrite, equalEntry, exists, formatBytes, hash, scanTree } from './workspace-service.js';
import { integerArgument, readTextPage } from './text-page.js';
import {
  assertPublicPath,
  checkAbort,
  normalizeRelative,
  resolveSafe,
  WorkspaceError,
} from './path-policy.js';

export interface Operation {
  id: string;
  name: string;
  paths: string[];
  before: Tree;
  after: Tree;
  createdAt: string;
  status: 'pending' | 'committed' | 'failed';
  error?: string;
}
function textDecode(
  bytes: Buffer,
  maxBytes: number,
): { content: string; bom: boolean; newline: string; ending: boolean } {
  if (bytes.length > maxBytes)
    throw new WorkspaceError('TEXT_TOO_LARGE', `文本超过 ${formatBytes(maxBytes)} 处理限制。`);
  if (bytes.includes(0)) throw new WorkspaceError('BINARY_FILE', '该文件是二进制或不支持的编码。');
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceError('UNSUPPORTED_ENCODING', '首版仅支持 UTF-8 文本。');
  }
  return {
    content,
    bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
    newline: content.includes('\r\n') ? '\r\n' : '\n',
    ending: /\r?\n$/.test(content),
  };
}
function textEncode(content: string, maxBytes: number, prior?: ReturnType<typeof textDecode>): Buffer {
  if (typeof content !== 'string') throw new WorkspaceError('INVALID_ARGUMENT', 'content 必须是字符串。');
  content = content.replace(/^\uFEFF/, '');
  if (prior) {
    content = content.replace(/\r\n|\r|\n/g, prior.newline);
    if (prior.ending && !content.endsWith(prior.newline)) content += prior.newline;
    if (!prior.ending) content = content.replace(/(?:\r?\n)+$/, '');
  }
  const bytes = Buffer.from((prior?.bom ? '\uFEFF' : '') + content, 'utf8');
  if (bytes.length > maxBytes)
    throw new WorkspaceError('TEXT_TOO_LARGE', `写入超过 ${formatBytes(maxBytes)} 文本限制。`);
  if (bytes.includes(0)) throw new WorkspaceError('BINARY_FILE', '禁止写入二进制内容。');
  return bytes;
}
export class FileService {
  constructor(readonly workspace: Workspace) {}
  private async target(relative: string, allowRoot = false): Promise<string> {
    const clean = normalizeRelative(relative, allowRoot);
    if (relative.length > this.workspace.config.tools.maxPathCharacters)
      throw new WorkspaceError(
        'INVALID_ARGUMENT',
        `path 最多 ${this.workspace.config.tools.maxPathCharacters} 个字符。`,
      );
    assertPublicPath(clean);
    return resolveSafe(this.workspace.workDir, clean, allowRoot);
  }
  private async text(relative: string): Promise<{
    bytes: Buffer;
    content: string;
    bom: boolean;
    newline: string;
    ending: boolean;
    hash: string;
  }> {
    const bytes = await fs.readFile(await this.target(relative));
    return { bytes, ...textDecode(bytes, this.workspace.config.text.maxFileBytes), hash: hash(bytes) };
  }
  private async scopedTree(paths: string[]): Promise<Tree> {
    const all: Tree = {};
    for (const p of paths) Object.assign(all, await scanTree(this.workspace.workDir, p));
    return all;
  }
  private async mutate(
    name: string,
    paths: string[],
    action: () => Promise<any>,
    signal?: AbortSignal,
  ): Promise<any> {
    checkAbort(signal);
    // Include automatically created parents so undo also removes directories introduced by this operation.
    const scopes: string[] = [];
    for (const rel of paths) {
      const segments = rel.split('/');
      let scope = rel;
      for (let n = 1; n < segments.length; n++) {
        const parent = segments.slice(0, n).join('/');
        if (!(await exists(await this.target(parent)))) {
          scope = parent;
          break;
        }
      }
      if (!scopes.some((p) => scope === p || scope.startsWith(p + '/'))) scopes.push(scope);
    }
    paths = scopes.filter((p) => !scopes.some((other) => other !== p && p.startsWith(other + '/')));
    const id = randomUUID();
    const opDir = path.join(this.workspace.root, 'trash', id);
    await fs.mkdir(path.join(opDir, 'before'), { recursive: true });
    const before = await this.scopedTree(paths);
    const operation: Operation = {
      id,
      name,
      paths,
      before,
      after: {},
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    for (const [rel, entry] of Object.entries(before)) {
      checkAbort(signal);
      const dest = path.join(opDir, 'before', rel);
      if (entry.kind === 'directory') await fs.mkdir(dest, { recursive: true });
      else {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.copyFile(await this.target(rel), dest);
      }
    }
    await atomicWrite(opDir, 'operation.json', JSON.stringify(operation));
    let result: any;
    try {
      checkAbort(signal);
      result = await action();
      operation.status = 'committed';
    } catch (e: any) {
      operation.status = 'failed';
      operation.error = e.message;
      throw e;
    } finally {
      operation.after = await this.scopedTree(paths);
      await atomicWrite(opDir, 'operation.json', JSON.stringify(operation));
      await fs.appendFile(
        path.join(this.workspace.root, 'operations.jsonl'),
        JSON.stringify(operation) + '\n',
      );
      await this.workspace.persist();
    }
    return { ...result, operationId: id };
  }
  async execute(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<any> {
    checkAbort(signal);
    const config = this.workspace.config;
    if (name === 'list') {
      const prefix = normalizeRelative(args.path ?? '', true);
      await this.target(prefix, true);
      const tree = await scanTree(this.workspace.workDir, prefix);
      const depth = integerArgument(args.depth, config.list.defaultDepth, 1, config.list.maxDepth, 'depth');
      const baseDepth = prefix ? prefix.split('/').length : 0;
      const entries = Object.entries(tree)
        .filter(([p]) => p !== prefix && p.split('/').length - baseDepth <= depth)
        .map(([p, e]) => ({ path: p, ...e }));
      const offset = integerArgument(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
        limit = integerArgument(args.limit, config.paging.defaultLimit, 1, config.paging.maxLimit, 'limit');
      return {
        entries: entries.slice(offset, offset + limit),
        total: entries.length,
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    }
    if (name === 'read') {
      const file = await this.text(args.path);
      return {
        path: args.path,
        hash: file.hash,
        ...readTextPage(file.content, args, config.read),
      };
    }
    if (name === 'search') {
      if (typeof args.query !== 'string' || !args.query)
        throw new WorkspaceError('INVALID_ARGUMENT', 'search 需要非空 query。');
      if (args.query.length > config.search.maxQueryCharacters)
        throw new WorkspaceError(
          'INVALID_ARGUMENT',
          `query 最多 ${config.search.maxQueryCharacters} 个字符。`,
        );
      const prefix = normalizeRelative(args.path ?? '', true);
      await this.target(prefix, true);
      const tree = await scanTree(this.workspace.workDir, prefix);
      const offset = integerArgument(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
        limit = integerArgument(args.limit, config.paging.defaultLimit, 1, config.paging.maxLimit, 'limit');
      const matches: any[] = [];
      let found = 0;
      let truncated = false;
      outer: for (const [rel, entry] of Object.entries(tree)) {
        checkAbort(signal);
        if (entry.kind !== 'file') continue;
        let content: string;
        try {
          content = (await this.text(rel)).content;
        } catch (e: any) {
          if (['BINARY_FILE', 'UNSUPPORTED_ENCODING', 'TEXT_TOO_LARGE', 'SENSITIVE_PATH'].includes(e.code))
            continue;
          throw e;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++)
          if (lines[i].includes(args.query)) {
            if (found++ >= offset)
              matches.push({
                path: rel,
                line: i + 1,
                text: lines[i].slice(0, config.search.previewCharacters),
              });
            if (matches.length >= limit) {
              truncated = true;
              break outer;
            }
          }
      }
      return { matches, nextOffset: truncated ? offset + matches.length : null };
    }
    if (name === 'changes') {
      const all = await this.workspace.changes();
      const offset = integerArgument(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
        limit = integerArgument(args.limit, config.paging.defaultLimit, 1, config.paging.maxLimit, 'limit');
      return {
        changes: all.slice(offset, offset + limit).map(({ originalPath, ...change }) => change),
        total: all.length,
        nextOffset: offset + limit < all.length ? offset + limit : null,
      };
    }
    if (name === 'restore') return this.restore(args, signal);
    const rel = normalizeRelative(args.path);
    const absolute = await this.target(rel);
    if (name === 'write' || name === 'edit') {
      const present = await exists(absolute);
      const prior = present ? await this.text(rel) : undefined;
      if (present && (!args.expectedHash || args.expectedHash !== prior?.hash))
        throw new WorkspaceError('STALE_FILE', '替换现有文件前必须提供 read 返回的最新 expectedHash。');
      if (!present && args.expectedHash)
        throw new WorkspaceError('STALE_FILE', '文件已不存在，预期版本不匹配。');
      let content = args.content;
      if (name === 'write' && typeof content === 'string' && content.length > config.tools.maxWriteCharacters)
        throw new WorkspaceError(
          'INVALID_ARGUMENT',
          `content 最多 ${config.tools.maxWriteCharacters} 个字符。`,
        );
      if (name === 'edit') {
        if (!prior) throw new WorkspaceError('NOT_FOUND', '要修改的文件不存在。');
        if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string')
          throw new WorkspaceError('INVALID_ARGUMENT', 'edit 需要非空 oldText 和 newText 字符串。');
        if (
          args.oldText.length > config.tools.maxEditCharacters ||
          args.newText.length > config.tools.maxEditCharacters
        )
          throw new WorkspaceError(
            'INVALID_ARGUMENT',
            `edit 文本最多 ${config.tools.maxEditCharacters} 个字符。`,
          );
        const old = args.oldText.replace(/\r\n|\r|\n/g, prior.newline);
        const matches = prior.content.split(old).length - 1;
        if (matches !== 1)
          throw new WorkspaceError('AMBIGUOUS_EDIT', `oldText 必须恰好匹配一次，实际 ${matches} 次。`);
        content = prior.content.replace(old, () => args.newText);
      }
      const bytes = textEncode(content, config.text.maxFileBytes, prior);
      return this.mutate(
        name,
        [rel],
        async () => {
          checkAbort(signal);
          if (prior && hash(await fs.readFile(await this.target(rel))) !== prior.hash)
            throw new WorkspaceError('STALE_FILE', '提交前文件已变化。');
          await atomicWrite(this.workspace.workDir, rel, bytes, signal);
          return { path: rel, hash: hash(bytes), bytes: bytes.length };
        },
        signal,
      );
    }
    if (name === 'mkdir') {
      if (await exists(absolute)) throw new WorkspaceError('ALREADY_EXISTS', '目标已存在。');
      return this.mutate(
        name,
        [rel],
        async () => {
          checkAbort(signal);
          await fs.mkdir(await this.target(rel), { recursive: true });
          return { path: rel };
        },
        signal,
      );
    }
    if (name === 'copy' || name === 'move') {
      const destination = normalizeRelative(args.destination);
      await this.target(destination);
      if (destination === rel || destination.startsWith(rel + '/'))
        throw new WorkspaceError('INVALID_ARGUMENT', '不能复制或移动到自身或子目录。');
      if (!(await exists(absolute))) throw new WorkspaceError('NOT_FOUND', '源文件不存在。');
      if (await exists(path.join(this.workspace.workDir, destination)))
        throw new WorkspaceError('ALREADY_EXISTS', '目标已存在，禁止覆盖。');
      await scanTree(this.workspace.workDir, rel);
      return this.mutate(
        name,
        name === 'move' ? [rel, destination] : [destination],
        async () => {
          checkAbort(signal);
          const dest = await this.target(destination);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await this.target(destination);
          if (name === 'move') {
            checkAbort(signal);
            await fs.rename(await this.target(rel), dest);
          } else {
            await fs.cp(await this.target(rel), dest, {
              recursive: true,
              errorOnExist: true,
              force: false,
              filter: async (src) => {
                checkAbort(signal);
                await resolveSafe(this.workspace.workDir, path.relative(this.workspace.workDir, src));
                return true;
              },
            });
          }
          return { path: rel, destination };
        },
        signal,
      );
    }
    if (name === 'delete') {
      if (this.workspace.items.some((i) => rel === i.id))
        throw new WorkspaceError('PATH_DENIED', '不能删除材料容器。');
      if (!(await exists(absolute))) throw new WorkspaceError('NOT_FOUND', '要删除的路径不存在。');
      return this.mutate(
        name,
        [rel],
        async () => {
          checkAbort(signal);
          await fs.rm(await this.target(rel), { recursive: true });
          return { path: rel, recoverable: true };
        },
        signal,
      );
    }
    throw new WorkspaceError('UNKNOWN_TOOL', `不支持工具：${name}`);
  }
  private async restore(args: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (args.operationId) {
      if (!/^[a-f0-9-]{36}$/.test(args.operationId))
        throw new WorkspaceError('INVALID_ARGUMENT', '操作 ID 无效。');
      const opRoot = path.join(this.workspace.root, 'trash', args.operationId);
      const op = JSON.parse(await fs.readFile(path.join(opRoot, 'operation.json'), 'utf8')) as Operation;
      const current = await this.scopedTree(op.paths);
      const keys = new Set([...Object.keys(current), ...Object.keys(op.after)]);
      if ([...keys].some((p) => !equalEntry(current[p], op.after[p])))
        throw new WorkspaceError('RESTORE_CONFLICT', '操作之后已发生其他修改，不能覆盖后续工作。');
      return this.mutate(
        'restore',
        op.paths,
        async () => {
          for (const rel of [...op.paths].sort((a, b) => b.length - a.length)) {
            checkAbort(signal);
            await fs.rm(await this.target(rel), { recursive: true, force: true });
          }
          for (const [rel, entry] of Object.entries(op.before).sort(([a], [b]) => a.length - b.length)) {
            checkAbort(signal);
            if (entry.kind === 'directory') await fs.mkdir(await this.target(rel), { recursive: true });
            else
              await atomicWrite(
                this.workspace.workDir,
                rel,
                await fs.readFile(await resolveSafe(path.join(opRoot, 'before'), rel)),
                signal,
              );
          }
          return { restoredOperationId: op.id };
        },
        signal,
      );
    }
    const rel = normalizeRelative(args.path);
    const base = await resolveSafe(this.workspace.baseDir, rel);
    const target = await this.target(rel);
    if (!(await exists(base))) {
      if (!(await exists(target)) || !(await fs.stat(target)).isFile())
        throw new WorkspaceError('NOT_FOUND', '找不到可恢复的文件；目录请按 operationId 撤销。');
      const current = hash(await fs.readFile(target));
      if (args.expectedHash !== current)
        throw new WorkspaceError('STALE_FILE', '移除新增文件前必须提供当前文件的 expectedHash。');
      return this.mutate(
        'restore',
        [rel],
        async () => {
          checkAbort(signal);
          if (hash(await fs.readFile(await this.target(rel))) !== current)
            throw new WorkspaceError('STALE_FILE', '提交前新增文件已变化，未移除。');
          await fs.unlink(await this.target(rel));
          return { path: rel, removed: true };
        },
        signal,
      );
    }
    if (!(await fs.stat(base)).isFile())
      throw new WorkspaceError('NOT_FOUND', '仅支持恢复基线中的单个文件，目录请按 operationId 撤销。');
    if (await exists(target)) {
      const current = hash(await fs.readFile(target));
      if (args.expectedHash !== current)
        throw new WorkspaceError('STALE_FILE', '恢复前必须提供当前文件的 expectedHash。');
    }
    const bytes = await fs.readFile(base);
    return this.mutate(
      'restore',
      [rel],
      async () => {
        await atomicWrite(this.workspace.workDir, rel, bytes, signal);
        return { path: rel, hash: hash(bytes) };
      },
      signal,
    );
  }
}
