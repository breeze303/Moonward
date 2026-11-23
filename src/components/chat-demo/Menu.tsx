import clsx from 'clsx'
import { Check } from 'lucide-react'
import { useId, useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss, type AnchoredOptions } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon?: ReactNode
  detail?: string
  checked?: boolean
  danger?: boolean
  onSelect: () => void
}

export const Menu = ({
  options, children, label, placement,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void; menuId: string }) => ReactNode
  label?: string
  placement?: AnchoredOptions
}) => {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const close = () => setOpen(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    placement ?? { align: 'start', alignOffset: -5, offset: 4 }
  )
  const focusTrigger = () => anchorRef.current?.querySelector('button')?.focus()
  useDismiss(open, [anchorRef, floatingRef], () => {
    if (floatingRef.current?.contains(document.activeElement)) focusTrigger()
    close()
  })
  useLayoutEffect(() => {
    if (open) {
      const first = floatingRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? floatingRef.current?.querySelector('button')
      first?.focus({ preventScroll: true })
      first?.scrollIntoView({ block: 'nearest' })
    }
  }, [open, floatingRef])

  return (
    <>
      <span ref={anchorRef} className={styles.anchor} onKeyDown={(event) => {
        if (!open && options.length && event.key === 'ArrowDown' && !anchorRef.current?.querySelector('button')?.disabled) {
          event.preventDefault()
          setOpen(true)
        }
      }}>
        {children({ open, toggle: () => setOpen((value) => !value), menuId })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              id={menuId}
              className={clsx(styles.menu, label && styles.picker)}
              style={position ?? undefined}
              role="menu"
              aria-label={label}
              onKeyDown={(event) => {
                if (event.key === 'Escape' || event.key === 'Tab') {
                  event.stopPropagation()
                  focusTrigger()
                  close()
                  return
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const direction = event.key === 'ArrowDown' ? 1 : -1
                event.preventDefault()
                buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + direction + buttons.length) % buttons.length]?.focus()
              }}
            >
              {label && <div className={styles.menuLabel} aria-hidden="true">{label}</div>}
              {options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  role={option.checked === undefined ? 'menuitem' : 'menuitemradio'}
                  aria-checked={option.checked}
                  tabIndex={-1}
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    setOpen(false)
                    focusTrigger()
                    option.onSelect()
                  }}
                >
                  {option.icon && <span className={styles.icon} aria-hidden="true">{option.icon}</span>}
                  {label ? <span className={styles.optionText}><span title={option.label}>{option.label}</span>{option.detail && <small title={option.detail}>{option.detail}</small>}</span> : option.label}
                  {option.checked && <Check size={16} className={styles.check} aria-hidden="true" />}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
