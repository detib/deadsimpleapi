import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { annotate, type VarScope } from '../../lib/variables'

/**
 * A single-line input that shows {{variables}} as tinted chips and reveals what
 * they resolve to while focused.
 *
 * The chips come from a mirror layer positioned exactly behind the input: the
 * mirror renders the same text in transparent ink, so only the chip backgrounds
 * show through, and the real input text stays crisp on top. That avoids the
 * usual transparent-text trick, which breaks text selection.
 */

export interface VarInputProps {
  value: string
  onChange: (value: string) => void
  scope: Map<string, VarScope>
  placeholder?: string
  className?: string
  spellCheck?: boolean
  disabled?: boolean
  monospace?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onBlur?: () => void
  inputRef?: React.RefObject<HTMLInputElement | null>
  ariaLabel?: string
  dataFocus?: string
  /** Takes focus with the caret at the end once, on mount. */
  focusOnMount?: boolean
}

export function VarInput({
  value,
  onChange,
  scope,
  placeholder,
  className,
  spellCheck = false,
  disabled,
  monospace = true,
  onKeyDown,
  onBlur,
  inputRef,
  ariaLabel,
  dataFocus,
  focusOnMount = false,
}: VarInputProps) {
  const localRef = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? localRef
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)

  const spans = useMemo(() => annotate(value, scope), [value, scope])

  /** Keeps the chip layer aligned while the input scrolls horizontally. */
  const syncScroll = useCallback(() => {
    if (mirrorRef.current && ref.current) {
      mirrorRef.current.scrollLeft = ref.current.scrollLeft
    }
  }, [ref])

  useEffect(syncScroll, [value, syncScroll])

  // Runs once: the caller promotes a draft row and hands focus to the new one.
  useEffect(() => {
    if (!focusOnMount) return
    const el = ref.current
    if (!el) return
    el.focus()
    const end = el.value.length
    try {
      el.setSelectionRange(end, end)
    } catch {
      // Some input types reject setSelectionRange; focus alone is enough.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const segments = useMemo(() => {
    const out: Array<{ text: string; kind: 'plain' | 'known' | 'unknown' }> = []
    let cursor = 0
    for (const span of spans) {
      if (span.start > cursor) out.push({ text: value.slice(cursor, span.start), kind: 'plain' })
      out.push({
        text: value.slice(span.start, span.end),
        kind: span.known ? 'known' : 'unknown',
      })
      cursor = span.end
    }
    if (cursor < value.length) out.push({ text: value.slice(cursor), kind: 'plain' })
    return out
  }, [spans, value])

  const unresolved = spans.filter((s) => !s.known)

  return (
    <div className={`varinput${className ? ` ${className}` : ''}${monospace ? ' is-mono' : ''}`}>
      <div className="varinput-mirror" ref={mirrorRef} aria-hidden="true">
        {segments.map((seg, i) =>
          seg.kind === 'plain' ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <span key={i} className={seg.kind === 'known' ? 'vchip' : 'vchip is-unknown'}>
              {seg.text}
            </span>
          ),
        )}
        {/* Trailing space keeps the mirror's scroll width equal to the input's. */}
        <span>{'​'}</span>
      </div>

      <input
        ref={ref}
        className="varinput-field"
        type="text"
        value={value}
        placeholder={placeholder}
        spellCheck={spellCheck}
        disabled={disabled}
        aria-label={ariaLabel}
        data-focus={dataFocus}
        autoComplete="off"
        autoCorrect="off"
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          onBlur?.()
        }}
      />

      {focused && spans.length > 0 && (
        <div className="varinput-hint" role="status">
          {spans.map((span, i) => (
            <div key={i} className="varinput-hint-row">
              <span className={span.known ? 'vchip' : 'vchip is-unknown'}>{span.name}</span>
              <span className="varinput-hint-value">
                {span.known ? span.resolved || <em>empty</em> : 'not defined'}
              </span>
            </div>
          ))}
          {unresolved.length > 0 && (
            <div className="varinput-hint-foot">
              <span>{unresolved.length} unresolved — sent as literal text</span>
              <span className="varinput-hint-fix">
                <kbd className="varinput-hint-kbd">Ctrl+E</kbd> to define
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
