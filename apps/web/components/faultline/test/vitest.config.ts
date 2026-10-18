import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/web/components/faultline/test/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10000,
  },
});
