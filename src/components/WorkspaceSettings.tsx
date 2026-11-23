import clsx from 'clsx'
import { LogOut, Monitor, Moon, Search, Settings, Shield, Sun, UserRound } from 'lucide-react'
import { useId, useState } from 'react'
import type { Usage, User } from '../../shared/contract.ts'
import { setThemePreference, useThemePreference } from '../app/theme.ts'
import type { ThemePreference } from '../app/theme.ts'
import styles from './chat-demo/Settings.module.css'
import { Modal, Notice } from './ui.tsx'

const themes = [
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
  { value: 'system', label: '跟随系统', Icon: Monitor },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; Icon: typeof Sun }>

export function WorkspaceSettings({ user, usage, busy, close, search, manage, signOut, error }: {
  user: User; usage: Usage; busy: boolean
  close: () => void; search: () => void; manage: () => void; signOut: () => void; error: string
}) {
  const [page, setPage] = useState<'general' | 'account'>('general')
  const preference = useThemePreference()
  const id = useId()

  return <Modal title="设置" close={close} className={clsx(styles.dialog, 'settings-modal')}>
    <div className={styles.dialogMain}>
      <nav className={styles.navigation} aria-label="设置分类">
        <button type="button" className={clsx(styles.navItem, page === 'general' && styles.navItemActive)} aria-pressed={page === 'general'}
          onClick={() => setPage('general')}><Settings size={16} />通用设置</button>
        <button type="button" className={clsx(styles.navItem, page === 'account' && styles.navItemActive)} aria-pressed={page === 'account'}
          onClick={() => setPage('account')}><UserRound size={16} />账号</button>
      </nav>
      <section className={styles.content} aria-label={page === 'general' ? '通用设置' : '账号'}>
        {page === 'general' ? <>
          <div className={clsx(styles.cell, styles.row)}>
            <span className={styles.text}>历史对话</span>
            <button className="button secondary" type="button" onClick={search}><Search size={16} />搜索对话</button>
          </div>
          <div className={styles.theme}>
            <div className={styles.label}>主题</div>
            <div role="radiogroup" aria-label="主题" className={styles.themeOptions}>
              {themes.map(({ value, label, Icon }) => <label key={value} className={clsx(styles.themeOption, preference === value && styles.themeOptionSelected, 'theme-radio')}>
                <input type="radio" name={`${id}-theme`} value={value} checked={preference === value} onChange={() => setThemePreference(value)} />
                <Icon size={18} />{label}
              </label>)}
            </div>
          </div>
        </> : <>
          {error && <Notice>{error}</Notice>}
          <div className={clsx(styles.cell, styles.row, 'account-info')}>
            <span className="avatar">{Array.from(user.name)[0]?.toUpperCase()}</span>
            <div><strong>{user.name}</strong><span>{user.email}</span></div>
          </div>
          <div className={clsx(styles.cell, styles.row)}>
            <div className={styles.text}><span>今日用量</span><span className={styles.description}>UTC 每日重置</span></div>
            <span>{usage.count} / {usage.limit} 次</span>
          </div>
          <div className={clsx(styles.cell, styles.row, 'settings-account-actions')}>
            {user.role === 'admin' && <button type="button" className="button secondary" disabled={busy} onClick={manage}><Shield size={16} />站点管理</button>}
            <button type="button" className="button secondary" onClick={signOut}><LogOut size={16} />退出登录</button>
          </div>
        </>}
      </section>
    </div>
  </Modal>
}
