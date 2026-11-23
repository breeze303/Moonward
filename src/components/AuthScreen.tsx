import { ArrowRight, Eye, EyeOff, LockKeyhole, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../shared/contract.ts'
import type { User } from '../../shared/contract.ts'
import { brand } from '../app/brand.ts'
import { toggleTheme, useTheme } from '../app/theme.ts'
import { api, ApiError, errorText } from '../services/api/appClient.ts'
import { IconButton, Loading, Mark, Notice } from './ui.tsx'

export function AuthScreen({ setup, waiting, invite, closeInvite, signedIn, setupChanged, initialError }: {
  setup: boolean; waiting: boolean; invite: string | null; closeInvite: () => void; signedIn: (user: User) => void; setupChanged: () => void; initialError: string
}) {
  const theme = useTheme()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [valid, setValid] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const creating = setup || !!invite
  useEffect(() => {
    if (!invite) return
    const controller = new AbortController()
    api<{ email: string }>('/invite/inspect', 'POST', { token: invite }, controller.signal).then((record) => {
      setEmail(record.email); setValid(true)
    }, (failure) => {
      if (!controller.signal.aborted) { setError(errorText(failure)); setValid(false) }
    })
    return () => controller.abort()
  }, [invite])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setPending(true); setError('')
    let created = false
    try {
      if (setup) {
        await api('/setup', 'POST', { email: email.trim(), name, password })
        created = true
      } else if (invite) {
        await api('/invite/redeem', 'POST', { token: invite, name, password })
      }
      await api('/auth/sign-in/email', 'POST', { email: email.trim(), password })
      if (invite) closeInvite()
      signedIn(await api<User>('/me'))
    } catch (failure) {
      setError(errorText(failure))
      if (setup && (created || failure instanceof ApiError && failure.code === 'admin_exists')) setupChanged()
    } finally { setPending(false) }
  }

  return <div className="auth-page">
    <header className="auth-top"><div className="brand"><Mark /><span>{brand}</span></div><IconButton label={theme === 'dark' ? '切换浅色' : '切换深色'} onClick={toggleTheme}>{theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}</IconButton></header>
    <main className="auth-main">
      <div className="auth-symbol"><LockKeyhole size={23} strokeWidth={1.7} /></div>
      <h1>{waiting ? '等待站点初始化' : setup ? '设置管理员账户' : invite ? '接受邀请' : `登录 ${brand}`}</h1>
      {waiting && <><p className="auth-foot">管理员完成首次设置后即可登录。</p><button type="button" className="text-button" onClick={setupChanged}>刷新状态</button></>}
      {invite && valid === null && <Loading label="正在验证邀请" />}
      {(error || (!invite && initialError)) && <Notice>{error || initialError}</Notice>}
      {!waiting && (!invite || valid) && <form onSubmit={(event) => void submit(event)}>
        {creating && <label>显示名称<input required maxLength={60} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <label>邮箱<input type="email" autoComplete="email" required maxLength={254} value={email} readOnly={Boolean(invite)} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>密码<span className="password-field"><input type={showPassword ? 'text' : 'password'} required minLength={creating ? MIN_PASSWORD_LENGTH : undefined} maxLength={MAX_PASSWORD_LENGTH} autoComplete={creating ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} />
          <IconButton label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</IconButton></span></label>
        <button type="submit" className="button primary" disabled={pending}>{pending ? '正在提交' : setup ? '创建管理员' : invite ? '创建账号' : '登录'}<ArrowRight size={17} /></button>
      </form>}
      {invite ? <button type="button" className="text-button" onClick={() => { setError(''); setPassword(''); closeInvite() }}>返回登录</button>
        : !setup && <div className="auth-foot">仅限受邀账号</div>}
    </main>
  </div>
}
