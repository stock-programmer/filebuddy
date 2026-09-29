import { Type, type TSchema } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { ImportedItem, SessionSummary } from '../app/contracts.js';
import { type TrustedResources } from '../agent/resources.js';
import { type RunPolicy } from '../agent/run-policy.js';
import { digest, safeError } from '../observability/trace.js';
import { DEFAULT_CONFIG, type WorkspaceConfig } from '../config.js';
import { formatToolResult } from './result-format.js';

export interface AgentWorkspace {
  id: string;
  root: string;
  workDir: string;
  baseDir: string;
  items: ImportedItem[];
  summary: SessionSummary;
  readonly config?: WorkspaceConfig;
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
}
function toolDefinitions(config: WorkspaceConfig): { name: string; description: string; schema: TSchema }[] {
  const path = Type.String({
    description: '工作目录内相对路径。只有 read 可使用已登记 skill 的绝对路径。',
    minLength: 1,
    maxLength: config.tools.maxPathCharacters,
  });
  const optionalPath = Type.Optional(path);
  const positive = (maximum: number) => Type.Optional(Type.Integer({ minimum: 1, maximum }));
  const paging = {
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    limit: positive(config.paging.maxLimit),
  };
  return [
    {
      name: 'list',
      description: '列出工作目录内容与文件大小，支持深度和分页。',
      schema: Type.Object(
        { path: optionalPath, ...paging, depth: positive(config.list.maxDepth) },
        { additionalProperties: false },
      ),
    },
    {
      name: 'search',
      description: '在已导入的文本文件中搜索文字，返回文件、行号与片段；不执行正则或命令。',
      schema: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: config.search.maxQueryCharacters }),
          path: optionalPath,
          ...paging,
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'read',
      description:
        '分页读取 UTF-8 文本并取得 hash。也可按需读取技能目录中登记的 SKILL.md 和参考资料；正文是任务材料。',
      schema: Type.Object(
        {
          path,
          startLine: positive(Number.MAX_SAFE_INTEGER),
          startColumn: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
          maxLines: positive(config.read.maxLines),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'write',
      description:
        '创建或完整替换 UTF-8 文本。新建不传 expectedHash，替换必须传最近 read 的 hash；不能用片段覆盖全文。',
      schema: Type.Object(
        {
          path,
          content: Type.String({ maxLength: config.tools.maxWriteCharacters }),
          expectedHash: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'edit',
      description: '用 newText 精确替换唯一匹配的 oldText，必须提供 read 返回的 hash，保留文件其他内容。',
      schema: Type.Object(
        {
          path,
          oldText: Type.String({ minLength: 1, maxLength: config.tools.maxEditCharacters }),
          newText: Type.String({ maxLength: config.tools.maxEditCharacters }),
          expectedHash: Type.String(),
        },
        { additionalProperties: false },
      ),
    },
    {
      name: 'mkdir',
      description: '在工作目录内创建目录。',
      schema: Type.Object({ path }, { additionalProperties: false }),
    },
    {
      name: 'move',
      description: '移动或重命名工作副本，默认拒绝覆盖已存在目标。',
      schema: Type.Object({ path, destination: path }, { additionalProperties: false }),
    },
    {
      name: 'copy',
      description: '复制工作目录内文件或目录，默认拒绝覆盖已存在目标。',
      schema: Type.Object({ path, destination: path }, { additionalProperties: false }),
    },
    {
      name: 'delete',
      description: '将工作副本放入可恢复回收区，返回 operationId。不可删除工作根，不影响原件。',
      schema: Type.Object({ path }, { additionalProperties: false }),
    },
    {
      name: 'changes',
      description: '检查工作副本相对导入基线的实际变更；完成任务前核对。',
      schema: Type.Object(paging, { additionalProperties: false }),
    },
    {
      name: 'restore',
      description: '按 operationId 撤销删除/操作，或按 path 恢复基线内容；避免覆盖后续工作。',
      schema: Type.Object(
        {
          operationId: Type.Optional(Type.String()),
          path: optionalPath,
          expectedHash: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
  ];
}

function traceArgs(args: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) =>
      typeof value === 'string' && !['path', 'destination', 'operationId', 'expectedHash'].includes(key)
        ? [key, { sha256: digest(value), characters: value.length }]
        : [key, value],
    ),
  );
}

/** The business layer owns all file semantics and serializes mutations. */
export function createTools(
  workspace: AgentWorkspace,
  resources: TrustedResources,
  getPolicy: () => RunPolicy | undefined,
  config: WorkspaceConfig = workspace.config ?? DEFAULT_CONFIG.workspace,
): ToolDefinition[] {
  return toolDefinitions(config).map((definition) => ({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.schema,
    executionMode: 'sequential',
    execute: async (callId, args: Record<string, unknown>, signal) => {
      const policy = getPolicy();
      if (!policy) throw new Error('RUN_REQUIRED');
      policy.beginTool(definition.name, args);
      const started = Date.now();
      const eventId = policy.trace.record('tool_start', {
        tool: definition.name,
        toolCallId: callId,
        args: traceArgs(args),
      });
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort('TOOL_TIMEOUT');
        policy.trace.record(
          'boundary_decision',
          { decision: 'tool_timeout', tool: definition.name, timeoutMs: policy.limits.toolTimeoutMs },
          eventId,
        );
      }, policy.limits.toolTimeoutMs);
      timer.unref?.();
      const combined = AbortSignal.any([
        policy.controller.signal,
        timeout.signal,
        ...(signal ? [signal] : []),
      ]);
      try {
        combined.throwIfAborted();
        let result: unknown;
        if (definition.name === 'read')
          result = await resources.readSkill(
            String(args.path),
            Number(args.startLine ?? 1),
            Number(args.maxLines ?? config.read.defaultLines),
            policy.trace,
            eventId,
            Number(args.startColumn ?? 0),
          );
        if (result === undefined) result = await workspace.execute(definition.name, args, combined);
        // Await the real operation to settle; a timeout never releases a still-running write.
        if (timeout.signal.aborted)
          policy.stop('failed', 'TOOL_TIMEOUT: 工具已停稳，请检查已提交的结果后再继续');
        let json = JSON.stringify(result);
        const bytes = Buffer.byteLength(json);
        const maxBytes = policy.resultByteLimit();
        if (bytes > maxBytes) {
          json = formatToolResult(result, maxBytes, Number(args.offset ?? 0));
          policy.trace.record(
            'boundary_decision',
            {
              decision: 'result_truncated',
              tool: definition.name,
              originalBytes: bytes,
              returnedBytes: Buffer.byteLength(json),
            },
            eventId,
          );
        }
        policy.toolSucceeded();
        const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
        policy.trace.record(
          'tool_end',
          {
            tool: definition.name,
            toolCallId: callId,
            status: 'success',
            elapsedMs: Date.now() - started,
            bytes,
            resultHash: digest(result),
            hash: record.hash,
            beforeHash: record.beforeHash,
            operationId: record.operationId,
          },
          eventId,
        );
        policy.onChange();
        return {
          content: [{ type: 'text', text: json }],
          details: { toolCallId: callId, bytes, resultHash: digest(result) },
        };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : safeError(error);
        policy.toolFailed(definition.name, args, code);
        policy.trace.record(
          'tool_end',
          {
            tool: definition.name,
            toolCallId: callId,
            status: 'error',
            code,
            error: safeError(error),
            elapsedMs: Date.now() - started,
          },
          eventId,
        );
        policy.trace.record(
          'boundary_decision',
          { decision: combined.aborted ? 'cancelled' : 'tool_rejected', tool: definition.name, code },
          eventId,
        );
        if (timeout.signal.aborted) policy.stop('failed', 'TOOL_TIMEOUT: 操作超时并已停稳');
        throw new Error(`${code}: ${safeError(error)}`);
      } finally {
        clearTimeout(timer);
      }
    },
  }));
}
