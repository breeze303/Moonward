import { AlertCircle, LoaderCircle, X } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Mark({ size = 36 }: { size?: number }) {
  return <span className="brand-mark" aria-hidden="true"><img src="/mark.svg" width={size} height={size} alt="" /></span>
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}</button>
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice" role="alert"><AlertCircle size={16} /><span>{children}</span></div>
}

export function Loading({ label = '加载中' }: { label?: string }) {
  return <div className="loading" role="status"><LoaderCircle size={17} className="spinner" />{label}</div>
}

export function Modal({ title, children, close, className = '' }: { title: string; children: ReactNode; close: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close() }
  }, [])
  return <dialog ref={ref} className={`modal ${className}`} aria-labelledby={id} onCancel={(event) => event.preventDefault()}>
    <header><h2 id={id}>{title}</h2><IconButton label="关闭" className="round-icon compact-icon" onClick={close}><X size={14} /></IconButton></header>
    {children}
  </dialog>
}
