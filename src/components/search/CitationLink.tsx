import type { Source } from '../../services/markdown/parse.ts'

export function CitationLink({ source }: { source: Source }) {
  return <a className="ds-a ds-markdown-cite" href={source.url} title={source.title} aria-label={`来源 ${source.index}：${source.title}`} target="_blank" rel="noreferrer">{source.index}</a>
}
