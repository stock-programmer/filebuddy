import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRunLimits, resolveConfig, type ConfigOverrides } from '../src/config.js';
import { WorkspaceService } from '../src/workspace/workspace-service.js';
import { TrustedResources } from '../src/agent/resources.js';
import { createTools } from '../src/tools/tools.js';
import { RunPolicy } from '../src/agent/run-policy.js';
import { TraceWriter } from '../src/observability/trace.js';

let temp: string;
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'xuwu-config-workspace-'));
});
afterEach(async () => {
  const target = path.resolve(temp);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('xuwu-config-workspace-')
  )
    throw new Error('Unexpected temporary directory');
  await fs.rm(target, { recursive: true, force: true });
});
async function workspace(overrides: ConfigOverrides = {}) {
  const config = resolveConfig(overrides);
  const service = new WorkspaceService(path.join(temp, 'data'), config.workspace);
  const ws = await service.create('test');
  return { config, service, ws };
}

describe('workspace effective configuration', () => {
  it.each([
    [{ maxFileBytes: 2, maxTotalBytes: 12, maxFiles: 3 }, 0, '单文件 2 字节'],
    [{ maxFileBytes: 4, maxTotalBytes: 6, maxFiles: 3 }, 1, '总计 6 字节'],
    [{ maxFileBytes: 4, maxTotalBytes: 12, maxFiles: 1 }, 1, '1 文件'],
  ] as const)(
    'uses changed import limits and their real values in warnings: %j',
    async (limits, count, message) => {
      const { ws } = await workspace({ workspace: { import: limits } });
      const source = path.join(temp, 'materials');
      await fs.mkdir(source);
      await Promise.all(
        ['a', 'b', 'c'].map((name) => fs.writeFile(path.join(source, `${name}.txt`), '1234')),
      );
      const result = await ws.importPaths([source]);
      expect(ws.items[0].fileCount).toBe(count);
      expect(result.warnings.join('\n')).toContain(message);
      expect((await fs.readdir(source)).length).toBe(3);
    },
  );

  it('keeps write characters separate from final UTF-8 bytes', async () => {
    const { ws } = await workspace({
      workspace: { text: { maxFileBytes: 8 }, tools: { maxWriteCharacters: 4 } },
    });
    await ws.execute('write', { path: 'ok.txt', content: '中文' });
    expect(await fs.readFile(path.join(ws.workDir, 'ok.txt'), 'utf8')).toBe('中文');
    await expect(ws.execute('write', { path: 'bytes.txt', content: '中文字' })).rejects.toThrow('8 字节');
    await expect(ws.execute('write', { path: 'characters.txt', content: '12345' })).rejects.toThrow(
      '4 个字符',
    );
    await fs.writeFile(path.join(ws.workDir, 'large.txt'), '123456789');
    await expect(ws.execute('read', { path: 'large.txt' })).rejects.toThrow('8 字节');
  });

  it('uses one paging rule for schema, defaults and execution, including reopened workspaces', async () => {
    const { config, service, ws } = await workspace({
      workspace: {
        paging: { defaultLimit: 1, maxLimit: 2 },
        list: { defaultDepth: 1, maxDepth: 3 },
        search: { maxQueryCharacters: 3, previewCharacters: 5 },
        read: { defaultLines: 1, maxLines: 2 },
      },
    });
    await Promise.all(
      ['a', 'b', 'c'].map((name) => fs.writeFile(path.join(ws.workDir, `${name}.txt`), 'abcdef\nsecond')),
    );
    const reopened = await service.open(ws.id);
    expect((await reopened.execute('list', {})).entries).toHaveLength(1);
    expect((await reopened.execute('list', { limit: 2 })).entries).toHaveLength(2);
    expect((await reopened.execute('changes', {})).changes).toHaveLength(1);
    expect((await reopened.execute('search', { query: 'a' })).matches).toEqual([
      { path: 'a.txt', line: 1, text: 'abcde' },
    ]);
    expect((await reopened.execute('read', { path: 'a.txt' })).content).toBe('abcdef');
    for (const name of ['list', 'changes', 'search'])
      await expect(reopened.execute(name, { limit: 3, query: 'a' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    await expect(reopened.execute('search', { query: 'abcd' })).rejects.toThrow('3 个字符');
    await expect(reopened.execute('read', { path: 'a.txt', maxLines: 3 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    const tools = createTools(reopened, new TrustedResources(temp, config.workspace), () => undefined);
    const schema = (name: string) => tools.find((tool) => tool.name === name)!.parameters as any;
    expect(schema('list').properties.limit.maximum).toBe(2);
    expect(schema('list').properties.depth.maximum).toBe(3);
    expect(schema('read').properties.maxLines.maximum).toBe(2);
    expect(schema('search').properties.query.maxLength).toBe(3);
  });

  it('pages workspace and trusted skill long lines with the changed byte budget and no lost characters', async () => {
    const { config, ws } = await workspace({
      workspace: { read: { maxContentBytes: 10 }, skills: { maxFileBytes: 100 } },
    });
    const content = '中😀'.repeat(7);
    await ws.execute('write', { path: 'unicode.txt', content });
    await fs.mkdir(path.join(temp, 'instructions'));
    await fs.writeFile(path.join(temp, 'instructions', 'system.md'), 'System instructions.');
    const skillRoot = path.join(temp, 'skills', 'paging');
    await fs.mkdir(skillRoot, { recursive: true });
    await fs.writeFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: paging\ndescription: Read test resources.\n---\nRead on demand.',
    );
    const resource = path.join(skillRoot, 'reference.txt');
    await fs.writeFile(resource, content);
    const resources = new TrustedResources(temp, config.workspace);
    await resources.reload();
    for (const kind of ['workspace', 'skill']) {
      let position = { startLine: 1, startColumn: 0 };
      let rebuilt = '';
      let pages = 0;
      for (;;) {
        const page: any =
          kind === 'workspace'
            ? await ws.execute('read', { path: 'unicode.txt', ...position })
            : await resources.readSkill(
                resource,
                position.startLine,
                config.workspace.read.defaultLines,
                undefined,
                undefined,
                position.startColumn,
              );
        expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(10);
        expect(page.content).not.toContain('\uFFFD');
        rebuilt += page.content;
        if (!page.nextPosition) break;
        expect(++pages).toBeLessThan(20);
        position = page.nextPosition;
      }
      expect(rebuilt).toBe(content);
    }
    await fs.writeFile(resource, 'x'.repeat(101));
    await expect(resources.readSkill(resource, 1, 1)).rejects.toThrow('100 字节');
  });

  it('changes diff limits independently from editable text limits and formats their notices', async () => {
    const { ws } = await workspace({
      workspace: { text: { maxFileBytes: 32 }, diff: { maxFileBytes: 8, maxTotalLines: 2 } },
    });
    await ws.execute('write', { path: 'large.txt', content: '123456789' });
    const large = await ws.diff('large.txt');
    expect(large.afterState).toBe('unavailable');
    expect(large.notice).toContain('8 字节');
    await ws.execute('write', { path: 'lines.txt', content: 'a\nb\nc\n' });
    const lines = await ws.diff('lines.txt');
    expect(lines.afterState).toBe('text');
    expect(lines.patch).toBe('');
    expect(lines.notice).toContain('超过 2 行');
  });

  it('measures the final escaped JSON result against the effective tool byte budget', async () => {
    const { config, ws } = await workspace({ run: { maxToolResultBytes: 512 } });
    await ws.execute('write', { path: 'quoted.txt', content: '\\"😀'.repeat(500) });
    const trace = new TraceWriter(path.join(temp, 'data'), ws.id, 'result-limit');
    const policy = new RunPolicy(getRunLimits(config), trace);
    try {
      const read = createTools(ws, new TrustedResources(temp, config.workspace), () => policy).find(
        (tool) => tool.name === 'read',
      )!;
      const result = await read.execute('read', { path: 'quoted.txt' }, undefined, undefined, {} as any);
      const output = result.content[0];
      if (output.type !== 'text') throw new Error('Expected text result');
      expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(512);
      const parsed = JSON.parse(output.text);
      expect(parsed.truncated).toBe(true);
      expect(parsed.content.length).toBeGreaterThan(0);
      expect(parsed.content).not.toContain('\uFFFD');
      expect(parsed.hash).toBeTruthy();
      expect(parsed.nextPosition).toEqual({ startLine: 1, startColumn: parsed.content.length });
    } finally {
      policy.close();
    }
  });
});
