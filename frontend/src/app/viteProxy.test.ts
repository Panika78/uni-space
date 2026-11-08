// @vitest-environment node

import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { createViteConfig } from '../../vite.config'

describe('Vite API proxy', () => {
  const originalProxyTarget = process.env.API_PROXY_TARGET

  afterEach(() => {
    if (originalProxyTarget === undefined) {
      delete process.env.API_PROXY_TARGET
    } else {
      process.env.API_PROXY_TARGET = originalProxyTarget
    }
  })

  it('loads the target from .env and preserves the API request path', async () => {
    delete process.env.API_PROXY_TARGET
    const envDirectory = mkdtempSync(join(tmpdir(), 'uni-space-vite-proxy-'))
    const upstream = createHttpServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ path: request.url }))
    })
    let viteServer: ViteDevServer | undefined

    try {
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      const upstreamAddress = upstream.address()
      if (!upstreamAddress || typeof upstreamAddress === 'string') {
        throw new Error('The test upstream did not bind to a TCP port')
      }

      writeFileSync(
        join(envDirectory, '.env'),
        `API_PROXY_TARGET=http://127.0.0.1:${upstreamAddress.port}\n`,
      )

      const config = createViteConfig('test', envDirectory)
      const vitePortProbe = createHttpServer()
      await new Promise<void>((resolve) => vitePortProbe.listen(0, '127.0.0.1', resolve))
      const viteAddress = vitePortProbe.address()
      if (!viteAddress || typeof viteAddress === 'string') {
        throw new Error('Could not allocate a port for the test Vite server')
      }
      await new Promise<void>((resolve) => vitePortProbe.close(() => resolve()))

      viteServer = await createViteServer({
        ...config,
        plugins: [],
        configFile: false,
        root: envDirectory,
        server: { ...config.server, host: '127.0.0.1', port: viteAddress.port, strictPort: true },
      })
      await viteServer.listen()

      const listeningAddress = viteServer.httpServer?.address()
      if (!listeningAddress || typeof listeningAddress === 'string') {
        throw new Error('The test Vite server did not bind to a TCP port')
      }

      const response = await fetch(`http://127.0.0.1:${listeningAddress.port}/api/openapi.json`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ path: '/api/openapi.json' })
    } finally {
      await viteServer?.close()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      rmSync(envDirectory, { recursive: true, force: true })
    }
  }, 15000)
})
