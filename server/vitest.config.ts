import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://lorebook:lorebook@localhost:5432/lorebook_test',
      COOKIE_SECURE: 'false',
      DATA_DIR: '/tmp',
      WEB_DIST: '/nonexistent',
    },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
