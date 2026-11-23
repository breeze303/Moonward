import clsx from 'clsx'
import { ArrowLeft, Menu, MessageSquarePlus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { acceptedMime, DEFAULT_MODEL_LIMITS, MAX_FILE_BYTES, MAX_FILES, MAX_TURN_BYTES } from '../../shared/contract.ts'
import type { Chat, ChatSummary, Effort, Model, Turn, Usage, User } from '../../shared/contract.ts'
import { brand } from '../app/brand.ts'
import { getLocal, setLocal } from '../app/storage.ts'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from '../app/viewport.ts'
import { api, ApiError, encodeFile, enqueue, errorText, respond } from '../services/api/appClient.ts'
import { Admin } from './Admin.tsx'
import { Composer, MessageItem } from './Conversation.tsx'
import type { DraftFile } from './Conversation.tsx'
import { WorkspaceSettings } from './WorkspaceSettings.tsx'
import { CollapsedSidebar, WorkspaceSidebar } from './WorkspaceSidebar.tsx'
import listStyle from './chat-demo/MessageList.module.css'
import mobileStyle from './chat-demo/MobileHeader.module.css'
import viewStyle from './chat-demo/SessionView.module.css'
import siderStyle from './chat-demo/Sider.module.css'
import homeStyle from './chat-demo/Welcome.module.css'
import { IconButton, Loading, Mark, Modal, Notice } from './ui.tsx'

type Phase = 'preparing' | 'streaming' | 'recovering'
type Active = { controller: AbortController; chat: Chat | null; phase: Phase }
const queryChat = (id: string) => `/chats/${id}`
const caveat = '内容由 AI 生成，请仔细甄别'

export function Workspace({ user, updateUser, expired }: { user: User; updateUser: (user: User | null) => void; expired: () => void }) {
  const scope = `wenji:${user.id}:`
  const mobile = useIsMobile()
  const frame = useMobileViewport(mobile)
  usePreventPageScroll(mobile)
  const [chats, setChats] = useState<ChatSummary[]>([])
  const [chat, setChat] = useState<Chat | null>(null)
  const [selected, setSelected] = useState(() => getLocal(`${scope}selected`))
  const selectedRef = useRef(selected)
  const [loading, setLoading] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  const [modelId, setModelId] = useState(() => getLocal(`${scope}model`) || '')
  const [modelError, setModelError] = useState('')
  const model = models.find((m) => m.id === modelId) || models[0]
  const [prefs, setPrefs] = useState<Record<string, Effort | undefined>>({})
  const preferred = model && (Object.hasOwn(prefs, model.id) ? prefs[model.id] : getLocal(`${scope}effort:${model.id}`))
  const effort = model?.efforts.find((level) => level === preferred)
  const [web, setWeb] = useState(false)
  const [text, setText] = useState(() => getLocal(`${scope}draft:${selected || 'new'}`) || '')
  const [files, setFiles] = useState<DraftFile[]>([])
  const [drawer, setDrawer] = useState(false)
  const [collapsed, setCollapsed] = useState(() => getLocal(`${scope}collapsed`) === '1')
  const [searching, setSearching] = useState(false)
  const [management, setManagement] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [quota, setQuota] = useState(user.usage)
  const [settings, setSettings] = useState(false)
  const [accountError, setAccountError] = useState('')
  const [deleting, setDeleting] = useState<ChatSummary | null>(null)
  const [phases, setPhases] = useState<ReadonlyMap<string | null, Phase>>(() => new Map())
  const [stoppingChats, setStoppingChats] = useState<ReadonlySet<string>>(() => new Set())
  const [mutating, setMutating] = useState(false)
  const active = useRef(new Map<string | null, Active>())
  const sequence = useRef(0)
  const listSequence = useRef(0)
  const modelSequence = useRef(0)
  const scroll = useRef<HTMLDivElement>(null)
  const messageList = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLElement>(null)
  const mobileMenu = useRef<HTMLButtonElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const follow = useRef(true)
  const previousScrollTop = useRef(0)
  const phase = phases.get(selected)
  const remoteRunId = !phase ? chat?.activeRunId : null
  const remoteStream = !!remoteRunId
  const stopping = selected !== null && stoppingChats.has(selected)
  const busy = !!phase || remoteStream || stopping
  const accountBusy = phases.size > 0 || remoteStream || stoppingChats.size > 0
  const canChangeChat = !mutating
  const home = !chat && !loading
  const namedChat = chats.find((entry) => entry.id === chat?.id && entry.version >= chat.version)
  const chatTitle = namedChat?.title || chat?.title || '新对话'
  const naming = chats.some((entry) => entry.titlePending)

  const handle = useCallback((failure: unknown, write: (message: string) => void) => {
    if (failure instanceof ApiError && (failure.status === 401 || failure.code === 'disabled')) expired()
    else write(errorText(failure))
  }, [expired])

  const reloadModels = useCallback(async () => {
    const ticket = ++modelSequence.current
    setModelError('')
    try {
      const items = await api<Model[]>('/models')
      if (ticket !== modelSequence.current) return
      setModels(items)
      if (!items.length) setModelError('没有可用的模型。')
    } catch (failure) { if (ticket === modelSequence.current) handle(failure, setModelError) }
  }, [handle])

  const reloadList = useCallback(async () => {
    const requestId = ++listSequence.current
    try {
      const list = await api<ChatSummary[]>('/chats')
      if (requestId === listSequence.current) setChats(list)
    } catch (failure) { if (requestId === listSequence.current) handle(failure, setError) }
  }, [handle])

  useEffect(() => {
    if (!naming) return
    const timer = window.setInterval(() => void reloadList(), 1000)
    return () => window.clearInterval(timer)
  }, [naming, reloadList])

  const remember = useCallback((id: string | null) => {
    selectedRef.current = id
    setSelected(id)
    setLocal(`${scope}selected`, id)
  }, [scope])

  const loadChat = useCallback(async (id: string, initial = false) => {
    const ticket = ++sequence.current
    if (initial) setLoading(true)
    try {
      const updated = await api<Chat>(queryChat(id))
      if (selectedRef.current !== id || ticket !== sequence.current || active.current.has(id)) return
      setChat(updated)
    } catch (failure) {
      if (selectedRef.current !== id || ticket !== sequence.current || active.current.has(id)) return
      if (failure instanceof ApiError && failure.status === 404) { remember(null); setChat(null); setText(getLocal(`${scope}draft:new`) || ''); setFiles([]) }
      else handle(failure, setError)
    } finally { if (ticket === sequence.current) setLoading(false) }
  }, [handle, remember, scope])

  const scrollEnd = useCallback(() => {
    const box = scroll.current
    if (box && follow.current) {
      box.scrollTop = box.scrollHeight
      previousScrollTop.current = box.scrollTop
    }
  }, [])

  const followRun = useCallback(async (runId: string, signal: AbortSignal, publish: (snapshot: Chat) => void) => {
    while (!signal.aborted) {
      let snapshot: Chat | undefined
      try {
        for await (const event of respond(runId, signal)) {
          if (signal.aborted) return
          if (event.type === 'start') { snapshot = event.chat; publish(snapshot) }
          else if (event.type === 'done') { publish(event.chat); setQuota(event.usage); return }
          else if (event.type === 'error') throw new ApiError(event.code)
          else if (snapshot) {
            const last = snapshot.messages.at(-1)
            if (snapshot.activeRunId === runId && last && (last.status === 'streaming' || last.status === 'queued')) {
              snapshot = { ...snapshot, messages: [...snapshot.messages.slice(0, -1),
                event.type === 'running' ? { ...last, status: 'streaming' } : event.type === 'thinking' ? { ...last, thinking: event.thinking }
                  : { ...last, content: event.type === 'replace' ? event.content : last.content + event.content }] }
              publish(snapshot)
            }
          }
        }
      } catch (failure) {
        if (signal.aborted) return
        if (!(failure instanceof ApiError) || (!['interrupted', 'network', 'upstream_failed'].includes(failure.code) && failure.status < 500)) throw failure
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 800))
    }
  }, [])

  useEffect(() => {
    void reloadList(); void reloadModels()
    if (selectedRef.current) void loadChat(selectedRef.current, true)
    return () => { for (const execution of active.current.values()) execution.controller.abort() }
  }, [loadChat, reloadList, reloadModels])
  useEffect(() => {
    const refresh = () => {
      void reloadList()
      void reloadModels()
      if (selectedRef.current && !remoteRunId && !active.current.has(selectedRef.current)) void loadChat(selectedRef.current)
      void api<User>('/me').then((value) => setQuota(value.usage), (failure) => handle(failure, setError))
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [handle, reloadList, reloadModels, loadChat, remoteRunId])
  useEffect(() => {
    if (!remoteRunId || !selected) return
    const controller = new AbortController()
    void followRun(remoteRunId, controller.signal, (snapshot) => {
      if (!controller.signal.aborted && selectedRef.current === selected && !active.current.has(selected)) setChat(snapshot)
    }).then(() => { if (!controller.signal.aborted) void reloadList() }, (failure) => {
      if (controller.signal.aborted) return
      handle(failure, setError)
      if (selectedRef.current === selected) void loadChat(selected)
    })
    return () => controller.abort()
  }, [followRun, handle, loadChat, reloadList, remoteRunId, selected])
  useEffect(() => { scrollEnd() }, [chat?.id, chat?.messages.length, scrollEnd, busy])
  useEffect(() => { setDrawer(false) }, [mobile])
  useLayoutEffect(() => {
    if (main.current) main.current.inert = mobile && drawer
  }, [mobile, drawer])
  useLayoutEffect(() => {
    if (!scroll.current || !messageList.current) return
    const observer = new ResizeObserver(scrollEnd)
    observer.observe(scroll.current)
    observer.observe(messageList.current)
    return () => observer.disconnect()
  }, [home, management, loading, scrollEnd])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 1800)
    return () => clearTimeout(timer)
  }, [toast])

  function choose(id: string | null) {
    if (!canChangeChat) return
    setManagement(false); setDrawer(false); setError('')
    if (id === selectedRef.current && (chat || !id)) return
    setLoading(false)
    ++sequence.current
    follow.current = true
    const live = active.current.get(id)?.chat ?? null
    remember(id); setChat(live); setFiles([]); setText(getLocal(`${scope}draft:${id || 'new'}`) || '')
    if (id && !live) void loadChat(id, true)
    else if (!mobile) requestAnimationFrame(() => textarea.current?.focus({ preventScroll: true }))
  }

  function draft(value: string) { setText(value); setLocal(`${scope}draft:${selectedRef.current || 'new'}`, value) }

  function addFiles(incoming: File[]) {
    if (!incoming.length) return
    const next = [...files]
    let size = next.reduce((n, item) => n + item.file.size, 0)
    let issue = ''
    for (const file of incoming) {
      const mime = (file.type || (/\.txt$/i.test(file.name) ? 'text/plain' : /\.pdf$/i.test(file.name) ? 'application/pdf' : '')) as DraftFile['mime']
      if (!acceptedMime.includes(mime) || (mime.startsWith('image/') ? !model?.vision : !model?.files)) { issue = '当前模型不支持此附件格式。'; continue }
      if (!file.size || file.size > MAX_FILE_BYTES || size + file.size > MAX_TURN_BYTES || next.length === MAX_FILES) { issue = '附件超过限制：每个 5 MiB，每轮合计 10 MiB，最多 8 个。'; continue }
      if (file.name.length > 180) { issue = '文件名太长。'; continue }
      size += file.size
      next.push({ file, mime })
    }
    setFiles(next); setError(issue)
  }

  function refreshPhases() {
    setPhases(new Map(Array.from(active.current, ([key, execution]) => [key, execution.phase])))
  }

  async function recover(id: string, signal: AbortSignal, publish: (chat: Chat) => void) {
    while (!signal.aborted) {
      try {
        const snapshot = await api<Chat>(queryChat(id), 'GET', undefined, signal)
        if (signal.aborted) return
        publish(snapshot)
        if (snapshot.activeRunId) await followRun(snapshot.activeRunId, signal, publish)
        else {
          void api<User>('/me').then((value) => setQuota(value.usage), () => {})
        }
        return
      } catch (failure) {
        if (signal.aborted) return
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
          handle(failure, selectedRef.current === id ? setError : setToast)
          return
        }
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_700))
    }
  }

  async function generate(action: Turn['action'], target?: string, edited?: string) {
    let key = selectedRef.current
    if (active.current.has(key) || busy || !model || mutating || loading || (chat?.id ?? null) !== key) return
    if (mobile) textarea.current?.blur()
    const execution: Active = { controller: new AbortController(), chat, phase: 'preparing' }
    active.current.set(key, execution)
    ++sequence.current
    refreshPhases(); setError(''); follow.current = true
    const publish = (snapshot: Chat) => {
      execution.chat = snapshot
      if (selectedRef.current === snapshot.id) setChat(snapshot)
    }
    const clearDraft = (key: string) => { if ((getLocal(key) || '') === text) setLocal(key, null) }
    let settled = false
    let sync = false
    try {
      const encoded = action === 'send' ? await Promise.all(files.map(({ file, mime }) => encodeFile(file, mime))) : []
      if (execution.controller.signal.aborted) return
      if (!execution.chat) {
        const created = await api<Chat>('/chats', 'POST', {}, execution.controller.signal)
        active.current.delete(key)
        key = created.id
        active.current.set(key, execution)
        if (selectedRef.current === null) remember(key)
        publish(created)
        if (text) setLocal(`${scope}draft:${key}`, text)
        clearDraft(`${scope}draft:new`)
        refreshPhases()
        void reloadList()
      }
      const current = execution.chat!
      const id = current.id
      const receipt = await enqueue({
        chatId: id, version: current.version, action, target, model: model.id,
        ...(action === 'send' ? { text, files: encoded } : action === 'edit' ? { text: edited } : {}),
        effort, web: model.web && web,
      }, execution.controller.signal)
      execution.phase = 'streaming'; publish(receipt.chat); refreshPhases()
      if (action === 'send') {
        clearDraft(`${scope}draft:${id}`)
        if (selectedRef.current === id) { setText(''); setFiles([]) }
      }
      void reloadList()
      await followRun(receipt.runId, execution.controller.signal, publish)
      settled = !execution.controller.signal.aborted
    } catch (failure) {
      if (!execution.controller.signal.aborted) {
        sync = !!execution.chat && failure instanceof ApiError && ['interrupted', 'network'].includes(failure.code)
        if (!sync) handle(failure, selectedRef.current === (execution.chat?.id ?? null) ? setError : setToast)
        if (failure instanceof ApiError && ['model_unavailable', 'model_feature'].includes(failure.code)) void reloadModels()
      }
    }
    finally {
      const id = execution.chat?.id
      if (sync && id) {
        execution.phase = 'recovering'; refreshPhases()
        await recover(id, execution.controller.signal, publish)
      }
      if (active.current.get(key) === execution) {
        active.current.delete(key)
        refreshPhases()
      }
      if (!execution.controller.signal.aborted || execution.phase === 'preparing') {
        if (!sync && !settled && id && selectedRef.current === id) void loadChat(id)
        void reloadList()
        if (action === 'send' && !mobile && selectedRef.current === (id ?? null)) {
          requestAnimationFrame(() => { if (selectedRef.current === (id ?? null)) textarea.current?.focus({ preventScroll: true }) })
        }
      }
    }
  }

  async function stop() {
    if (stopping || !busy) return
    const id = selectedRef.current
    const execution = active.current.get(id)
    if (execution?.phase === 'preparing') execution.controller.abort()
    if (!id) return
    setStoppingChats((previous) => new Set(previous).add(id))
    try {
      const finished = await api<{ chat: Chat; usage: Usage }>(`${queryChat(id)}/stop`, 'POST', {})
      if (execution && active.current.get(id) === execution) {
        execution.chat = finished.chat
        if (execution.phase === 'recovering') execution.controller.abort()
      }
      if (selectedRef.current === id) {
        ++sequence.current; setChat(finished.chat); setLoading(false)
      }
      setQuota(finished.usage)
    } catch (failure) { handle(failure, selectedRef.current === id ? setError : setToast) } finally {
      setStoppingChats((previous) => new Set([...previous].filter((chatId) => chatId !== id)))
      void reloadList()
    }
  }

  const chatBusy = (id: string) => phases.has(id) || stoppingChats.has(id) || (id === selected && remoteStream)

  async function changeChat(target: ChatSummary, payload: { title: string } | { selected: string } | null) {
    if (active.current.has(target.id) || chatBusy(target.id) || mutating) return
    setMutating(true); setError('')
    try {
      const { id } = target
      const version = chat?.id === id ? chat.version : target.version
      if (payload) {
        const result = await api<Chat>(queryChat(id), 'PATCH', { version, ...payload })
        if (selectedRef.current === id) {
          if ('selected' in payload) {
            follow.current = true; requestAnimationFrame(scrollEnd)
          }
          setChat(result)
        }
      } else {
        await api(queryChat(id), 'DELETE', { version })
        if (selectedRef.current === id) {
          remember(null); setChat(null); setFiles([]); setText(getLocal(`${scope}draft:new`) || '')
        }
      }
      setDeleting(null); await reloadList()
    } catch (failure) {
      handle(failure, management ? setToast : setError); setDeleting(null); void reloadList()
      if (selectedRef.current === target.id) void loadChat(target.id)
    }
    finally { setMutating(false) }
  }

  async function signOut() {
    setAccountError('')
    try { await api('/auth/sign-out', 'POST', {}); updateUser(null) } catch (failure) { handle(failure, setAccountError) }
  }

  function collapseSidebar(value: boolean) {
    setCollapsed(value); setLocal(`${scope}collapsed`, value ? '1' : null)
  }

  function closeDrawer() {
    setDrawer(false)
    requestAnimationFrame(() => mobileMenu.current?.focus({ preventScroll: true }))
  }

  const mobileHeader = (label?: string) => <header className={mobileStyle.header}>
    <button type="button" ref={mobileMenu} className="icon-button round-icon large-icon" aria-label="打开对话侧栏" title="打开对话侧栏"
      aria-expanded={drawer} onClick={() => setDrawer(true)}><Menu size={20} /></button>
    {label ? <div className={mobileStyle.title} title={label}>{label}</div>
      : <div className={clsx(mobileStyle.brand, 'brand')}><Mark size={24} /><span>{brand}</span></div>}
    {management ? <IconButton label="返回对话" className="round-icon large-icon" onClick={() => setManagement(false)}><ArrowLeft size={20} /></IconButton>
      : label && <IconButton label="开启新对话" className="round-icon large-icon" disabled={!canChangeChat} onClick={() => choose(null)}><MessageSquarePlus size={20} /></IconButton>}
  </header>

  const composer = <>
    {modelError && <div className="model-feedback"><Notice>{modelError}</Notice><IconButton label="刷新模型" onClick={() => void reloadModels()}><RefreshCw size={16} /></IconButton></div>}
    {error && <div className="model-feedback"><Notice>{error}</Notice><IconButton label="关闭提示" onClick={() => setError('')}><X size={16} /></IconButton></div>}
    <Composer home={home} text={text} change={draft} files={files} add={addFiles} remove={(index) => setFiles(files.filter((_, i) => i !== index))}
      model={model} models={models} selectModel={(next) => { setModelId(next); setLocal(`${scope}model`, next); setWeb(false) }}
      effort={effort} setEffort={(next) => {
        if (!model || (next && !model.efforts.includes(next))) return
        setPrefs((previous) => ({ ...previous, [model.id]: next }))
        setLocal(`${scope}effort:${model.id}`, next ?? null)
      }}
      web={web} setWeb={setWeb} busy={busy} disabled={loading || mutating}
      preparing={phase === 'preparing'} generating={chat?.id === selected && Boolean(chat?.activeRunId)} stopping={stopping}
      submit={() => void generate('send')} stop={() => void stop()} textarea={textarea} />
  </>

  return <div className="workspace" ref={frame}>
    {mobile && drawer && <button className={clsx(siderStyle.drawerMask, 'drawer-mask')} aria-label="关闭侧栏" tabIndex={-1} onClick={closeDrawer} />}
    {(mobile ? drawer : !collapsed) && <WorkspaceSidebar chats={chats} selected={!management ? selected : null} mobile={mobile}
      disabled={!canChangeChat} actionsDisabled={(id) => chatBusy(id) || mutating} searching={searching} choose={choose}
      collapse={mobile ? closeDrawer : () => collapseSidebar(true)} onCloseSearch={() => setSearching(false)}
      onSettings={() => { setSettings(true); setDrawer(false); setAccountError('') }}
      onRename={(item, title) => void changeChat(item, { title })} onDelete={setDeleting} />}
    <main className="workspace-main" ref={main}>
      {!mobile && collapsed && <CollapsedSidebar disabled={!canChangeChat} expand={() => collapseSidebar(false)} create={() => choose(null)} />}
      {management ? <>
        {mobile ? mobileHeader('站点管理') : <header className={viewStyle.header}>
          <IconButton label="返回对话" className={clsx('round-icon', collapsed && viewStyle.withCollapsedSider)} onClick={() => setManagement(false)}><ArrowLeft size={18} /></IconButton>
        </header>}
        <Admin modelsChanged={() => void reloadModels()} />
      </> : home ? <div className={homeStyle.container}>
        {mobile && mobileHeader()}
        <div className={homeStyle.welcome}>
          {!mobile && <div className={clsx(homeStyle.signature, 'brand')}><Mark size={46} />{collapsed && <span>{brand}</span>}</div>}
          <h1 className={homeStyle.greeting}>今天有什么可以帮到你？</h1>
          {composer}
          {mobile && <div className={viewStyle.caveat}>{caveat}</div>}
        </div>
      </div> : <div className={viewStyle.view}>
        {mobile ? mobileHeader(chatTitle) : <header className={viewStyle.header}>
          {chat && <div className={clsx(viewStyle.title, collapsed && viewStyle.withCollapsedSider)} title={chatTitle}>{chatTitle}</div>}
        </header>}
        <div className={clsx(listStyle.container, 'message-list')}>
          <div className="conversation-scroll" ref={scroll} onScroll={() => {
            const el = scroll.current
            if (!el) return
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) follow.current = true
            else if (el.scrollTop < previousScrollTop.current) follow.current = false
            previousScrollTop.current = el.scrollTop
          }}>
            {loading ? <div className="session-loading"><Loading label="正在加载对话..." /></div> : chat &&
              <div className={listStyle.column} ref={messageList}>
                {chat.messages.map((message, index) => <MessageItem key={message.id} message={message} first={index === 0} last={index === chat.messages.length - 1}
                  busy={busy || mutating} contextLimit={model?.limits?.contextChars ?? DEFAULT_MODEL_LIMITS.contextChars}
                  branch={(id) => void changeChat(chat, { selected: id })} edit={(id, value) => void generate('edit', id, value)}
                  retry={(id) => void generate('retry', id)} onUpdate={scrollEnd} notify={setToast} />)}
              </div>}
          </div>
          {!loading && <div className={viewStyle.inputContainer}>
            {composer}<div className={viewStyle.caveat}>{caveat}</div>
          </div>}
        </div>
      </div>}
    </main>
    {toast && <div className="toast" role="status">{toast}</div>}
    {settings && <WorkspaceSettings user={user} usage={quota} busy={accountBusy || mutating}
      close={() => setSettings(false)} error={accountError} search={() => {
        setSettings(false); setSearching(true)
        if (mobile) setDrawer(true)
        else collapseSidebar(false)
      }} manage={() => { setSettings(false); setManagement(true) }} signOut={() => void signOut()} />}
    {deleting && <Modal title="永久删除对话" close={() => { if (!mutating) setDeleting(null) }}>
      <p className="modal-copy">删除后，该对话及其中上传的文件将不可恢复。确认删除吗？</p>
      <div className="modal-actions"><button className="button secondary" disabled={mutating} onClick={() => setDeleting(null)}>取消</button>
        <button className="button danger" disabled={mutating} onClick={() => void changeChat(deleting, null)}>删除</button></div>
    </Modal>}
  </div>
}
