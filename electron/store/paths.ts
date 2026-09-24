import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { clearTimeout as clearTimer, setTimeout as setTimer } from 'node:timers'

/**
 * Everything the app owns lives as plain JSON under Electron's userData
 * directory: no database, no native modules, just files a user can read, diff
 * and back up.
 */

export interface StorePaths {
  root: string
  /** Directory holding one <slug>.<id>.json file per collection. */
  collections: string
  history: string
  settings: string
  cookies: string
  /** Response bodies too large to hand over IPC. */
  overflow: string
  tmp: string
}

let resolved: StorePaths | null = null

/** Called once from main, before anything else touches the store. */
export function initPaths(userDataDir: string): void {
  const tmp = join(userDataDir, 'tmp')
  resolved = {
    root: userDataDir,
    collections: join(userDataDir, 'collections'),
    history: join(userDataDir, 'history.json'),
    settings: join(userDataDir, 'settings.json'),
    cookies: join(userDataDir, 'cookies.json'),
    // Overflow bodies are throwaway state, so they share the scratch dir:
    // wiping one directory clears both.
    overflow: tmp,
    tmp,
  }
}

export function paths(): StorePaths {
  if (!resolved) throw new Error('store: initPaths() must be called before any store access')
  return resolved
}

export async function ensureDirs(): Promise<void> {
  const p = paths()
  const dirs = [...new Set([p.root, p.collections, p.tmp, p.overflow])]
  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })))
}

/* ------------------------------------------------------------------ */
/* File names                                                          */
/* ------------------------------------------------------------------ */

/** Win32 resolves these to DOS devices whatever extension follows. */
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/**
 * Cutting UTF-16 at a fixed length can orphan the leading half of a surrogate
 * pair (an emoji in the name), and Windows rejects a filename containing one.
 */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  const head = s.slice(0, max)
  const last = head.charCodeAt(max - 1)
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, max - 1) : head
}

/**
 * Turns a collection name into a filesystem-safe slug. The slug is cosmetic -
 * the id appended after it is what keeps the file unique - so it may be lossy.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/\s+/g, '-')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '')
    .toLowerCase()
    .replace(/-{2,}/g, '-')
    .replace(/^[-.\s]+/, '')

  // Windows silently drops trailing dots and spaces, so the name we think we
  // wrote would not be the name on disk.
  let slug = cut(cleaned, 60).replace(/[-.\s]+$/, '')

  if (!slug) return 'collection'
  if (RESERVED_DEVICE.test(slug.split('.')[0])) slug = `_${slug}`
  return slug
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** '' when the value is not a Node errno error. */
export function errnoCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return ''
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/* ------------------------------------------------------------------ */
/* Serialised work queues                                              */
/* ------------------------------------------------------------------ */

export interface KeyedQueue {
  <T>(key: string, task: () => Promise<T>): Promise<T>
}

const noop = (): void => {}

/**
 * Runs tasks that share a key one after another. A rejected task does not
 * poison the queue: the next one still runs.
 */
export function createKeyedQueue(): KeyedQueue {
  const chains = new Map<string, Promise<unknown>>()
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve()
    const run = prev.then(task, task)
    const settled: Promise<unknown> = run.then(noop, noop)
    chains.set(key, settled)
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key)
    })
    return run
  }
}

/* ------------------------------------------------------------------ */
/* Atomic JSON IO                                                      */
/* ------------------------------------------------------------------ */

const fileQueue = createKeyedQueue()

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimer(resolve, ms)
  })

async function renameOver(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    const code = errnoCode(err)
    // On Windows an antivirus scanner or the search indexer can hold a handle
    // on the target for a few milliseconds; one retry clears it in practice.
    if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err
    await delay(50)
    await rename(from, to)
  }
}

async function writeStaging(staging: string, json: string): Promise<void> {
  const fh = await open(staging, 'w')
  try {
    await fh.writeFile(json, 'utf8')
    // The rename is atomic, but it says nothing about the bytes having left the
    // page cache: without this, a power cut can leave a well-named empty file.
    // Best effort - some filesystems answer EINVAL and there is nothing to do.
    await fh.sync().catch(noop)
  } finally {
    await fh.close().catch(noop)
  }
}

/**
 * Write-then-rename, so a crash mid-write leaves the previous file intact.
 * Writes to the same path are serialised in-process.
 */
export function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  return fileQueue(file, async () => {
    const json = JSON.stringify(data, null, 2)
    const staging = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeStaging(staging, json)
      await renameOver(staging, file)
    } catch (err) {
      await unlink(staging).catch(noop)
      throw err
    }
  })
}

/** Never throws: a missing, empty or malformed file yields the fallback. */
export async function readJsonSafe<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8')
    // Notepad and PowerShell both like to prepend a BOM to hand-edited files.
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    if (!text.trim()) return fallback
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

/* ------------------------------------------------------------------ */
/* Debounced writes                                                    */
/* ------------------------------------------------------------------ */

export interface DebouncedWriter {
  /** Marks the state dirty and arms the coalescing window. */
  schedule(): void
  /** Writes pending state now, and waits for any in-flight write. */
  flush(): Promise<void>
}

/**
 * Coalescing writer. The timer is armed by the first change and is not pushed
 * back by later ones, so sustained activity still reaches disk every `delayMs`
 * instead of being starved until it stops.
 */
export function debouncedWriter(delayMs: number, write: () => Promise<void>): DebouncedWriter {
  let timer: ReturnType<typeof setTimer> | null = null
  let dirty = false
  let inFlight: Promise<void> = Promise.resolve()

  const fire = (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (!dirty) return inFlight
    dirty = false
    // Persistence is best effort: a failed write must not reject whoever
    // happened to trigger the flush, which is usually app quit.
    inFlight = inFlight.then(write, write).catch(noop)
    return inFlight
  }

  return {
    schedule(): void {
      dirty = true
      if (timer !== null) return
      timer = setTimer(() => {
        timer = null
        void fire()
      }, delayMs)
    },
    flush: fire,
  }
}
