import { existsSync } from 'node:fs'
import { defineConfig } from '@playwright/test'

const chrome = '/usr/bin/google-chrome'
const executablePath = process.env.BROWSER_EXECUTABLE || (existsSync(chrome) ? chrome : undefined)
const port = process.env.BROWSER_TEST_PORT || '4178'
const baseURL = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: './test', testMatch: '*.spec.ts', workers: 1, timeout: 30_000,
  use: { baseURL, browserName: 'chromium', launchOptions: { executablePath }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run build && node test/serve.ts', url: `${baseURL}/healthz`, timeout: 60_000 },
})
