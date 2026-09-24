import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

import type { KV } from '../../../shared/types'
import { kv as makeKV } from '../../../shared/factory'
import type { VarScope } from '../../lib/variables'
import { Icon } from './Icon'
import { VarInput } from './VarInput'

/**
 * The enable/key/value/note grid behind params, headers, cookies, form fields
 * and variable sets.
 *
 * A blank draft row always sits at the bottom; typing into it promotes it to a
 * real row and a new blank appears. That means there is never an "add row"
 * button to hunt for, and the list can still be emptied completely.
 */

type FieldKey = 'key' | 'value' | 'description'

export interface KVTableProps {
  rows: KV[]
  onChange: (rows: KV[]) => void
  scope: Map<string, VarScope>
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Hides the third free-text column when the context has no use for it. */
  showDescription?: boolean
  /** Renders values as password fields with a reveal toggle. */
  allowSecret?: boolean
  /** Suggestions offered in the key column's datalist. */
  keySuggestions?: readonly string[]
  disabled?: boolean
  emptyHint?: string
}

/** Focuses a freshly mounted input and parks the caret at the end. */
function focusEnd(el: HTMLInputElement | null): void {
  if (!el) return
  el.focus()
  const end = el.value.length
  try {
    el.setSelectionRange(end, end)
  } catch {
    // Inputs of type=password in some engines reject setSelectionRange.
  }
}

export function KVTable({
  rows,
  onChange,
  scope,
  keyPlaceholder = 'Name',
  valuePlaceholder = 'Value',
  showDescription = true,
  allowSecret = false,
  keySuggestions,
  disabled = false,
  emptyHint,
}: KVTableProps) {
  const listId = useMemo(
    () => (keySuggestions?.length ? `kv-suggest-${Math.abs(hash(keySuggestions.join()))}` : undefined),
    [keySuggestions],
  )

  /**
   * The draft row is controlled at "", so the character that promotes it lands
   * in a brand-new row while the caret is still in the (now empty) draft. This
   * records which field of which row should take focus on the very next render,
   * without which typing a name would append one row per keystroke.
   */
  const focusNext = useRef<{ id: string; field: FieldKey } | null>(null)
  const pending = focusNext.current
  useLayoutEffect(() => {
    focusNext.current = null
  })

  const patch = useCallback(
    (index: number, next: Partial<KV>) => {
      const copy = rows.slice()
      copy[index] = { ...copy[index], ...next }
      onChange(copy)
    },
    [rows, onChange],
  )

  const editDraft = useCallback(
    (field: FieldKey, value: string) => {
      const row: KV = { ...makeKV(), [field]: value }
      focusNext.current = { id: row.id, field }
      onChange([...rows, row])
    },
    [rows, onChange],
  )

  const remove = useCallback(
    (index: number) => {
      const copy = rows.slice()
      copy.splice(index, 1)
      onChange(copy)
    },
    [rows, onChange],
  )

  const move = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= rows.length) return
      const copy = rows.slice()
      const [moved] = copy.splice(from, 1)
      copy.splice(to, 0, moved)
      onChange(copy)
    },
    [rows, onChange],
  )

  const allEnabled = rows.length > 0 && rows.every((r) => r.enabled)
  const takesFocus = (row: KV, field: FieldKey): boolean =>
    pending?.id === row.id && pending.field === field

  return (
    <div className={`kvtable${showDescription ? '' : ' is-narrow'}${disabled ? ' is-disabled' : ''}`}>
      {listId && (
        <datalist id={listId}>
          {keySuggestions?.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}

      <div className="kvtable-head">
        <div className="kv-cell kv-toggle">
          <input
            type="checkbox"
            className="checkbox"
            checked={allEnabled}
            disabled={disabled || !rows.length}
            aria-label={allEnabled ? 'Disable all rows' : 'Enable all rows'}
            onChange={() => onChange(rows.map((r) => ({ ...r, enabled: !allEnabled })))}
          />
        </div>
        <div className="kv-cell plate">{keyPlaceholder}</div>
        <div className="kv-cell plate">{valuePlaceholder}</div>
        {showDescription && <div className="kv-cell plate">Note</div>}
        <div className="kv-cell kv-actions" />
      </div>

      <div className="kvtable-body">
        {rows.map((row, index) => (
          <div className={`kvtable-row${row.enabled ? '' : ' is-off'}`} key={row.id}>
            <div className="kv-cell kv-toggle">
              <input
                type="checkbox"
                className="checkbox"
                checked={row.enabled}
                disabled={disabled}
                aria-label={`Include ${row.key || 'row'}`}
                onChange={(e) => patch(index, { enabled: e.target.checked })}
              />
            </div>

            <div className="kv-cell">
              <input
                className="kv-input"
                value={row.key}
                list={listId}
                placeholder={keyPlaceholder}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                aria-label={keyPlaceholder}
                ref={takesFocus(row, 'key') ? focusEnd : undefined}
                onChange={(e) => patch(index, { key: e.target.value })}
              />
            </div>

            <div className="kv-cell">
              {allowSecret && row.secret ? (
                <input
                  className="kv-input"
                  type="password"
                  value={row.value}
                  disabled={disabled}
                  aria-label={valuePlaceholder}
                  ref={takesFocus(row, 'value') ? focusEnd : undefined}
                  onChange={(e) => patch(index, { value: e.target.value })}
                />
              ) : (
                <VarInput
                  value={row.value}
                  onChange={(value) => patch(index, { value })}
                  scope={scope}
                  placeholder={valuePlaceholder}
                  disabled={disabled}
                  ariaLabel={valuePlaceholder}
                  focusOnMount={takesFocus(row, 'value')}
                />
              )}
            </div>

            {showDescription && (
              <div className="kv-cell">
                <input
                  className="kv-input is-quiet"
                  value={row.description ?? ''}
                  placeholder="—"
                  disabled={disabled}
                  spellCheck={false}
                  aria-label="Note"
                  ref={takesFocus(row, 'description') ? focusEnd : undefined}
                  onChange={(e) => patch(index, { description: e.target.value })}
                />
              </div>
            )}

            <div className="kv-cell kv-actions">
              {allowSecret && (
                <button
                  className="btn-icon btn-xs"
                  title={row.secret ? 'Show value' : 'Mask value'}
                  aria-label={row.secret ? 'Show value' : 'Mask value'}
                  disabled={disabled}
                  onClick={() => patch(index, { secret: !row.secret })}
                >
                  <Icon name={row.secret ? 'eye-off' : 'eye'} size={12} />
                </button>
              )}
              <button
                className="btn-icon btn-xs"
                title="Move up"
                aria-label="Move up"
                disabled={disabled || index === 0}
                onClick={() => move(index, index - 1)}
              >
                <Icon name="chevron-up" size={12} />
              </button>
              <button
                className="btn-icon btn-xs"
                title="Move down"
                aria-label="Move down"
                disabled={disabled || index === rows.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <Icon name="chevron-down" size={12} />
              </button>
              <button
                className="btn-icon btn-xs is-danger"
                title="Remove row"
                aria-label="Remove row"
                disabled={disabled}
                onClick={() => remove(index)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        ))}

        {!disabled && (
          <div className="kvtable-row is-draft" key="draft">
            <div className="kv-cell kv-toggle">
              <input type="checkbox" className="checkbox" checked readOnly tabIndex={-1} aria-hidden="true" />
            </div>
            <div className="kv-cell">
              <input
                className="kv-input"
                value=""
                list={listId}
                placeholder={keyPlaceholder}
                spellCheck={false}
                autoComplete="off"
                aria-label={`New ${keyPlaceholder.toLowerCase()}`}
                onChange={(e) => editDraft('key', e.target.value)}
              />
            </div>
            <div className="kv-cell">
              <input
                className="kv-input"
                value=""
                placeholder={valuePlaceholder}
                spellCheck={false}
                autoComplete="off"
                aria-label={`New ${valuePlaceholder.toLowerCase()}`}
                onChange={(e) => editDraft('value', e.target.value)}
              />
            </div>
            {showDescription && (
              <div className="kv-cell">
                <input
                  className="kv-input is-quiet"
                  value=""
                  placeholder="—"
                  spellCheck={false}
                  aria-label="New note"
                  onChange={(e) => editDraft('description', e.target.value)}
                />
              </div>
            )}
            <div className="kv-cell kv-actions" />
          </div>
        )}
      </div>

      {rows.length === 0 && emptyHint && <p className="kvtable-hint">{emptyHint}</p>}
    </div>
  )
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}
