import { useId } from 'react'

function MoonGlyph({ variant }: { variant: 'reply' | 'effort' }) {
  const id = useId()
  const disc = `${id}-disc`
  const light = `${id}-light`
  const name = `${variant}-moon`
  const size = variant === 'reply' ? 42 : 40

  return <svg className={name} width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <defs>
      <mask id={disc} x="0" y="0" width="48" height="48" maskUnits="userSpaceOnUse">
        <circle cx="24" cy="24" r="10.5" fill="#fff" />
        <circle className={`${name}-shadow`} cx="24" cy="24" r="10.8" fill="#000" />
      </mask>
      <radialGradient id={light} cx="39%" cy="33%" r="75%">
        <stop stopColor="currentColor" />
        <stop offset="1" stopColor="currentColor" stopOpacity=".76" />
      </radialGradient>
    </defs>
    {variant === 'effort' && <circle className="effort-moon-unlit" cx="24" cy="24" r="10.5" />}
    <circle cx="24" cy="24" r="10.5" fill={`url(#${light})`} mask={`url(#${disc})`} />
    <g className={`${name}-stars`} fill="currentColor">
      <path d="M36 8.5q.55 3 3.5 3.5-2.95.55-3.5 3.5-.55-2.95-3.5-3.5 2.95-.5 3.5-3.5Z" />
      <path d="M12.5 32q.5 2 2.5 2.5-2 .5-2.5 2.5-.5-2-2.5-2.5 2-.5 2.5-2.5Z" opacity=".78" />
      <circle cx="24" cy="40.5" r=".8" opacity=".57" />
    </g>
  </svg>
}

export function ReplyMoon() { return <MoonGlyph variant="reply" /> }
export function EffortMoon() { return <MoonGlyph variant="effort" /> }
