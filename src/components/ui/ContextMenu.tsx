import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Icon, type IconName } from './Icon'

export interface MenuItem {
  label: string
  onSelect?: () => void
  icon?: IconName
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Renders a divider; label is ignored. */
  separator?: boolean
}

export interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

/**
 * A pointer-anchored menu rendered into a portal so it escapes any panel that
 * clips overflow, and flipped back on screen when it would run off an edge.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [active, setActive] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 6
    setPos({
      left: Math.max(pad, Math.min(x, window.innerWidth - rect.width - pad)),
      top: Math.max(pad, Math.min(y, window.innerHeight - rect.height - pad)),
    })
    el.focus()
  }, [x, y, items.length])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onScroll = () => onClose()
    // `true` so a click anywhere, including inside other portals, dismisses.
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('resize', onScroll)
    window.addEventListener('wheel', onScroll, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('wheel', onScroll)
    }
  }, [onClose])

  const selectable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.separator && !item.disabled)

  const step = (delta: number) => {
    if (!selectable.length) return
    const current = selectable.findIndex((s) => s.index === active)
    const next = (current + delta + selectable.length) % selectable.length
    setActive(selectable[next].index)
  }

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      // A portal still bubbles through the React tree, so without this a pick
      // would also reach whatever row rendered the menu and act twice.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          step(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          step(-1)
        } else if (event.key === 'Enter' && active >= 0) {
          event.preventDefault()
          const item = items[active]
          if (item && !item.disabled && !item.separator) {
            onClose()
            item.onSelect?.()
          }
        }
      }}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div className="menu-sep" key={`sep-${index}`} role="separator" />
        ) : (
          <button
            key={`${item.label}-${index}`}
            role="menuitem"
            className={`menu-item${item.danger ? ' menu-item-danger' : ''}${
              active === index ? ' is-active' : ''
            }`}
            disabled={item.disabled}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              onClose()
              item.onSelect?.()
            }}
          >
            <span className="menu-item-icon">{item.icon && <Icon name={item.icon} size={13} />}</span>
            <span className="menu-label">{item.label}</span>
            {item.shortcut && <span className="menu-key">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
