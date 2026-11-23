import assert from 'node:assert/strict'
import { test } from 'node:test'
import { htmlPreviewDocument } from '../src/services/markdown/htmlPreview.ts'

test('HTML preview preserves static content and puts its CSP before any user styling', () => {
  const page = htmlPreviewDocument(`<!doctype html><html lang="zh"><head><title>预览</title>
    <style>.report{color:green}</style></head><body><main class="report" style="padding:10px">
    <h1>报告 &amp; 数据</h1><img src="data:image/png;base64,eA==" alt="inline"></main></body></html>`)
  assert.ok(page.startsWith('<!doctype html><html lang="zh"><head><meta http-equiv="Content-Security-Policy"'))
  assert.ok(page.indexOf('Content-Security-Policy') < page.indexOf('<style>'))
  assert.ok(page.includes('<style>.report{color:green}</style>'))
  assert.ok(page.includes('<h1>报告 &amp; 数据</h1>'))
  assert.ok(page.includes('src="data:image/png;base64,eA=="'))
  assert.ok(page.includes('style="padding:10px"'))
  assert.match(htmlPreviewDocument('<p>fragment</p>'), /<body><p>fragment<\/p><\/body>/u)
})

test('HTML preview excludes active markup, navigational attributes and remote resources', () => {
  const page = htmlPreviewDocument(`
    <base href="/remote-base"><meta http-equiv="refresh" content="0;url=/remote-refresh">
    <link rel="stylesheet" href="/remote.css"><script>ACTIVE_MARKER</script>
    <a target="_top" href="/remote-link" ping="/remote-ping" onclick="ACTIVE_MARKER">Visible link label</a>
    <form action="/remote-form"><input formaction="/remote-form" autofocus></form>
    <img src="/remote.png" srcset="/remote-2x.png 2x" onerror="ACTIVE_MARKER">
    <img src="data:image/svg+xml;base64,eA=="><iframe src="/remote-frame"></iframe>
    <template shadowrootmode="open"><style>.ignored{color:red}</style></template>`)
  assert.ok(page.includes('<a>Visible link label</a>'))
  assert.ok(page.includes('<form><input></form>'))
  assert.ok(page.includes("form-action 'none'"))
  assert.doesNotMatch(page, /remote|ACTIVE_MARKER|shadowroot|<iframe|<script|autofocus|image\/svg\+xml/u)
})

test('HTML preview keeps inline SVG drawing, fragment references and declarative animations', () => {
  const page = htmlPreviewDocument(`<svg viewBox="0 0 120 60" role="img" aria-labelledby="title">
    <title id="title">Drawing</title>
    <style>.wheel{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
    <defs><linearGradient id="paint"><stop offset="1" stop-color="gold"/></linearGradient>
    <circle id="wheel" r="8"/><path id="route" d="M0 0H40"/></defs>
    <rect fill="url(#paint)" width="90" height="40"/>
    <use xlink:href="#wheel"/>
    <g><animateTransform attributeName="transform" type="translate" values="0;40" dur="1s" repeatCount="indefinite"/>
    <animateMotion dur="2s"><mpath href="#route"/></animateMotion>
    <animate href="#wheel" attributeName="r" from="8" to="10" dur="1s"/></g></svg>`)
  assert.match(page, /<svg viewBox="0 0 120 60" role="img" aria-labelledby="title">/u)
  assert.match(page, /<style>.*@keyframes spin/u)
  assert.match(page, /<linearGradient id="paint">/u)
  assert.match(page, /fill="url\(#paint\)"/u)
  assert.match(page, /<use xlink:href="#wheel"><\/use>/u)
  assert.match(page, /<animateTransform attributeName="transform" type="translate" values="0;40" dur="1s" repeatCount="indefinite">/u)
  assert.match(page, /<animateMotion dur="2s"><mpath href="#route">/u)
  assert.match(page, /<animate href="#wheel" attributeName="r" from="8" to="10" dur="1s">/u)
})

test('SVG sanitization strips active elements, non-local references and unsafe animation targets', () => {
  const page = htmlPreviewDocument(`<svg onload="BLOCKED" xml:base="/external/">
    <foreignObject><p>BLOCKED</p></foreignObject><script>BLOCKED</script>
    <image href="/external/image.png"/><filter><feImage href="/external/filter.png"/></filter>
    <title><span>BLOCKED</span>Drawing</title>
    <use href="/external/sprite.svg#shape" xlink:href="/external/sprite.svg#shape"/>
    <use href="#shape"><set attributeName="href" to="/external/sprite.svg#shape"/>
    <animate attributeName="xlink:href" to="/external/sprite.svg#shape" dur="1s"/>
    <animate attributeName="onload" to="BLOCKED" dur="1s"/>
    <animate attributeName="style" to="BLOCKED" dur="1s"/></use></svg>`)
  assert.match(page, /<title>Drawing<\/title>/u)
  assert.match(page, /<use href="#shape">\s*<\/use>/u)
  assert.doesNotMatch(page, /BLOCKED|external|xml:base|onload|foreignObject|<script|<image|<feImage|<animate|<set/u)
})
