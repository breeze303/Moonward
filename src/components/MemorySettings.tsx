import { useEffect, useId, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { api, errorText } from '../services/api/appClient.ts'
import { IconButton, Notice } from './ui.tsx'
import './memory.css'

type Item = {
  id: string
  body: string
  scope: string
  revision: number
  changed: string
  origin: string | null
  source: string | null
  locked: boolean
}
type View = { enabled: boolean; automatic: boolean; items: Item[] }

function MemorySwitch({ title, description, checked, disabled, change }: {
  title: string; description: string; checked: boolean; disabled: boolean; change: (value: boolean) => void
}) {
  const id = useId()
  return (
    <label className="memory-preference">
      <span className="memory-preference-copy">
        <span id={`${id}-title`}>{title}</span>
        <small id={`${id}-description`}>{description}</small>
      </span>
      <input className="memory-switch" type="checkbox" role="switch" aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`} checked={checked} disabled={disabled}
        onChange={(e) => change(e.target.checked)} />
    </label>
  )
}

export function MemorySettings() {
  const [view, set] = useState<View | null>(null),
    [error, fail] = useState(''),
    [pending, busy] = useState(false),
    [body, text] = useState(''),
    [scope, area] = useState(''),
    [editing, edit] = useState<Item | null>(null),
    [confirm, ask] = useState(false)
  const refresh = () => api<View>('/memory').then(set)
  useEffect(() => {
    void refresh().catch((e) => fail(errorText(e)))
  }, [])
  function reset() {
    edit(null)
    text('')
    area('')
  }
  async function setPreference(key: 'enabled' | 'automatic', value: boolean) {
    if (!view || pending) return
    busy(true)
    fail('')
    set({ ...view, [key]: value })
    try {
      await api('/memory/settings', 'PATCH', { [key]: value })
    } catch (e) {
      set(view)
      fail(errorText(e))
    } finally {
      busy(false)
    }
  }
  async function write(path: string, method: string, data: unknown) {
    if (pending) return
    busy(true)
    fail('')
    try {
      await api(path, method, data)
      await refresh()
      reset()
      ask(false)
    } catch (e) {
      fail(errorText(e))
    } finally {
      busy(false)
    }
  }
  return (
    <div className="memory-settings">
      <h3>记忆</h3>
      {error && <Notice>{error}</Notice>}
      {view && (
        <>
          <div>
            <MemorySwitch title="使用已保存的记忆" checked={view.enabled} disabled={pending}
              description="相关记忆会随消息发送给当前模型网关。关闭后保留条目，但不再读取或保存。"
              change={(value) => void setPreference('enabled', value)} />
            <MemorySwitch title="从聊天中自动记忆" checked={view.enabled && view.automatic} disabled={!view.enabled || pending}
              description="开启后，符合条件的新消息可发送给管理员指定的提取模型，可能产生额外费用。"
              change={(value) => void setPreference('automatic', value)} />
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void write(
                editing ? `/memory/${editing.id}` : '/memory',
                'POST',
                editing ? { action: 'edit', revision: editing.revision, body, scope } : { body, scope },
              )
            }}
          >
            <label>
              记忆内容
              <span className="memory-editor">
                <span className="memory-editor-mirror" aria-hidden="true">{`${body}\n`}</span>
                <textarea className="memory-field" rows={1} required maxLength={500} value={body}
                  onChange={(e) => text(e.target.value)} />
              </span>
            </label>
            <label>
              适用主题
              <input
                className="memory-field"
                maxLength={60}
                placeholder="通用（留空）或项目名"
                value={scope}
                onChange={(e) => area(e.target.value)}
              />
            </label>
            <div>
              <button className="button secondary" disabled={pending || !view.enabled || !body.trim()}>
                {editing ? '保存修改' : '添加记忆'}
              </button>{' '}
              {editing && (
                <button type="button" className="text-button" onClick={reset}>
                  取消
                </button>
              )}
            </div>
          </form>
          <h4>已保存 · {view.items.length}</h4>
          {view.items.map((m) => (
            <div className="memory-row" key={m.id}>
              <div>
                <strong>{m.body}</strong>
                <small>
                  {m.scope || '通用'} ·{' '}
                  {m.origin || (m.source ? '未命名对话' : m.locked ? '手动记录' : '来源已移除')} ·{' '}
                  {new Date(m.changed).toLocaleDateString()}
                </small>
              </div>
              <IconButton
                label="编辑记忆"
                disabled={pending || !view.enabled}
                onClick={() => {
                  edit(m)
                  text(m.body)
                  area(m.scope)
                }}
              >
                <Pencil size={15} />
              </IconButton>
              <IconButton
                label="删除记忆"
                disabled={pending}
                onClick={() => void write(`/memory/${m.id}`, 'POST', { action: 'delete', revision: m.revision })}
              >
                <Trash2 size={15} />
              </IconButton>
            </div>
          ))}
          {!!view.items.length && (
            <div className="memory-clear-actions">
              <button
                type="button" className="button danger memory-clear"
                disabled={pending}
                onClick={() => (confirm ? void write('/memory', 'DELETE', { confirm: true }) : ask(true))}
              >
                <Trash2 size={15} aria-hidden="true" />
                {confirm ? '确认永久清空全部记忆' : '清空全部记忆'}
              </button>
              {confirm && (
                <button className="text-button" onClick={() => ask(false)}>
                  取消
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
