import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SETTINGS,
  type AppSettings,
  type RequestSettings,
} from '../../shared/types'
import { debouncedWriter, paths, readJsonSafe, writeJsonAtomic } from './paths'

/**
 * settings.json is meant to be hand-editable, so nothing here trusts it: every
 * field is coerced back to its default when the type is wrong and clamped to a
 * range the UI can actually render.
 */

const WRITE_DELAY_MS = 300

const MIN_BODY_CAP = 1024 * 1024
const MAX_BODY_CAP = 512 * 1024 * 1024

let current: AppSettings = defaults()
let loaded = false
let loading: Promise<AppSettings> | null = null

const writer = debouncedWriter(WRITE_DELAY_MS, () => writeJsonAtomic(paths().settings, current))

function defaults(): AppSettings {
  return { ...DEFAULT_APP_SETTINGS, defaultSettings: { ...DEFAULT_SETTINGS } }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.min(max, Math.max(min, n))
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  Math.round(clamp(v, min, max, fallback))

/**
 * `base` is what an absent or unusable field falls back to: the defaults when
 * reading the file, the live value when merging a patch, so a single bad field
 * in an IPC patch cannot silently reset the rest of the user's configuration.
 */
function coerceRequestSettings(raw: unknown, base: RequestSettings): RequestSettings {
  const o = isRecord(raw) ? raw : {}
  const d = base
  return {
    followRedirects: bool(o.followRedirects, d.followRedirects),
    maxRedirects: clampInt(o.maxRedirects, 0, 50, d.maxRedirects),
    timeoutMs: clampInt(o.timeoutMs, 0, 3_600_000, d.timeoutMs),
    verifyTls: bool(o.verifyTls, d.verifyTls),
    encodeUrl: bool(o.encodeUrl, d.encodeUrl),
    sendCookies: bool(o.sendCookies, d.sendCookies),
    storeCookies: bool(o.storeCookies, d.storeCookies),
    decompress: bool(o.decompress, d.decompress),
    streamResponse: bool(o.streamResponse, d.streamResponse),
    proxy: str(o.proxy, d.proxy).trim(),
  }
}

function coerceSettings(raw: unknown, base: AppSettings): AppSettings {
  const o = isRecord(raw) ? raw : {}
  const d = base
  return {
    theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : d.theme,
    uiScale: clamp(o.uiScale, 0.8, 1.6, d.uiScale),
    editorFontSize: clamp(o.editorFontSize, 9, 24, d.editorFontSize),
    wrapLines: bool(o.wrapLines, d.wrapLines),
    historyLimit: clampInt(o.historyLimit, 0, 10_000, d.historyLimit),
    inlineBodyCapBytes: clampInt(o.inlineBodyCapBytes, MIN_BODY_CAP, MAX_BODY_CAP, d.inlineBodyCapBytes),
    defaultSettings: coerceRequestSettings(o.defaultSettings, d.defaultSettings),
    sidebarWidth: clampInt(o.sidebarWidth, 180, 600, d.sidebarWidth),
    responseWidth: clampInt(o.responseWidth, 320, 1400, d.responseWidth),
    sidebarCollapsed: bool(o.sidebarCollapsed, d.sidebarCollapsed),
    confirmDelete: bool(o.confirmDelete, d.confirmDelete),
  }
}

export function loadSettings(): Promise<AppSettings> {
  if (loaded) return Promise.resolve(currentSettings())
  if (!loading) {
    loading = (async () => {
      const raw = await readJsonSafe<unknown>(paths().settings, {})
      current = coerceSettings(raw, defaults())
      loaded = true
      return currentSettings()
    })().finally(() => {
      loading = null
    })
  }
  return loading
}

/**
 * Field-by-field merge over what is already loaded; unknown keys are dropped,
 * and a field the patch omits - or sets to something unusable - keeps its
 * current value rather than snapping back to the factory default.
 */
export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  await loadSettings()
  current = coerceSettings(patch, current)
  writer.schedule()
  return currentSettings()
}

/** Synchronous snapshot for hot paths; defaults until loadSettings resolves. */
export function currentSettings(): AppSettings {
  return { ...current, defaultSettings: { ...current.defaultSettings } }
}

export async function flushSettings(): Promise<void> {
  await writer.flush()
}
