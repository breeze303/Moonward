import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readServerSentEvents } from '../src/services/api/sse.ts'
import { ResponseAccumulator } from '../server/upstream.ts'
import { toMdAst } from '../src/services/markdown/parse.ts'

test('upstream output token exhaustion is reported separately from other incomplete replies', () => {
  const state = new ResponseAccumulator()
  state.accept({ type: 'response.output_text.delta', delta: 'Retained text' })
  state.accept({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
  assert.equal(state.error, 'upstream_output_limit')
  assert.equal(state.snapshot().text, 'Retained text')
})

test('output protection follows the configured budget for streaming and terminal-only text', () => {
  const text = 'x'.repeat(900)
  const short = new ResponseAccumulator(16)
  short.accept({ type: 'response.output_text.delta', delta: text })
  assert.equal(short.error, 'reply_too_large')
  assert.equal(short.snapshot().text, text.slice(0, 512))

  const stream = new ResponseAccumulator(32)
  stream.accept({ type: 'response.output_text.delta', delta: text })
  assert.equal(stream.error, null)
  assert.equal(stream.snapshot().text, text)

  const final = new ResponseAccumulator(16)
  final.accept({ type: 'response.output_text.delta', delta: 'x' })
  final.accept({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } })
  assert.equal(final.error, 'reply_too_large')
  assert.equal(final.snapshot().text, text.slice(0, 512))
})

test('SSE decoder handles split UTF-8, CRLF, multiline data, comments and truncated frames', async () => {
  const data = Buffer.from(': ready\r\nevent: notice\r\ndata: 第一行\r\ndata: second\r\n\r\ndata: truncated')
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of data) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  const parsed = []
  for await (const event of readServerSentEvents(stream)) parsed.push(event)
  assert.deepEqual(parsed, [{ event: 'notice', data: '第一行\nsecond', lastEventId: '' }])
})

test('citation offsets survive multiple parts and emoji and preserve Markdown syntax', () => {
  const state = new ResponseAccumulator(32)
  state.accept({ type: 'response.output_text.delta', delta: '🟢 **说明**。' })
  state.accept({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', title: 'Source', url: 'https://example.com', start_index: 2, end_index: 9 } })
  state.accept({ type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: 'javascript:void(0)' } })
  state.accept({ type: 'response.output_text.delta', output_index: 1, delta: '\n\nNext.' })
  state.accept({ type: 'response.completed', response: { usage: { input_tokens: 123 } } })
  const snapshot = state.snapshot()
  assert.equal(state.terminal, 'completed')
  assert.equal(state.inputTokens, 123)
  assert.equal(snapshot.text, '🟢 **说明**。\n\nNext.')
  assert.deepEqual(snapshot.citations, [{ url: 'https://example.com/', title: 'Source', start: 3, end: 10 }])
  const ast = toMdAst(snapshot.text, { sources: snapshot.citations, disableLink: false })
  assert.equal(ast.children[0].type, 'paragraph')
  if (ast.children[0].type === 'paragraph') assert.equal(ast.children[0].children.at(-1)?.type, 'citation')
})

test('Markdown parses emphasis next to Chinese punctuation without changing literal stars', () => {
  const input = '**我正筛选古诗词命名及出处。**我整理诗句出处候选'
  const options = { sources: undefined, disableLink: false }
  const [plain] = toMdAst(input, options).children
  assert.ok(plain?.type === 'paragraph')
  const [bold, tail] = plain.children
  assert.ok(bold?.type === 'strong' && bold.children[0]?.type === 'text')
  assert.equal(bold.children[0].value, '我正筛选古诗词命名及出处。')
  assert.ok(tail?.type === 'text')
  assert.equal(tail.value, '我整理诗句出处候选')
  assert.equal(bold.position?.end.offset, input.indexOf('我整理'))

  const [literal] = toMdAst('`**段落。**后文` 和 \\*\\*段落。\\*\\*后文', options).children
  assert.ok(literal?.type === 'paragraph')
  const [code, escaped] = literal.children
  assert.ok(code?.type === 'inlineCode' && escaped?.type === 'text')
  assert.equal(code.value, '**段落。**后文')
  assert.equal(escaped.value, ' 和 **段落。**后文')
})

test('reasoning accumulator uses only bounded public summary text and never invents timing', () => {
  const state = new ResponseAccumulator(64)
  state.accept({ type: 'response.reasoning_text.delta', delta: 'private chain' })
  assert.equal(state.thinking, null)
  state.accept({ type: 'response.completed', response: { output: [
    { type: 'reasoning', encrypted_content: 'private', content: [{ type: 'reasoning_text', text: 'private' }],
      summary: [{ type: 'summary_text', text: 'public '.repeat(2_000) }, { type: 'text', text: 'private' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
  ] } })
  const snapshot = state.snapshot()
  assert.equal(snapshot.text, 'answer')
  assert.equal(snapshot.thinking?.active, false)
  assert.equal(snapshot.thinking?.elapsedMs, null)
  assert.equal(snapshot.thinking?.summary.length, 2_048)
  assert.ok(!JSON.stringify(snapshot).includes('private'))
})
