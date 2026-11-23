import { useMemo } from 'react'
import { htmlPreviewDocument } from '../../services/markdown/htmlPreview.ts'
import { useTranslate } from '../../i18n/index.js'
import styles from './CodeBlock.module.css'

export default function HtmlPreview({ code }: { code: string }) {
  const t = useTranslate()
  const document = useMemo(() => htmlPreviewDocument(code), [code])
  return <iframe className={styles.preview} title={t('htmlPreviewTitle')} srcDoc={document} sandbox="" referrerPolicy="no-referrer" />
}
