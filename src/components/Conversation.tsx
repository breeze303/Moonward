import clsx from 'clsx'
import { ArrowUp, ArrowUpRight, BookX, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileText, Globe2, LoaderCircle, Paperclip, PencilLine, RotateCcw, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import { acceptedMime, DEFAULT_MODEL_LIMITS, MAX_MODEL_LIMITS } from '../../shared/contract.ts'
import type { Citation, Effort, FileMime, FileView, Message, Model, Thinking } from '../../shared/contract.ts'
import { api,errorText,label } from '../services/api/appClient.ts'
import { copyText } from '../utils/clipboard.js'
import assistantStyle from './chat-demo/AssistantMessage.module.css'
import branchesStyle from './chat-demo/BranchSwitcher.module.css'
import inputStyle from './chat-demo/ChatInput.module.css'
import fileStyle from './chat-demo/FileCard.module.css'
import imageStyle from './chat-demo/MessageFile.module.css'
import sourceStyle from './chat-demo/SourceCard.module.css'
import userStyle from './chat-demo/UserMessage.module.css'
import { Markdown } from './markdown/Markdown.tsx'
import { ModelPicker } from './ModelControls.tsx'
import { ReplyMoon } from './ReplyMoon.tsx'
import { IconButton } from './ui.tsx'

export type DraftFile = { file: File; mime: FileMime }

const fileCaption = (mime: FileMime, size: number) => `${mime === 'application/pdf' ? 'PDF' : 'TXT'} · ${size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`}`

function Attachment({ file }: { file: FileView }) {
  const url = `/api/files/${file.id}`
  if (file.mime.startsWith('image/')) return <a className={clsx(imageStyle.image, 'message-attachment')} href={`${url}?inline=1`}
    target="_blank" rel="noreferrer" title={file.name} aria-label={file.name}><img src={`${url}?inline=1`} alt={file.name} loading="lazy" /></a>
  return <div className={clsx(fileStyle.card, fileStyle.clickable, 'message-attachment')}>
    <a href={url} download={file.name} aria-label={file.name} title={file.name} />
    <FileText size={22} className={fileStyle.icon} />
    <div className={fileStyle.content}><div className={fileStyle.caption}>{file.name}</div><div className={fileStyle.subCaption}>{fileCaption(file.mime, file.size)}</div></div>
    <Download size={14} aria-hidden="true" />
  </div>
}

function ThinkingState({ thinking, running, onUpdate }: { thinking: Thinking; running: boolean; onUpdate: () => void }) {
  const active = running && thinking.active
  const { elapsedMs } = thinking
  const elapsed = elapsedMs === null ? null : elapsedMs < 1000 ? '不到 1 秒' : `${Math.round(elapsedMs / 1000)} 秒`
  const caption = active ? '思考中' : elapsed ? `已思考 ${elapsed}` : thinking.summary ? '思考摘要' : ''
  if (!caption) return null
  const status = <span className="thinking-label" role={active ? 'status' : undefined}>
    {active ? <><ReplyMoon /><span className="thinking-shimmer">{caption}</span></> : caption}
  </span>
  return thinking.summary ? <details className="thinking-state">
    <summary title="思考摘要">{status}<ChevronDown size={14} aria-hidden="true" /></summary>
    <div className="thinking-summary"><Markdown content={thinking.summary} loading={active} previewHtml={false} onUpdate={onUpdate} /></div>
  </details> : <div className="thinking-state">{status}</div>
}

export function MessageItem({ message, memoryOff, first, last, busy, contextLimit, branch, edit, retry, onUpdate, notify }: {
  message: Message; memoryOff?:boolean; first: boolean; last: boolean; busy: boolean; contextLimit: number
  branch: (id: string) => void; edit: (id: string, text: string) => void; retry: (id: string) => void; onUpdate: () => void; notify: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [undone,undo]=useState('')
  const [value, setValue] = useState(message.content)
  const tooLong = editing && value.trim().length > contextLimit
  const index = message.siblings.indexOf(message.id)
  const generating = message.status === 'streaming'
  const user = message.role === 'user'
  const many = message.siblings.length > 1

  const status = message.error ? label(message.error)
    : message.status === 'stopped' ? '已停止' : message.status === 'interrupted' ? '回复已中断' : '回复未完成'

  return <article className={clsx(user ? userStyle.container : assistantStyle.message, user && first && userStyle.isFirst, 'chat-message')}
    aria-label={user ? '你的消息' : '模型回复'}>
    {message.files.length > 0 && <div className={clsx(userStyle.files, message.files.some((file) => !file.mime.startsWith('image/')) && userStyle.filesWithDocuments)}>
      {message.files.map((file) => <Attachment key={file.id} file={file} />)}
    </div>}
    {!user && message.thinking && <ThinkingState thinking={message.thinking} running={generating} onUpdate={onUpdate} />}
    {editing ? <form className={userStyle.editor} onSubmit={(event) => {
      event.preventDefault()
      if (!value.trim() || tooLong) return
      edit(message.id, value); setEditing(false)
    }}><textarea className={userStyle.textarea} aria-label="编辑消息内容" autoFocus value={value} maxLength={MAX_MODEL_LIMITS.contextChars} aria-invalid={tooLong} onChange={(event) => setValue(event.target.value)} />
      {tooLong && <p className="input-limit" role="status">输入超过模型的上下文上限。</p>}
      <div className={userStyle.editorActions}><button type="button" className="button secondary" onClick={() => setEditing(false)}>取消</button>
      <button type="submit" className="button primary" disabled={busy || !value.trim() || tooLong}>发送新分支</button></div></form>
    : user ? message.content && <div className={userStyle.bubble}>{message.content}</div>
    : message.content ? <div className="ds-assistant-message-main-content"><Markdown content={message.content} loading={generating} previewHtml={message.status === 'completed'} citations={message.citations} onUpdate={onUpdate} /></div>
    : generating && !message.thinking?.active && <div className={assistantStyle.waiting} role="status" aria-label="正在等待回复">
      {[0, 1, 2].map((dot) => <span key={dot} className={assistantStyle.waitingDot} />)}
    </div>}

    {message.savedMemory&&undone!==`${message.savedMemory.id}:${message.savedMemory.revision}`&&<details className="memory-note"><summary>已记住 · 查看</summary>{message.savedMemory.body} <button className="text-button" onClick={async()=>{const m=message.savedMemory!;try{await api(`/memory/${m.id}`,'POST',{action:'undo',revision:m.revision});undo(`${m.id}:${m.revision}`);notify('已撤销记忆变更')}catch(e){notify(errorText(e))}}}>撤销</button></details>}
    {memoryOff&&user&&/^\s*(?:请?记住|remember\b)/i.test(message.content)&&<small className="memory-note">此对话不使用记忆，本条未保存到记忆。</small>}
    {message.status === 'queued' && <div className="reply-state" role="status">排队中</div>}
    {!user && message.status !== 'completed' && message.status !== 'queued' && !generating && <div className={message.error ? assistantStyle.notice : 'reply-state'}>{status}</div>}
    {!generating && message.citations.length > 0 && <CitationList citations={message.citations} />}
    {!generating && message.status !== 'queued' && !editing && <div className={user ? userStyle.bottom : assistantStyle.bottom}>
      {many && <div className={branchesStyle.switcher} aria-label="消息版本">
        <IconButton className="round-icon compact-icon" label="上一分支" disabled={busy || index <= 0} onClick={() => branch(message.siblings[index - 1])}><ChevronLeft size={15} /></IconButton>
        <span className={branchesStyle.count}>{index + 1} / {message.siblings.length}</span>
        <IconButton className="round-icon compact-icon" label="下一分支" disabled={busy || index >= message.siblings.length - 1} onClick={() => branch(message.siblings[index + 1])}><ChevronRight size={15} /></IconButton>
      </div>}
      <div className={clsx('chat-message-actions', user ? userStyle.actions : assistantStyle.actions, !user && last && assistantStyle.alwaysShow)}>
        {message.content && <IconButton className="round-icon compact-icon" label="复制消息"
          onClick={() => { void copyText(message.content).then((ok) => notify(ok ? '已复制' : '复制失败')) }}><Copy size={16} /></IconButton>}
        {user ? <IconButton className="round-icon compact-icon" label="编辑消息" disabled={busy || !message.content}
          onClick={() => { setValue(message.content); setEditing(true) }}><PencilLine size={16} /></IconButton>
        : <IconButton className="round-icon compact-icon" label="重新生成" disabled={busy} onClick={() => retry(message.id)}><RotateCcw size={16} /></IconButton>}
      </div>
    </div>}
  </article>
}

function CitationList({ citations }: { citations: Citation[] }) {
  const seen = new Set<string>()
  const links = citations.flatMap(({ url, title }) => {
    const link = URL.parse(url)
    if (!link || !['https:', 'http:'].includes(link.protocol) || link.username || link.password || seen.has(link.href)) return []
    seen.add(link.href)
    return [{ link, title }]
  })
  if (!links.length) return null
  return <section className={sourceStyle.sources} aria-label="引用网页">
    <h3><Globe2 size={14} aria-hidden="true" />引用网页</h3>
    <ul>
      {links.map(({ link, title }) => <li key={link.href}>
        <a className={sourceStyle.card} href={link.href} target="_blank" rel="noreferrer" title={title}>
          <span className={sourceStyle.title}>{title}</span>
          <span className={sourceStyle.siteName}>{link.hostname}</span>
          <ArrowUpRight size={15} className={sourceStyle.external} aria-hidden="true" />
        </a>
      </li>)}
    </ul>
  </section>
}

function DraftAttachment({ draft: { file, mime }, busy, remove }: { draft: DraftFile; busy: boolean; remove: () => void }) {
  const isImage = mime.startsWith('image/')
  const [src, setSrc] = useState('')
  useEffect(() => {
    if (!isImage) return
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [isImage, file])

  return <div className={isImage ? inputStyle.attachment : clsx(fileStyle.card, fileStyle.editable)} title={file.name}>
    {isImage ? src && <img src={src} alt={file.name} /> : <>
      <FileText size={22} className={fileStyle.icon} />
      <div className={fileStyle.content}><div className={fileStyle.caption}>{file.name}</div><div className={fileStyle.subCaption}>{fileCaption(mime, file.size)}</div></div>
    </>}
    <button type="button" className={clsx(isImage ? inputStyle.remove : fileStyle.remove, 'draft-remove')}
      aria-label={`移除 ${file.name}`} title={`移除 ${file.name}`} disabled={busy} onClick={remove}><X size={12} /></button>
  </div>
}

export function Composer({ home, text, change, files, add, remove, model, models, selectModel, effort, setEffort, web, setWeb, memoryAvailable, withoutMemory, setWithoutMemory, busy, disabled, preparing, generating, stopping, submit, stop, textarea }: {
  home: boolean
  text: string; change: (text: string) => void; files: DraftFile[]; add: (files: File[]) => void; remove: (index: number) => void
  model: Model | undefined; models: Model[]; selectModel: (id: string) => void; effort?: Effort; setEffort: (effort?: Effort) => void
  web: boolean; setWeb: (value: boolean) => void; busy: boolean; disabled: boolean; preparing: boolean; generating: boolean; stopping: boolean
  memoryAvailable: boolean; withoutMemory: boolean; setWithoutMemory: (value: boolean) => void
  submit: () => void; stop: () => void; textarea: RefObject<HTMLTextAreaElement>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const locked = busy || disabled
  const trimmed = text.trim()
  const tooLong = trimmed.length > (model?.limits?.contextChars ?? DEFAULT_MODEL_LIMITS.contextChars)
  const canSend = Boolean(model && !locked && !tooLong && (trimmed || files.length))
  const allowed = model ? acceptedMime.filter((mime) => mime.startsWith('image/') ? model.vision : model.files) : []
  function submitForm(event: FormEvent) { event.preventDefault(); if (canSend) submit() }

  return <form className={clsx('composer', inputStyle.wrapper, home ? inputStyle.home : inputStyle.session, dragging && 'composer-dragging')}
    data-generating={generating ? '' : undefined}
    onClick={(event) => { if (event.target === event.currentTarget) textarea.current?.focus({ preventScroll: true }) }} onSubmit={submitForm}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); if (allowed.length && !locked) setDragging(true) } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); if (!locked) add(Array.from(event.dataTransfer.files)) } }}>
    <span className="composer-glow" aria-hidden="true" />
    {files.length > 0 && <div className={inputStyle.attachments}>{files.map((draft, index) =>
      <DraftAttachment key={`${draft.file.name}-${draft.file.size}-${index}`} draft={draft} busy={locked} remove={() => remove(index)} />)}</div>}
    <div className={clsx(inputStyle.textareaWrapper, 'composer-text')}>
      <textarea className={inputStyle.textarea} ref={textarea} aria-label="消息" placeholder="请输入消息" rows={2} value={text}
        maxLength={MAX_MODEL_LIMITS.contextChars} aria-invalid={tooLong} readOnly={preparing} onChange={(event) => change(event.target.value)}
        onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length && !locked) { event.preventDefault(); add(files) } }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (canSend) submit() } }} />
      <div className={clsx(inputStyle.mirror, 'composer-mirror')} aria-hidden="true">{`${text}\n`}</div>
    </div>
    {tooLong && <p className="input-limit" role="status">输入超过模型的上下文上限。</p>}
    <div className={clsx(inputStyle.functionRow, 'composer-toolbar')}>
      <div className={inputStyle.toggles}>
        {model?.web && <button type="button" className={clsx(inputStyle.toggle, 'composer-toggle composer-search')}
          aria-label="智能搜索" title={`智能搜索：${web ? '开启' : '关闭'}`} aria-pressed={web} disabled={locked} onClick={() => setWeb(!web)}>
          {web ? <Check size={14} aria-hidden="true" /> : <Globe2 size={14} aria-hidden="true" />}<span>智能搜索</span>
        </button>}
        {memoryAvailable && home && <button type="button"
          className={clsx(inputStyle.toggle, 'composer-toggle composer-memory')}
          aria-label="本对话不使用记忆" aria-pressed={withoutMemory} disabled={locked}
          title={`本对话不使用记忆：${withoutMemory ? '开启' : '关闭'}`}
          onClick={() => setWithoutMemory(!withoutMemory)}>
          {withoutMemory ? <Check size={14} aria-hidden="true" /> : <BookX size={14} aria-hidden="true" />}<span>不使用记忆</span>
        </button>}
      </div>
      <div className={clsx(inputStyle.right, 'composer-actions')}>
        <ModelPicker model={model} models={models} choose={selectModel} effort={effort} setEffort={setEffort} disabled={locked} />
        <input ref={input} hidden type="file" multiple accept={allowed.join(',')} aria-label="选择附件" onChange={(event) => {
          add(Array.from(event.target.files || [])); event.target.value = ''
        }} />
        <IconButton label="添加附件" className="round-icon" disabled={locked || !allowed.length} onClick={() => input.current?.click()}><Paperclip size={16} /></IconButton>
        {busy ? <button type="button" aria-label="停止生成" title="停止生成" className={inputStyle.sendButton} disabled={stopping} onClick={stop}>
          {preparing || stopping ? <LoaderCircle size={16} className="spinner" /> : <Square size={14} fill="currentColor" />}
        </button> : <button type="submit" aria-label="发送消息" title="发送消息" className={clsx(inputStyle.sendButton, !canSend && inputStyle.disabled)} disabled={!canSend}>
          <ArrowUp size={18} strokeWidth={2.25} />
        </button>}
      </div>
    </div>
  </form>
}
