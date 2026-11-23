import { memo, useMemo } from 'react'
import type { Citation } from '../../../shared/contract.ts'
import { toMdAst } from '../../services/markdown/parse.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

export const Markdown = memo(function Markdown({
  content,
  loading,
  previewHtml,
  citations,
  onUpdate,
}: {
  content: string
  loading: boolean
  previewHtml: boolean
  citations?: Citation[]
  onUpdate: () => void
}) {
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const ast = useMemo(
    () => (throttledMarkdown ? toMdAst(throttledMarkdown, { sources: citations, disableLink: false }) : null),
    [throttledMarkdown, citations]
  )
  return ast ? (
    <MarkdownAstRenderer
      ast={ast}
      loading={loading}
      previewHtml={previewHtml}
      onUpdate={onUpdate}
    />
  ) : null
})
