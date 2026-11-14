import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export function createViteConfig(mode: string, envDirectory = process.cwd()) {
  const env = loadEnv(mode, envDirectory, '')

  return {
    plugins: [react(), tailwindcss()],
    build: {
      // Vite 7.3 collects licenses only for dependencies present in emitted chunks.
      license: { fileName: 'licenses.md' },
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      proxy: {
        '/api': {
          target: env.API_PROXY_TARGET || 'http://localhost:8000',
          changeOrigin: true,
        },
      },
    },
  }
}

export default defineConfig(({ mode }) => ({
  ...createViteConfig(mode),
  test: {
    environment: 'jsdom',
    setupFiles: './src/testSetup.ts',
    clearMocks: true,
  },
}))
