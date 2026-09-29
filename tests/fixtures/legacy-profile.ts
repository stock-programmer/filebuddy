import { getRunLimits, resolveConfig } from '../../src/config.js';

/** Keep the original small-window scenarios stable while production defaults evolve. */
export const LEGACY_LIMITS = getRunLimits(
  resolveConfig({
    model: { contextWindow: 65536, maxTokens: 4096 },
    run: {
      outputTokens: 4096,
      compactionOutputTokens: 4096,
      safetyTokens: 2048,
      compressionRatio: 0.75,
      maxToolFailures: 6,
      requestFirstContentTimeoutMs: 90000,
      compaction: { maxRecentTokens: 12000 },
    },
  }),
);
