import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppController } from '../src/app/controller.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'xuwu-controller-'));
  roots.push(root);
  const controller = new AppController(root, process.cwd(), () => {});
  controller.current = await controller.workspaces.create('session-a');
  return { root, controller };
}
describe('host ownership and confirmation boundary', () => {
  it('holds exclusivity throughout a pending delivery confirmation, blocking tasks and session mutations', async () => {
    const { controller } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = controller.withDelivery(async () => {
      await gate;
      return 'confirmed';
    });
    try {
      await expect(controller.send('change files')).rejects.toThrow('交付');
      await expect(controller.create()).rejects.toThrow('处理中');
      await expect(controller.select('session-b')).rejects.toThrow('处理中');
      await expect(controller.deleteSession('session-a')).rejects.toThrow('处理中');
      await expect(controller.removeItem('not-present')).rejects.toThrow('处理中');
      await expect(controller.restore('file.txt')).rejects.toThrow('处理中');
    } finally {
      release();
      await held;
      await controller.dispose();
    }
  }, 30000);
  it('removes only this session records even if its run file or another session run file is truncated', async () => {
    const { root, controller } = await fixture();
    await controller.workspaces.create('session-b');
    const runId = '11111111-1111-4111-8111-111111111111';
    for (const dir of [
      'runs',
      'sessions/session-a',
      'traces/session-a',
      'traces/session-b',
      'activity/session-a',
      'activity/session-b',
    ])
      await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'traces/session-a', `${runId}.jsonl`), '{}\n');
    await writeFile(path.join(root, 'runs', `${runId}.json`), '{');
    await writeFile(path.join(root, 'runs', 'session-a.latest.json'), '{');
    await writeFile(path.join(root, 'runs', 'unrelated.json'), '{');
    await writeFile(path.join(root, 'traces/session-b', 'keep.jsonl'), 'keep');
    await writeFile(path.join(root, 'activity/session-a', 'messages.jsonl'), 'remove');
    await writeFile(path.join(root, 'activity/session-b', 'messages.jsonl'), 'keep');
    controller.current = null;
    await controller.deleteSession('session-a');
    expect((await controller.workspaces.list()).map((item) => item.id)).toEqual(['session-b']);
    await expect(readFile(path.join(root, 'runs', `${runId}.json`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(root, 'runs', 'unrelated.json'), 'utf8')).toBe('{');
    expect(await readFile(path.join(root, 'traces/session-b', 'keep.jsonl'), 'utf8')).toBe('keep');
    await expect(readFile(path.join(root, 'activity/session-a', 'messages.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(path.join(root, 'activity/session-b', 'messages.jsonl'), 'utf8')).toBe('keep');
    await controller.dispose();
  }, 30000);
});
