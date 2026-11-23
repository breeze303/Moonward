import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import './app/theme.css'
import './app/app.css'
import './app/workspace.css'

const fragment = new URLSearchParams(location.hash.slice(1))
const invite = fragment.get('invite')
if (invite || fragment.has('setup')) history.replaceState(null, '', `${location.pathname}${location.search}`)
createRoot(document.getElementById('root')!).render(<App initialInvite={invite} />)
