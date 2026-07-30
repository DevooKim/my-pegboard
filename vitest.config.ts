import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '#': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // 에이전트 worktree에는 자체 node_modules와 React 사본이 있어서
    // 거기 테스트를 같이 돌리면 "Invalid hook call"이 난다.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
