import { useSyncExternalStore } from 'react'
import { getLocal, setLocal } from './storage.ts'

type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()
const stored = getLocal('wenji:theme')
let preference: ThemePreference = stored === 'dark' || stored === 'light' ? stored : 'system'
let theme: Theme = 'light'

function applyTheme() {
  theme = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference
  document.body.toggleAttribute('data-ds-dark-theme', theme === 'dark')
  document.documentElement.style.colorScheme = theme
  listeners.forEach((listener) => listener())
}

media.addEventListener('change', applyTheme)
applyTheme()

export function setThemePreference(value: ThemePreference) {
  preference = value
  setLocal('wenji:theme', value === 'system' ? null : value)
  applyTheme()
}

export function toggleTheme() { setThemePreference(theme === 'dark' ? 'light' : 'dark') }

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const useTheme = () => useSyncExternalStore(subscribe, () => theme)
export const useThemePreference = () => useSyncExternalStore(subscribe, () => preference)
