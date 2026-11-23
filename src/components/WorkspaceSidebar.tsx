import clsx from 'clsx'
import { Check, Ellipsis, MessageSquarePlus, PanelLeft, PencilLine, Search, Settings, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ChatSummary } from '../../shared/contract.ts'
import { brand } from '../app/brand.ts'
import { Menu } from './chat-demo/Menu.tsx'
import itemStyle from './chat-demo/SessionItem.module.css'
import style from './chat-demo/Sider.module.css'
import { IconButton, Mark } from './ui.tsx'

type SidebarProps = {
  chats: ChatSummary[]
  selected: string | null
  mobile: boolean
  disabled: boolean
  actionsDisabled: (id: string) => boolean
  searching: boolean
  choose: (id: string | null) => void
  collapse: () => void
  onSettings: () => void
  onCloseSearch: () => void
  onRename: (chat: ChatSummary, title: string) => void
  onDelete: (chat: ChatSummary) => void
}

const month = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' })
const calendarDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())

function groupChats(chats: ChatSummary[]) {
  const today = calendarDay(new Date())
  const groups = new Map<string, ChatSummary[]>()
  for (const chat of chats) {
    const date = new Date(chat.updatedAt)
    const days = (today - calendarDay(date)) / 86_400_000
    const group = days <= 0 ? '今天' : days === 1 ? '昨天' : days < 7 ? '7 天内' : days < 30 ? '30 天内' : month.format(date)
    const entries = groups.get(group)
    if (entries) entries.push(chat)
    else groups.set(group, [chat])
  }
  return groups
}

function HistoryItem({ chat, active, disabled, actionsDisabled, choose, onRename, onDelete }: {
  chat: ChatSummary; active: boolean; disabled: boolean; actionsDisabled: boolean
  choose: SidebarProps['choose']; onRename: SidebarProps['onRename']; onDelete: SidebarProps['onDelete']
}) {
  const [editing, setEditing] = useState(false)
  const actionRef = useRef<HTMLDivElement>(null)
  const title = chat.title || '新对话'
  function finish() {
    setEditing(false)
    requestAnimationFrame(() => actionRef.current?.querySelector('button')?.focus({ preventScroll: true }))
  }

  return <div className={clsx(itemStyle.item, active && itemStyle.active, 'history-item')}>
    {editing ? <form className={itemStyle.rename} onSubmit={(event) => {
      event.preventDefault()
      const value = String(new FormData(event.currentTarget).get('title') || '').trim()
      if (!value || actionsDisabled) return
      if (value !== title) onRename(chat, value)
      finish()
    }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.stopPropagation(); finish() }
    }}>
      <input name="title" className={itemStyle.renameInput} defaultValue={title} aria-label="对话名称"
        required maxLength={100} autoFocus onFocus={(event) => event.target.select()} />
      <IconButton type="submit" label="保存名称" className="compact-icon" disabled={actionsDisabled}><Check size={15} /></IconButton>
      <IconButton label="取消重命名" className="compact-icon" onClick={finish}><X size={14} /></IconButton>
    </form> : <>
      <button type="button" className={clsx(itemStyle.title, 'history-title')} title={title} disabled={disabled}
        aria-current={active ? 'page' : undefined} onClick={() => choose(chat.id)}>{title}</button>
      <div ref={actionRef} className={itemStyle.action}>
        <Menu options={[
          { key: 'rename', label: '重命名', icon: <PencilLine size={16} />, onSelect: () => setEditing(true) },
          { key: 'delete', label: '删除', icon: <Trash2 size={16} />, danger: true, onSelect: () => onDelete(chat) },
        ]}>{({ open, toggle, menuId }) => <IconButton className="round-icon compact-icon" label={`${title}：更多`}
          aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
          disabled={actionsDisabled} onClick={toggle}><Ellipsis size={16} /></IconButton>}</Menu>
      </div>
    </>}
  </div>
}

export function WorkspaceSidebar({ chats, selected, mobile, disabled, actionsDisabled, searching, choose, collapse,
  onSettings, onCloseSearch, onRename, onDelete }: SidebarProps) {
  const [query, setQuery] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const collapseButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (searching) searchInput.current?.focus({ preventScroll: true })
    else if (mobile) collapseButton.current?.focus({ preventScroll: true })
  }, [mobile, searching])
  const match = searching ? query.trim().toLocaleLowerCase() : ''
  const groups = groupChats(match ? chats.filter((chat) => (chat.title || '新对话').toLocaleLowerCase().includes(match)) : chats)

  return <aside className={clsx(style.sider, mobile && style.mobile, mobile && style.drawer)} aria-label="对话侧栏"
    onKeyDown={(event) => { if (mobile && event.key === 'Escape' && !event.defaultPrevented) collapse() }}>
    <div className={style.top}>
      <div className="brand"><Mark size={26} /><span>{brand}</span></div>
      <button ref={collapseButton} type="button" className="icon-button round-icon" aria-label="收起侧栏" title="收起侧栏" onClick={collapse}>
        <PanelLeft size={16} />
      </button>
    </div>
    <button type="button" className={style.newChat} disabled={disabled} onClick={() => choose(null)}>
      <span className={style.newChatIcon}><MessageSquarePlus size={16} /></span>开启新对话
    </button>
    {searching && <div className={clsx(style.search, 'history-search')}>
      <div className={style.searchField}>
        <Search size={16} aria-hidden="true" />
        <input ref={searchInput} type="search" aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={(event) => setQuery(event.target.value)} />
        {query && <IconButton label="清空搜索" className="compact-icon" onClick={() => { setQuery(''); searchInput.current?.focus() }}><X size={13} /></IconButton>}
      </div>
      <button type="button" className={style.searchClose} aria-label="关闭搜索" onClick={() => { setQuery(''); onCloseSearch() }}>关闭</button>
    </div>}
    <div className={style.listWrap}>
      <nav className={style.list} aria-label="对话历史">
        {match && !groups.size && <p className={style.sectionHeader}>没有匹配的对话</p>}
        {Array.from(groups, ([label, entries]) => <section key={label} className={style.section}>
          <h2 className={style.sectionHeader}>{label}</h2>
          {entries.map((chat) => <HistoryItem key={chat.id} chat={chat} active={chat.id === selected} disabled={disabled}
            actionsDisabled={actionsDisabled(chat.id)} choose={choose} onRename={onRename} onDelete={onDelete} />)}
        </section>)}
      </nav>
    </div>
    <div className={style.bottom}>
      <button type="button" className={style.settings} onClick={onSettings}>
        <span className={style.settingsIcon}><Settings size={16} /></span><span className={style.settingsLabel}>设置</span>
      </button>
    </div>
  </aside>
}

export function CollapsedSidebar({ expand, create, disabled }: { expand: () => void; create: () => void; disabled: boolean }) {
  return <div className={style.collapsed}><div className={style.collapsedGroup}>
    <IconButton label="打开对话侧栏" className="round-icon" onClick={expand}><PanelLeft size={16} /></IconButton>
    <IconButton label="开启新对话" className="round-icon" disabled={disabled} onClick={create}><MessageSquarePlus size={16} /></IconButton>
  </div></div>
}
