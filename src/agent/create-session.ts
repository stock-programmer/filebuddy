import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createTools, type AgentWorkspace } from '../tools/tools.js';
import { TrustedResources } from './resources.js';
import { createModelRuntime } from './model-runtime.js';
import { DEFAULT_CONFIG, compressionWatermark, type ModelConfig, type RunLimits } from '../config.js';
import { budgetedStream, type RunPolicy } from './run-policy.js';
import { installContextCompaction } from './context-compaction.js';
import { createKimiTokenCounter } from './kimi-token-count.js';

export async function createSession(options: {
  workspace: AgentWorkspace;
  dataRoot: string;
  appRoot: string;
  model: ModelConfig;
  limits: RunLimits;
  getPolicy: () => RunPolicy | undefined;
}) {
  const { workspace, dataRoot, appRoot, limits } = options;
  const sessionDir = join(dataRoot, 'sessions', workspace.id);
  await mkdir(sessionDir, { recursive: true });
  const workspaceConfig = workspace.config ?? DEFAULT_CONFIG.workspace;
  const resources = new TrustedResources(appRoot, workspaceConfig);
  await resources.reload();
  const { runtime, model } = await createModelRuntime(options.model);
  const tools = createTools(workspace, resources, options.getPolicy, workspaceConfig);
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    enableAnalytics: false,
    enableInstallTelemetry: false,
    enableSkillCommands: false,
    retry: {
      enabled: true,
      maxRetries: limits.retry.maxRetries,
      baseDelayMs: limits.retry.baseDelayMs,
      maxAgentDelayMs: limits.retry.maxDelayMs,
      provider: {
        maxRetries: 0,
        timeoutMs: limits.requestFirstContentTimeoutMs,
      },
    },
    compaction: {
      // K3 thresholds are driven by the same official count as the request gate.
      // The host enables Pi's native compactor only at the next safe turn boundary.
      enabled: model.id !== 'kimi-k3',
      reserveTokens: model.contextWindow - compressionWatermark(limits),
      keepRecentTokens: Math.min(
        limits.compaction.maxRecentTokens,
        Math.floor(compressionWatermark(limits) * limits.compaction.recentRatio),
      ),
    },
    images: { blockImages: true },
    defaultProjectTrust: 'never',
  });
  const sessionManager = SessionManager.continueRecent(workspace.workDir, sessionDir);
  const { session } = await createAgentSession({
    cwd: workspace.workDir,
    agentDir: join(dataRoot, 'pi-isolated'),
    modelRuntime: runtime,
    model,
    thinkingLevel: model.reasoning ? limits.reasoningEffort : 'off',
    resourceLoader: resources,
    sessionManager,
    settingsManager,
    tools: tools.map((tool) => tool.name),
    customTools: tools,
  });
  const tokenCounter =
    model.id === 'kimi-k3'
      ? createKimiTokenCounter({
          model,
          apiKey: options.model.apiKey,
          stream: (requestModel, context, requestOptions) =>
            runtime.streamSimple(requestModel, context, requestOptions),
          timeoutMs: () => options.getPolicy()?.limits.requestIdleTimeoutMs ?? limits.requestIdleTimeoutMs,
          reasoning: limits.reasoningEffort,
        })
      : undefined;
  session.agent.streamFunction = budgetedStream(
    session.agent.streamFunction,
    options.getPolicy,
    tokenCounter,
  );
  installContextCompaction(session, sessionManager, options.getPolicy, tokenCounter);
  return { session, sessionManager, resources };
}
