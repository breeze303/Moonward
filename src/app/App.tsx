import { useCallback, useEffect, useState } from 'react'
import { api, ApiError, errorText } from '../services/api/appClient.ts'
import type { User } from '../../shared/contract.ts'
import { AuthScreen } from '../components/AuthScreen.tsx'
import { Workspace } from '../components/Workspace.tsx'
import { Loading, Mark, Notice } from '../components/ui.tsx'

const onSetupPage = () => location.pathname === '/setup' || location.pathname === '/setup/'
const leaveSetupPage = () => { if (onSetupPage()) history.replaceState(null, '', '/') }

export function App({ initialInvite }: { initialInvite: string | null }) {
  const [invite, setInvite] = useState(initialInvite)
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [setup, setSetup] = useState(false)
  const [error, setError] = useState('')
  const expire = useCallback(() => { setUser(null); setError('登录已过期或账号已停用。') }, [])
  const refresh = useCallback(async () => {
    setError('')
    try { setUser(await api<User>('/me')); setSetup(false); leaveSetupPage() } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
        setSetup(failure.code === 'setup_required')
        if (failure.code !== 'setup_required') leaveSetupPage()
        setUser(null)
        if (failure.status === 403) setError(failure.message)
      } else { setUser(undefined); setError(errorText(failure)) }
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  if (setup || user === null || (invite && user)) return <AuthScreen key={setup ? 'setup' : invite ?? 'login'} setup={setup} waiting={setup && !onSetupPage()}
    invite={setup ? null : invite} closeInvite={() => setInvite(null)}
    signedIn={(account) => { leaveSetupPage(); setSetup(false); setInvite(null); setUser(account) }} setupChanged={() => void refresh()} initialError={error} />
  if (!user) return <div className="center-page"><Mark size={44} />{error ? <><Notice>{error}</Notice><button className="button secondary" onClick={() => void refresh()}>重试</button></> : <Loading />}</div>
  return <Workspace key={user.id} user={user} updateUser={setUser} expired={expire} />
}
