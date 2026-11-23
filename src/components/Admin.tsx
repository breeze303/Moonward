import { Check, Copy, KeyRound, PencilLine, Plus, RefreshCw, Save, Search, Trash2, UserPlus, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../shared/contract.ts'
import type { AdminAccountsView, AdminUser, AdminUserInput, AdminUserPatch, GatewaySettings, Usage } from '../../shared/contract.ts'
import { api, errorText } from '../services/api/appClient.ts'
import { copyText } from '../utils/clipboard.js'
import { AdminModels } from './AdminModels.tsx'
import { IconButton, Loading, Modal, Notice } from './ui.tsx'
import styles from './AdminModels.module.css'

function LimitField({ label, initial, disabled, save, min=0, max=100_000 }: { label: string; initial: number; disabled: boolean; save: (value: number) => Promise<void>; min?:number; max?:number }) {
  const [value, setValue] = useState(String(initial))
  const [pending, setPending] = useState(false)
  useEffect(() => { setValue(String(initial)) }, [initial])
  return <form className="limit-field" onSubmit={(event) => {
    event.preventDefault()
    if (disabled || pending || Number(value) === initial) return
    setPending(true)
    void save(Number(value)).finally(() => setPending(false))
  }}><input aria-label={label} type="number" min={min} max={max} step={1} required disabled={disabled || pending} value={value} onChange={(e) => setValue(e.target.value)} />
    <IconButton type="submit" label={`保存${label}`} disabled={disabled || pending || Number(value) === initial}><Check size={16} /></IconButton>
  </form>
}

export function Admin({ modelsChanged }: { modelsChanged: () => void }) {
  const [view, setView] = useState<'accounts' | 'gateway' | 'models'>('accounts')
  return <section className="admin-view" aria-label="站点管理">
    <div className="admin-header"><h1>站点管理</h1></div>
    <nav className="admin-tabs" aria-label="管理分类">
      <button type="button" aria-pressed={view === 'accounts'} onClick={() => setView('accounts')}>用户与用量</button>
      <button type="button" aria-pressed={view === 'gateway'} onClick={() => setView('gateway')}>API 配置</button>
      <button type="button" aria-pressed={view === 'models'} onClick={() => setView('models')}>模型管理</button>
    </nav>
    {view === 'accounts' ? <AdminAccounts /> : view === 'gateway' ? <AdminGateway changed={modelsChanged} /> : <AdminModels changed={modelsChanged} />}
  </section>
}

function AdminGateway({ changed }: { changed: () => void }) {
  const [settings, setSettings] = useState<GatewaySettings | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const refresh = useCallback(async () => {
    setPending(true); setError(''); setSaved(false); setApiKey('')
    try {
      const current = await api<GatewaySettings>('/admin/gateway')
      setSettings(current); setBaseUrl(current.baseUrl)
    } catch (failure) { setError(errorText(failure)) }
    finally { setPending(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings || pending) return
    setPending(true); setError(''); setSaved(false)
    try {
      const updated = await api<GatewaySettings>('/admin/gateway', 'PUT', {
        version: settings.version, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setSettings(updated); setBaseUrl(updated.baseUrl); setApiKey(''); setSaved(true)
      changed()
    } catch (failure) { setError(errorText(failure)) }
    finally { setPending(false) }
  }

  return <section aria-label="API 配置">
    <div className={styles.toolbar}>
      <h2>模型网关</h2>
      <IconButton label="重新读取 API 配置" onClick={() => void refresh()} disabled={pending}><RefreshCw size={16} /></IconButton>
    </div>
    {error && <Notice>{error}</Notice>}
    {!settings ? !error && <Loading /> : <form className={`${styles.form} ${styles.gateway}`} onSubmit={(event) => void save(event)} autoComplete="off">
      <fieldset className={styles.fields} disabled={pending}>
        <label>API 基础地址<input type="url" required maxLength={2048} value={baseUrl} placeholder="https://api.openai.com/v1"
          onChange={(event) => { setBaseUrl(event.target.value); setSaved(false) }} /></label>
        <label>API Key<input type="password" autoComplete="new-password" required={!settings.hasKey || baseUrl.trim() !== settings.baseUrl}
          maxLength={4096} value={apiKey} placeholder={settings.hasKey ? '已配置，留空保留' : '输入 API Key'}
          onChange={(event) => { setApiKey(event.target.value); setSaved(false) }} /></label>
      </fieldset>
      <div className="actions"><button className="button primary" type="submit" disabled={pending}>
        <Save size={16} />{pending ? '正在验证…' : '验证并保存'}
      </button></div>
    </form>}
    {saved && <div className={styles.saved} role="status"><Check size={16} />API 配置已保存</div>}
  </section>
}

function AdminAccounts() {
  const [data, setData] = useState<AdminAccountsView | null>(null)
  const [error, setError] = useState('')
  const [invite, setInvite] = useState(false)
  const [editor, setEditor] = useState<AdminUser | 'new' | null>(null)
  const [remove, setRemove] = useState<AdminUser | null>(null)
  const [query, setQuery] = useState('')
  const [email, setEmail] = useState('')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [confirm, setConfirm] = useState<AdminUser | null>(null)
  const busy = pending || refreshing
  const needle = query.trim().toLocaleLowerCase()
  const filteredUsers = (data?.users ?? []).filter((user) =>
    user.name.toLocaleLowerCase().includes(needle) || user.email.toLocaleLowerCase().includes(needle))
  const refresh = useCallback(async () => {
    setRefreshing(true); setError('')
    try { setData(await api<AdminAccountsView>('/admin')) }
    catch (failure) { setError(errorText(failure)) } finally { setRefreshing(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function createUser(input: AdminUserInput) {
    setPending(true); setError('')
    try {
      const user = await api<AdminUser>('/admin/users', 'POST', input)
      setData((current) => current && { ...current, users: [...current.users, user].sort(sortUsers) })
      setQuery('')
      setEditor(null)
    } catch (failure) { setError(errorText(failure)) } finally { setPending(false) }
  }

  async function patchUser(id: string, change: AdminUserPatch) {
    setPending(true); setError('')
    try {
      const updated = await api<AdminUser>(`/admin/users/${id}`, 'PATCH', change)
      setData((current) => current && { ...current, users: current.users.map((user) => user.id === id ? updated : user).sort(sortUsers) })
      if (editor && editor !== 'new' && editor.id === id) setEditor(null)
      if (confirm?.id === id) setConfirm(null)
    } catch (failure) { setError(errorText(failure)) } finally { setPending(false) }
  }

  async function removeUser(user: AdminUser) {
    setPending(true); setError('')
    try {
      await api<void>(`/admin/users/${user.id}`, 'DELETE')
      setData((current) => current && { ...current, users: current.users.filter((item) => item.id !== user.id) })
      setRemove(null)
    } catch (failure) { setError(errorText(failure)) } finally { setPending(false) }
  }

  async function inviteUser(event: FormEvent) {
    event.preventDefault()
    setPending(true); setError('')
    try { setLink((await api<{ url: string }>('/admin/invitations', 'POST', { email })).url) }
    catch (failure) { setError(errorText(failure)) } finally { setPending(false) }
  }

  return <section aria-label="用户与用量">
    <div className="admin-header"><h2>用量</h2>
      <div className="actions">{data && <time dateTime={data.site.day}>{data.site.day} UTC</time>}
        <IconButton label="刷新用量" onClick={() => void refresh()} disabled={busy}><RefreshCw size={17} /></IconButton></div></div>
    {error && !invite && !editor && !confirm && !remove && <Notice>{error}</Notice>}
    {!data ? !error && <Loading /> : <>
      <div className="metrics"><div><span>今日请求</span><strong>{data.site.count} <small>/ {data.site.limit}</small></strong></div>
        <div><span>输入 / 输出 token</span><strong>{data.site.inputTokens.toLocaleString()} <small>/ {data.site.outputTokens.toLocaleString()}</small></strong></div>
        <div><span>全站每日上限</span><LimitField label="全站每日上限" initial={data.site.limit} disabled={busy} save={async (limit) => {
          setPending(true); setError('')
          try { const site = await api<Usage>('/admin/site', 'PATCH', { limit }); setData((current) => current && { ...current, site }) }
          catch (failure) { setError(errorText(failure)) } finally { setPending(false) }
        }} /></div>
      </div>
      {data.capacity && <div className="metrics">{(['running','waiting'] as const).map(key=>{
        const label=key==='running'?'同时生成上限':'等待队列上限'
        return <div key={key}><span>{label}</span><LimitField label={label} min={key==='running'?1:0} max={key==='running'?1000:10000} initial={data.capacity![key]} disabled={busy} save={async value=>{
          setPending(true);setError('');try{const capacity=await api<NonNullable<AdminAccountsView['capacity']>>('/admin/capacity','PATCH',{[key]:value});setData(current=>current&&{...current,capacity})}catch(e){setError(errorText(e))}finally{setPending(false)}
        }}/></div>
      })}</div>}
      <div className="admin-header user-toolbar">
        <div className="table-title"><Users size={17} aria-hidden="true" /><h2>用户</h2><span>{filteredUsers.length}{filteredUsers.length !== data.users.length ? ` / ${data.users.length}` : ''}</span></div>
        <div className="actions">
          <button className="button secondary" disabled={busy} onClick={() => { setInvite(true); setEmail(''); setLink(''); setCopied(false); setError('') }}><UserPlus size={16} />邀请用户</button>
          <button className="button primary" disabled={busy} onClick={() => { setEditor('new'); setError('') }}><Plus size={16} />新增用户</button>
        </div>
      </div>
      <div className="user-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索用户" type="search" value={query} placeholder="搜索姓名或邮箱" onChange={(event) => setQuery(event.target.value)} /></div>
      {filteredUsers.length === 0 ? <p className="users-empty" role="status">未找到用户</p> :
        <table className="users-table" role="table" aria-label="用户列表">
          <thead><tr><th scope="col">用户</th><th scope="col">状态</th><th scope="col">今日请求</th><th scope="col">每日上限</th><th scope="col">操作</th></tr></thead>
          <tbody role="rowgroup">{filteredUsers.map((user) => <tr key={user.id} role="row">
            <td className="user-identity" role="cell"><strong>{user.name}</strong><span className="email">{user.email}</span></td>
            <td className="user-status" role="cell"><span className={`badge ${user.disabled ? 'muted' : ''}`}>{user.role === 'admin' ? '管理员' : user.disabled ? '已停用' : '正常'}</span></td>
            <td className="user-count" role="cell"><span className="user-mobile-label" aria-hidden="true">今日请求</span>{user.usage.count}</td>
            <td className="user-limit" role="cell"><span className="user-mobile-label" aria-hidden="true">每日上限</span><LimitField label={`${user.name}的每日上限`} initial={user.usage.limit} disabled={busy} save={(limit) => patchUser(user.id, { limit })} /></td>
            <td role="cell"><div className="user-actions"><IconButton label={`编辑 ${user.name}`} disabled={busy} onClick={() => { setEditor(user); setError('') }}><PencilLine size={16} /></IconButton>
              {user.role !== 'admin' && <><button className={`text-button ${user.disabled ? '' : 'danger-text'}`} disabled={busy} onClick={() => { setConfirm(user); setError('') }}>{user.disabled ? '启用' : '停用'}</button>
                <IconButton label={`删除 ${user.name}`} className="danger-icon" disabled={busy} onClick={() => { setRemove(user); setError('') }}><Trash2 size={16} /></IconButton></>}
            </div></td>
          </tr>)}</tbody>
        </table>}
    </>}
    {data && editor && <UserEditor initial={editor === 'new' ? undefined : editor} defaultLimit={data.defaultUserLimit} pending={pending} error={error}
      close={() => { if (!pending) { setEditor(null); setError('') } }}
      onCreate={createUser} onUpdate={patchUser} />}
    {invite && <Modal title="邀请用户" close={() => { if (!pending) { setInvite(false); setError('') } }}>
      {error && <Notice>{error}</Notice>}
      {!link ? <form className="modal-form" onSubmit={(event) => void inviteUser(event)}><label>受邀邮箱<input autoFocus type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <div className="modal-actions"><button className="button secondary" type="button" disabled={pending} onClick={() => { setInvite(false); setError('') }}>取消</button><button className="button primary" type="submit" disabled={pending}>生成邀请</button></div></form>
      : <div className="modal-form"><label>邀请链接（24 小时有效）<input value={link} readOnly onFocus={(e) => e.target.select()} /></label>
        <div className="modal-actions"><button className="button primary" onClick={() => { void copyText(link).then((ok) => { setCopied(ok); if (!ok) setError('无法复制链接。') }) }}><Copy size={16} />{copied ? '已复制' : '复制链接'}</button></div></div>}
    </Modal>}
    {confirm && <Modal title={`${confirm.disabled ? '启用' : '停用'}账号`} close={() => { if (!pending) { setConfirm(null); setError('') } }}>
      <p className="modal-copy">{confirm.email}</p>{error && <Notice>{error}</Notice>}
      <div className="modal-actions"><button className="button secondary" disabled={pending} onClick={() => { setConfirm(null); setError('') }}>取消</button>
        <button className={`button ${confirm.disabled ? 'primary' : 'danger'}`} disabled={pending} onClick={() => void patchUser(confirm.id, { disabled: !confirm.disabled })}>确认{confirm.disabled ? '启用' : '停用'}</button></div>
    </Modal>}
    {remove && <Modal title="删除账号" close={() => { if (!pending) { setRemove(null); setError('') } }}>
      <p className="modal-copy">将永久删除 <strong>{remove.email}</strong> 的账号、聊天和附件。</p>
      {error && <Notice>{error}</Notice>}
      <div className="modal-actions"><button className="button secondary" disabled={pending} onClick={() => { setRemove(null); setError('') }}>取消</button>
        <button className="button danger" disabled={pending} onClick={() => void removeUser(remove)}><Trash2 size={16} />确认删除</button></div>
    </Modal>}
  </section>
}

function sortUsers(left: AdminUser, right: AdminUser) {
  return left.role.localeCompare(right.role) || left.name.localeCompare(right.name) || left.email.localeCompare(right.email)
}

function UserEditor({ initial, defaultLimit, pending, error, close, onCreate, onUpdate }: {
  initial?: AdminUser; defaultLimit: number; pending: boolean; error: string; close: () => void
  onCreate: (input: AdminUserInput) => Promise<void>
  onUpdate: (id: string, change: AdminUserPatch) => Promise<void>
}) {
  const [email, setEmail] = useState(initial?.email || '')
  const [name, setName] = useState(initial?.name || '')
  const [password, setPassword] = useState('')
  const [limit, setLimit] = useState(String(initial?.usage.limit ?? defaultLimit))
  const editing = Boolean(initial)
  return <Modal title={editing ? '编辑用户' : '新增用户'} close={close}>
    {error && <Notice>{error}</Notice>}
    <form className="modal-form" autoComplete="off" onSubmit={(event) => {
      event.preventDefault()
      const input = { email: email.trim().toLowerCase(), name: name.trim(), password, limit: Number(limit) }
      if (initial) void onUpdate(initial.id, { email: input.email, name: input.name, limit: input.limit, ...(password ? { password } : {}) })
      else void onCreate(input)
    }}>
      <label>邮箱<input autoFocus type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label>显示名称<input required maxLength={60} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{editing ? '新密码' : '密码'}<input type="password" minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} required={!editing} autoComplete="new-password" placeholder={editing ? '留空表示不修改' : `至少 ${MIN_PASSWORD_LENGTH} 个字符`} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label>每日请求上限<input type="number" min={0} max={100_000} step={1} required value={limit} onChange={(event) => setLimit(event.target.value)} /></label>
      {editing && <p className="modal-hint"><KeyRound size={14} />修改邮箱或密码后，该用户需要重新登录。</p>}
      <div className="modal-actions"><button className="button secondary" type="button" onClick={close} disabled={pending}>取消</button><button className="button primary" type="submit" disabled={pending}>{pending ? '保存中…' : editing ? '保存修改' : '创建账号'}</button></div>
    </form>
  </Modal>
}
