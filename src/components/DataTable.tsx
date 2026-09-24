import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import { analyzeArray, compareValues, getPath, type ColumnStat, type JsonType } from '../lib/json'
import { useStore } from '../state/store'
import { ContextMenu, type MenuItem } from './ui/ContextMenu'
import { Icon } from './ui/Icon'
import './DataTable.css'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const MAX_COLUMNS = 150
const SAMPLE_SIZE = 500
const OVERSCAN = 8
const MIN_COL_W = 60
const MAX_COL_W = 680
/** Bases multiplied by --ui-scale; DataTable.css repeats the same maths. */
const GUTTER_BASE = 52
const HEAD_BASE = 30
const ROW_BASE = { comfortable: 26, compact: 21 } as const
/** Past this many columns the first one is worth freezing. */
const PIN_AFTER = 6
const NARROW_PX = 760
/* Above this the toolbar has room to lay the controls out flat instead of
   hiding them behind an overflow button. Filling the window or going full
   screen clears it comfortably. */
const ROOMY_PX = 1080
const AUTOSIZE_ROWS = 300
const MEASURE_CAP = 160
const DAY_MS = 86_400_000
/** Prefixed to exported CSV so Excel reads the file as UTF-8, not ANSI. */
const BOM = '﻿'

type Density = keyof typeof ROW_BASE
type FieldKind = 'string' | 'number' | 'date' | 'boolean' | 'other'
type PopKind = 'columns' | 'filters' | 'export' | 'more' | null

interface SortSpec {
  path: string
  dir: 'asc' | 'desc'
}

interface Filter {
  id: string
  path: string
  op: OpId
  a: string
  b: string
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                       */
/* ------------------------------------------------------------------ */

const isNullish = (v: unknown): boolean => v === null || v === undefined

function isEmptyValue(v: unknown): boolean {
  if (isNullish(v)) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

function numOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function boolOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (s === 'true' || s === 'yes' || s === '1') return true
  if (s === 'false' || s === 'no' || s === '0') return false
  return null
}

const WHOLE_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Epochs are only read as dates at 10 (seconds) or 13 (millis) digits. */
function toTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= 1e12) return v
    if (v >= 1e9) return v * 1000
    return null
  }
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  if (/^\d{13}$/.test(t)) return Number(t)
  if (/^\d{10}$/.test(t)) return Number(t) * 1000
  const parsed = Date.parse(t)
  return Number.isFinite(parsed) ? parsed : null
}

function cellText(v: unknown): string {
  if (v === undefined) return ''
  if (v === null) return 'null'
  const t = typeof v
  if (t === 'string') return v as string
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

const INT_FMT = new Intl.NumberFormat()
const NUM_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 })

function fmtInt(n: number): string {
  return INT_FMT.format(n)
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  // Outside this band Intl either spells an exponent out in full or rounds
  // the value away to zero; the raw literal is the honest reading.
  if (n !== 0 && (Math.abs(n) >= 1e21 || Math.abs(n) < 1e-6)) return String(n)
  return NUM_FMT.format(n)
}

function refLabel(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`
  return `{${Object.keys(v as object).length}}`
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

let seq = 0
function uid(): string {
  seq += 1
  return `f${seq}`
}

/* ------------------------------------------------------------------ */
/* Column shape                                                        */
/* ------------------------------------------------------------------ */

function kindOf(col: ColumnStat): FieldKind {
  if (col.type === 'boolean') return 'boolean'
  // dateLike is only ever set on string columns, so it outranks numeric:
  // a column of epoch-second strings is a date, not a measurement.
  if (col.dateLike) return 'date'
  if (col.numeric) return 'number'
  if (col.type === 'object' || col.type === 'array') return 'other'
  return 'string'
}

function typeLabel(col: ColumnStat): string {
  switch (col.type) {
    case 'array':
      return 'arr'
    case 'object':
      return 'obj'
    case 'mixed':
      return 'mixed'
    case 'null':
    case 'undefined':
      return 'null'
    default:
      break
  }
  const kind = kindOf(col)
  return kind === 'string' ? 'str' : kind === 'number' ? 'num' : kind === 'other' ? 'obj' : kind
}

/** The JsonType handed to compareValues, not the column's raw dominant type. */
function sortType(col: ColumnStat | undefined): JsonType {
  if (!col) return 'mixed'
  if (col.type === 'boolean') return 'boolean'
  if (col.numeric) return 'number'
  // compareStrings already orders date-shaped strings chronologically.
  if (col.type === 'string') return 'string'
  return 'mixed'
}

/* ------------------------------------------------------------------ */
/* Operators                                                           */
/* ------------------------------------------------------------------ */

type OpId =
  | 'contains'
  | 'ncontains'
  | 'eq'
  | 'neq'
  | 'starts'
  | 'ends'
  | 'regex'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'before'
  | 'after'
  | 'istrue'
  | 'isfalse'
  | 'empty'
  | 'nempty'
  | 'isnull'
  | 'notnull'

interface OpDef {
  id: OpId
  label: string
  arity: 0 | 1 | 2
}

const ANY_OPS: OpDef[] = [
  { id: 'isnull', label: 'is null', arity: 0 },
  { id: 'notnull', label: 'is not null', arity: 0 },
]

const EMPTY_OPS: OpDef[] = [
  { id: 'empty', label: 'is empty', arity: 0 },
  { id: 'nempty', label: 'is not empty', arity: 0 },
]

const OPS: Record<FieldKind, OpDef[]> = {
  string: [
    { id: 'contains', label: 'contains', arity: 1 },
    { id: 'ncontains', label: 'does not contain', arity: 1 },
    { id: 'eq', label: 'equals', arity: 1 },
    { id: 'neq', label: 'not equals', arity: 1 },
    { id: 'starts', label: 'starts with', arity: 1 },
    { id: 'ends', label: 'ends with', arity: 1 },
    { id: 'regex', label: 'matches regex', arity: 1 },
    ...EMPTY_OPS,
    ...ANY_OPS,
  ],
  number: [
    { id: 'eq', label: '=', arity: 1 },
    { id: 'neq', label: '!=', arity: 1 },
    { id: 'gt', label: '>', arity: 1 },
    { id: 'gte', label: '>=', arity: 1 },
    { id: 'lt', label: '<', arity: 1 },
    { id: 'lte', label: '<=', arity: 1 },
    { id: 'between', label: 'between', arity: 2 },
    ...EMPTY_OPS,
    ...ANY_OPS,
  ],
  date: [
    { id: 'before', label: 'before', arity: 1 },
    { id: 'after', label: 'after', arity: 1 },
    { id: 'between', label: 'between', arity: 2 },
    ...EMPTY_OPS,
    ...ANY_OPS,
  ],
  boolean: [
    { id: 'istrue', label: 'is true', arity: 0 },
    { id: 'isfalse', label: 'is false', arity: 0 },
    { id: 'empty', label: 'is empty', arity: 0 },
    ...ANY_OPS,
  ],
  other: [
    { id: 'contains', label: 'contains', arity: 1 },
    { id: 'ncontains', label: 'does not contain', arity: 1 },
    ...EMPTY_OPS,
    ...ANY_OPS,
  ],
}

function opDef(kind: FieldKind, id: OpId): OpDef {
  return OPS[kind].find((o) => o.id === id) ?? OPS[kind][0]
}

interface Compiled {
  test(row: unknown): boolean
  error?: string
}

const PASS: Compiled = { test: () => true }

/**
 * Never throws: a bad regex reports its message and stops filtering, and an
 * operand the user has not finished typing leaves every row visible instead
 * of blanking the table between keystrokes.
 */
function compileFilter(f: Filter, col: ColumnStat | undefined): Compiled {
  const kind = col ? kindOf(col) : 'string'
  const path = f.path
  const at = (row: unknown): unknown => getPath(row, path)

  switch (f.op) {
    case 'isnull':
      return { test: (r) => isNullish(at(r)) }
    case 'notnull':
      return { test: (r) => !isNullish(at(r)) }
    case 'empty':
      return { test: (r) => isEmptyValue(at(r)) }
    case 'nempty':
      return { test: (r) => !isEmptyValue(at(r)) }
    case 'istrue':
      return { test: (r) => boolOf(at(r)) === true }
    case 'isfalse':
      return { test: (r) => boolOf(at(r)) === false }
    default:
      break
  }

  const a = f.a.trim()
  if (!a) return PASS

  switch (f.op) {
    case 'contains':
    case 'ncontains':
    case 'starts':
    case 'ends': {
      const needle = a.toLowerCase()
      const hit = (r: unknown): boolean => {
        const s = cellText(at(r)).toLowerCase()
        if (f.op === 'starts') return s.startsWith(needle)
        if (f.op === 'ends') return s.endsWith(needle)
        return s.includes(needle)
      }
      return f.op === 'ncontains' ? { test: (r) => !hit(r) } : { test: hit }
    }
    case 'regex': {
      let re: RegExp
      try {
        re = new RegExp(a, 'i')
      } catch (err) {
        return { test: () => true, error: err instanceof Error ? err.message : 'Invalid regex' }
      }
      return { test: (r) => re.test(cellText(at(r))) }
    }
    case 'eq':
    case 'neq': {
      if (kind === 'number') {
        const target = Number(a)
        if (!Number.isFinite(target)) return PASS
        const hit = (r: unknown): boolean => numOf(at(r)) === target
        return f.op === 'eq' ? { test: hit } : { test: (r) => !hit(r) }
      }
      const target = a.toLowerCase()
      const hit = (r: unknown): boolean => cellText(at(r)).toLowerCase() === target
      return f.op === 'eq' ? { test: hit } : { test: (r) => !hit(r) }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const target = Number(a)
      if (!Number.isFinite(target)) return PASS
      return {
        test: (r) => {
          const n = numOf(at(r))
          if (n === null) return false
          if (f.op === 'gt') return n > target
          if (f.op === 'gte') return n >= target
          if (f.op === 'lt') return n < target
          return n <= target
        },
      }
    }
    case 'before':
    case 'after': {
      const target = toTime(a)
      if (target === null) return PASS
      // A bare yyyy-mm-dd means the whole day, so "after" starts at the next
      // midnight rather than excluding that day's own later timestamps.
      const from = WHOLE_DAY.test(a) ? target + DAY_MS : target
      return {
        test: (r) => {
          const t = toTime(at(r))
          if (t === null) return false
          return f.op === 'before' ? t < target : t >= from
        },
      }
    }
    case 'between': {
      if (kind === 'date') {
        const b = f.b.trim()
        const ta = toTime(a)
        const tb = toTime(b)
        if (ta === null || tb === null) return PASS
        // Each bound covers an interval of its own: a bare yyyy-mm-dd is that
        // whole day, a timestamp is just itself. Taking the union means both
        // ends are included and "between X and X" is never empty.
        const from = Math.min(ta, tb)
        const endA = ta + (WHOLE_DAY.test(a) ? DAY_MS : 1)
        const endB = tb + (WHOLE_DAY.test(b) ? DAY_MS : 1)
        const to = Math.max(endA, endB)
        return {
          test: (r) => {
            const t = toTime(at(r))
            return t !== null && t >= from && t < to
          },
        }
      }
      const x = Number(a)
      const y = Number(f.b.trim())
      if (!Number.isFinite(x) || !Number.isFinite(y)) return PASS
      const [from, to] = x <= y ? [x, y] : [y, x]
      return {
        test: (r) => {
          const n = numOf(at(r))
          return n !== null && n >= from && n <= to
        },
      }
    }
    default:
      return PASS
  }
}

function filterSummary(f: Filter, col: ColumnStat | undefined): string {
  const kind = col ? kindOf(col) : 'string'
  const def = opDef(kind, f.op)
  const name = col?.label ?? f.path ?? 'value'
  if (def.arity === 0) return `${name} ${def.label}`
  if (def.arity === 2) return `${name} ${def.label} ${f.a || '…'} – ${f.b || '…'}`
  return `${name} ${def.label} ${f.a || '…'}`
}

/* ------------------------------------------------------------------ */
/* Measuring                                                           */
/* ------------------------------------------------------------------ */

let measureCtx: CanvasRenderingContext2D | null | undefined

function textWidth(text: string, font: string): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

/* ------------------------------------------------------------------ */
/* Popover                                                             */
/* ------------------------------------------------------------------ */

function Popover({
  anchor,
  label,
  width,
  onClose,
  children,
}: {
  anchor: HTMLElement
  label: string
  width?: number
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(() => {
    const box = anchor.getBoundingClientRect()
    return { left: box.left, top: box.bottom + 4 }
  })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const self = el.getBoundingClientRect()
    const rect = anchor.getBoundingClientRect()
    const pad = 8
    setPos({
      left: Math.max(pad, Math.min(rect.left, window.innerWidth - self.width - pad)),
      top: Math.max(pad, Math.min(rect.bottom + 4, window.innerHeight - self.height - pad)),
    })
    el.focus()
  }, [anchor])

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      // The trigger keeps its own click, so its button stays a real toggle.
      if (ref.current?.contains(target) || anchor.contains(target)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])

  return createPortal(
    <div
      ref={ref}
      className="dt-pop"
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top, width }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      {children}
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* Cell                                                                */
/* ------------------------------------------------------------------ */

function CellBody({
  value,
  isDate,
  onOpen,
}: {
  value: unknown
  isDate: boolean
  onOpen: () => void
}): JSX.Element {
  // A key that is absent and a key that is present but null are different
  // facts about the payload, so they never render the same.
  if (value === undefined) {
    return (
      <span className="dt-void" title="Key not present in this row">
        —
      </span>
    )
  }
  if (value === null) {
    return (
      <span className="dt-null" title="null">
        null
      </span>
    )
  }
  if (typeof value === 'boolean') {
    return <span className={`dt-bool${value ? ' is-true' : ''}`}>{value ? 'true' : 'false'}</span>
  }
  if (typeof value === 'number') {
    return <span className="dt-numv">{fmtNumber(value)}</span>
  }
  if (typeof value === 'object') {
    return (
      <button
        type="button"
        className="dt-ref"
        title="Open row detail"
        onClick={(event) => {
          event.stopPropagation()
          onOpen()
        }}
      >
        {refLabel(value)}
      </button>
    )
  }
  const text = String(value)
  if (isDate) {
    const t = toTime(text)
    return (
      <span className="dt-datev" title={t === null ? text : new Date(t).toLocaleString()}>
        {text}
      </span>
    )
  }
  return <span title={text.length > 24 ? text : undefined}>{text}</span>
}

/* ------------------------------------------------------------------ */
/* DataTable                                                           */
/* ------------------------------------------------------------------ */

export interface DataTableProps {
  rows: unknown[]
  sourcePath?: string
  onChangeSource?: () => void
  className?: string
}

export function DataTable({
  rows,
  sourcePath,
  onChangeSource,
  className,
}: DataTableProps): JSX.Element {
  const toast = useStore((s) => s.toast)
  // The same number DataTable.css multiplies its row metrics by, read from the
  // one source of truth rather than off the computed --ui-scale custom property.
  const uiScale = useStore((s) => s.settings.uiScale)
  const scale = uiScale > 0 ? uiScale : 1

  const [density, setDensity] = useState<Density>('comfortable')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filter[]>([])
  const [sorts, setSorts] = useState<SortSpec[]>([])
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [pinned, setPinned] = useState<string | null>(null)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [resizing, setResizing] = useState<string | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [detail, setDetail] = useState<number | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  /** 'app' fills the workbench between the two rails; 'screen' is real
      element fullscreen, the F11 behaviour. */
  const [zoom, setZoom] = useState<'none' | 'app' | 'screen'>('none')
  const [pop, setPop] = useState<PopKind>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    path: string
    index: number | null
  } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [view, setView] = useState({ w: 900, h: 420 })
  const [shellW, setShellW] = useState(NARROW_PX * 2)

  const rootRef = useRef<HTMLDivElement>(null)

  // The user can leave real fullscreen without touching our button (Escape,
  // F11, the window manager), so the browser is the source of truth.
  useEffect(() => {
    const sync = () => {
      const mine = document.fullscreenElement === rootRef.current
      setZoom((z) => (mine ? 'screen' : z === 'screen' ? 'none' : z))
    }
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleZoom = useCallback((mode: 'app' | 'screen') => {
    setZoom((current) => {
      if (mode === 'screen') {
        if (current === 'screen') {
          void document.exitFullscreen?.()
          return 'none'
        }
        // requestFullscreen rejects when the gesture is not trusted; the
        // fullscreenchange handler confirms success, so failing is a no-op.
        void rootRef.current?.requestFullscreen?.().catch(() => undefined)
        return current
      }
      if (current === 'screen') void document.exitFullscreen?.()
      return current === 'app' ? 'none' : 'app'
    })
  }, [])

  // Escape leaves the fill-the-window mode. Real fullscreen is the browser's
  // to close, and it already handles Escape itself.
  useEffect(() => {
    if (zoom !== 'app') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setZoom('none')
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [zoom])
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const filtersBtn = useRef<HTMLButtonElement>(null)
  const columnsBtn = useRef<HTMLButtonElement>(null)
  const exportBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)

  const anchorPos = useRef<number | null>(null)

  /* -------------------- reset when the source changes -------------- */

  const [prevRows, setPrevRows] = useState(rows)
  if (prevRows !== rows) {
    // A different array is a different table: nothing about the old one's
    // columns, filters or selection survives.
    setPrevRows(rows)
    setSearch('')
    setFilters([])
    setSorts([])
    setHidden(new Set<string>())
    setPinned(null)
    setWidths({})
    setSelected(new Set<number>())
    setDetail(null)
    setCursor(null)
    setScrollTop(0)
    anchorPos.current = null
  }

  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [rows])

  /* -------------------- shape -------------------------------------- */

  const shape = useMemo(
    () => analyzeArray(rows, { maxColumns: MAX_COLUMNS, sampleSize: SAMPLE_SIZE }),
    [rows],
  )
  const sampled = Math.min(shape.rowCount, SAMPLE_SIZE)
  const capped = shape.columns.length >= MAX_COLUMNS

  const colByPath = useMemo(() => {
    const map = new Map<string, ColumnStat>()
    for (const col of shape.columns) map.set(col.path, col)
    return map
  }, [shape])

  const columns = useMemo(() => {
    const shown = shape.columns.filter((c) => !hidden.has(c.path))
    if (!pinned) return shown
    const at = shown.findIndex((c) => c.path === pinned)
    if (at <= 0) return shown
    const copy = shown.slice()
    const [col] = copy.splice(at, 1)
    copy.unshift(col)
    return copy
  }, [shape, hidden, pinned])

  /* -------------------- geometry ----------------------------------- */

  const rowH = Math.round(ROW_BASE[density] * scale)
  const headH = Math.round(HEAD_BASE * scale)
  const gutterW = Math.round(GUTTER_BASE * scale)
  // Measured on the whole component, never on the scroller: the drawer takes
  // its width out of the scroller, so deciding "narrow" from that would flip
  // the drawer to a bottom sheet, widen the scroller, flip it back, and spin
  // the ResizeObserver forever.
  const narrow = shellW < NARROW_PX
  const roomy = shellW >= ROOMY_PX

  // The toolbar swaps between flat controls and an overflow button as the
  // panel resizes; a popover anchored to the button that just disappeared
  // would be left pointing at nothing.
  useEffect(() => {
    setPop(null)
  }, [roomy])
  const stickyFirst = columns.length > PIN_AFTER && !narrow

  // Derived once per shape, not per cell: cellText(col.sample) serialises an
  // object sample, and a cell-time default would re-run that for every visible
  // cell on every scroll frame.
  const defaultWidths = useMemo(() => {
    const map = new Map<string, number>()
    for (const col of shape.columns) {
      const label = col.label.length * 7 + 76
      const sample = Math.min(cellText(col.sample).length, 34) * 7 + 24
      const base = kindOf(col) === 'number' ? Math.max(label, 96) : Math.max(label, sample)
      map.set(col.path, clamp(Math.round(base * scale), MIN_COL_W, Math.round(320 * scale)))
    }
    return map
  }, [shape, scale])

  const widthFor = useCallback(
    (col: ColumnStat): number => widths[col.path] ?? defaultWidths.get(col.path) ?? MIN_COL_W,
    [widths, defaultWidths],
  )

  const totalW = useMemo(
    () => columns.reduce((sum, col) => sum + widthFor(col), gutterW),
    [columns, widthFor, gutterW],
  )

  /* -------------------- filter, search, sort ----------------------- */

  const compiled = useMemo(
    () => filters.map((f) => ({ f, c: compileFilter(f, colByPath.get(f.path)) })),
    [filters, colByPath],
  )

  const deferredSearch = useDeferredValue(search)
  const searchPaths = useMemo(() => columns.map((c) => c.path), [columns])

  const ordered = useMemo(() => {
    const src = shape.rows
    const count = src.length
    const tests = compiled.map((x) => x.c.test)
    const q = deferredSearch.trim().toLowerCase()
    const out: number[] = []

    outer: for (let i = 0; i < count; i++) {
      const row = src[i]
      for (const test of tests) if (!test(row)) continue outer
      if (q) {
        let hit = false
        for (const path of searchPaths) {
          if (cellText(getPath(row, path)).toLowerCase().includes(q)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      out.push(i)
    }

    if (sorts.length) {
      const specs = sorts.map((s) => ({ ...s, type: sortType(colByPath.get(s.path)) }))
      out.sort((ia, ib) => {
        for (const spec of specs) {
          const a = getPath(src[ia], spec.path)
          const b = getPath(src[ib], spec.path)
          const an = isNullish(a)
          const bn = isNullish(b)
          // Missing values sink in both directions instead of flipping to the top.
          if (an || bn) {
            if (an && bn) continue
            return an ? 1 : -1
          }
          const r = compareValues(a, b, spec.type)
          if (r !== 0) return spec.dir === 'desc' ? -r : r
        }
        return ia - ib
      })
    }
    return out
  }, [shape, compiled, deferredSearch, searchPaths, sorts, colByPath])

  const total = ordered.length
  const filtered = total !== shape.rowCount
  // The cursor is a position in the current view, and a filter can shrink that
  // view out from under it; past the end it is simply no cursor at all.
  const cursorPos = cursor !== null && cursor < total ? cursor : null

  /* -------------------- virtual window ----------------------------- */

  useEffect(() => {
    const root = rootRef.current
    const el = scrollRef.current
    if (!root || !el) return
    const sync = (): void => {
      setShellW(root.clientWidth)
      // Same-value bail-outs: a horizontal scrollbar appearing fires the
      // observer for both boxes and only one of the two numbers moves.
      setView((prev) =>
        prev.w === el.clientWidth && prev.h === el.clientHeight
          ? prev
          : { w: el.clientWidth, h: el.clientHeight },
      )
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(root)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Rows begin below a sticky header, so the header's own height is dead
  // space at the top of the viewport rather than part of the row window.
  const start = clamp(Math.floor(scrollTop / rowH) - OVERSCAN, 0, Math.max(0, total - 1))
  const end = clamp(Math.ceil((scrollTop + view.h - headH) / rowH) + OVERSCAN, start, total)
  const topPad = start * rowH
  const bottomPad = Math.max(0, (total - end) * rowH)

  /* -------------------- actions ------------------------------------ */

  const copyText = useCallback(
    (text: string, what: string) => {
      navigator.clipboard.writeText(text).then(
        () => toast('success', `${what} copied`),
        () => toast('error', 'Could not write to the clipboard'),
      )
    },
    [toast],
  )

  const toggleSort = useCallback((path: string, additive: boolean) => {
    setSorts((prev) => {
      const at = prev.findIndex((s) => s.path === path)
      const current = at >= 0 ? prev[at] : null
      const next: SortSpec | null = !current
        ? { path, dir: 'asc' }
        : current.dir === 'asc'
          ? { path, dir: 'desc' }
          : null
      if (!additive) return next ? [next] : []
      if (at < 0) return next ? [...prev, next] : prev
      const copy = prev.slice()
      if (next) copy[at] = next
      else copy.splice(at, 1)
      return copy
    })
  }, [])

  const setSortDir = useCallback((path: string, dir: 'asc' | 'desc') => {
    setSorts([{ path, dir }])
  }, [])

  const addFilter = useCallback(
    // The seed is boxed because a cell holding undefined is itself a fact
    // worth filtering on, and a bare optional argument could not tell that
    // apart from "opened the builder with no cell in hand".
    (path: string, seed?: { value: unknown }) => {
      const col = colByPath.get(path)
      const kind = col ? kindOf(col) : 'string'
      const ops = OPS[kind]
      let op: OpId = ops[0].id
      let a = ''
      let b = ''
      if (seed) {
        const value = seed.value
        if (isNullish(value)) op = 'isnull'
        else if (kind === 'boolean') op = boolOf(value) === false ? 'isfalse' : 'istrue'
        else if (kind === 'date') {
          const text = cellText(value)
          const day = text.slice(0, 10)
          // A timestamp narrows to its own day; an epoch has no day to slice
          // off and would be misread as a shorter one, so it stays whole.
          op = 'between'
          a = WHOLE_DAY.test(day) ? day : text
          b = a
        } else {
          op = 'eq'
          a = cellText(value)
        }
      }
      if (!ops.some((o) => o.id === op)) op = ops[0].id
      setFilters((prev) => [...prev, { id: uid(), path, op, a, b }])
    },
    [colByPath],
  )

  const patchFilter = useCallback((id: string, patch: Partial<Filter>) => {
    setFilters((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }, [])

  const dropFilter = useCallback((id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const hideColumn = useCallback(
    (path: string) => {
      setHidden((prev) => {
        // A table with nothing but a row-number gutter is not a view of
        // anything, so the last visible column never turns off.
        if (prev.has(path) || shape.columns.length - prev.size <= 1) return prev
        const next = new Set(prev)
        next.add(path)
        return next
      })
      setPinned((p) => (p === path ? null : p))
    },
    [shape],
  )

  const showColumn = useCallback((path: string) => {
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }, [])

  /* -------------------- export ------------------------------------- */

  const project = useCallback(
    (indices: readonly number[]): Array<Record<string, unknown>> =>
      indices.map((i) => {
        const row = shape.rows[i]
        const out: Record<string, unknown> = {}
        for (const col of columns) out[col.label] = getPath(row, col.path)
        return out
      }),
    [columns, shape],
  )

  const toCsv = useCallback(
    (indices: readonly number[]): string => {
      const esc = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
      const lines = [columns.map((c) => esc(c.label)).join(',')]
      for (const i of indices) {
        const row = shape.rows[i]
        lines.push(columns.map((c) => esc(cellText(getPath(row, c.path)))).join(','))
      }
      return lines.join('\r\n')
    },
    [columns, shape],
  )

  const downloadCsv = useCallback(() => {
    const base =
      (sourcePath ?? 'table').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'table'
    // The BOM is what makes Excel read the file as UTF-8 rather than ANSI.
    const bytes = new TextEncoder().encode(BOM + toCsv(ordered))
    window.api.files.saveAs(`${base}.csv`, bytes).then(
      (path) => {
        if (path) toast('success', 'CSV saved', path)
      },
      (err: unknown) => toast('error', 'Could not save the CSV', String(err)),
    )
  }, [ordered, sourcePath, toCsv, toast])

  /* -------------------- selection ---------------------------------- */

  const selectRange = useCallback(
    (from: number, to: number, additive: boolean) => {
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      setSelected((prev) => {
        const next = new Set<number>(additive ? prev : [])
        for (let p = lo; p <= hi && p < ordered.length; p++) next.add(ordered[p])
        return next
      })
    },
    [ordered],
  )

  /**
   * View order first, then anything a filter has since hidden. The toolbar
   * counts the whole selection, so the copy has to carry the whole selection.
   */
  const selectedRows = useCallback((): unknown[] => {
    const seen = new Set<number>()
    const out: unknown[] = []
    for (const i of ordered) {
      if (!selected.has(i)) continue
      seen.add(i)
      out.push(shape.rows[i])
    }
    const rest = [...selected].filter((i) => !seen.has(i)).sort((x, y) => x - y)
    for (const i of rest) out.push(shape.rows[i])
    return out
  }, [ordered, selected, shape])

  const onRowClick = useCallback(
    (event: React.MouseEvent, pos: number) => {
      const index = ordered[pos]
      setCursor(pos)
      if (event.shiftKey && anchorPos.current !== null) {
        selectRange(anchorPos.current, pos, event.ctrlKey || event.metaKey)
        return
      }
      anchorPos.current = pos
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(index)) next.delete(index)
          else next.add(index)
          return next
        })
        return
      }
      setSelected(new Set([index]))
      setDetail(index)
    },
    [ordered, selectRange],
  )

  const scrollPosIntoView = useCallback(
    (pos: number) => {
      const el = scrollRef.current
      if (!el) return
      const top = pos * rowH
      if (top < el.scrollTop) el.scrollTop = top
      else if (top + rowH > el.scrollTop + el.clientHeight - headH) {
        el.scrollTop = top + rowH - el.clientHeight + headH
      }
    },
    [rowH, headH],
  )

  const onGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // Header buttons and resize grips live inside the grid; their own keys
      // must not also drive the row cursor.
      if (event.target !== event.currentTarget || !total) return
      const page = Math.max(1, Math.floor((view.h - headH) / rowH) - 1)
      const at = cursorPos ?? -1
      let next: number

      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(total - 1, at + 1)
          break
        case 'ArrowUp':
          next = Math.max(0, (cursorPos ?? total) - 1)
          break
        case 'PageDown':
          next = Math.min(total - 1, Math.max(at, 0) + page)
          break
        case 'PageUp':
          next = Math.max(0, Math.max(at, 0) - page)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = total - 1
          break
        case 'Enter':
        case ' ':
          if (cursorPos !== null) {
            event.preventDefault()
            setSelected(new Set([ordered[cursorPos]]))
            setDetail(ordered[cursorPos])
          }
          return
        case 'Escape':
          if (detail !== null) {
            event.preventDefault()
            setDetail(null)
          }
          return
        default:
          return
      }

      event.preventDefault()
      setCursor(next)
      if (event.shiftKey && anchorPos.current !== null) selectRange(anchorPos.current, next, false)
      else {
        anchorPos.current = next
        setSelected(new Set([ordered[next]]))
      }
      scrollPosIntoView(next)
    },
    [total, view.h, headH, rowH, cursorPos, detail, ordered, selectRange, scrollPosIntoView],
  )

  /* -------------------- resizing ----------------------------------- */

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, path: string, from: number) => {
      event.preventDefault()
      event.stopPropagation()
      const el = event.currentTarget
      const startX = event.clientX
      const id = event.pointerId
      el.setPointerCapture(id)
      setResizing(path)
      const move = (ev: PointerEvent): void => {
        setWidths((w) => ({ ...w, [path]: clamp(from + ev.clientX - startX, MIN_COL_W, MAX_COL_W) }))
      }
      const stop = (): void => {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id)
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', stop)
        el.removeEventListener('pointercancel', stop)
        setResizing(null)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', stop)
      el.addEventListener('pointercancel', stop)
    },
    [],
  )

  const autoSize = useCallback(
    (col: ColumnStat) => {
      const grid = gridRef.current
      if (!grid) return
      const style = getComputedStyle(grid)
      const font = `${style.fontSize} ${style.fontFamily}`
      let widest = textWidth(col.label, font) + 74
      const probe = Math.min(ordered.length, AUTOSIZE_ROWS)
      for (let i = 0; i < probe; i++) {
        const text = cellText(getPath(shape.rows[ordered[i]], col.path)).slice(0, MEASURE_CAP)
        if (!text) continue
        const w = textWidth(text, font) + 20
        if (w > widest) widest = w
      }
      setWidths((prev) => ({ ...prev, [col.path]: clamp(Math.ceil(widest), MIN_COL_W, MAX_COL_W) }))
    },
    [ordered, shape],
  )

  /* -------------------- header and cell menu ----------------------- */

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const col = colByPath.get(menu.path)
    if (!col) return []
    const sortAt = sorts.findIndex((s) => s.path === menu.path)
    // A header menu has no row of its own, so it borrows the open row detail
    // or the first selected row for "filter by this value".
    const refIndex =
      menu.index ?? detail ?? (selected.size > 0 ? (selected.values().next().value ?? null) : null)
    const refValue = refIndex === null ? undefined : getPath(shape.rows[refIndex], col.path)

    const items: MenuItem[] = []
    if (menu.index !== null && refIndex !== null) {
      items.push(
        {
          label: 'Copy cell value',
          icon: 'copy',
          onSelect: () => copyText(cellText(refValue), 'Cell'),
        },
        {
          label: 'Copy row JSON',
          icon: 'braces',
          onSelect: () => copyText(JSON.stringify(shape.rows[refIndex], null, 2), 'Row'),
        },
        { label: '', separator: true },
      )
    }
    items.push(
      { label: 'Sort ascending', icon: 'sort-asc', onSelect: () => setSortDir(col.path, 'asc') },
      { label: 'Sort descending', icon: 'sort-desc', onSelect: () => setSortDir(col.path, 'desc') },
      {
        label: 'Clear sort',
        icon: 'close',
        disabled: sortAt < 0,
        onSelect: () => setSorts((prev) => prev.filter((s) => s.path !== col.path)),
      },
      { label: '', separator: true },
      {
        label: 'Filter by this value',
        icon: 'filter',
        disabled: refIndex === null,
        onSelect: () => addFilter(col.path, { value: refValue }),
      },
      {
        label: 'Add filter…',
        icon: 'plus',
        onSelect: () => {
          addFilter(col.path)
          setPop('filters')
        },
      },
      { label: '', separator: true },
      {
        label: 'Hide column',
        icon: 'eye-off',
        disabled: columns.length <= 1,
        onSelect: () => hideColumn(col.path),
      },
      {
        label: pinned === col.path ? 'Unpin column' : 'Pin as first column',
        icon: 'pin',
        onSelect: () => setPinned((p) => (p === col.path ? null : col.path)),
      },
      { label: '', separator: true },
      {
        label: 'Copy column values',
        icon: 'copy',
        onSelect: () =>
          copyText(
            ordered.map((i) => cellText(getPath(shape.rows[i], col.path))).join('\n'),
            `${col.label} values`,
          ),
      },
    )
    return items
  }, [
    menu,
    colByPath,
    columns,
    sorts,
    detail,
    selected,
    shape,
    pinned,
    ordered,
    copyText,
    setSortDir,
    addFilter,
    hideColumn,
  ])

  /* -------------------- derived render data ------------------------ */

  const srcLabel = sourcePath ?? '(root)'
  const activeFilters = filters.length
  const filterErrors = compiled.filter((x) => x.c.error)
  const selectedCount = selected.size

  // The drawer names the row by the number in the gutter, which is its place
  // in the current view, not its index in the untouched array.
  const detailPos = useMemo(
    () => (detail === null ? -1 : ordered.indexOf(detail)),
    [detail, ordered],
  )

  const detailText = useMemo(() => {
    if (detail === null) return ''
    const row = shape.rows[detail]
    try {
      return JSON.stringify(row, null, 2) ?? String(row)
    } catch {
      return String(row)
    }
  }, [detail, shape])

  const body: JSX.Element[] = []
  for (let pos = start; pos < end; pos++) {
    const index = ordered[pos]
    const row = shape.rows[index]
    const isSelected = selected.has(index)
    body.push(
      <div
        key={index}
        id={`dt-row-${pos}`}
        role="row"
        aria-rowindex={pos + 2}
        aria-selected={isSelected}
        className={`dt-row${isSelected ? ' is-sel' : ''}${cursorPos === pos ? ' is-cursor' : ''}`}
        onClick={(event) => onRowClick(event, pos)}
      >
        <div className="dt-cell dt-gutter" role="gridcell" style={{ width: gutterW }}>
          {fmtInt(pos + 1)}
        </div>
        {columns.map((col, ci) => {
          const kind = kindOf(col)
          const pin = stickyFirst && ci === 0
          return (
            <div
              key={col.path}
              role="gridcell"
              className={`dt-cell${kind === 'number' ? ' is-num' : ''}${pin ? ' is-pin' : ''}`}
              style={{ width: widthFor(col), left: pin ? gutterW : undefined }}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, path: col.path, index })
              }}
            >
              <CellBody
                value={getPath(row, col.path)}
                isDate={kind === 'date'}
                onOpen={() => setDetail(index)}
              />
            </div>
          )
        })}
      </div>,
    )
  }

  /** Shared by the overflow menu and the CSV split-button's caret. */
  const exportItems = (
    <>
            <div className="dt-pop-label plate">
              Export {fmtInt(total)} row{total === 1 ? '' : 's'}
            </div>

            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPop(null)
                copyText(JSON.stringify(project(ordered), null, 2), 'JSON')
              }}
            >
              <span className="menu-item-icon">
                <Icon name="braces" size={13} />
              </span>
              <span className="menu-label">Copy as JSON</span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPop(null)
                copyText(toCsv(ordered), 'CSV')
              }}
            >
              <span className="menu-item-icon">
                <Icon name="table" size={13} />
              </span>
              <span className="menu-label">Copy as CSV</span>
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPop(null)
                downloadCsv()
              }}
            >
              <span className="menu-item-icon">
                <Icon name="download" size={13} />
              </span>
              <span className="menu-label">Download CSV</span>
            </button>
    </>
  )

  return (
    <div
      ref={rootRef}
      className={`dt${narrow ? ' is-narrow' : ''}${resizing ? ' is-resizing' : ''}${
        zoom === 'app' ? ' is-zoom-app' : ''
      }${className ? ` ${className}` : ''}`}
      data-density={density}
    >
      <div className="dt-toolbar">
        {onChangeSource ? (
          <button
            type="button"
            className="dt-src"
            onClick={onChangeSource}
            title="Choose a different array in this response"
          >
            <Icon name="table" size={12} />
            <span className="truncate">{srcLabel}</span>
            <Icon name="chevron-down" size={11} />
          </button>
        ) : (
          <span className="dt-src is-static">
            <Icon name="table" size={12} />
            <span className="truncate">{srcLabel}</span>
          </span>
        )}

        <span className="dt-counts">
          <span className="dt-dash">—</span>
          {fmtInt(shape.rowCount)} row{shape.rowCount === 1 ? '' : 's'}
          {filtered && <span className="dt-shown"> · {fmtInt(total)} shown</span>}
        </span>

        <label className="dt-search">
          <Icon name="search" size={12} />
          <input
            className="dt-search-input"
            type="search"
            value={search}
            placeholder="Search rows"
            aria-label="Search across visible columns"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <span className="dt-gap" />

        {selectedCount > 0 && (
          <span className="dt-selinfo">
            <span className="plate">{fmtInt(selectedCount)} selected</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() =>
                copyText(
                  JSON.stringify(selectedRows(), null, 2),
                  `${selectedCount} row${selectedCount === 1 ? '' : 's'}`,
                )
              }
            >
              <Icon name="copy" size={12} />
              Copy selected
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set<number>())}
            >
              <Icon name="close" size={12} />
            </button>
          </span>
        )}

        <button
          type="button"
          ref={filtersBtn}
          className={`btn btn-sm${pop === 'filters' ? ' is-on' : ''}`}
          aria-expanded={pop === 'filters'}
          aria-haspopup="dialog"
          onClick={() => setPop((p) => (p === 'filters' ? null : 'filters'))}
        >
          <Icon name="filter" size={12} />
          Filters
          {activeFilters > 0 && <span className="dt-badge is-on">{activeFilters}</span>}
        </button>

        {roomy ? (
          <>
            <button
              type="button"
              ref={columnsBtn}
              className={`btn btn-sm${pop === 'columns' ? ' is-on' : ''}`}
              aria-expanded={pop === 'columns'}
              aria-haspopup="dialog"
              onClick={() => setPop((p) => (p === 'columns' ? null : 'columns'))}
            >
              <Icon name="columns" size={12} />
              Columns
              {hidden.size > 0 && <span className="dt-badge">{hidden.size} off</span>}
            </button>

            <span className="dt-split">
              <button
                type="button"
                className="btn btn-sm dt-split-main"
                title="Download the visible rows as CSV"
                onClick={downloadCsv}
              >
                <Icon name="download" size={12} />
                CSV
              </button>
              <button
                type="button"
                ref={exportBtn}
                className="btn btn-sm dt-split-caret"
                aria-label="More export formats"
                aria-expanded={pop === 'export'}
                aria-haspopup="dialog"
                onClick={() => setPop((p) => (p === 'export' ? null : 'export'))}
              >
                <Icon name="chevron-down" size={11} />
              </button>
            </span>

            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              aria-pressed={density === 'compact'}
              aria-label={`Row density: ${density}`}
              title={`Row density: ${density}`}
              onClick={() => setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))}
            >
              <Icon name={density === 'compact' ? 'collapse' : 'expand'} size={13} />
            </button>
          </>
        ) : (
          <button
            type="button"
            ref={moreBtn}
            className={`btn btn-ghost btn-icon btn-sm${pop === 'more' ? ' is-on' : ''}`}
            aria-label="Columns, export and density"
            title="Columns, export and density"
            aria-expanded={pop === 'more'}
            aria-haspopup="dialog"
            onClick={() => setPop((p) => (p === 'more' ? null : 'more'))}
          >
            <Icon name="dots" size={13} />
            {hidden.size > 0 && <span className="dt-dot" aria-hidden="true" />}
          </button>
        )}

        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-pressed={zoom === 'app'}
          aria-label={zoom === 'app' ? 'Restore the table' : 'Fill the window with the table'}
          title={zoom === 'app' ? 'Restore  (Esc)' : 'Fill the window'}
          onClick={() => toggleZoom('app')}
        >
          <Icon name={zoom === 'app' ? 'collapse' : 'expand'} size={13} />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          aria-pressed={zoom === 'screen'}
          aria-label={zoom === 'screen' ? 'Leave full screen' : 'Full screen'}
          title={zoom === 'screen' ? 'Leave full screen  (Esc)' : 'Full screen'}
          onClick={() => toggleZoom('screen')}
        >
          <Icon name={zoom === 'screen' ? 'fullscreen-exit' : 'fullscreen'} size={13} />
        </button>
      </div>

      {(activeFilters > 0 || capped || filterErrors.length > 0) && (
        <div className="dt-chips">
          {filters.map((f) => {
            const summary = filterSummary(f, colByPath.get(f.path))
            return (
              <span className="chip dt-chip" key={f.id}>
                <span className="truncate">{summary}</span>
                <button
                  type="button"
                  className="dt-chip-x"
                  aria-label={`Remove filter: ${summary}`}
                  onClick={() => dropFilter(f.id)}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            )
          })}
          {activeFilters > 1 && <span className="dt-chip-note plate">All must match</span>}
          {activeFilters > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters([])}>
              Clear filters
            </button>
          )}
          {filterErrors.map((x) => (
            <span className="dt-chip-err" key={x.f.id}>
              <Icon name="alert" size={11} />
              {x.c.error}
            </span>
          ))}
          {capped && (
            <span className="dt-chip-note plate">
              Column list capped at {MAX_COLUMNS} — deeper keys are not shown
            </span>
          )}
        </div>
      )}

      <div className="dt-main">
        <div
          ref={scrollRef}
          className="dt-scroll"
          role="grid"
          aria-label={`Rows of ${srcLabel}`}
          aria-rowcount={total + 1}
          aria-colcount={columns.length + 1}
          aria-activedescendant={cursorPos === null ? undefined : `dt-row-${cursorPos}`}
          tabIndex={0}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          onKeyDown={onGridKeyDown}
          onFocus={(event) => {
            if (event.target === event.currentTarget && cursorPos === null && total > 0) setCursor(0)
          }}
        >
          <div
            ref={gridRef}
            className="dt-grid"
            role="rowgroup"
            style={{ width: Math.max(totalW, view.w) }}
          >
            <div className="dt-head" role="row" aria-rowindex={1} style={{ height: headH }}>
              <div
                className="dt-th dt-gutter"
                role="columnheader"
                aria-label="Row number"
                style={{ width: gutterW }}
              >
                #
              </div>
              {columns.map((col, ci) => {
                const sortAt = sorts.findIndex((s) => s.path === col.path)
                const spec = sortAt >= 0 ? sorts[sortAt] : null
                const width = widthFor(col)
                const pct = sampled ? Math.min(100, Math.round((col.present / sampled) * 100)) : 100
                const pin = stickyFirst && ci === 0
                return (
                  <div
                    key={col.path}
                    role="columnheader"
                    className={`dt-th${pin ? ' is-pin' : ''}${spec ? ' is-sorted' : ''}`}
                    style={{ width, left: pin ? gutterW : undefined }}
                    aria-sort={spec ? (spec.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      className="dt-th-btn"
                      title={`${col.path || 'value'} · ${typeLabel(col)} · present in ${pct}% of sampled rows · click to sort, shift-click to add a level`}
                      onClick={(event) => toggleSort(col.path, event.shiftKey)}
                    >
                      <span className="dt-th-name truncate">{col.label}</span>
                      <span className="dt-th-type" data-type={typeLabel(col)}>{typeLabel(col)}</span>
                      {pct < 100 && <span className="dt-th-pct">{pct}%</span>}
                      {spec && (
                        <span className="dt-th-sort">
                          <Icon name={spec.dir === 'asc' ? 'sort-asc' : 'sort-desc'} size={11} />
                          {sorts.length > 1 && <b>{sortAt + 1}</b>}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="dt-th-menu"
                      aria-label={`Options for column ${col.label}`}
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setMenu({ x: rect.left, y: rect.bottom + 2, path: col.path, index: null })
                      }}
                    >
                      <Icon name="dots-v" size={12} />
                    </button>
                    <div
                      className="dt-th-grip"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize column ${col.label}`}
                      tabIndex={0}
                      data-dragging={resizing === col.path}
                      onPointerDown={(event) => startResize(event, col.path, width)}
                      onDoubleClick={() => autoSize(col)}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                        event.preventDefault()
                        const delta = event.key === 'ArrowLeft' ? -8 : 8
                        setWidths((w) => ({
                          ...w,
                          [col.path]: clamp(width + delta, MIN_COL_W, MAX_COL_W),
                        }))
                      }}
                    />
                  </div>
                )
              })}
            </div>

            {total === 0 ? (
              <div className="dt-empty">
                {shape.rowCount === 0 ? (
                  <div className="empty-state">
                    <p className="plate">Empty array</p>
                    <p>{srcLabel} holds no rows.</p>
                  </div>
                ) : (
                  <div className="empty-state">
                    <p className="plate">No matches</p>
                    <p>
                      None of the {fmtInt(shape.rowCount)} rows match the current
                      {activeFilters > 0 ? ' filters' : ' search'}.
                    </p>
                    <div className="empty-actions">
                      {activeFilters > 0 && (
                        <button type="button" className="btn btn-sm" onClick={() => setFilters([])}>
                          Clear filters
                        </button>
                      )}
                      {search && (
                        <button type="button" className="btn btn-sm" onClick={() => setSearch('')}>
                          Clear search
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="dt-pad" style={{ height: topPad }} aria-hidden="true" />
                {body}
                <div className="dt-pad" style={{ height: bottomPad }} aria-hidden="true" />
              </>
            )}
          </div>
        </div>

        {detail !== null && (
          <aside className="dt-drawer" aria-label="Row detail">
            <div className="dt-drawer-head">
              <span className="plate">
                Row {fmtInt((detailPos >= 0 ? detailPos : detail) + 1)}
              </span>
              <span className="dt-gap" />
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => copyText(detailText, 'Row')}
              >
                <Icon name="copy" size={12} />
                Copy
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                aria-label="Close row detail"
                onClick={() => setDetail(null)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            <pre className="dt-drawer-body mono">{detailText}</pre>
          </aside>
        )}
      </div>

      {pop === 'columns' && (roomy ? columnsBtn.current : moreBtn.current) && (
        <Popover
          anchor={(roomy ? columnsBtn.current : moreBtn.current) as HTMLElement}
          label="Column visibility"
          width={318}
          onClose={() => setPop(null)}
        >
          <div className="dt-pop-head">
            <span className="plate">Columns</span>
            <span className="dt-gap" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setHidden(new Set<string>())}
            >
              Show all
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              // One column always stays on: a table with no columns is not a view.
              onClick={() => setHidden(new Set(shape.columns.slice(1).map((c) => c.path)))}
            >
              Hide all
            </button>
          </div>
          <div className="dt-pop-body">
            {shape.columns.map((col) => {
              const pct = sampled ? Math.min(100, Math.round((col.present / sampled) * 100)) : 100
              const on = !hidden.has(col.path)
              return (
                <label className="dt-colrow" key={col.path}>
                  <input
                    className="checkbox"
                    type="checkbox"
                    checked={on}
                    disabled={on && columns.length <= 1}
                    onChange={() => (on ? hideColumn(col.path) : showColumn(col.path))}
                  />
                  <span className="dt-colname truncate" title={col.path || 'value'}>
                    {col.label}
                  </span>
                  <span className="dt-colmeta">
                    <span className="dt-th-type" data-type={typeLabel(col)}>{typeLabel(col)}</span>
                    <span className={`dt-colpct${pct < 100 ? ' is-partial' : ''}`}>{pct}%</span>
                  </span>
                </label>
              )
            })}
          </div>
          <div className="dt-pop-foot">
            Structure sampled from {fmtInt(sampled)} of {fmtInt(shape.rowCount)} rows. The
            percentage is how often a key is present — anything under 100% is optional.
          </div>
        </Popover>
      )}

      {pop === 'filters' && filtersBtn.current && (
        <Popover
          anchor={filtersBtn.current}
          label="Filter builder"
          width={narrow ? 380 : 580}
          onClose={() => setPop(null)}
        >
          <div className="dt-pop-head">
            <span className="plate">Filters — all must match</span>
            <span className="dt-gap" />
            {activeFilters > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters([])}>
                Clear all
              </button>
            )}
          </div>
          <div className="dt-pop-body">
            {filters.length === 0 && (
              <p className="dt-pop-empty">No filters yet. Add one to narrow the rows down.</p>
            )}
            {filters.map((f) => {
              const col = colByPath.get(f.path)
              const kind = col ? kindOf(col) : 'string'
              const def = opDef(kind, f.op)
              const error = compiled.find((x) => x.f.id === f.id)?.c.error
              const valueType = kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'
              return (
                <div className="dt-frow" key={f.id}>
                  <select
                    className="select dt-fcol"
                    value={f.path}
                    aria-label="Filter column"
                    onChange={(event) => {
                      const nextCol = colByPath.get(event.target.value)
                      const nextKind = nextCol ? kindOf(nextCol) : 'string'
                      const keep = OPS[nextKind].some((o) => o.id === f.op)
                      patchFilter(f.id, {
                        path: event.target.value,
                        op: keep ? f.op : OPS[nextKind][0].id,
                      })
                    }}
                  >
                    {shape.columns.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select dt-fop"
                    value={f.op}
                    aria-label="Filter operator"
                    onChange={(event) => patchFilter(f.id, { op: event.target.value as OpId })}
                  >
                    {OPS[kind].map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {def.arity === 0 ? (
                    <span className="dt-fnone">no value</span>
                  ) : (
                    <span className="dt-fvals">
                      <input
                        className={`input dt-fv${error ? ' input-invalid' : ''}`}
                        type={valueType}
                        step={valueType === 'number' ? 'any' : undefined}
                        value={f.a}
                        aria-label="Filter value"
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => patchFilter(f.id, { a: event.target.value })}
                      />
                      {def.arity === 2 && (
                        <>
                          <span className="dt-fand">and</span>
                          <input
                            className="input dt-fv"
                            type={valueType}
                            step={valueType === 'number' ? 'any' : undefined}
                            value={f.b}
                            aria-label="Filter upper bound"
                            onChange={(event) => patchFilter(f.id, { b: event.target.value })}
                          />
                        </>
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    aria-label="Remove this filter"
                    onClick={() => dropFilter(f.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                  {error && (
                    <p className="dt-ferr">
                      <Icon name="alert" size={11} />
                      {error} — this filter is being ignored.
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          <div className="dt-pop-foot">
            <button
              type="button"
              className="btn btn-sm"
              disabled={shape.columns.length === 0}
              onClick={() => addFilter(shape.columns[0].path)}
            >
              <Icon name="plus" size={12} />
              Add filter
            </button>
          </div>
        </Popover>
      )}

      {pop === 'export' && exportBtn.current && (
        <Popover anchor={exportBtn.current} label="Export" width={252} onClose={() => setPop(null)}>
          <div className="dt-pop-body is-menu">{exportItems}</div>
        </Popover>
      )}

      {pop === 'more' && moreBtn.current && (
        <Popover anchor={moreBtn.current} label="Table options" width={264} onClose={() => setPop(null)}>
          <div className="dt-pop-body is-menu">
            <button
              type="button"
              className="menu-item"
              onClick={() => setPop('columns')}
            >
              <span className="menu-item-icon">
                <Icon name="columns" size={13} />
              </span>
              <span className="menu-label">Columns</span>
              <span className="menu-key">
                {hidden.size > 0
                  ? `${fmtInt(columns.length)} of ${fmtInt(shape.columns.length)}`
                  : fmtInt(columns.length)}
              </span>
            </button>

            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setPop(null)
                setDensity((d) => (d === 'compact' ? 'comfortable' : 'compact'))
              }}
            >
              <span className="menu-item-icon">
                <Icon name={density === 'compact' ? 'expand' : 'collapse'} size={13} />
              </span>
              <span className="menu-label">
                {density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
              </span>
            </button>

            <div className="menu-sep" role="separator" />

            {exportItems}
          </div>
          <div className="dt-pop-foot">
            Exports follow the current filters, sort and column visibility.
          </div>
        </Popover>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  )
}
