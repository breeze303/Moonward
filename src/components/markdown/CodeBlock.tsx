import { useTranslate } from '../../i18n/index.js'
import { lazy, memo, Suspense, useEffect, useMemo, useReducer, useState } from 'react'
import Prism from 'prismjs'
import {
  getHighlightLang,
  isHighlightLoaded,
  loadHighlight,
} from '../../services/markdown/highlight.js'
import { Check, Copy, Eye } from 'lucide-react'
import { copyText } from '../../utils/clipboard.js'
import { MermaidDiagram } from './MermaidDiagram.js'
import styles from './CodeBlock.module.css'

const HtmlPreview = lazy(() => import('./HtmlPreview.tsx'))

/** 代码块标题栏：左侧语言名，右侧复制 */
const CodeInfoRow = ({
  code,
  infostring,
  showDiagram,
  onToggleDiagram,
  showPreview,
  onTogglePreview,
}: {
  code: string
  infostring: string
  showDiagram: boolean
  onToggleDiagram?: () => void
  showPreview: boolean
  onTogglePreview?: (show: boolean) => void
}) => {
  const t = useTranslate()
  const [copyState, setCopyState] = useState<'copy' | 'copied' | 'copyFailed'>('copy')
  return (
    <div className={styles.container}>
      {onTogglePreview ? (
        <div className="md-code-block-switch" role="group" aria-label={t('htmlSwitchLabel')}>
          <button type="button" className={styles.button} aria-pressed={!showPreview} onClick={() => onTogglePreview(false)}>{t('htmlSource')}</button>
          <button type="button" className={styles.button} aria-pressed={showPreview} onClick={() => onTogglePreview(true)}><Eye aria-hidden="true" />{t('htmlPreview')}</button>
        </div>
      ) : onToggleDiagram ? (
        <div className="md-code-block-switch" aria-label={t('mermaidSwitchLabel')}>
          <button
            type="button"
            className={styles.button}
            aria-pressed={showDiagram}
            onClick={() => !showDiagram && onToggleDiagram()}
          >
            {t('mermaidDiagram')}
          </button>
          <button
            type="button"
            className={styles.button}
            aria-pressed={!showDiagram}
            onClick={() => showDiagram && onToggleDiagram()}
          >
            {t('mermaidCode')}
          </button>
        </div>
      ) : (
        <span className={styles.name}>{infostring}</span>
      )}
      <button
        type="button"
        className={styles.button}
        onClick={async () => {
          setCopyState(await copyText(code) ? 'copied' : 'copyFailed')
          setTimeout(() => setCopyState('copy'), 1500)
        }}
      >
        {copyState === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        <span>{t(copyState)}</span>
      </button>
    </div>
  )
}

/** 代码块：语言包按需加载，不支持或尚未加载的语言按纯文本显示 */
export const CodeBlock = memo(function CodeBlock({
  code,
  infostring,
  loading = false,
  previewHtml = false,
}: {
  code: string
  infostring: string
  loading?: boolean
  previewHtml?: boolean
}) {
  const t = useTranslate()
  const isMermaid = infostring.toLowerCase() === 'mermaid'
  const canPreview = previewHtml && code.trim() !== '' && ['html', 'htm', 'html5'].includes(infostring.toLowerCase())
  const [preview, setPreview] = useState(false)
  const showPreview = canPreview && preview
  const [showDiagram, setShowDiagram] = useState(true)
  // 语言包注册在全局 Prism 上，每次渲染直接判断；加载完成后触发一次重渲染
  const rerender = useReducer((n: number) => n + 1, 0)[1]
  const lang = getHighlightLang(infostring)
  const loaded = lang !== null && isHighlightLoaded(lang)
  useEffect(() => {
    if (lang === null || loaded) {
      return
    }
    let unmounted = false
    loadHighlight(lang).then(() => {
      if (!unmounted) {
        rerender()
      }
    })
    return () => {
      unmounted = true
    }
  }, [lang, loaded, rerender])
  const renderedHtml = useMemo(() => {
    const name = lang !== null && loaded ? lang : 'plaintext'
    return Prism.highlight(code, Prism.languages[name], name)
  }, [code, lang, loaded])
  return (
    <div className="md-code-block">
      <div className="md-code-block-banner">
        <CodeInfoRow
          code={code}
          infostring={infostring}
          showDiagram={showDiagram}
          onToggleDiagram={isMermaid ? () => setShowDiagram((show) => !show) : undefined}
          showPreview={showPreview}
          onTogglePreview={canPreview ? setPreview : undefined}
        />
      </div>
      {showPreview ? (
        <Suspense fallback={<div className={styles.previewLoading} role="status">{t('htmlPreviewLoading')}</div>}><HtmlPreview code={code} /></Suspense>
      ) : isMermaid && showDiagram ? (
        <MermaidDiagram code={code} loading={loading} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: renderedHtml }}></pre>
      )}
    </div>
  )
})
