import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

dotenv.config({
  path: [
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '../../.env.local'),
    path.resolve(process.cwd(), '../.env.local'),
    '.env',
  ],
  override: true,
});

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/__tests__/**',
        '**/vite.config.ts',
        '**/vitest.config.ts',
      ],
    },
    testTimeout: 10000,
  },
});
