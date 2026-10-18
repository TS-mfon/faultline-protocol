import { defineConfig } from 'vitest/config';
export default defineConfig({ oxc: { jsx: { runtime: 'automatic' } }, test: { include: ['apps/web/components/faultline/test/**/*.test.ts', 'packages/**/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts', 'examples/test/**/*.test.ts', 'tests/**/*.test.ts'], testTimeout: 15000 } });
