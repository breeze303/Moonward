import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createApplication } from '../server/app.ts'
import { mountFrontend } from '../server/static.ts'
import { loadConfig } from '../server/config.ts'
import type { Config } from '../server/config.ts'
import { chatTitleInstructions } from '../server/upstream.ts'
import { startWorker } from '../server/worker.ts'

export const mockKey = 'test-only-gateway-key-not-a-credential'
export const adminEmail = 'admin@example.test'
export const password = 'Test-only-password-876!'
export const minimumPassword = 'Test-1234!'
const secret = randomBytes(32).toString('hex')
const endpoint = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const svgFixture = readFileSync(new URL('./fixtures/pelican-drive.html', import.meta.url), 'utf8')

export async function listen(server: Server, port = 0) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  return endpoint(server)
}

export function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

type RequestBody = { input: Array<{ role: string; content: unknown }>; instructions?: string; tools?: unknown[]; model: string; store: boolean; max_output_tokens: number; reasoning?: { effort?: string; summary?: string } }
type TextPart = { type: string; text?: string }

export async function startMock(port = 0, options: { key?: string; models?: string[]; title?: (text: string) => string | null | Promise<string | null> } = {}) {
  const bodies: RequestBody[] = []
  const titleBodies: RequestBody[] = []
  let aborted = 0
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.use((req, res, next) => {
    if (req.get('Authorization') !== `Bearer ${options.key ?? mockKey}`) { res.status(401).json({ error: { message: 'Mock authentication required' } }); return }
    next()
  })
  app.get('/v1/models', (_req, res) => { res.json({ data: (options.models ?? ['gpt-6.2-sol', 'gpt-test-text', 'not-allowed']).map((id) => ({ id })) }) })
  app.post('/v1/responses', async (req, res) => {
    const body = req.body as RequestBody
    const parts = Array.isArray(body.input.at(-1)?.content) ? body.input.at(-1)!.content as TextPart[] : []
    const prompt = parts.find((part) => part.type === 'input_text')?.text || ''
    const make = (event: object) => `data: ${JSON.stringify(event)}\r\n\r\n`
    if (body.instructions === chatTitleInstructions) {
      titleBodies.push(body)
      const title = await options.title?.(prompt)
      if (res.destroyed) return
      if (!title) { res.status(503).end(); return }
      res.set('Content-Type', 'text/event-stream; charset=utf-8').end(make({ type: 'response.completed', response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: title }] }],
      } }))
      return
    }
    bodies.push(body)
    if (Object.hasOwn(body, 'max_tool_calls')) {
      res.status(400).json({ error: { message: 'Unsupported parameter: max_tool_calls' } })
      return
    }
    const track = JSON.stringify(body.input).includes('MAPLE-9781')
    const htmlFixture = prompt === 'HTML_PREVIEW'
    const moonFixture = prompt === 'MOONWAIT 等待标志'
    const fadeParts = prompt === 'STREAM_FADE' ? ['First words.', ' More words.', '\n\n**Final words.**'] : null
    const delayed = /^(?:SWITCH|RECONNECT)\s/.test(prompt)
    const text = htmlFixture ? [
      '```html', '<!doctype html>', '<html><head><title>HTML fixture</title>',
      '<meta http-equiv="refresh" content="0;url=/preview-probe/refresh">',
      '<link rel="stylesheet" href="/preview-probe/link.css">',
      '<style>@import url("/preview-probe/import.css"); h1{color:rgb(11, 99, 66)} body{background-image:url("https://preview-network.invalid/preview-probe/background.png")}</style>',
      '</head><body><h1>预览测试页面</h1><p style="font-weight:700" id="still-static">本地样式</p>',
      '<script>document.getElementById("still-static").textContent="脚本不应该运行"</script>',
      '<iframe src="/preview-probe/frame"></iframe><img src="/preview-probe/image.png" alt="external">',
      `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==" alt="embedded">`,
      '<a href="/preview-probe/nav" target="_top">预览链接</a>',
      '<form action="/preview-probe/form"><button>预览表单</button></form></body></html>', '```',
    ].join('\n') : prompt === 'SVG_PREVIEW' ? `\`\`\`html\n${svgFixture}\n\`\`\`` : prompt === 'RICH_MARKDOWN' ? [
      '**Markdown**', '', '$x^2$', '', '```js', 'const n = 42', '```', '', '```mermaid', 'flowchart LR', '  A[Start] --> B[Finish]', '```',
    ].join('\n') : prompt.startsWith('LONG_LENGTH ') ? 'x'.repeat(100_000) : fadeParts ? fadeParts.join('') : body.tools?.length ? 'Responses API 支持流式输出。'
      : prompt.includes('回忆编号') && track ? 'MAPLE-9781'
      : `**资料摘要**：${prompt.replace(/^(SLOW|DROP|INCOMPLETE|FAIL|SWITCH|RECONNECT|MOONWAIT)\s*/, '') || '已读取你的附件'}。`
    const annotations = body.tools?.length ? [{ type: 'url_citation', url: 'https://developers.openai.com/api/docs/guides/streaming-responses', title: 'OpenAI 流式输出文档', start_index: 0, end_index: [...text].length }] : []
    const hasSummary = moonFixture || body.reasoning?.summary === 'auto'
    const markdownSummary = hasSummary && prompt === '检查思考摘要'
    const firstSummary = markdownSummary ? '### 思考步骤\n\n**我正筛选古诗词命名及出处。**我整理诗句出处候选' : '核对输出格式。'
    const restSummary = markdownSummary ? '\n\n1. 检查 `输入`\n2. 组织回复\n\n```html\n<h1>仅作为源码</h1>\n```' : ''
    const reasoning = { type: 'reasoning', summary: [{ type: 'summary_text', text: firstSummary + restSummary }], encrypted_content: 'must-not-be-exposed' }
    const summaryDelta = (delta: string) => make({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta })
    const delta = (fragment: string) => make({ type: 'response.output_text.delta', output_index: Number(hasSummary), content_index: 0, delta: fragment })
    let completed = false
    res.set('Content-Type', 'text/event-stream; charset=utf-8').flushHeaders()
    res.write(': ready\r\n\r\n')
    const emitReasoning = () => {
      res.write(make({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } }))
      res.write(make({ type: 'response.reasoning_text.delta', delta: 'must-not-be-exposed' }))
      res.write(summaryDelta(firstSummary))
    }
    const reasoningStart = moonFixture && setTimeout(emitReasoning, 850)
    if (hasSummary && !moonFixture) emitReasoning()
    const summaryContinuation = markdownSummary && setTimeout(() => res.write(summaryDelta(restSummary)), 300)
    const first = setTimeout(() => {
      const chunk = Buffer.from(delta(htmlFixture ? text : fadeParts?.[0] ?? text.slice(0, 10)))
      // Split a CRLF delimiter and the multibyte body across writes.
      res.write(chunk.subarray(0, chunk.length - 3))
      res.write(chunk.subarray(chunk.length - 3))
      if (prompt.startsWith('DROP')) { completed = true; res.end() }
    }, delayed ? 1_200 : moonFixture ? 4_800 : markdownSummary ? 2_200 : hasSummary ? 700 : 25)
    const middle = fadeParts && setTimeout(() => res.write(delta(fadeParts[1])), 550)
    const second = setTimeout(() => {
      if (completed) return
      completed = true
      const terminal = prompt.startsWith('INCOMPLETE') ? 'incomplete' : prompt.startsWith('FAIL') ? 'failed' : 'completed'
      if (!htmlFixture) res.write(delta(fadeParts?.[2] ?? text.slice(10)))
      res.end(make({ type: `response.${terminal}`, response: {
        output: [...(hasSummary ? [reasoning] : []), { type: 'message', content: [{ type: 'output_text', text, annotations }] }],
        usage: { input_tokens: 17, output_tokens: 13 },
        ...(terminal === 'failed' ? { error: { message: 'Raw credential-bearing test error must not escape' } } : {}),
      } }))
    }, delayed ? 3_600 : moonFixture ? 5_200 : htmlFixture || fadeParts ? 1_200 : prompt.startsWith('SLOW') ? 6_000 : markdownSummary ? 2_350 : hasSummary ? 820 : 80)
    res.on('close', () => {
      if (reasoningStart) clearTimeout(reasoningStart)
      if (summaryContinuation) clearTimeout(summaryContinuation)
      clearTimeout(first)
      if (middle) clearTimeout(middle)
      clearTimeout(second)
      if (!completed) aborted++
    })
  })
  const server = createServer(app)
  const url = await listen(server, port)
  return { url, bodies, titleBodies, aborted: () => aborted, close: () => closeServer(server) }
}

export async function startSite(upstream: string | null, opts: { port?: number; dbPath?: string; staticFiles?: boolean; siteLimit?: number; seed?: boolean; loopbackAlias?: boolean; worker?: boolean } = {}) {
  let handler: ReturnType<typeof express> | undefined
  const server = createServer((req, res) => {
    if (handler) handler(req, res)
    else res.writeHead(503).end()
  })
  const origin = await listen(server, opts.port)
  const config = loadConfig({
    APP_ORIGIN: origin, AUTH_SECRET: secret,
    ...(upstream ? { OPENAI_BASE_URL: `${upstream}/v1`, OPENAI_API_KEY: mockKey, OPENAI_MODELS: 'gpt-6.2-sol,gpt-test-text,unavailable-model' } : {}),
    APP_ALLOWED_ORIGINS: opts.loopbackAlias ? origin.replace('127.0.0.1', 'localhost') : undefined,
    DATABASE_PATH: opts.dbPath || ':memory:',
    SITE_DAILY_LIMIT: opts.siteLimit?.toString(),
  })
  const application = await createApplication(config)
  if (opts.seed !== false) await application.accounts.createAdmin(adminEmail, '测试管理员', password)
  if (opts.staticFiles) mountFrontend(application.app)
  const worker = opts.worker === false ? undefined : startWorker(config, application.db)
  handler = application.app
  return { ...application, config, origin, async shutdown() { await application.drain(); await closeServer(server); await worker?.close(); await application.close() } }
}

export class BrowserlessClient {
  origin: string
  cookie = ''
  constructor(origin: string) { this.origin = origin }
  async api(path: string, method = 'GET', data?: unknown, signal?: AbortSignal) {
    const res = await fetch(`${this.origin}/api${path}`, {
      method, signal,
      headers: { Origin: this.origin, Connection: 'close', ...(this.cookie ? { Cookie: this.cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    })
    for (const raw of res.headers.getSetCookie()) {
      const part = raw.split(';', 1)[0]
      this.cookie = [...(this.cookie ? this.cookie.split('; ').filter((value) => value.split('=')[0] !== part.split('=')[0]) : []), part].join('; ')
    }
    return res
  }
  async login(email = adminEmail, secret = password) {
    const res = await this.api('/auth/sign-in/email', 'POST', { email, password: secret })
    assert.equal(res.status, 200, await res.clone().text())
    await res.text()
    assert.ok(this.cookie)
    return this
  }
}

export function overrideConfig(config: Config, changes: Partial<Config>): Config { return { ...config, ...changes } }
