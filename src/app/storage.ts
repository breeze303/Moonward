export function getLocal(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}

export function setLocal(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch { /* Private browsing and storage quotas must not block chat. */ }
}
