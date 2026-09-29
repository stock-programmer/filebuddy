import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  DEFAULT_CONFIG,
  compressionWatermark,
  inputLimit,
  getRunLimits,
  loadConfig,
  resolveConfig,
  type ConfigOverrides,
} from '../src/config.js';
import { MIN_TOOL_RESULT_BYTES, truncateToolResult } from '../src/tools/result-format.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('xuwu-config-'))
      throw new Error('Unsafe config test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

async function envFile(contents: string) {
  const root = await mkdtemp(join(tmpdir(), 'xuwu-config-'));
  roots.push(root);
  const path = join(root, '.env');
  await writeFile(path, contents, 'utf8');
  return path;
}

describe('one resolved configuration', () => {
  it('uses environment over the supplied .env over defaults without mutating process.env', async () => {
    const file = await envFile(
      [
        'AGENT_MODEL=file-model',
        'AGENT_API_KEY=file-fixture-key',
        'AGENT_CONTEXT_WINDOW=131072',
        'AGENT_MAX_OUTPUT_TOKENS=8192',
        'AGENT_RUN_OUTPUT_TOKENS=8192',
        'AGENT_COMPACTION_OUTPUT_TOKENS=8192',
        'AGENT_RUN_TOKEN_LIMIT=250000',
      ].join('\n'),
    );
    const originalModel = process.env.AGENT_MODEL;
    const config = loadConfig({
      envFile: file,
      env: { AGENT_MODEL: 'system-model', AGENT_MAX_OUTPUT_TOKENS: undefined },
    });
    expect(config.model).toMatchObject({
      model: 'system-model',
      apiKey: 'file-fixture-key',
      contextWindow: 131072,
      maxTokens: 8192,
    });
    expect(config.run).toMatchObject({
      outputTokens: 8192,
      compactionOutputTokens: 8192,
      tokenLimit: 250000,
    });
    expect(config.workspace).toEqual(DEFAULT_CONFIG.workspace);
    expect(process.env.AGENT_MODEL).toBe(originalModel);
  });

  it('uses defaults for missing files and blank settings while allowing a blank system key to clear the file key', async () => {
    const file = await envFile(
      'AGENT_API_KEY=file-fixture-key\nAGENT_CONTEXT_WINDOW=131072\nAGENT_RUN_TOKEN_LIMIT=3000\n',
    );
    expect(loadConfig({ env: {}, envFile: join(dirname(file), 'missing.env') })).toEqual(DEFAULT_CONFIG);
    const config = loadConfig({
      envFile: file,
      env: {
        AGENT_API_KEY: ' ',
        AGENT_CONTEXT_WINDOW: '',
        AGENT_RUN_TOKEN_LIMIT: '  ',
      },
    });
    expect(config.model.apiKey).toBe('');
    expect(config.model.contextWindow).toBe(DEFAULT_CONFIG.model.contextWindow);
    expect(config.run.tokenLimit).toBeNull();
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '0x10000', '1_000', 'invalid', '9007199254740992'])(
    'rejects invalid numeric model settings (%s) instead of reverting to defaults',
    (value) => {
      for (const name of ['AGENT_CONTEXT_WINDOW', 'AGENT_MAX_OUTPUT_TOKENS'])
        expect(() => loadConfig({ env: { [name]: value } })).toThrow(name);
    },
  );

  it.each(['0', '-0.1', '1', '1.1', 'NaN'])('rejects an invalid compression ratio %s', (value) => {
    expect(() => loadConfig({ env: { AGENT_COMPRESSION_RATIO: value } })).toThrow('AGENT_COMPRESSION_RATIO');
  });

  it.each([
    [
      {
        model: { contextWindow: 8192, maxTokens: 8192 },
        run: { outputTokens: 8192, compactionOutputTokens: 8192 },
      },
      'model.contextWindow',
    ],
    [{ run: { outputTokens: 1048577 } }, 'run.outputTokens'],
    [{ run: { compactionOutputTokens: 1048577 } }, 'run.compactionOutputTokens'],
    [{ run: { minToolResultBytes: 20000 } }, 'run.minToolResultBytes'],
    [{ run: { retry: { baseDelayMs: 3000, maxDelayMs: 2000 } } }, 'run.retry.maxDelayMs'],
    [{ run: { compaction: { maxRecentTokens: 16 } } }, 'run.compaction.minRecentTokens'],
    [{ workspace: { import: { maxTotalBytes: 100 } } }, 'workspace.import'],
    [{ workspace: { read: { maxLines: 10 } } }, 'workspace.read'],
    [{ workspace: { paging: { maxLimit: 10 } } }, 'workspace.paging'],
    [{ workspace: { list: { defaultDepth: 9 } } }, 'workspace.list'],
  ] satisfies [ConfigOverrides, string][])(
    'validates relationships for programmatic overrides %#',
    (overrides, field) => {
      expect(() => resolveConfig(overrides)).toThrow(field);
    },
  );

  it('validates explicit overrides after environment resolution and keeps unrelated nested values', () => {
    const config = loadConfig({
      env: {
        AGENT_MAX_OUTPUT_TOKENS: '8192',
        AGENT_CONTEXT_WINDOW: '131072',
        AGENT_RUN_OUTPUT_TOKENS: '8192',
        AGENT_COMPACTION_OUTPUT_TOKENS: '8192',
      },
      overrides: {
        run: { outputTokens: 2048, retry: { maxRetries: 3 } },
        workspace: { paging: { defaultLimit: 20 } },
      },
    });
    expect(config.run).toMatchObject({
      outputTokens: 2048,
      compactionOutputTokens: 8192,
      retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 2000 },
    });
    expect(config.workspace.paging).toEqual({ defaultLimit: 20, maxLimit: 200 });
    expect(() => loadConfig({ env: {}, overrides: { model: { maxTokens: NaN } } })).toThrow(
      'model.maxTokens',
    );
    expect(() => resolveConfig({ run: { outputTokens: 16384 } }, config)).toThrow('run.outputTokens');
  });

  it('rejects invalid endpoints without echoing credentials or private query data', () => {
    for (const baseUrl of [
      'not-a-url-fixture-secret',
      'https://fixture-user:fixture-secret@example.test/v1',
      'https://example.test/v1?token=fixture-secret',
      'http://example.test/v1',
    ]) {
      expect(() => resolveConfig({ model: { baseUrl } })).toThrow('model.baseUrl');
      try {
        resolveConfig({ model: { baseUrl } });
      } catch (error) {
        expect((error as Error).message).not.toContain('fixture-secret');
      }
    }
    expect(resolveConfig({ model: { baseUrl: 'http://127.0.0.1:4321/v1' } }).model.baseUrl).toBe(
      'http://127.0.0.1:4321/v1',
    );
  });

  it('preserves explicit request allowances even when they equal the previous model ceiling', () => {
    const base = resolveConfig({
      model: { maxTokens: 4096 },
      run: { outputTokens: 4096, compactionOutputTokens: 4096 },
    });
    const updated = resolveConfig({ model: { maxTokens: 8192 } }, base);
    expect(updated.model.maxTokens).toBe(8192);
    expect(updated.run).toMatchObject({ outputTokens: 4096, compactionOutputTokens: 4096 });
    expect(() => resolveConfig({ model: { maxTokens: 2048 } }, base)).toThrow('run.outputTokens');
    expect(
      resolveConfig(
        {
          model: { maxTokens: 2048 },
          run: { outputTokens: 2048, compactionOutputTokens: 1024 },
        },
        base,
      ).run,
    ).toMatchObject({ outputTokens: 2048, compactionOutputTokens: 1024 });
  });

  it('keeps model capabilities separate from the default conversation and summary budgets', () => {
    expect(DEFAULT_CONFIG.model).toMatchObject({ contextWindow: 1048576, maxTokens: 1048576 });
    expect(DEFAULT_CONFIG.run).toMatchObject({
      outputTokens: 32768,
      compactionOutputTokens: 32768,
      safetyTokens: 8192,
      compressionRatio: 0.9,
      reasoningEffort: 'high',
      compactionReasoningEffort: 'low',
      requestFirstContentTimeoutMs: 300000,
      requestIdleTimeoutMs: 90000,
      progressSilenceMs: 15000,
      maxToolFailures: null,
      compaction: { maxRecentTokens: 65536 },
    });
    expect(DEFAULT_CONFIG.workspace.import.maxFiles).toBe(1000);
    expect(compressionWatermark(getRunLimits(DEFAULT_CONFIG))).toBe(906854);
    const changedCapability = resolveConfig({ model: { maxTokens: 524288 } });
    expect(changedCapability.run).toMatchObject({ outputTokens: 32768, compactionOutputTokens: 32768 });
    expect(() => resolveConfig({ model: { maxTokens: 8192 } })).toThrow('run.outputTokens');
    expect(
      resolveConfig({
        model: { maxTokens: 8192 },
        run: { outputTokens: 4096, compactionOutputTokens: 2048 },
      }).run,
    ).toMatchObject({ outputTokens: 4096, compactionOutputTokens: 2048 });
  });

  it('resolves first-content waiting separately from streaming idle time with the same source priority', async () => {
    const file = await envFile(
      'AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS=180000\nAGENT_REQUEST_IDLE_TIMEOUT_MS=45000\n',
    );
    expect(loadConfig({ envFile: file, env: {} }).run).toMatchObject({
      requestFirstContentTimeoutMs: 180000,
      requestIdleTimeoutMs: 45000,
    });
    expect(
      loadConfig({ envFile: file, env: { AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS: '240000' } }).run,
    ).toMatchObject({
      requestFirstContentTimeoutMs: 240000,
      requestIdleTimeoutMs: 45000,
    });
    expect(
      loadConfig({
        envFile: file,
        env: { AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS: ' ', AGENT_REQUEST_IDLE_TIMEOUT_MS: '' },
      }).run,
    ).toMatchObject({
      requestFirstContentTimeoutMs: 300000,
      requestIdleTimeoutMs: 90000,
    });
    expect(resolveConfig({ run: { requestFirstContentTimeoutMs: 180000 } }).run.requestIdleTimeoutMs).toBe(
      90000,
    );
    expect(resolveConfig({ run: { requestIdleTimeoutMs: 45000 } }).run.requestFirstContentTimeoutMs).toBe(
      300000,
    );
  });

  it.each(['0', '-1', '999', '1000.5', '3600001', 'NaN', 'Infinity', 'invalid'])(
    'rejects invalid first-content timeout %s by its setting name',
    (value) => {
      expect(() => loadConfig({ env: { AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS: value } })).toThrow(
        'AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS',
      );
      expect(() => resolveConfig({ run: { requestFirstContentTimeoutMs: Number(value) } })).toThrow(
        'run.requestFirstContentTimeoutMs',
      );
    },
  );

  it('resolves progress feedback cadence through the same sources without changing execution limits', async () => {
    const file = await envFile('AGENT_PROGRESS_SILENCE_MS=12000\n');
    expect(loadConfig({ env: {} }).run.progressSilenceMs).toBe(15000);
    expect(loadConfig({ envFile: file, env: {} }).run.progressSilenceMs).toBe(12000);
    expect(
      loadConfig({ envFile: file, env: { AGENT_PROGRESS_SILENCE_MS: '20000' } }).run.progressSilenceMs,
    ).toBe(20000);
    expect(loadConfig({ envFile: file, env: { AGENT_PROGRESS_SILENCE_MS: ' ' } }).run.progressSilenceMs).toBe(
      15000,
    );
    const config = loadConfig({
      envFile: file,
      env: { AGENT_PROGRESS_SILENCE_MS: '20000' },
      overrides: { run: { progressSilenceMs: 100 } },
    });
    expect(config.run).toEqual({ ...DEFAULT_CONFIG.run, progressSilenceMs: 100 });
    expect(getRunLimits(config).progressSilenceMs).toBe(100);
    expect(resolveConfig({ run: { outputTokens: 1024 } }, config).run.progressSilenceMs).toBe(100);
    for (const progressSilenceMs of [1, 2147483647])
      expect(resolveConfig({ run: { progressSilenceMs } }).run.progressSilenceMs).toBe(progressSilenceMs);
  });

  it.each(['0', '-1', '1.5', '2147483648', 'NaN', 'Infinity', 'invalid'])(
    'rejects invalid progress feedback cadence %s by its setting name',
    (value) => {
      expect(() => loadConfig({ env: { AGENT_PROGRESS_SILENCE_MS: value } })).toThrow(
        'AGENT_PROGRESS_SILENCE_MS',
      );
      expect(() => resolveConfig({ run: { progressSilenceMs: Number(value) } })).toThrow(
        'run.progressSilenceMs',
      );
    },
  );

  it('loads explicit reasoning and compaction settings and treats blank values as defaults', () => {
    const config = loadConfig({
      env: {
        AGENT_REASONING_EFFORT: 'max',
        AGENT_COMPACTION_REASONING_EFFORT: 'high',
        AGENT_COMPACTION_RECENT_TOKENS: '32768',
        AGENT_MAX_REPEATED_FAILURES: '3',
        AGENT_RUN_MAX_TOOL_FAILURES: '9',
      },
    });
    expect(config.run).toMatchObject({
      reasoningEffort: 'max',
      compactionReasoningEffort: 'high',
      compaction: { maxRecentTokens: 32768 },
      maxRepeatedFailures: 3,
      maxToolFailures: 9,
    });
    expect(
      loadConfig({
        env: {
          AGENT_REASONING_EFFORT: ' ',
          AGENT_COMPACTION_REASONING_EFFORT: '',
          AGENT_COMPACTION_RECENT_TOKENS: ' ',
          AGENT_MAX_REPEATED_FAILURES: '',
          AGENT_RUN_MAX_TOOL_FAILURES: ' ',
        },
      }).run,
    ).toEqual(DEFAULT_CONFIG.run);
  });

  it.each([
    ['AGENT_REASONING_EFFORT', 'medium'],
    ['AGENT_COMPACTION_REASONING_EFFORT', 'invalid'],
    ['AGENT_COMPACTION_RECENT_TOKENS', '0'],
    ['AGENT_MAX_REPEATED_FAILURES', '1.5'],
    ['AGENT_RUN_MAX_TOOL_FAILURES', '-1'],
  ])('rejects invalid %s using the setting name', (name, value) => {
    expect(() => loadConfig({ env: { [name]: value } })).toThrow(name);
  });

  it('freezes nested effective values and derives the watermark from the effective larger output reservation', () => {
    const config = resolveConfig({
      model: { contextWindow: 131072, maxTokens: 8192 },
      run: { outputTokens: 1024, compactionOutputTokens: 8192, compressionRatio: 0.6 },
    });
    for (const value of [
      config,
      config.model,
      config.run,
      config.run.retry,
      config.run.compaction,
      config.workspace,
      config.workspace.read,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(config.run.retry, 'maxRetries', 999)).toBe(false);
    const limits = getRunLimits(config);
    expect(Object.isFrozen(limits)).toBe(true);
    expect(inputLimit(limits)).toBe(131072 - 8192 - config.run.safetyTokens);
    expect(compressionWatermark(limits)).toBe(Math.floor(inputLimit(limits) * 0.6));
    expect(DEFAULT_CONFIG.run.retry.maxRetries).toBe(1);
    expect(DEFAULT_CONFIG.model.contextWindow).toBe(1048576);
  });

  it('accepts exactly enough result bytes for the protocol envelope and rejects less', () => {
    expect(() => resolveConfig({ run: { minToolResultBytes: MIN_TOOL_RESULT_BYTES - 1 } })).toThrow(
      'run.minToolResultBytes',
    );
    const config = resolveConfig({
      run: { minToolResultBytes: MIN_TOOL_RESULT_BYTES, maxToolResultBytes: MIN_TOOL_RESULT_BYTES },
    });
    const original = '中文🙂"\\'.repeat(200);
    const result = truncateToolResult(original, config.run.minToolResultBytes);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(config.run.minToolResultBytes);
    expect(JSON.parse(result)).toMatchObject({ truncated: true, originalBytes: Buffer.byteLength(original) });
  });
});
