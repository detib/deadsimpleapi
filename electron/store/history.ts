import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SETTINGS,
  type HistoryEntry,
  type RequestSettings,
  type Timing,
  type WireBody,
  type WirePart,
  type WireRequest,
} from '../../shared/types'
import { debouncedWriter, paths, readJsonSafe, writeJsonAtomic } from './paths'

/**
 * A single append-mostly file, newest first. Firing requests in a loop must not
 * turn into one disk write per request, so writes are coalesced and only the
 * final state of the window reaches disk. Main flushes on quit.
 */

const WRITE_DELAY_MS = 400
const MAX_LIMIT = 10_000

let entries: HistoryEntry[] | null = null
let loading: Promise<HistoryEntry[]> | null = null
let limit = DEFAULT_APP_SETTINGS.historyLimit

const writer = debouncedWriter(WRITE_DELAY_MS, () => writeJsonAtomic(paths().history, entries ?? []))

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

function coerceWireSettings(raw: unknown): RequestSettings {
  const o = isRecord(raw) ? raw : {}
  const d = DEFAULT_SETTINGS
  return {
    followRedirects: bool(o.followRedirects, d.followRedirects),
    maxRedirects: Math.max(0, num(o.maxRedirects, d.maxRedirects)),
    timeoutMs: Math.max(0, num(o.timeoutMs, d.timeoutMs)),
    verifyTls: bool(o.verifyTls, d.verifyTls),
    encodeUrl: bool(o.encodeUrl, d.encodeUrl),
    sendCookies: bool(o.sendCookies, d.sendCookies),
    storeCookies: bool(o.storeCookies, d.storeCookies),
    decompress: bool(o.decompress, d.decompress),
    streamResponse: bool(o.streamResponse, d.streamResponse),
    proxy: str(o.proxy, d.proxy),
  }
}

function coerceWireBody(raw: unknown): WireBody {
  const o = isRecord(raw) ? raw : {}
  if (o.kind === 'text') return { kind: 'text', text: str(o.text, '') }
  if (o.kind === 'file') return { kind: 'file', path: str(o.path, '') }
  if (o.kind === 'multipart') {
    const parts: WirePart[] = []
    for (const item of Array.isArray(o.parts) ? o.parts : []) {
      if (!isRecord(item)) continue
      const part: WirePart = {
        name: str(item.name, ''),
        kind: item.kind === 'file' ? 'file' : 'text',
        value: str(item.value, ''),
      }
      if (typeof item.filePath === 'string') part.filePath = item.filePath
      if (typeof item.fileName === 'string') part.fileName = item.fileName
      if (typeof item.contentType === 'string') part.contentType = item.contentType
      parts.push(part)
    }
    return { kind: 'multipart', parts }
  }
  return { kind: 'none' }
}

/**
 * The snapshot is handed straight back to the engine when a row is re-fired, so
 * a hand-edited file must not be able to reach it half-formed.
 */
function coerceSnapshot(raw: Record<string, unknown>): WireRequest {
  const headers: Array<[string, string]> = []
  for (const item of Array.isArray(raw.headers) ? raw.headers : []) {
    if (Array.isArray(item) && typeof item[0] === 'string') {
      headers.push([item[0], str(item[1], '')])
    }
  }
  return {
    execId: str(raw.execId, ''),
    method: str(raw.method, 'GET'),
    url: str(raw.url, ''),
    headers,
    body: coerceWireBody(raw.body),
    settings: coerceWireSettings(raw.settings),
  }
}

const PHASES = ['dns', 'tcp', 'tls', 'wait', 'download'] as const

function coerceTiming(raw: unknown): Timing | undefined {
  if (!isRecord(raw)) return undefined
  const timing: Timing = { total: num(raw.total, 0), startedAt: num(raw.startedAt, 0) }
  for (const phase of PHASES) {
    const v = raw[phase]
    if (typeof v === 'number' && Number.isFinite(v)) timing[phase] = v
  }
  return timing
}

/** Drops rows that carry nothing useful; keeps anything that can be replayed. */
function coerce(raw: unknown): HistoryEntry | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id : ''
  const at = num(raw.at, 0)
  if (!id || !at || !isRecord(raw.snapshot)) return null

  const out: HistoryEntry = {
    id,
    at,
    method: typeof raw.method === 'string' ? raw.method : 'GET',
    url: typeof raw.url === 'string' ? raw.url : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    ok: raw.ok === true,
    durationMs: num(raw.durationMs, 0),
    responseSize: num(raw.responseSize, 0),
    snapshot: coerceSnapshot(raw.snapshot),
  }
  if (typeof raw.collectionId === 'string') out.collectionId = raw.collectionId
  if (typeof raw.requestId === 'string') out.requestId = raw.requestId
  if (typeof raw.status === 'number') out.status = raw.status
  if (typeof raw.statusText === 'string') out.statusText = raw.statusText
  if (typeof raw.error === 'string') out.error = raw.error
  const timing = coerceTiming(raw.timing)
  if (timing) out.timing = timing
  return out
}

/** Newest first, so trimming the tail drops the oldest. */
function trim(list: HistoryEntry[]): boolean {
  if (limit <= 0) {
    const had = list.length > 0
    list.length = 0
    return had
  }
  if (list.length <= limit) return false
  list.length = limit
  return true
}

function ensure(): Promise<HistoryEntry[]> {
  if (entries) return Promise.resolve(entries)
  if (!loading) {
    loading = (async () => {
      const raw = await readJsonSafe<unknown>(paths().history, [])
      const list: HistoryEntry[] = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const e = coerce(item)
          if (e) list.push(e)
        }
      }
      list.sort((a, b) => b.at - a.at)
      trim(list)
      // A clear or an add that happened while we were reading wins.
      if (!entries) entries = list
      return entries
    })().finally(() => {
      loading = null
    })
  }
  return loading
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  return (await ensure()).slice()
}

export async function addHistory(e: HistoryEntry): Promise<void> {
  const list = await ensure()
  list.unshift(e)
  trim(list)
  writer.schedule()
}

export async function clearHistory(): Promise<void> {
  entries = []
  writer.schedule()
  // Destructive and user-initiated: do not leave it sitting in the window.
  await writer.flush()
}

export async function deleteHistory(id: string): Promise<void> {
  const list = await ensure()
  const i = list.findIndex((e) => e.id === id)
  if (i < 0) return
  list.splice(i, 1)
  writer.schedule()
}

export function setHistoryLimit(n: number): void {
  const next = Number.isFinite(n)
    ? Math.max(0, Math.min(MAX_LIMIT, Math.floor(n)))
    : DEFAULT_APP_SETTINGS.historyLimit
  if (next === limit) return
  limit = next
  if (entries && trim(entries)) writer.schedule()
}

export async function flushHistory(): Promise<void> {
  await writer.flush()
}
