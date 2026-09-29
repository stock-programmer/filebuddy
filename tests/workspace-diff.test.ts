import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hash, WorkspaceService, type Workspace } from '../src/workspace/workspace-service.js';

let temp: string, source: string, ws: Workspace;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xuwu-diff-'));
  source = path.join(temp, 'materials');
  await fs.mkdir(source);
  ws = await new WorkspaceService(path.join(temp, 'data')).create('test');
});
afterEach(async () => {
  const target = path.resolve(temp);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('xuwu-diff-'))
    throw new Error('Unexpected temporary directory');
  await fs.rm(target, { recursive: true, force: true });
});

async function imported(content: string | Buffer, name = 'notes.txt'): Promise<string> {
  await fs.writeFile(path.join(source, name), content);
  await ws.importPaths([source]);
  return `${ws.items[0].workPath}/${name}`;
}

describe('workspace file diff', () => {
  it('returns real text edits and the working-copy hash without changing the original', async () => {
    const rel = await imported('first\nold\nlast\n');
    const updated = 'first\nnew\nlast\n';
    await fs.writeFile(path.join(ws.workDir, rel), updated);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before: 'first\nold\nlast\n',
      after: updated,
      beforeState: 'text',
      afterState: 'text',
      expectedHash: hash(updated),
    });
    expect(result.patch).toContain('-old\n+new\n');
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe('first\nold\nlast\n');
  });

  it.each(['', 'new file\n'])('distinguishes an added file from a missing file: %j', async (content) => {
    const rel = 'added.txt';
    await fs.writeFile(path.join(ws.workDir, rel), content);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before: '',
      after: content,
      beforeState: 'missing',
      afterState: 'text',
      expectedHash: hash(content),
    });
    if (content) expect(result.patch).toContain('+new file');
    else expect(result.patch).not.toContain('@@');
  });

  it.each(['', 'deleted file\n'])('distinguishes a deleted file from an empty file: %j', async (content) => {
    const rel = await imported(content);
    await fs.unlink(path.join(ws.workDir, rel));
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before: content,
      after: '',
      beforeState: 'text',
      afterState: 'missing',
    });
    expect(result.expectedHash).toBeUndefined();
    if (content) expect(result.patch).toContain('-deleted file');
    else expect(result.patch).not.toContain('@@');
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe(content);
  });

  it.each([
    [Buffer.from([65, 0, 66]), Buffer.from([65, 0, 67])],
    [Buffer.from([0xff, 0x41]), Buffer.from([0xff, 0x42])],
  ])('does not manufacture a text diff for binary files', async (before, after) => {
    const rel = await imported(before, 'binary.dat');
    await fs.writeFile(path.join(ws.workDir, rel), after);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before: '',
      after: '',
      patch: '',
      beforeState: 'unavailable',
      afterState: 'unavailable',
      expectedHash: hash(after),
    });
    expect(result.notice).toContain('二进制或非 UTF-8');
    expect(await fs.readFile(path.join(source, 'binary.dat'))).toEqual(before);
  });

  it('does not compare display placeholders when both files exceed the size limit', async () => {
    const before = Buffer.alloc(4 * 1024 * 1024 + 1, 'a');
    const after = Buffer.alloc(before.length, 'b');
    const rel = await imported(before, 'large.txt');
    await fs.writeFile(path.join(ws.workDir, rel), after);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before: '',
      after: '',
      patch: '',
      beforeState: 'unavailable',
      afterState: 'unavailable',
      expectedHash: hash(after),
    });
    expect(result.notice).toContain('4 MiB');
    expect(hash(await fs.readFile(path.join(source, 'large.txt')))).toBe(hash(before));
  });

  it('reports directories explicitly instead of treating them as empty files', async () => {
    await ws.importPaths([source]);
    const result = await ws.diff(ws.items[0].workPath);
    expect(result).toMatchObject({ beforeState: 'unavailable', afterState: 'unavailable', patch: '' });
    expect(result.notice).toContain('目录');
  });

  it('exposes BOM and newline changes while preserving the original bytes', async () => {
    const original = Buffer.from('\uFEFFfirst\r\nlast\r\n');
    const rel = await imported(original);
    await fs.writeFile(path.join(ws.workDir, rel), 'first\nlast\n');
    const result = await ws.diff(rel);
    expect(result.beforeFormat).toBe('UTF-8 BOM · CRLF');
    expect(result.afterFormat).toBe('UTF-8 · LF');
    expect(result.before).toBe('first\r\nlast\r\n');
    expect(result.after).toBe('first\nlast\n');
    expect(result.patch).toContain('@@');
    expect(await fs.readFile(path.join(source, 'notes.txt'))).toEqual(original);
    expect(await fs.readFile(path.join(ws.baseDir, rel))).toEqual(original);
  });

  it('reports a BOM-only change even when the decoded text is identical', async () => {
    const rel = await imported('\uFEFFsame\n');
    await fs.writeFile(path.join(ws.workDir, rel), 'same\n');
    const result = await ws.diff(rel);
    expect(result.before).toBe(result.after);
    expect(result.beforeFormat).toBe('UTF-8 BOM · LF');
    expect(result.afterFormat).toBe('UTF-8 · LF');
    expect(result.notice).toContain('文件格式有变化');
  });

  it('does not manufacture line changes for CR-only line endings', async () => {
    const before = 'first\rsecond\r';
    const after = 'first\nchanged\n';
    const rel = await imported(before);
    await fs.writeFile(path.join(ws.workDir, rel), after);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({
      before,
      after,
      beforeState: 'text',
      afterState: 'text',
      beforeFormat: 'UTF-8 · CR',
      patch: '',
      expectedHash: hash(after),
    });
    expect(result.notice).toContain('文件含 CR 换行');
    expect(await fs.readFile(path.join(source, 'notes.txt'), 'utf8')).toBe(before);
  });

  it('retains complete text but omits the patch beyond the total line limit', async () => {
    const before = 'line\n'.repeat(25000);
    const after = before + 'extra\n';
    const rel = await imported(before);
    await fs.writeFile(path.join(ws.workDir, rel), after);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({ before, after, patch: '', expectedHash: hash(after) });
    expect(result.notice).toContain('50,000');
  });

  it('returns a clear notice when computing a large replacement exceeds its budget', async () => {
    const before = Array.from({ length: 11000 }, (_, i) => `old ${i}\n`).join('');
    const after = Array.from({ length: 11000 }, (_, i) => `new ${i}\n`).join('');
    const rel = await imported(before);
    await fs.writeFile(path.join(ws.workDir, rel), after);
    const result = await ws.diff(rel);
    expect(result).toMatchObject({ before, after, patch: '', expectedHash: hash(after) });
    expect(result.notice).toContain('差异计算超过');
  }, 10000);
});
