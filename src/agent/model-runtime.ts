import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { ModelConfig } from '../config.js';

export async function createModelRuntime(config: ModelConfig) {
  const isKimiK3 = config.model === 'kimi-k3';
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerProvider('xuwu-model', {
    name: '用户配置的模型',
    api: 'openai-completions',
    baseUrl: config.baseUrl,
    authHeader: true,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: isKimiK3,
        ...(isKimiK3
          ? {
              thinkingLevelMap: {
                off: null,
                minimal: null,
                low: 'low',
                medium: null,
                high: 'high',
                xhigh: 'max',
                max: 'max',
              },
            }
          : {}),
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: isKimiK3,
          maxTokensField: isKimiK3 ? 'max_completion_tokens' : 'max_tokens',
          supportsUsageInStreaming: true,
          ...(isKimiK3
            ? {
                thinkingFormat: 'openai',
                requiresReasoningContentOnAssistantMessages: true,
                supportsMidConvoSystemMessages: true,
                supportsMidConvoToolAdditions: true,
              }
            : {}),
        },
      },
    ],
  });
  if (config.apiKey) await runtime.setRuntimeApiKey('xuwu-model', config.apiKey);
  const model = runtime.getModel('xuwu-model', config.model);
  if (!model) throw new Error('无法注册指定模型');
  return { runtime, model };
}
