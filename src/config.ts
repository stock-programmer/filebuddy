import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { MIN_TOOL_RESULT_BYTES } from './tools/result-format.js';

type ReadonlyTree<T> = { readonly [K in keyof T]: T[K] extends object ? ReadonlyTree<T[K]> : T[K] };
type PartialTree<T> = { -readonly [K in keyof T]?: T[K] extends object ? PartialTree<T[K]> : T[K] };

// Validation boundaries are shared with the final request gate. They are not model capabilities.
export const MIN_OUTPUT_TOKENS = 256;
const MIN_CONTEXT_TOKENS = 8192;
const CONTENT_TIMEOUT_RANGE = { min: 1000, max: 3600000 };
const MAX_TIMER_MS = 2147483647; // Node timers overflow above the signed 32-bit range.
export type ReasoningEffort = 'low' | 'high' | 'max';

// K3 capability metadata: https://platform.kimi.com/docs/guide/kimi-k3-quickstart
// Request budgets below are application policy, not copies of these capability ceilings.
const modelDefaults = {
  model: 'kimi-k3',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: '',
  contextWindow: 1048576,
  maxTokens: 1048576,
};
const defaults = {
  model: modelDefaults,
  run: {
    outputTokens: 32768,
    compactionOutputTokens: 32768,
    reasoningEffort: 'high' as ReasoningEffort,
    compactionReasoningEffort: 'low' as ReasoningEffort,
    // Pi reserves 4096 internally; allow additional adapter/token-count headroom.
    safetyTokens: 8192,
    compressionRatio: 0.9,
    tokenLimit: null as number | null,
    maxModelCalls: null as number | null,
    maxToolCalls: null as number | null,
    requestFirstContentTimeoutMs: 300000,
    requestIdleTimeoutMs: 90000,
    // Product feedback cadence, independent of request timeouts and execution budgets.
    progressSilenceMs: 15000,
    toolTimeoutMs: 30000,
    maxRepeatedFailures: 2,
    maxToolFailures: null as number | null,
    maxToolResultBytes: 16384,
    minToolResultBytes: 512,
    resultBytesPerToken: 1.5,
    maxTaskCharacters: 30000,
    retry: { maxRetries: 1, baseDelayMs: 1000, maxDelayMs: 2000 },
    compaction: {
      maxRecentTokens: 65536,
      recentRatio: 0.25,
      minRecentTokens: 32,
      manualRecentRatio: 0.1,
    },
  },
  workspace: {
    dataDir: null as string | null,
    import: { maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024, maxFiles: 1000 },
    text: { maxFileBytes: 4 * 1024 * 1024 },
    read: { defaultLines: 200, maxLines: 1000, maxContentBytes: 12000 },
    paging: { defaultLimit: 100, maxLimit: 200 },
    list: { defaultDepth: 1, maxDepth: 8 },
    search: { maxQueryCharacters: 1000, previewCharacters: 500 },
    tools: { maxPathCharacters: 1024, maxWriteCharacters: 4000000, maxEditCharacters: 1000000 },
    skills: { maxFileBytes: 512 * 1024 },
    diff: { maxFileBytes: 4 * 1024 * 1024, maxTotalLines: 50000, timeoutMs: 1000, maxEditLength: 20000 },
  },
};

export type AppConfig = ReadonlyTree<typeof defaults>;
export type ModelConfig = AppConfig['model'];
export type RunConfig = AppConfig['run'];
export type WorkspaceConfig = AppConfig['workspace'];
export type ConfigOverrides = PartialTree<AppConfig>;
export type RunLimits = RunConfig & { readonly contextWindow: number };

export function inputLimit(limits: RunLimits) {
  return (
    limits.contextWindow - Math.max(limits.outputTokens, limits.compactionOutputTokens) - limits.safetyTokens
  );
}
export function compressionWatermark(limits: RunLimits) {
  return Math.floor(inputLimit(limits) * limits.compressionRatio);
}

function freeze<T extends object>(value: T): ReadonlyTree<T> {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value) as ReadonlyTree<T>;
}
export const DEFAULT_CONFIG: AppConfig = freeze(defaults);

function invalid(name: string, requirement: string): never {
  // Never include raw values: configuration can contain credentials and private endpoints.
  throw new Error(`配置 ${name} ${requirement}`);
}
function integer(value: number, name: string, min = 1, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    invalid(name, `必须为 ${min} 到 ${max} 的安全整数`);
}
function ratio(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) invalid(name, '必须大于 0 且小于 1');
}
export function validateBudget(value: number | null, name: string) {
  if (value !== null) integer(value, name);
  return value;
}

/** Pure resolution, also used for explicit programmatic changes. No environment reads here. */
export function resolveConfig(overrides: ConfigOverrides = {}, base?: AppConfig): AppConfig {
  base ??= DEFAULT_CONFIG;
  const model = { ...base.model, ...overrides.model };
  const run = {
    ...base.run,
    ...overrides.run,
    retry: { ...base.run.retry, ...overrides.run?.retry },
    compaction: { ...base.run.compaction, ...overrides.run?.compaction },
  };
  const workspace = { ...base.workspace, ...overrides.workspace } as typeof defaults.workspace;
  for (const key of Object.keys(base.workspace) as (keyof WorkspaceConfig)[]) {
    if (key !== 'dataDir')
      Object.assign(workspace, { [key]: { ...base.workspace[key], ...overrides.workspace?.[key] } });
  }
  if (typeof model.model !== 'string' || !model.model.trim()) invalid('model.model', '不能为空');
  if (typeof model.apiKey !== 'string') invalid('model.apiKey', '必须为字符串');
  model.model = model.model.trim();
  let url: URL;
  try {
    url = new URL(model.baseUrl);
  } catch {
    invalid('model.baseUrl', '必须为有效 URL');
  }
  if (url.username || url.password || url.search || url.hash)
    invalid('model.baseUrl', '不能包含凭证、查询参数或片段');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    invalid('model.baseUrl', '必须使用 HTTPS；仅本机回环地址允许 HTTP');
  integer(model.contextWindow, 'model.contextWindow', MIN_CONTEXT_TOKENS);
  integer(model.maxTokens, 'model.maxTokens', MIN_OUTPUT_TOKENS);
  integer(run.outputTokens, 'run.outputTokens', MIN_OUTPUT_TOKENS, model.maxTokens);
  integer(run.compactionOutputTokens, 'run.compactionOutputTokens', MIN_OUTPUT_TOKENS, model.maxTokens);
  for (const name of ['tokenLimit', 'maxModelCalls', 'maxToolCalls', 'maxToolFailures'] as const)
    validateBudget(run[name], `run.${name}`);
  for (const name of ['reasoningEffort', 'compactionReasoningEffort'] as const)
    if (!['low', 'high', 'max'].includes(run[name])) invalid(`run.${name}`, '必须为 low、high 或 max');
  ratio(run.compressionRatio, 'run.compressionRatio');
  for (const name of [
    'safetyTokens',
    'toolTimeoutMs',
    'maxRepeatedFailures',
    'maxToolResultBytes',
    'minToolResultBytes',
    'maxTaskCharacters',
  ] as const)
    integer(run[name], `run.${name}`);
  integer(run.toolTimeoutMs, 'run.toolTimeoutMs', 1, MAX_TIMER_MS);
  integer(run.progressSilenceMs, 'run.progressSilenceMs', 1, MAX_TIMER_MS);
  for (const name of ['requestFirstContentTimeoutMs', 'requestIdleTimeoutMs'] as const)
    integer(run[name], `run.${name}`, CONTENT_TIMEOUT_RANGE.min, CONTENT_TIMEOUT_RANGE.max);
  if (!Number.isFinite(run.resultBytesPerToken) || run.resultBytesPerToken <= 0)
    invalid('run.resultBytesPerToken', '必须为有限正数');
  if (run.minToolResultBytes > run.maxToolResultBytes)
    invalid('run.minToolResultBytes', '不能超过 maxToolResultBytes');
  // Ensure there is room for the truncation envelope, even when the cumulative budget is exhausted.
  integer(run.minToolResultBytes, 'run.minToolResultBytes', MIN_TOOL_RESULT_BYTES);
  integer(run.retry.maxRetries, 'run.retry.maxRetries', 0);
  integer(run.retry.baseDelayMs, 'run.retry.baseDelayMs', 1, MAX_TIMER_MS);
  integer(run.retry.maxDelayMs, 'run.retry.maxDelayMs', run.retry.baseDelayMs, MAX_TIMER_MS);
  ratio(run.compaction.recentRatio, 'run.compaction.recentRatio');
  ratio(run.compaction.manualRecentRatio, 'run.compaction.manualRecentRatio');
  integer(run.compaction.maxRecentTokens, 'run.compaction.maxRecentTokens');
  integer(
    run.compaction.minRecentTokens,
    'run.compaction.minRecentTokens',
    1,
    run.compaction.maxRecentTokens,
  );
  const limits = { ...run, contextWindow: model.contextWindow };
  if (inputLimit(limits) <= 0) invalid('model.contextWindow', '必须大于输出预留与安全预留之和');
  const recentTokens = Math.floor(compressionWatermark(limits) * run.compaction.recentRatio);
  if (recentTokens < run.compaction.minRecentTokens)
    invalid('run.compaction', '压缩水位必须容纳最小近期历史');
  for (const [group, values] of Object.entries(workspace)) {
    if (group === 'dataDir') continue;
    for (const [name, value] of Object.entries(values!))
      integer(value as number, `workspace.${group}.${name}`);
  }
  integer(workspace.read.maxContentBytes, 'workspace.read.maxContentBytes', 4); // One UTF-8 code point.
  integer(workspace.diff.timeoutMs, 'workspace.diff.timeoutMs', 1, MAX_TIMER_MS);
  if (workspace.import.maxFileBytes > workspace.import.maxTotalBytes)
    invalid('workspace.import', '单文件限制不能超过累计限制');
  if (workspace.read.defaultLines > workspace.read.maxLines)
    invalid('workspace.read', '默认行数不能超过最大行数');
  if (workspace.paging.defaultLimit > workspace.paging.maxLimit)
    invalid('workspace.paging', '默认条数不能超过最大条数');
  if (workspace.list.defaultDepth > workspace.list.maxDepth)
    invalid('workspace.list', '默认深度不能超过最大深度');
  if (workspace.dataDir !== null) {
    if (typeof workspace.dataDir !== 'string' || !workspace.dataDir.trim())
      invalid('workspace.dataDir', '必须为非空路径或 null');
    workspace.dataDir = resolve(workspace.dataDir);
  }
  return freeze({ model, run, workspace });
}

/** Load once at the composition root: environment > .env > code defaults; never mutate process.env. */
export function loadConfig(
  options: { env?: NodeJS.ProcessEnv; envFile?: string; overrides?: ConfigOverrides } = {},
): AppConfig {
  let file: Record<string, string> = {};
  if (options.envFile) {
    try {
      file = parse(readFileSync(options.envFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取配置文件');
    }
  }
  const env = { ...file };
  for (const [key, value] of Object.entries(options.env ?? process.env))
    if (value !== undefined) env[key] = value;
  const raw = (name: string) => env[name]?.trim();
  const number = (name: string) => {
    const value = raw(name);
    if (!value) return undefined;
    // Decimal notation only; NaN, Infinity, hex and accidental punctuation are configuration errors.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value)))
      invalid(name, '必须为有限十进制数');
    return Number(value);
  };
  const model: ConfigOverrides['model'] = {};
  const run: NonNullable<ConfigOverrides['run']> = {};
  const workspace: NonNullable<ConfigOverrides['workspace']> = {};
  if (raw('AGENT_MODEL')) model.model = raw('AGENT_MODEL');
  if (raw('AGENT_BASE_URL')) model.baseUrl = raw('AGENT_BASE_URL');
  if (env.AGENT_API_KEY !== undefined) model.apiKey = env.AGENT_API_KEY.trim();
  const modelNumbers = {
    contextWindow: 'AGENT_CONTEXT_WINDOW',
    maxTokens: 'AGENT_MAX_OUTPUT_TOKENS',
  } as const;
  for (const [key, name] of Object.entries(modelNumbers)) {
    const value = number(name);
    if (value !== undefined) Object.assign(model, { [key]: value });
  }
  const runNumbers = {
    outputTokens: 'AGENT_RUN_OUTPUT_TOKENS',
    compactionOutputTokens: 'AGENT_COMPACTION_OUTPUT_TOKENS',
    safetyTokens: 'AGENT_SAFETY_TOKENS',
    compressionRatio: 'AGENT_COMPRESSION_RATIO',
    tokenLimit: 'AGENT_RUN_TOKEN_LIMIT',
    maxModelCalls: 'AGENT_RUN_MAX_MODEL_CALLS',
    maxToolCalls: 'AGENT_RUN_MAX_TOOL_CALLS',
    maxToolFailures: 'AGENT_RUN_MAX_TOOL_FAILURES',
    requestFirstContentTimeoutMs: 'AGENT_REQUEST_FIRST_CONTENT_TIMEOUT_MS',
    requestIdleTimeoutMs: 'AGENT_REQUEST_IDLE_TIMEOUT_MS',
    progressSilenceMs: 'AGENT_PROGRESS_SILENCE_MS',
    toolTimeoutMs: 'AGENT_TOOL_TIMEOUT_MS',
    maxToolResultBytes: 'AGENT_TOOL_RESULT_MAX_BYTES',
    maxRepeatedFailures: 'AGENT_MAX_REPEATED_FAILURES',
  } as const;
  for (const [key, name] of Object.entries(runNumbers)) {
    const value = number(name);
    if (value !== undefined) Object.assign(run, { [key]: value });
  }
  const reasoningNames = {
    reasoningEffort: 'AGENT_REASONING_EFFORT',
    compactionReasoningEffort: 'AGENT_COMPACTION_REASONING_EFFORT',
  } as const;
  for (const [key, name] of Object.entries(reasoningNames)) {
    const value = raw(name);
    if (value) Object.assign(run, { [key]: value });
  }
  const maxRecentTokens = number('AGENT_COMPACTION_RECENT_TOKENS');
  if (maxRecentTokens !== undefined) run.compaction = { maxRecentTokens };
  const workspaceNumbers = {
    XUWU_IMPORT_MAX_FILE_BYTES: ['import', 'maxFileBytes'],
    XUWU_IMPORT_MAX_TOTAL_BYTES: ['import', 'maxTotalBytes'],
    XUWU_IMPORT_MAX_FILES: ['import', 'maxFiles'],
    XUWU_TEXT_MAX_BYTES: ['text', 'maxFileBytes'],
    XUWU_READ_DEFAULT_LINES: ['read', 'defaultLines'],
    XUWU_READ_MAX_LINES: ['read', 'maxLines'],
    XUWU_READ_MAX_BYTES: ['read', 'maxContentBytes'],
    XUWU_PAGE_DEFAULT_LIMIT: ['paging', 'defaultLimit'],
    XUWU_PAGE_MAX_LIMIT: ['paging', 'maxLimit'],
  } as const;
  for (const [name, [group, key]] of Object.entries(workspaceNumbers)) {
    const value = number(name);
    if (value !== undefined) Object.assign(workspace, { [group]: { ...workspace[group], [key]: value } });
  }
  if (raw('XUWU_DATA_DIR')) workspace.dataDir = raw('XUWU_DATA_DIR');
  let result: AppConfig;
  try {
    result = resolveConfig({ model, run, workspace });
  } catch (error) {
    let message = (error as Error).message;
    for (const [key, name] of Object.entries(modelNumbers)) message = message.replace(`model.${key}`, name);
    for (const [key, name] of Object.entries(runNumbers)) message = message.replace(`run.${key}`, name);
    for (const [key, name] of Object.entries(reasoningNames)) message = message.replace(`run.${key}`, name);
    message = message.replace('run.compaction.maxRecentTokens', 'AGENT_COMPACTION_RECENT_TOKENS');
    for (const [name, [group, key]] of Object.entries(workspaceNumbers))
      message = message.replace(`workspace.${group}.${key}`, name);
    throw new Error(message);
  }
  return options.overrides ? resolveConfig(options.overrides, result) : result;
}

export function getRunLimits(config: AppConfig): RunLimits {
  return freeze({ ...config.run, contextWindow: config.model.contextWindow });
}
export const DEFAULT_LIMITS = getRunLimits(DEFAULT_CONFIG);
