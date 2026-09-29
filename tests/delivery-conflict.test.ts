import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { WorkspaceService, type Workspace } from '../src/workspace/workspace-service.js';
import { DeliveryService } from '../src/workspace/delivery-service.js';
let temp: string, source: string, ws: Workspace, delivery: DeliveryService, rel: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xuwu-delivery-'));
  source = path.join(temp, 'input');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'a.txt'), 'before');
  ws = await new WorkspaceService(path.join(temp, 'data')).create('test');
  await ws.importPaths([source]);
  rel = `${ws.items[0].workPath}/a.txt`;
  delivery = new DeliveryService(ws);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(temp, { recursive: true, force: true });
});
async function change(value = 'after') {
  const read = await ws.execute('read', { path: rel });
  await ws.execute('write', { path: rel, content: value, expectedHash: read.hash });
}
function changeOriginalWhileStaging(target: string, content: string): () => boolean {
  const realWrite = fs.writeFile.bind(fs);
  let injected = false;
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    await realWrite(file, data, options);
    if (
      !injected &&
      typeof file === 'string' &&
      path.dirname(file) === source &&
      /^\.xuwu-.+\.tmp$/.test(path.basename(file))
    ) {
      injected = true;
      await realWrite(target, content);
    }
  });
  return () => injected;
}
describe('delivery preview, conflict protection and recovery', { timeout: 30000 }, () => {
  it('requires exact preview of current workspace and protects original until apply', async () => {
    await change();
    const preview = await delivery.preview();
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('before');
    await change('later');
    await expect(delivery.apply(preview.token)).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('before');
  });
  it('detects externally modified originals before and after preview', async () => {
    await change();
    const preview = await delivery.preview();
    await fs.writeFile(path.join(source, 'a.txt'), 'external');
    await expect(delivery.apply(preview.token)).rejects.toMatchObject({ code: 'ORIGINAL_CONFLICT' });
    expect((await delivery.preview()).conflicts).toHaveLength(1);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('external');
  });
  it('applies selected changes, retains unrelated files, and can restore backup', async () => {
    await change();
    const newRel = `${ws.items[0].workPath}/new.txt`;
    await ws.execute('write', { path: newRel, content: 'new' });
    await fs.writeFile(path.join(source, 'unrelated.txt'), 'external addition');
    const preview = await delivery.preview([rel]);
    const result = await delivery.apply(preview.token, [rel]);
    expect(result.applied).toEqual([rel]);
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('after');
    expect(await fs.readFile(path.join(source, 'unrelated.txt'), 'utf8')).toBe('external addition');
    await expect(fs.stat(path.join(source, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    const restored = await delivery.restoreDelivery(result.deliveryId);
    expect(restored.restored).toEqual([rel]);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('before');
  });
  it('uses latest delivery baseline for repeated apply and does not overwrite new outside edits on restore', async () => {
    await change();
    const first = await delivery.apply((await delivery.preview()).token);
    expect((await delivery.preview()).changes).toEqual([]);
    await change('second');
    const second = await delivery.apply((await delivery.preview()).token);
    expect(second.failed).toEqual([]);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('second');
    const oldRestore = await delivery.restoreDelivery(first.deliveryId);
    expect(oldRestore.failed).toHaveLength(1);
    await fs.writeFile(path.join(source, 'a.txt'), 'outside');
    expect((await delivery.restoreDelivery(second.deliveryId)).failed).toHaveLength(1);
  });
  it('reports partial directory deletion without deleting newly added original files', async () => {
    await ws.execute('delete', { path: ws.items[0].workPath });
    await fs.writeFile(path.join(source, 'new-outside.txt'), 'keep');
    const result = await delivery.apply((await delivery.preview()).token);
    expect(result.applied).toContain(rel);
    expect(result.failed.some((f) => f.path === ws.items[0].workPath)).toBe(true);
    expect(await fs.readFile(path.join(source, 'new-outside.txt'), 'utf8')).toBe('keep');
    const restored = await delivery.restoreDelivery(result.deliveryId);
    expect(restored.restored).toContain(rel);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('before');
  });
  it('exports only work contents and rejects unconfirmed original overwrite', async () => {
    await change();
    const destination = path.join(temp, 'result.zip');
    await delivery.export(destination);
    const zip = new AdmZip(destination);
    expect(zip.getEntries().some((e) => e.entryName.includes('manifest.json'))).toBe(false);
    expect(zip.readAsText(rel)).toBe('after');
    await expect(delivery.export(path.join(source, 'a.txt'))).rejects.toMatchObject({
      code: 'EXPORT_TARGET_DENIED',
    });
  });
  it('does not grant single imported file access to its parent directory', async () => {
    const single = await new WorkspaceService(path.join(temp, 'single-data')).create('single');
    await single.importPaths([path.join(source, 'a.txt')]);
    const parent = path.posix.dirname(single.items[0].workPath);
    await single.execute('write', { path: `${parent}/sibling.txt`, content: 'new' });
    const preview = await new DeliveryService(single).preview();
    expect(preview.changes[0].canApply).toBe(false);
    expect(preview.conflicts).toHaveLength(1);
  });
  it('includes required new parent directories when a child file is selected', async () => {
    const file = `${ws.items[0].workPath}/new/inner/result.txt`;
    await ws.execute('write', { path: file, content: 'nested' });
    const preview = await delivery.preview([file]);
    expect(preview.paths).toContain(`${ws.items[0].workPath}/new`);
    expect(preview.paths).toContain(`${ws.items[0].workPath}/new/inner`);
    const result = await delivery.apply(preview.token);
    expect(result.failed).toEqual([]);
    expect(await fs.readFile(path.join(source, 'new', 'inner', 'result.txt'), 'utf8')).toBe('nested');
    expect((await delivery.preview()).conflicts).toEqual([]);
    expect((await delivery.preview()).changes).toEqual([]);
  });
  it('includes contained deletions when a removed directory is selected', async () => {
    await ws.execute('delete', { path: ws.items[0].workPath });
    const preview = await delivery.preview([ws.items[0].workPath]);
    expect(preview.paths).toContain(rel);
    const result = await delivery.apply(preview.token);
    expect(result.failed).toEqual([]);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await delivery.restoreDelivery(result.deliveryId)).failed).toEqual([]);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('before');
  });
  it('rejects a concurrent original edit made while the replacement is staged', async () => {
    await change();
    const preview = await delivery.preview();
    const injected = changeOriginalWhileStaging(path.join(source, 'a.txt'), 'concurrent external edit');
    const result = await delivery.apply(preview.token);
    expect(injected()).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('concurrent external edit');
    expect((await fs.readdir(source)).some((name) => name.startsWith('.xuwu-'))).toBe(false);
  });
  it('rejects a newly created destination appearing while a new file is staged', async () => {
    const newPath = `${ws.items[0].workPath}/new.txt`;
    await ws.execute('write', { path: newPath, content: 'agent content' });
    const preview = await delivery.preview([newPath]);
    const injected = changeOriginalWhileStaging(path.join(source, 'new.txt'), 'external creation');
    const result = await delivery.apply(preview.token);
    expect(injected()).toBe(true);
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(await fs.readFile(path.join(source, 'new.txt'), 'utf8')).toBe('external creation');
  });
  it('refuses backup restore when the delivered file changes during restore staging', async () => {
    await change();
    const applied = await delivery.apply((await delivery.preview()).token);
    const injected = changeOriginalWhileStaging(path.join(source, 'a.txt'), 'concurrent restore edit');
    const result = await delivery.restoreDelivery(applied.deliveryId);
    expect(injected()).toBe(true);
    expect(result.restored).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(await fs.readFile(path.join(source, 'a.txt'), 'utf8')).toBe('concurrent restore edit');
  });
});
