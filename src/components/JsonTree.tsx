import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'

import { highlightRanges } from '../lib/format'
import { typeOf, type JsonType } from '../lib/json'
import { useStore } from '../state/store'
import { Caret, Icon } from './ui/Icon'
import './JsonTree.css'

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/*                                                                     */
/* Every walk in this file is bounded. The document can be 50MB, so     */
/* nothing may be proportional to it except an explicit, capped pass    */
/* the user asked for - expand all, or the filter.                      */
/* ------------------------------------------------------------------ */

const INDENT = 12
const ROW_FALLBACK = 20
const OVERSCAN = 10

/** Expand-all refuses past this many rows rather than freezing. */
const EXPAND_CAP = 20_000
/** Backstop for a hand-expanded document that would still explode. */
const ROW_CAP = 120_000
/** Children drawn per container before a "show more" rung appears. */
const CHILD_FIRST = 2_000
const CHILD_STEP = 10_000
/** defaultExpandDepth never opens more containers than this. */
const SEED_CAP = 400

const CLIP = 200
const CLIP_MAX = 4_000
const LABEL_CLIP = 120

const SCAN_CAP = 300_000
const MATCH_CAP = 5_000
const MAX_DEPTH = 400
const MARK_CAP = 24
const PREVIEW_CHARS = 44

const EMPTY_SET: ReadonlySet<string> = new Set<string>()
const EMPTY_LIMITS: ReadonlyMap<string, number> = new Map<string, number>()

/* ------------------------------------------------------------------ */
/* Paths and values                                                    */
/* ------------------------------------------------------------------ */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Mirrors childPath() in src/lib/json, so every path here feeds getPath(). */
function keyPath(parent: string, key: string): string {
  if (IDENT.test(key)) return parent ? `${parent}.${key}` : key
  return `${parent}[${JSON.stringify(key)}]`
}

function isBranch(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function sizeOf(value: unknown): number {
  if (Array.isArray(value)) return value.length
  return Object.keys(value as Record<string, unknown>).length
}

/** The text a filter matches against; null means "this is a container". */
function scalarText(value: unknown): string | null {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value)
    case 'undefined':
      return 'undefined'
    default:
      return value === null ? 'null' : null
  }
}

const ESC: Record<string, string | undefined> = {
  '\\': '\\\\',
  '"': '\\"',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
}

/** Newlines become \n, so no single string can grow a row past one line. */
function escapeJson(text: string): string {
  return text.replace(
    /["\\\u0000-\u001f\u2028\u2029]/g,
    (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

const CONTROL = /[\u0000-\u001f\u2028\u2029]/g

/**
 * A key may legally hold a newline or a control character; printed raw it would
 * spill out of a fixed-height rung. Absurdly long keys are clipped for the same
 * reason - the row must stay one line.
 */
function labelText(key: string): string {
  const clipped = key.length > LABEL_CLIP ? `${key.slice(0, LABEL_CLIP)}…` : key
  return clipped.replace(
    CONTROL,
    (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function scalarDisplay(value: unknown, type: JsonType): string {
  switch (type) {
    case 'number':
      if (typeof value === 'bigint') return `${value}`
      return Object.is(value, -0) ? '-0' : String(value)
    case 'boolean':
      return value === true ? 'true' : 'false'
    case 'null':
      return 'null'
    default:
      return value === undefined ? 'undefined' : String(value)
  }
}

function headOf(value: unknown, count: number): string {
  if (Array.isArray(value)) return count === 0 ? '[]' : `[${count}]`
  if (count === 0) return '{}'
  return `{${count} ${count === 1 ? 'key' : 'keys'}}`
}

function brief(value: unknown): string {
  if (Array.isArray(value)) return '[…]'
  if (isBranch(value)) return '{…}'
  const text = scalarText(value) ?? ''
  return text.length > 20 ? `${text.slice(0, 20)}…` : text
}

/** The first couple of keys or items, as far as they fit. */
function previewOf(value: unknown): string {
  const parts: string[] = []
  let width = 0
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (width >= PREVIEW_CHARS) {
        parts.push('…')
        break
      }
      const piece = brief(value[i])
      parts.push(piece)
      width += piece.length + 2
    }
  } else {
    const keys = Object.keys(value as Record<string, unknown>)
    for (let i = 0; i < keys.length; i++) {
      if (width >= PREVIEW_CHARS) {
        parts.push('…')
        break
      }
      parts.push(keys[i])
      width += keys[i].length + 2
    }
  }
  return parts.join(', ')
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value}`
  if (typeof value === 'number' && !Number.isFinite(value)) return `${value}`
  return value
}

/** Strings copy raw; everything else copies as pretty JSON. */
function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const out = JSON.stringify(value, jsonSafe, 2)
    return out === undefined ? String(value) : out
  } catch {
    return String(value)
  }
}

function copyText(text: string, success: string): void {
  const { toast } = useStore.getState()
  void navigator.clipboard.writeText(text).then(
    () => toast('success', success),
    (err: unknown) => toast('error', 'Could not copy', String(err)),
  )
}

/* ------------------------------------------------------------------ */
/* Flattening                                                          */
/* ------------------------------------------------------------------ */

interface JsonRow {
  kind: 'node' | 'more'
  path: string
  depth: number
  label: string
  index: boolean
  value: unknown
  type: JsonType
  /** Expandable: a container that actually has children. */
  branch: boolean
  /** An object or array, including an empty one. Drives {} / [] rendering. */
  container: boolean
  count: number
  open: boolean
  /** 'more' rows only: the container they belong to, and what is left. */
  owner: string
  hidden: number
  /** 1-based position among siblings, and the true sibling count. Only these
   *  tell a screen reader where a virtualised row sits in its parent. */
  pos: number
  size: number
}

interface Frame {
  path: string
  depth: number
  /** null for arrays; iteration then runs over indices. */
  keys: string[] | null
  value: unknown
  len: number
  i: number
  limit: number
  /** Inside a filter match: everything below is kept without testing. */
  free: boolean
}

function frameOf(value: unknown, path: string, depth: number, limit: number, free: boolean): Frame {
  const array = Array.isArray(value)
  const keys = array ? null : Object.keys(value as Record<string, unknown>)
  const len = array ? (value as unknown[]).length : (keys as string[]).length
  return { path, depth, keys, value, len, i: 0, limit: Math.min(len, limit), free }
}

function childOf(frame: Frame, at: number, key: string): unknown {
  if (frame.keys === null) return (frame.value as unknown[])[at]
  return (frame.value as Record<string, unknown>)[key]
}

interface BuildInput {
  root: unknown
  open: ReadonlySet<string>
  /** Ancestors of filter matches. Kept apart from the user's own set. */
  forced: ReadonlySet<string> | null
  keep: ReadonlySet<string> | null
  hits: ReadonlySet<string> | null
  shown: ReadonlyMap<string, number>
}

function makeRow(
  path: string,
  depth: number,
  label: string,
  index: boolean,
  value: unknown,
  open: ReadonlySet<string>,
  forced: ReadonlySet<string> | null,
): JsonRow {
  const container = isBranch(value)
  const count = container ? sizeOf(value) : 0
  // Empty containers render as {} / [] but have nothing to expand into.
  const branch = container && count > 0
  return {
    kind: 'node',
    path,
    depth,
    label,
    index,
    value,
    type: typeOf(value),
    branch,
    container,
    count,
    open: branch && (open.has(path) || (forced !== null && forced.has(path))),
    owner: '',
    hidden: 0,
    pos: 1,
    size: 1,
  }
}

/**
 * Walks only what is visible: a container is descended into solely when it is
 * open, so the row count tracks the viewport rather than the document.
 */
function buildRows(input: BuildInput): JsonRow[] {
  const { root, open, forced, keep, hits, shown } = input
  const filtered = keep !== null
  const rows: JsonRow[] = [makeRow('', 0, '', false, root, open, forced)]
  if (!rows[0].open) return rows

  const rootLimit = filtered ? Infinity : (shown.get('') ?? CHILD_FIRST)
  const stack: Frame[] = [frameOf(root, '', 1, rootLimit, false)]

  while (stack.length > 0 && rows.length < ROW_CAP) {
    const frame = stack[stack.length - 1]
    if (frame.i >= frame.limit) {
      if (frame.len > frame.limit) {
        rows.push({
          kind: 'more',
          path: `#more:${frame.path}`,
          depth: frame.depth,
          label: '',
          index: false,
          value: undefined,
          type: 'undefined',
          branch: false,
          container: false,
          count: 0,
          open: false,
          owner: frame.path,
          hidden: frame.len - frame.limit,
          pos: frame.limit + 1,
          size: frame.len,
        })
      }
      stack.pop()
      continue
    }

    const at = frame.i++
    const key = frame.keys === null ? String(at) : frame.keys[at]
    const path = frame.keys === null ? `${frame.path}[${at}]` : keyPath(frame.path, key)
    if (keep !== null && !frame.free && !keep.has(path)) continue

    const value = childOf(frame, at, key)
    const row = makeRow(path, frame.depth, key, frame.keys === null, value, open, forced)
    row.pos = at + 1
    row.size = frame.len
    rows.push(row)

    if (row.open && frame.depth < MAX_DEPTH) {
      const free = frame.free || (hits !== null && hits.has(path))
      const limit = filtered ? Infinity : (shown.get(path) ?? CHILD_FIRST)
      stack.push(frameOf(value, path, frame.depth + 1, limit, free))
    }
  }

  return rows
}

/* ------------------------------------------------------------------ */
/* Expansion sets                                                      */
/* ------------------------------------------------------------------ */

function seedExpanded(root: unknown, depth: number): ReadonlySet<string> {
  if (depth <= 0 || !isBranch(root) || sizeOf(root) === 0) return EMPTY_SET
  const out = new Set<string>([''])
  let level: Array<{ value: unknown; path: string }> = [{ value: root, path: '' }]

  for (let d = 1; d < depth && level.length > 0 && out.size < SEED_CAP; d++) {
    const next: Array<{ value: unknown; path: string }> = []
    for (const node of level) {
      const frame = frameOf(node.value, node.path, d, Infinity, false)
      for (let i = 0; i < frame.len && out.size < SEED_CAP; i++) {
        const key = frame.keys === null ? String(i) : frame.keys[i]
        const child = childOf(frame, i, key)
        if (!isBranch(child) || sizeOf(child) === 0) continue
        const path = frame.keys === null ? `${node.path}[${i}]` : keyPath(node.path, key)
        out.add(path)
        next.push({ value: child, path })
      }
    }
    level = next
  }
  return out
}

/**
 * Every container path under `value`, or null when opening them all would show
 * more than `cap` rows. Counting as it walks is what lets expand-all refuse
 * instead of hanging.
 */
function expandFrom(value: unknown, base: string, cap: number): Set<string> | null {
  const out = new Set<string>()
  if (!isBranch(value)) return out

  let count = 1
  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: base, depth: 0 },
  ]

  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    const frame = frameOf(node.value, node.path, node.depth, Infinity, false)
    if (frame.len === 0) continue

    out.add(node.path)
    count += frame.len
    if (count > cap) return null
    if (node.depth >= MAX_DEPTH) continue

    for (let i = 0; i < frame.len; i++) {
      const key = frame.keys === null ? String(i) : frame.keys[i]
      const child = childOf(frame, i, key)
      if (!isBranch(child)) continue
      const path = frame.keys === null ? `${node.path}[${i}]` : keyPath(node.path, key)
      stack.push({ value: child, path, depth: node.depth + 1 })
    }
  }
  return out
}

function isUnder(path: string, base: string): boolean {
  if (base === '') return true
  return path === base || path.startsWith(`${base}.`) || path.startsWith(`${base}[`)
}

/* ------------------------------------------------------------------ */
/* Filter                                                              */
/* ------------------------------------------------------------------ */

interface Scan {
  /** Matches plus every ancestor of a match. */
  keep: ReadonlySet<string>
  /** The matches themselves, so their own subtrees stay browsable. */
  hits: ReadonlySet<string>
  forced: ReadonlySet<string>
  matches: number
  capped: boolean
}

/**
 * The one deliberately document-wide pass: a filter has to see into closed
 * subtrees. Bounded by node count and match count, and deferred by the caller
 * so typing never blocks on it.
 */
function scanFilter(root: unknown, needle: string): Scan {
  const keep = new Set<string>()
  const hits = new Set<string>()
  const forced = new Set<string>()
  const pin = needle.toLowerCase()
  let matches = 0
  let capped = false

  const rootText = scalarText(root)
  if (rootText !== null && rootText.toLowerCase().includes(pin)) {
    matches++
    keep.add('')
    hits.add('')
  }
  if (!isBranch(root)) return { keep, hits, forced, matches, capped }

  const stack: Frame[] = [frameOf(root, '', 1, Infinity, false)]
  let seen = 0

  while (stack.length > 0) {
    if (seen >= SCAN_CAP || matches >= MATCH_CAP) {
      capped = true
      break
    }
    const frame = stack[stack.length - 1]
    if (frame.i >= frame.len) {
      stack.pop()
      continue
    }

    const at = frame.i++
    seen++
    // An array index is a position, not a name, so it is not searched.
    const key = frame.keys === null ? '' : frame.keys[at]
    const value = childOf(frame, at, key)
    const text = scalarText(value)
    const hit =
      (key !== '' && key.toLowerCase().includes(pin)) ||
      (text !== null && text.toLowerCase().includes(pin))
    const branch = isBranch(value) && frame.depth < MAX_DEPTH

    // Building a path for every leaf would allocate a string per node; only
    // the nodes that need one get one.
    let path = ''
    if (hit || branch) {
      path = frame.keys === null ? `${frame.path}[${at}]` : keyPath(frame.path, key)
    }

    if (hit) {
      matches++
      keep.add(path)
      hits.add(path)
      for (let k = 0; k < stack.length; k++) {
        keep.add(stack[k].path)
        forced.add(stack[k].path)
      }
    }
    if (branch) stack.push(frameOf(value, path, frame.depth + 1, Infinity, false))
  }

  return { keep, hits, forced, matches, capped }
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

function Marked({ text, needle }: { text: string; needle: string }): JSX.Element {
  if (!needle) return <>{text}</>
  const ranges = highlightRanges(text, needle)
  if (ranges.length === 0) return <>{text}</>

  const parts: Array<string | JSX.Element> = []
  let at = 0
  for (let i = 0; i < ranges.length && i < MARK_CAP; i++) {
    const [from, to] = ranges[i]
    if (from > at) parts.push(text.slice(at, from))
    parts.push(
      <mark className="jt-mark" key={i}>
        {text.slice(from, to)}
      </mark>,
    )
    at = to
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

const TYPE_CLASS: Partial<Record<JsonType, string>> = {
  string: 'is-string',
  number: 'is-number',
  boolean: 'is-bool',
  null: 'is-null',
  undefined: 'is-invalid',
}

/** NaN and Infinity survive a lenient parse but are not JSON. */
function valueClass(row: JsonRow): string {
  if (row.type === 'number' && typeof row.value === 'number' && !Number.isFinite(row.value)) {
    return 'is-invalid'
  }
  return TYPE_CLASS[row.type] ?? 'is-punct'
}

interface RowProps {
  row: JsonRow
  domId: string
  cursor: boolean
  needle: string
  wide: boolean
  onSelect: (row: JsonRow) => void
  onToggle: (row: JsonRow, deep: boolean) => void
  onMore: (row: JsonRow) => void
  onWiden: (path: string) => void
  onPickPath: (path: string) => void
  onCopyValue: (row: JsonRow) => void
}

/**
 * Memoised: a scroll tick re-renders the whole slice, and every prop here is
 * either a primitive or an identity that only changes when the row itself is
 * rebuilt - so rows that stayed on screen do no work, and previewOf() does not
 * re-walk a large container on every frame.
 */
const Row = memo(function Row(props: RowProps): JSX.Element {
  const { row, cursor, needle, wide } = props
  const indent = { width: `${row.depth * INDENT}px` }
  // Keeping focus on the tree means the keyboard still works after a click.
  const hold = (event: ReactMouseEvent): void => event.preventDefault()

  if (row.kind === 'more') {
    return (
      <div
        className={`jt-row is-more${cursor ? ' is-cursor' : ''}`}
        id={props.domId}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-posinset={row.pos}
        aria-setsize={row.size}
        aria-selected={cursor}
        onClick={() => props.onSelect(row)}
      >
        <span className="jt-indent" style={indent} aria-hidden="true" />
        <button
          type="button"
          className="jt-inline"
          tabIndex={-1}
          onMouseDown={hold}
          onClick={(event: ReactMouseEvent) => {
            event.stopPropagation()
            props.onMore(row)
          }}
        >
          Show {Math.min(row.hidden, CHILD_STEP).toLocaleString()} more
        </button>
        <span className="jt-hidden">{row.hidden.toLocaleString()} not shown</span>
      </div>
    )
  }

  const label = row.depth === 0 ? 'root' : labelText(row.label)
  const toggle = (event: ReactMouseEvent): void => {
    event.stopPropagation()
    props.onSelect(row)
    props.onToggle(row, event.altKey)
  }

  let body: JSX.Element
  if (row.container) {
    body = (
      <span className="jt-v is-punct">
        {headOf(row.value, row.count)}
        {!row.open && <span className="jt-preview">{previewOf(row.value)}</span>}
      </span>
    )
  } else if (row.type === 'string') {
    const raw = row.value as string
    const limit = wide ? CLIP_MAX : CLIP
    const clipped = raw.length > limit
    const shown = `"${escapeJson(clipped ? raw.slice(0, limit) : raw)}${clipped ? '…' : ''}"`
    body = (
      <span className="jt-v is-string">
        <Marked text={shown} needle={needle} />
        {clipped && !wide && (
          <button
            type="button"
            className="jt-inline"
            tabIndex={-1}
            title={`Show more of this ${raw.length.toLocaleString()} character string`}
            onMouseDown={hold}
            onClick={(event: ReactMouseEvent) => {
              event.stopPropagation()
              props.onWiden(row.path)
            }}
          >
            +{(raw.length - limit).toLocaleString()}
          </button>
        )}
      </span>
    )
  } else {
    body = (
      <span className={`jt-v ${valueClass(row)}`}>
        <Marked text={scalarDisplay(row.value, row.type)} needle={needle} />
      </span>
    )
  }

  return (
    <div
      className={`jt-row${cursor ? ' is-cursor' : ''}`}
      id={props.domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-posinset={row.pos}
      aria-setsize={row.size}
      aria-expanded={row.branch ? row.open : undefined}
      aria-selected={cursor}
      onClick={() => props.onSelect(row)}
    >
      <span className="jt-indent" style={indent} aria-hidden="true" />
      {row.branch ? (
        <span className="jt-caret" onClick={toggle}>
          <Caret open={row.open} size={11} />
        </span>
      ) : (
        <span className="jt-caret is-empty" aria-hidden="true" />
      )}
      <span
        className={`jt-key${row.depth === 0 ? ' is-root plate' : row.index ? ' is-index' : ''}`}
        onClick={toggle}
      >
        {row.depth === 0 || row.index ? label : <Marked text={label} needle={needle} />}
      </span>
      <span className="jt-colon">:</span>
      {body}
      <span className="jt-actions">
        {row.path !== '' && (
          <button
            type="button"
            className="jt-act"
            tabIndex={-1}
            aria-label={`Copy the path ${row.path}`}
            title="Copy path (P)"
            onMouseDown={hold}
            onClick={(event: ReactMouseEvent) => {
              event.stopPropagation()
              props.onPickPath(row.path)
            }}
          >
            <Icon name="link" size={11} />
          </button>
        )}
        <button
          type="button"
          className="jt-act"
          tabIndex={-1}
          aria-label={`Copy the value of ${label}`}
          title="Copy value (C)"
          onMouseDown={hold}
          onClick={(event: ReactMouseEvent) => {
            event.stopPropagation()
            props.onCopyValue(row)
          }}
        >
          <Icon name="copy" size={11} />
        </button>
      </span>
    </div>
  )
})

/* ------------------------------------------------------------------ */
/* JsonTree                                                            */
/* ------------------------------------------------------------------ */

export interface JsonTreeProps {
  value: unknown
  defaultExpandDepth?: number
  filter?: string
  onPickPath?: (path: string) => void
  className?: string
}

interface Slice {
  start: number
  end: number
}

export function JsonTree({
  value,
  defaultExpandDepth = 1,
  filter = '',
  onPickPath,
  className,
}: JsonTreeProps): JSX.Element {
  const uid = useId()
  // A callback ref, not useRef: the scroller unmounts whenever a filter
  // matches nothing, and the observers below have to follow the new node.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const uiScale = useStore((s) => s.settings.uiScale)

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    seedExpanded(value, defaultExpandDepth),
  )
  const [shown, setShown] = useState<ReadonlyMap<string, number>>(EMPTY_LIMITS)
  const [wide, setWide] = useState<ReadonlySet<string>>(EMPTY_SET)
  const [cursor, setCursor] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [range, setRange] = useState<Slice>({ start: 0, end: 60 })
  const [rowH, setRowH] = useState(ROW_FALLBACK)

  // A new document resets everything. Done during render rather than in an
  // effect so the old tree is never painted against the new value.
  const [source, setSource] = useState(value)
  if (source !== value) {
    setSource(value)
    setExpanded(seedExpanded(value, defaultExpandDepth))
    setShown(EMPTY_LIMITS)
    setWide(EMPTY_SET)
    setCursor(null)
    setNotice('')
    setRange({ start: 0, end: 60 })
  }

  // The filter walks the whole document, so it rides one render behind the
  // keystroke that caused it.
  const needle = useDeferredValue(filter.trim())
  const scan = useMemo(() => (needle ? scanFilter(value, needle) : null), [value, needle])

  const rows = useMemo(
    () =>
      buildRows({
        root: value,
        open: expanded,
        forced: scan === null ? null : scan.forced,
        keep: scan === null ? null : scan.keep,
        hits: scan === null ? null : scan.hits,
        shown,
      }),
    [value, expanded, scan, shown],
  )

  const cursorIndex = useMemo(
    () => (cursor === null ? -1 : rows.findIndex((row) => row.path === cursor)),
    [rows, cursor],
  )

  /* ---------------------------- virtualisation ------------------- */

  // Rows are 20px on the 4px grid, but every other metric in the app tracks
  // uiScale. The spacers are only in register if this number is the height the
  // stylesheet actually produced, so it is measured off a real row rather than
  // assumed - reading --jt-row back would hand over an unevaluated round().
  useLayoutEffect(() => {
    const first = scroller?.querySelector('.jt-row')
    if (!(first instanceof HTMLElement)) return
    const measured = first.getBoundingClientRect().height
    if (measured >= 8) setRowH((prev) => (Math.abs(prev - measured) < 0.5 ? prev : measured))
  }, [uiScale, scroller, rows.length])

  const measure = useCallback(() => {
    const el = scroller
    if (el === null) return
    const first = Math.max(0, Math.floor(el.scrollTop / rowH) - OVERSCAN)
    const span = Math.ceil(el.clientHeight / rowH) + OVERSCAN * 2
    setRange((prev) =>
      prev.start === first && prev.end === first + span ? prev : { start: first, end: first + span },
    )
  }, [rowH, scroller])

  useEffect(() => {
    measure()
  }, [measure, rows.length])

  useEffect(() => {
    const el = scroller
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    return () => observer.disconnect()
  }, [measure, scroller])

  // A new document, or a new filter, starts from the top.
  useEffect(() => {
    const el = scroller
    if (el !== null) el.scrollTop = 0
  }, [value, needle, scroller])

  useEffect(() => {
    if (cursorIndex < 0) return
    const el = scroller
    if (el === null) return
    const top = cursorIndex * rowH
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowH > el.scrollTop + el.clientHeight) {
      el.scrollTop = top + rowH - el.clientHeight
    }
  }, [cursorIndex, rowH, scroller])

  /* ---------------------------- actions -------------------------- */

  const select = useCallback((row: JsonRow) => setCursor(row.path), [])

  const toggle = useCallback((row: JsonRow, deep: boolean) => {
    if (!row.branch) return
    if (deep && !row.open) {
      const sub = expandFrom(row.value, row.path, EXPAND_CAP)
      if (sub === null) {
        setNotice(`That branch alone would show over ${EXPAND_CAP.toLocaleString()} rows.`)
        return
      }
      setNotice('')
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const path of sub) next.add(path)
        return next
      })
      return
    }
    setNotice('')
    setExpanded((prev) => {
      const next = new Set(prev)
      if (deep) {
        for (const path of prev) if (isUnder(path, row.path)) next.delete(path)
      } else if (row.open) next.delete(row.path)
      else next.add(row.path)
      return next
    })
  }, [])

  const expandAll = useCallback(() => {
    const all = expandFrom(value, '', EXPAND_CAP)
    if (all === null) {
      setNotice(
        `Too large to expand: this body would show over ${EXPAND_CAP.toLocaleString()} rows. Open the branches you need instead.`,
      )
      return
    }
    setNotice('')
    setExpanded(all)
  }, [value])

  const collapseAll = useCallback(() => {
    setNotice('')
    setExpanded(EMPTY_SET)
  }, [])

  const showMore = useCallback((row: JsonRow) => {
    setShown((prev) => {
      const next = new Map(prev)
      next.set(row.owner, (prev.get(row.owner) ?? CHILD_FIRST) + CHILD_STEP)
      return next
    })
  }, [])

  const widen = useCallback((path: string) => {
    setWide((prev) => new Set(prev).add(path))
  }, [])

  const pickPath = useCallback(
    (path: string) => {
      // The contract is "always copies". When a handler exists it owns the
      // feedback, so this write stays silent rather than raising a second toast.
      if (onPickPath) {
        onPickPath(path)
        void navigator.clipboard.writeText(path).catch(() => undefined)
        return
      }
      copyText(path, 'Path copied')
    },
    [onPickPath],
  )

  const copyValue = useCallback((row: JsonRow) => {
    if (row.kind !== 'node') return
    copyText(serialize(row.value), 'Value copied')
  }, [])

  const copyAll = useCallback(() => copyText(serialize(value), 'JSON copied'), [value])

  /* ---------------------------- keyboard ------------------------- */

  const move = useCallback(
    (to: number) => {
      if (rows.length === 0) return
      setCursor(rows[Math.max(0, Math.min(rows.length - 1, to))].path)
    },
    [rows],
  )

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.ctrlKey || event.metaKey || rows.length === 0) return
      const i = cursorIndex
      const row = i >= 0 ? rows[i] : null
      const el = scroller
      const page = Math.max(1, Math.floor((el?.clientHeight ?? rowH * 10) / rowH) - 1)

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          move(i + 1)
          break
        case 'ArrowUp':
          event.preventDefault()
          move(i <= 0 ? 0 : i - 1)
          break
        case 'PageDown':
          event.preventDefault()
          move(Math.max(i, 0) + page)
          break
        case 'PageUp':
          event.preventDefault()
          move(Math.max(i, 0) - page)
          break
        case 'Home':
          event.preventDefault()
          move(0)
          break
        case 'End':
          event.preventDefault()
          move(rows.length - 1)
          break
        case 'ArrowRight':
          event.preventDefault()
          if (row === null) move(0)
          else if (row.branch && !row.open) toggle(row, event.altKey)
          else if (i + 1 < rows.length && rows[i + 1].depth > row.depth) move(i + 1)
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (row === null) {
            move(0)
            break
          }
          if (row.branch && row.open) {
            toggle(row, event.altKey)
            break
          }
          for (let j = i - 1; j >= 0; j--) {
            if (rows[j].depth < row.depth) {
              move(j)
              break
            }
          }
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          if (row === null) move(0)
          else if (row.kind === 'more') showMore(row)
          else toggle(row, event.altKey)
          break
        case 'c':
        case 'C':
          if (row !== null && row.kind === 'node') {
            event.preventDefault()
            copyValue(row)
          }
          break
        case 'p':
        case 'P':
          if (row !== null && row.kind === 'node' && row.path !== '') {
            event.preventDefault()
            pickPath(row.path)
          }
          break
        default:
          break
      }
    },
    [rows, cursorIndex, rowH, scroller, move, toggle, showMore, copyValue, pickPath],
  )

  /* ---------------------------- render --------------------------- */

  const total = rows.length
  const start = Math.max(0, Math.min(range.start, total))
  const end = Math.max(start, Math.min(range.end, total))
  const slice = rows.slice(start, end)
  const activeId = cursorIndex >= start && cursorIndex < end ? `${uid}-r-${cursorIndex}` : undefined
  const blank = scan !== null && scan.matches === 0

  return (
    <div className={className ? `jsontree ${className}` : 'jsontree'}>
      <div className="jt-bar">
        <button type="button" className="btn btn-ghost btn-sm" onClick={expandAll}>
          <Icon name="expand" size={12} />
          Expand all
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={collapseAll}>
          <Icon name="collapse" size={12} />
          Collapse all
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copyAll}>
          <Icon name="copy" size={12} />
          Copy JSON
        </button>

        <span className="jt-bar-spacer" />

        {notice !== '' && (
          <span className="jt-notice" role="status" title={notice}>
            <Icon name="alert" size={12} />
            {notice}
          </span>
        )}

        <span className="jt-count mono" role="status">
          {scan === null
            ? `${total.toLocaleString()} rows`
            : `${scan.matches.toLocaleString()}${scan.capped ? '+' : ''} ${
                scan.matches === 1 ? 'match' : 'matches'
              }`}
        </span>
      </div>

      {blank ? (
        <div className="empty-state jt-empty">
          <p className="plate">No matches</p>
          <p>Nothing in this body contains that text.</p>
        </div>
      ) : (
        <div
          className="jt-scroll"
          ref={setScroller}
          role="tree"
          tabIndex={0}
          aria-label="JSON body"
          aria-activedescendant={activeId}
          onScroll={measure}
          onKeyDown={onKeyDown}
        >
          <div className="jt-pad" style={{ height: `${start * rowH}px` }} aria-hidden="true" />
          {slice.map((row, offset) => (
            <Row
              key={row.path === '' ? '#root' : row.path}
              row={row}
              domId={`${uid}-r-${start + offset}`}
              cursor={cursorIndex === start + offset}
              needle={needle}
              wide={wide.has(row.path)}
              onSelect={select}
              onToggle={toggle}
              onMore={showMore}
              onWiden={widen}
              onPickPath={pickPath}
              onCopyValue={copyValue}
            />
          ))}
          <div
            className="jt-pad"
            style={{ height: `${(total - end) * rowH}px` }}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  )
}
