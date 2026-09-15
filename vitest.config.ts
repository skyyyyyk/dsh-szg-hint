import { defineConfig } from 'vitest/config'

/**
 * 本仓库自己的测试配置。
 *
 * 独立仓库不继承任何宿主仓库的 vitest 配置：在 dsh 源码树内 checkout 时，
 * vitest 会向上命中宿主的 `vitest.*.config`（那里的 include 只匹配
 * `packages/...`），结果一条用例都跑不到。这里显式把自己的用例收进来。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
})
