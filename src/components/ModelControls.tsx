import { ArrowLeft, Check, ChevronDown, Sparkle } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { effortLevels } from '../../shared/contract.ts'
import type { Effort, Model } from '../../shared/contract.ts'
import { EffortMoon } from './ReplyMoon.tsx'
import { useAnchoredPosition, useDismiss } from './chat-demo/anchored.ts'
import menuStyle from './chat-demo/Menu.module.css'

export const effortNames: Record<Effort, string> = {
  none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大',
}

type PickerPanel = 'effort' | 'models'

export function ModelPicker({ model, models, choose, effort, setEffort, disabled }: {
  model?: Model; models: Model[]; choose: (id: string) => void; effort?: Effort; setEffort: (effort?: Effort) => void; disabled: boolean
}) {
  const [panel, setPanel] = useState<PickerPanel | null>(null)
  const dialogId = useId()
  const rangeRef = useRef<HTMLInputElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const levels = effortLevels.filter((level) => model?.efforts.includes(level))
  const index = effort ? levels.indexOf(effort) + 1 : 0
  const selected = levels[index - 1]
  const atMax = selected === 'max'
  const defaultName = model?.defaultEffort ? effortNames[model.defaultEffort] : '由网关决定'
  const current = selected ? effortNames[selected] : `跟随默认（${defaultName}）`
  const effective = selected ?? model?.defaultEffort
  const depthLabel = effective ? effortNames[effective] : '默认'
  const depthIndex = effective ? levels.indexOf(effective) : -1
  const moonPhase = effective === 'max' ? 1 : Math.max(0, depthIndex) / Math.max(1, levels.length - 1)
  const locked = disabled || !models.length
  const visible = panel !== null && !locked
  const showEffort = panel === 'effort' && levels.length > 0
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLButtonElement, HTMLDivElement>(
    visible, { side: 'bottom', align: showEffort ? 'center' : 'end', offset: 8, maxHeight: 320, measureKey: showEffort },
  )
  const ready = visible && position !== null
  const focusTrigger = () => anchorRef.current?.focus({ preventScroll: true })
  useDismiss(visible, [anchorRef, floatingRef], () => {
    if (floatingRef.current?.contains(document.activeElement)) focusTrigger()
    setPanel(null)
  })
  useEffect(() => { if (locked) setPanel(null) }, [locked])
  useLayoutEffect(() => {
    if (!ready) return
    if (showEffort) rangeRef.current?.focus({ preventScroll: true })
    else {
      const option = modelListRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
        modelListRef.current?.querySelector<HTMLButtonElement>('button')
      option?.focus({ preventScroll: true })
      option?.scrollIntoView({ block: 'nearest' })
    }
  }, [ready, showEffort])

  function pickTouchEffort(event: PointerEvent<HTMLInputElement>) {
    const track = railRef.current?.getBoundingClientRect()
    if (!track?.width) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - track.left) / track.width))
    const next = Math.round(fraction * levels.length)
    if (next !== index) setEffort(levels[next - 1])
  }

  return <>
    <button ref={anchorRef} type="button" className="composer-model" disabled={locked}
      title={model ? `${model.label}${levels.length ? ` · 推理深度：${current}` : ''}` : '模型'}
      aria-label={model ? `模型：${model.label}` : '模型'} aria-haspopup="dialog"
      aria-description={levels.length ? `推理深度：${current}` : undefined}
      aria-expanded={visible} aria-controls={visible ? dialogId : undefined}
      onClick={() => setPanel(visible ? null : levels.length ? 'effort' : 'models')}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && !visible) {
          event.preventDefault()
          setPanel('models')
        }
      }}>
      <span className="composer-model-label">{model?.label || '模型'}</span>
      {!!levels.length && <span className="composer-model-effort">{depthLabel}</span>}
      <ChevronDown size={12} className="model-chevron" aria-hidden="true" />
    </button>
    {visible && createPortal(<div ref={floatingRef} id={dialogId} className="model-popover" data-effort={showEffort || undefined}
      role="dialog" aria-label={showEffort ? '推理深度' : '模型设置'}
      style={position ?? { visibility: 'hidden' }} onKeyDown={(event) => {
        if (event.key !== 'Escape' && event.key !== 'Tab') return
        if (event.key === 'Tab') {
          const fromSlider = event.target === rangeRef.current
          if (showEffort && (fromSlider ? event.shiftKey : !event.shiftKey)) return
          if (!showEffort && event.shiftKey && levels.length && modelListRef.current?.contains(event.target as Node)) return
        }
        event.stopPropagation()
        focusTrigger()
        setPanel(null)
      }}>
      {showEffort ? <div>
        <button type="button" className="effort-model-list" aria-label={`推理深度：${current}，选择模型`} onClick={() => setPanel('models')}>
          {current}<ChevronDown size={13} aria-hidden="true" />
        </button>
        <div className="effort-scale" data-max={atMax || undefined}
          style={{ '--effort-progress': `${index / levels.length * 100}%`, '--effort-phase': moonPhase } as CSSProperties}>
          <div ref={railRef} className="effort-rail" aria-hidden="true">
            <div className="effort-track"><span className="effort-track-fill">
              {atMax && [8, 5, 6].map((size) => <span className="effort-track-spark" key={size}>
                <Sparkle size={size} fill="currentColor" strokeWidth={1} />
              </span>)}
            </span></div>
            <EffortMoon />
          </div>
          <input ref={rangeRef} className="effort-range" type="range" min={0} max={levels.length} step={1} value={index}
            aria-label="推理深度" aria-valuetext={current} onChange={(event) => setEffort(levels[Number(event.target.value) - 1])}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.pointerType !== 'touch') return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              pickTouchEffort(event)
            }}
            onPointerMove={(event) => {
              if (event.isPrimary && event.pointerType === 'touch' && event.currentTarget.hasPointerCapture(event.pointerId)) pickTouchEffort(event)
            }} />
        </div>
      </div> : <>
        {!!levels.length && <button type="button" className="model-popover-back" aria-label="返回推理深度" onClick={() => setPanel('effort')}>
          <ArrowLeft size={15} aria-hidden="true" />推理深度
        </button>}
        <div className={menuStyle.menuLabel} aria-hidden="true">选择模型</div>
        <div ref={modelListRef} role="menu" aria-label="选择模型" onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          const options = Array.from(event.currentTarget.querySelectorAll('button'))
          const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
            (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          options[next]?.focus()
        }}>
          {models.map((option) => <button key={option.id} type="button" role="menuitemradio" aria-checked={model?.id === option.id}
            tabIndex={-1} className={`${menuStyle.option} model-popover-option`} onClick={() => {
              focusTrigger()
              setPanel(null)
              choose(option.id)
            }}>
            <span className={menuStyle.optionText}><span title={option.label}>{option.label}</span></span>
            {model?.id === option.id && <Check size={16} className={menuStyle.check} aria-hidden="true" />}
          </button>)}
        </div>
      </>}
    </div>, document.body)}
  </>
}
