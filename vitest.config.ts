import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '.cache/vitest',
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Keep dependency loading bounded on machines with slow small-file reads.
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: [
            '@earendil-works/pi-coding-agent',
            '@earendil-works/pi-ai',
            '@earendil-works/pi-agent-core',
            'typebox',
          ],
        },
      },
    },
  },
});
