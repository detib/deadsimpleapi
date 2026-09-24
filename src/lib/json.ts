/**
 * Structure analysis powering the response table view. Pure - no React, no DOM.
 * Everything here is written to stay linear over row count: a 50k-row array is
 * only ever fully touched for its length, never re-serialised or re-scanned.
 */

export type JsonType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | 'array'
  | 'mixed'
  | 'undefined'

export interface ColumnStat {
  path: string
  label: string
  types: Record<JsonType, number>
  type: JsonType
  present: number
  nullCount: number
  unique: number
  sample: unknown
  numeric: boolean
  dateLike: boolean
  booleanLike: boolean
  min?: number
  max?: number
}

export interface TableShape {
  rows: unknown[]
  columns: ColumnStat[]
  rowCount: number
  homogeneous: boolean
}

export function typeOf(v: unknown): JsonType {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (Array.isArray(v)) return 'array'
  switch (typeof v) {
    case 'string':
      return 'string'
    case 'number':
    case 'bigint':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      // Functions and symbols cannot come out of JSON.parse.
      return 'undefined'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function childPath(parent: string, key: string): string {
  if (IDENT_RE.test(key)) return parent ? `${parent}.${key}` : key
  return `${parent}[${JSON.stringify(key)}]`
}

const pathCache = new Map<string, string[]>()

function parsePath(path: string): string[] {
  const cached = pathCache.get(path)
  if (cached) return cached

  const tokens: string[] = []
  let buf = ''
  for (let i = 0; i < path.length; i++) {
    const c = path[i]
    if (c === '.') {
      if (buf) tokens.push(buf)
      buf = ''
      continue
    }
    if (c === '[') {
      if (buf) tokens.push(buf)
      buf = ''
      const close = path.indexOf(']', i)
      if (close < 0) break
      let inner = path.slice(i + 1, close).trim()
      const quoted =
        inner.length >= 2 &&
        ((inner.startsWith("'") && inner.endsWith("'")) ||
          (inner.startsWith('"') && inner.endsWith('"')))
      if (quoted) inner = inner.slice(1, -1)
      tokens.push(inner)
      i = close
      continue
    }
    buf += c
  }
  if (buf) tokens.push(buf)

  if (pathCache.size > 1000) pathCache.clear()
  pathCache.set(path, tokens)
  return tokens
}

function readTokens(root: unknown, tokens: string[]): unknown {
  let cur: unknown = root
  for (const token of tokens) {
    if (cur === null || cur === undefined || token === '') return undefined
    if (Array.isArray(cur)) {
      const i = Number(token)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined
      cur = cur[i]
      continue
    }
    if (typeof cur !== 'object') return undefined
    const record = cur as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, token)) return undefined
    cur = record[token]
  }
  return cur
}

/** Dots and [n] indices; ['quoted key'] is accepted too. Never throws. */
export function getPath(root: unknown, path: string): unknown {
  return readTokens(root, parsePath(path))
}

/* ------------------------------------------------------------------ */
/* Array discovery                                                     */
/* ------------------------------------------------------------------ */

export interface ArrayHit {
  path: string
  length: number
  objectLike: boolean
}

/** Elements probed per array when recursing, so a huge array stays cheap. */
const ARRAY_PROBE = 5
const MAX_HITS = 200

export function findArrayPaths(root: unknown, maxDepth = 6): ArrayHit[] {
  const out: ArrayHit[] = []
  visitForArrays(root, '', 0, maxDepth, out)
  // The UI auto-selects out[0]: the biggest table-shaped array wins.
  out.sort(
    (a, b) =>
      (a.objectLike === b.objectLike ? 0 : a.objectLike ? -1 : 1) ||
      b.length - a.length ||
      a.path.length - b.path.length,
  )
  return out
}

function visitForArrays(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  out: ArrayHit[],
): void {
  if (out.length >= MAX_HITS) return

  if (Array.isArray(value)) {
    out.push({ path, length: value.length, objectLike: isObjectLike(value) })
    if (depth >= maxDepth) return
    const probe = Math.min(value.length, ARRAY_PROBE)
    for (let i = 0; i < probe; i++) {
      visitForArrays(value[i], `${path}[${i}]`, depth + 1, maxDepth, out)
      if (out.length >= MAX_HITS) return
    }
    return
  }

  if (isRecord(value) && depth < maxDepth) {
    for (const key of Object.keys(value)) {
      visitForArrays(value[key], childPath(path, key), depth + 1, maxDepth, out)
      if (out.length >= MAX_HITS) return
    }
  }
}

function isObjectLike(rows: unknown[]): boolean {
  const probe = Math.min(rows.length, 20)
  if (probe === 0) return false
  let records = 0
  for (let i = 0; i < probe; i++) if (isRecord(rows[i])) records++
  return records * 2 >= probe && records > 0
}

/* ------------------------------------------------------------------ */
/* Column analysis                                                     */
/* ------------------------------------------------------------------ */

const UNIQUE_CAP = 1000
const DOMINANT_RATIO = 0.8
const BOOL_WORDS = new Set(['true', 'false', '0', '1', 'yes', 'no'])
const VALUE_TYPES: JsonType[] = ['string', 'number', 'boolean', 'object', 'array']

/**
 * Conservative date shapes only: ISO 8601, yyyy-mm-dd, yyyy/mm/dd, or a 10/13
 * digit epoch. A plain integer must never be read as a date.
 */
const DATE_SHAPE =
  /^(\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?|\d{4}\/\d{2}\/\d{2}|\d{10}|\d{13})$/

function looksDateish(s: string): boolean {
  if (s.length < 10 || s.length > 40) return false
  const first = s.charCodeAt(0)
  if (first < 48 || first > 57) return false
  if (!DATE_SHAPE.test(s)) return false
  // Epoch strings never reach Date.parse; everything else must really parse.
  if (s.length <= 13 && !s.includes('-') && !s.includes('/')) return true
  return Number.isFinite(Date.parse(s))
}

function numify(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

interface Acc {
  path: string
  label: string
  types: Record<JsonType, number>
  present: number
  nullCount: number
  uniques: Set<string> | null
  uniqueCount: number
  sample: unknown
  hasSample: boolean
  stringCount: number
  numericStrings: number
  dateStrings: number
  boolLike: number
  hasNumber: boolean
  min: number
  max: number
}

function newAcc(path: string, label: string): Acc {
  return {
    path,
    label,
    types: {
      string: 0,
      number: 0,
      boolean: 0,
      null: 0,
      object: 0,
      array: 0,
      mixed: 0,
      undefined: 0,
    },
    present: 0,
    nullCount: 0,
    uniques: new Set<string>(),
    uniqueCount: 0,
    sample: undefined,
    hasSample: false,
    stringCount: 0,
    numericStrings: 0,
    dateStrings: 0,
    boolLike: 0,
    hasNumber: false,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  }
}

function addUnique(acc: Acc, key: string): void {
  if (acc.uniques === null) return
  acc.uniques.add(key)
  if (acc.uniques.size >= UNIQUE_CAP) {
    acc.uniqueCount = acc.uniques.size
    acc.uniques = null
  }
}

function trackNumber(acc: Acc, n: number): void {
  acc.hasNumber = true
  if (n < acc.min) acc.min = n
  if (n > acc.max) acc.max = n
}

function observe(
  accs: Map<string, Acc>,
  path: string,
  label: string,
  value: unknown,
  rowIndex: number,
  maxColumns: number,
): void {
  let acc = accs.get(path)
  if (!acc) {
    if (accs.size >= maxColumns) return
    acc = newAcc(path, label)
    accs.set(path, acc)
  }

  const type = typeOf(value)
  acc.types[type]++
  acc.present++
  if (type === 'null' || type === 'undefined') {
    acc.nullCount++
    return
  }
  if (!acc.hasSample) {
    acc.sample = value
    acc.hasSample = true
  }

  switch (type) {
    case 'string': {
      const s = value as string
      acc.stringCount++
      if (looksDateish(s)) acc.dateStrings++
      const n = numify(s)
      if (n !== null) {
        acc.numericStrings++
        trackNumber(acc, n)
      }
      if (BOOL_WORDS.has(s.toLowerCase())) acc.boolLike++
      addUnique(acc, 's:' + s)
      break
    }
    case 'number': {
      const n = Number(value)
      if (Number.isFinite(n)) trackNumber(acc, n)
      if (n === 0 || n === 1) acc.boolLike++
      addUnique(acc, 'n:' + String(n))
      break
    }
    case 'boolean': {
      acc.boolLike++
      addUnique(acc, 'b:' + String(value))
      break
    }
    default:
      // Objects and arrays are assumed distinct rather than serialised.
      addUnique(acc, '#' + String(rowIndex))
  }
}

function collect(
  row: Record<string, unknown>,
  prefix: string,
  depth: number,
  maxDepth: number,
  maxColumns: number,
  accs: Map<string, Acc>,
  rowIndex: number,
): void {
  for (const key of Object.keys(row)) {
    const value = row[key]
    const path = childPath(prefix, key)
    // Arrays are never flattened: they stay one column of type 'array'.
    if (depth < maxDepth && isRecord(value) && Object.keys(value).length > 0) {
      collect(value, path, depth + 1, maxDepth, maxColumns, accs, rowIndex)
    } else {
      observe(accs, path, key, value, rowIndex, maxColumns)
    }
  }
}

function finalize(acc: Acc): ColumnStat {
  const denom = acc.present - acc.nullCount

  let type: JsonType
  if (denom <= 0) {
    type = acc.nullCount > 0 ? 'null' : 'undefined'
  } else {
    let best: JsonType = 'mixed'
    let bestCount = 0
    for (const candidate of VALUE_TYPES) {
      const count = acc.types[candidate]
      if (count > bestCount) {
        bestCount = count
        best = candidate
      }
    }
    type = bestCount / denom >= DOMINANT_RATIO ? best : 'mixed'
  }

  const numeric =
    denom > 0 && (type === 'number' || (acc.stringCount === denom && acc.numericStrings === denom))
  const dateLike =
    acc.stringCount > 0 &&
    acc.stringCount / denom >= DOMINANT_RATIO &&
    acc.dateStrings / acc.stringCount >= DOMINANT_RATIO
  const booleanLike = denom > 0 && (type === 'boolean' || acc.boolLike === denom)

  const stat: ColumnStat = {
    path: acc.path,
    label: acc.label,
    types: acc.types,
    type,
    present: acc.present,
    nullCount: acc.nullCount,
    unique: acc.uniques ? acc.uniques.size : acc.uniqueCount,
    sample: acc.sample,
    numeric,
    dateLike,
    booleanLike,
  }
  if (numeric && acc.hasNumber) {
    stat.min = acc.min
    stat.max = acc.max
  }
  return stat
}

/** 'id' first, then a depth-1 '<something>.id', then first-seen order. */
const ID_AT_DEPTH_1 = /^[A-Za-z_$][A-Za-z0-9_$]*\.id$/

function idRank(path: string): number {
  if (path === 'id') return 0
  return ID_AT_DEPTH_1.test(path) ? 1 : 2
}

export function analyzeArray(
  rows: unknown[],
  opts?: { maxDepth?: number; maxColumns?: number; sampleSize?: number },
): TableShape {
  const maxDepth = Math.max(1, opts?.maxDepth ?? 2)
  const maxColumns = Math.max(1, opts?.maxColumns ?? 200)
  const sampleSize = Math.max(1, opts?.sampleSize ?? 500)

  // getPath on a downloaded document can hand back anything; never assume the
  // caller checked that the selected node really is an array.
  const list = Array.isArray(rows) ? rows : []
  const rowCount = list.length
  const sampled = Math.min(rowCount, sampleSize)
  const accs = new Map<string, Acc>()

  for (let k = 0; k < sampled; k++) {
    // Evenly spread the sample so a tail of differently-shaped rows still shows.
    const index = rowCount > sampleSize ? Math.floor((k * rowCount) / sampleSize) : k
    const row = list[index]
    if (isRecord(row)) collect(row, '', 1, maxDepth, maxColumns, accs, index)
    else observe(accs, '', 'value', row, index, maxColumns)
  }

  const columns = [...accs.values()].map(finalize)

  // Disambiguate leaf labels only when two columns would read the same.
  const labelCounts = new Map<string, number>()
  for (const column of columns) {
    labelCounts.set(column.label, (labelCounts.get(column.label) ?? 0) + 1)
  }
  for (const column of columns) {
    if ((labelCounts.get(column.label) ?? 0) > 1) column.label = column.path
  }

  // Array.prototype.sort is stable, so first-seen order survives inside a rank.
  columns.sort((a, b) => idRank(a.path) - idRank(b.path))

  return {
    rows: list,
    columns,
    rowCount,
    homogeneous: sampled > 0 && columns.every((c) => c.present === sampled),
  }
}

/* ------------------------------------------------------------------ */
/* Sorting                                                             */
/* ------------------------------------------------------------------ */

const TYPE_RANK: Record<JsonType, number> = {
  number: 0,
  string: 1,
  boolean: 2,
  array: 3,
  object: 4,
  mixed: 5,
  null: 6,
  undefined: 7,
}

let collator: Intl.Collator | null = null

function compareStrings(a: string, b: string): number {
  if (a === b) return 0
  if (looksDateish(a) && looksDateish(b)) {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta < tb ? -1 : 1
  }
  // Intl.Collator is localeCompare(a, b, { numeric, sensitivity }) without
  // rebuilding the options object on every comparison.
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  return collator.compare(a, b)
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return numify(v)
  if (typeof v === 'boolean') return v ? 1 : 0
  return null
}

function compareNumbers(a: unknown, b: unknown): number {
  const x = toNumber(a)
  const y = toNumber(b)
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
  return x < y ? -1 : x > y ? 1 : 0
}

const isNullish = (v: unknown): boolean => v === null || v === undefined

/** Total order for sorting. Nullish sorts last; see makeComparator for direction. */
export function compareValues(a: unknown, b: unknown, type: JsonType): number {
  if (isNullish(a) || isNullish(b)) return isNullish(a) && isNullish(b) ? 0 : isNullish(a) ? 1 : -1

  switch (type) {
    case 'number':
      return compareNumbers(a, b)
    case 'boolean':
      return (a === true ? 1 : 0) - (b === true ? 1 : 0)
    case 'string':
      return compareStrings(String(a), String(b))
    default: {
      const ta = typeOf(a)
      const tb = typeOf(b)
      if (ta !== tb) return TYPE_RANK[ta] - TYPE_RANK[tb]
      if (ta === 'number') return compareNumbers(a, b)
      if (ta === 'boolean') return (a === true ? 1 : 0) - (b === true ? 1 : 0)
      if (ta === 'string') return compareStrings(a as string, b as string)
      // Objects and arrays keep their original order.
      return 0
    }
  }
}

/**
 * Row comparator for a column. The path is parsed once, and nullish values stay
 * at the bottom in both directions.
 */
export function makeComparator(
  path: string,
  type: JsonType,
  dir: 'asc' | 'desc',
): (a: unknown, b: unknown) => number {
  const tokens = parsePath(path)
  const sign = dir === 'desc' ? -1 : 1
  return (rowA, rowB) => {
    const a = readTokens(rowA, tokens)
    const b = readTokens(rowB, tokens)
    if (isNullish(a) || isNullish(b)) {
      return isNullish(a) && isNullish(b) ? 0 : isNullish(a) ? 1 : -1
    }
    return sign * compareValues(a, b, type)
  }
}
