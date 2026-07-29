import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Tauri expects a fixed port and passes TAURI_ENV_* during `tauri dev`.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      '#': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  // Tauri serves the frontend from a fixed port; failing loudly beats
  // silently moving to another port that the Rust side isn't pointed at.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // exactOptionalPropertyTypes 아래에서는 undefined를 명시적으로 넘길 수 없다.
    ...(host ? { hmr: { protocol: 'ws' as const, host, port: 1421 } } : {}),
    watch: { ignored: ['**/src-tauri/**'] },
  },

  build: {
    // macOS 전용 WKWebView — 하위 호환 트랜스파일이 필요 없다.
    target: 'safari15',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Vite 8은 Rolldown/Oxc 기반이다. 'esbuild'를 지정하면 별도 설치를 요구한다.
    minify: process.env.TAURI_ENV_DEBUG ? false : 'oxc',
  },
})
