import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService, type Workspace } from '../src/workspace/workspace-service.js';

let temp: string, source: string, ws: Workspace;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xuwu-workspace-'));
  source = path.join(temp, 'materials');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'notes.txt'), 'first\r\nsecond\r\n');
  ws = await new WorkspaceService(path.join(temp, 'data')).create('test');
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});
describe('workspace authorization and reversible text operations', { timeout: 30000 }, () => {
  it('imports overlapping inputs once and keeps original independent', async () => {
    const result = await ws.importPaths([path.join(source, 'notes.txt'), source, source]);
    expect(result.items).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('合并'))).toBe(true);
    const p = `${ws.items[0].workPath}/notes.txt`;
    const read = await ws.execute('read', { path: p });
    await ws.execute('edit', { path: p, oldText: 'first', newText: 'changed', expectedHash: read.hash });
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
    expect((await ws.execute('read', { path: p })).content).toBe('changed\r\nsecond\r\n');
  });
  it('preserves two roots with the same name and skips sensitive input', async () => {
    const other = path.join(temp, 'other', 'materials');
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, 'two.txt'), 'second');
    await fs.writeFile(path.join(source, '.env'), 'API_KEY=secret');
    await ws.importPaths([source, other]);
    expect(ws.items).toHaveLength(2);
    expect(ws.items[0].workPath).not.toBe(ws.items[1].workPath);
    expect(ws.items.flatMap((i) => i.warnings).some((w) => w.includes('.env'))).toBe(true);
    expect(Object.keys(await ws.tree()).some((p) => p.endsWith('.env'))).toBe(false);
  });
  it.each([
    '../outside.txt',
    'C:\\secret',
    'C:secret',
    '\\\\server\\share',
    '/etc/passwd',
    'notes.txt:ads',
    'con.txt',
    'foo.',
  ])('rejects unsafe path %s', async (p) => {
    await expect(ws.execute('write', { path: p, content: 'bad' })).rejects.toMatchObject({
      code: 'PATH_DENIED',
    });
  });
  it('blocks sensitive new files and stale hashes', async () => {
    await ws.importPaths([source]);
    const p = `${ws.items[0].workPath}/notes.txt`;
    await expect(ws.execute('write', { path: p, content: 'bad' })).rejects.toMatchObject({
      code: 'STALE_FILE',
    });
    await expect(ws.execute('write', { path: 'new/.env', content: 'bad' })).rejects.toMatchObject({
      code: 'SENSITIVE_PATH',
    });
  });
  it('preserves BOM and CRLF and rejects binary reading', async () => {
    await fs.writeFile(path.join(source, 'bom.txt'), Buffer.from('\uFEFFhello\r\nworld\r\n'));
    await fs.writeFile(path.join(source, 'opaque.dat'), Buffer.from([0, 255, 3]));
    await ws.importPaths([source]);
    const p = `${ws.items[0].workPath}/bom.txt`;
    const read = await ws.execute('read', { path: p });
    await ws.execute('write', { path: p, content: 'new\ntext', expectedHash: read.hash });
    expect(await fs.readFile(path.join(ws.workDir, p), 'utf8')).toBe('\uFEFFnew\r\ntext\r\n');
    await expect(ws.execute('read', { path: `${ws.items[0].workPath}/opaque.dat` })).rejects.toMatchObject({
      code: 'BINARY_FILE',
    });
  });
  it('supports CRUD, search, list and undo without overwriting subsequent edits', async () => {
    await ws.importPaths([source]);
    const root = ws.items[0].workPath;
    await ws.execute('mkdir', { path: `${root}/out` });
    await ws.execute('write', { path: `${root}/out/new.txt`, content: 'needle' });
    await ws.execute('copy', { path: `${root}/out/new.txt`, destination: `${root}/copy.txt` });
    await ws.execute('move', { path: `${root}/copy.txt`, destination: `${root}/renamed.txt` });
    expect((await ws.execute('search', { path: root, query: 'needle' })).matches).toHaveLength(2);
    expect((await ws.execute('list', { path: root })).entries.length).toBe(3);
    const removed = await ws.execute('delete', { path: `${root}/renamed.txt` });
    await ws.execute('restore', { operationId: removed.operationId });
    const copy = await ws.execute('read', { path: `${root}/renamed.txt` });
    const edited = await ws.execute('edit', {
      path: `${root}/renamed.txt`,
      oldText: 'needle',
      newText: 'next',
      expectedHash: copy.hash,
    });
    await ws.execute('write', { path: `${root}/renamed.txt`, content: 'later', expectedHash: edited.hash });
    await expect(ws.execute('restore', { operationId: edited.operationId })).rejects.toMatchObject({
      code: 'RESTORE_CONFLICT',
    });
    expect((await ws.changes()).some((c) => c.kind === 'added')).toBe(true);
  });
  it('rejects links during both import and later tool access', async () => {
    const outside = path.join(temp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    const link = path.join(source, 'escape');
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const imported = await ws.importPaths([source]);
    expect(imported.warnings.some((w) => w.includes('链接'))).toBe(true);
    const injected = path.join(ws.workDir, 'injected');
    await fs.symlink(outside, injected, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(ws.execute('read', { path: 'injected/secret.txt' })).rejects.toMatchObject({
      code: 'LINK_DENIED',
    });
    await fs.unlink(injected);
  });
  it('serializes writes and refuses already-cancelled operations before commit', async () => {
    await ws.importPaths([source]);
    const p = `${ws.items[0].workPath}/notes.txt`;
    const read = await ws.execute('read', { path: p });
    const results = await Promise.allSettled([
      ws.execute('write', { path: p, content: 'one', expectedHash: read.hash }),
      ws.execute('write', { path: p, content: 'two', expectedHash: read.hash }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const signal = AbortSignal.abort();
    await expect(
      ws.execute('write', { path: 'cancelled.txt', content: 'bad' }, signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await ws.tree())['cancelled.txt']).toBeUndefined();
  });
  it('restores persisted session and file state', async () => {
    await ws.importPaths([source]);
    const reopened = await new WorkspaceService(path.join(temp, 'data')).open('test');
    expect(reopened.items).toEqual(ws.items);
    expect(
      (await reopened.execute('read', { path: `${reopened.items[0].workPath}/notes.txt` })).content,
    ).toContain('first');
  });
  it('undo removes new implicit directories and read pages long Unicode lines without splitting characters', async () => {
    const created = await ws.execute('write', { path: 'new/deep/long.txt', content: '中文'.repeat(3000) });
    const first = await ws.execute('read', { path: 'new/deep/long.txt' });
    expect(first.truncated).toBe(true);
    expect(first.content).not.toContain('\uFFFD');
    const second = await ws.execute('read', { path: 'new/deep/long.txt', ...first.nextPosition });
    expect(first.content + second.content).toBe('中文'.repeat(3000));
    await ws.execute('restore', { operationId: created.operationId });
    expect(await ws.tree()).toEqual({});
  });
  it('removing an input and deleting a session preserve originals and other sessions', async () => {
    const service = new WorkspaceService(path.join(temp, 'data'));
    const other = await service.create('other');
    await ws.importPaths([source]);
    await other.importPaths([source]);
    const otherFile = `${other.items[0].workPath}/notes.txt`;
    const otherBefore = await other.execute('read', { path: otherFile });
    await ws.removeItem(ws.items[0].id);
    expect(ws.items).toEqual([]);
    expect((await other.execute('read', { path: otherFile })).hash).toBe(otherBefore.hash);
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
    await expect(service.delete('../other')).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await service.delete(ws.id);
    expect((await service.list()).map((s) => s.id)).toEqual(['other']);
    expect((await (await service.open('other')).execute('read', { path: otherFile })).hash).toBe(
      otherBefore.hash,
    );
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
  });
  it('restores an added file to absence with a current hash and supports undo of that removal', async () => {
    await ws.importPaths([source]);
    const file = `${ws.items[0].workPath}/added.txt`;
    await ws.execute('write', { path: file, content: 'first version' });
    const viewed = await ws.diff(file);
    expect(viewed.expectedHash).toBeTruthy();
    await expect(ws.execute('restore', { path: file })).rejects.toMatchObject({ code: 'STALE_FILE' });
    const updated = await ws.execute('write', {
      path: file,
      content: 'second version',
      expectedHash: viewed.expectedHash,
    });
    await expect(
      ws.execute('restore', { path: file, expectedHash: viewed.expectedHash }),
    ).rejects.toMatchObject({ code: 'STALE_FILE' });
    expect((await ws.execute('read', { path: file })).content).toBe('second version');
    const removed = await ws.execute('restore', { path: file, expectedHash: updated.hash });
    expect(removed.removed).toBe(true);
    expect((await ws.changes()).find((c) => c.path === file)).toBeUndefined();
    await ws.execute('restore', { operationId: removed.operationId });
    expect((await ws.execute('read', { path: file })).content).toBe('second version');
    await expect(fs.stat(path.join(source, 'added.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
