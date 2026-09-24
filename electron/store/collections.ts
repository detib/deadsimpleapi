import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { cloneNode, countRequests, newCollection, uid } from '../../shared/factory'
import { normalizeCollection } from '../../shared/normalize'
import type { Collection, CollectionSummary, KV, VariableSet } from '../../shared/types'
import {
  createKeyedQueue,
  errnoCode,
  paths,
  readJsonSafe,
  safeFileName,
  writeJsonAtomic,
} from './paths'

/**
 * One JSON file per collection, named <slug>.<id>.json: the slug keeps the
 * directory browsable, the id keeps it collision-free. The id inside the file
 * is authoritative - the name is only a label - so a user may rename files
 * freely without breaking anything.
 */

const byId = new Map<string, Collection>()
const pathById = new Map<string, string>()
/** Files already read into the cache, so a rescan never re-parses them. */
const ingested = new Set<string>()

const queue = createKeyedQueue()

let scanned = false
let scanning: Promise<void> | null = null

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function fileFor(c: Collection): string {
  return join(paths().collections, `${safeFileName(c.name)}.${c.id}.json`)
}

async function ingest(file: string): Promise<void> {
  const raw = await readJsonSafe<unknown>(file, null)
  ingested.add(file)
  if (!isRecord(raw)) return
  const c = normalizeCollection(raw)
  const owner = pathById.get(c.id)
  if (owner !== undefined && owner !== file) {
    // Two files claim the same id, which happens when a user copies one by
    // hand. The newcomer gets a fresh id in memory and keeps it on next save.
    c.id = uid()
  }
  byId.set(c.id, c)
  pathById.set(c.id, file)
}

/** Reads the collections directory once; later calls are free. */
function scan(): Promise<void> {
  if (scanned) return Promise.resolve()
  if (!scanning) {
    scanning = (async () => {
      const dir = paths().collections
      const names = await readdir(dir).catch(() => [] as string[])
      for (const name of names) {
        // Also skips the staging files left behind by an interrupted write.
        if (!name.toLowerCase().endsWith('.json')) continue
        const file = join(dir, name)
        if (ingested.has(file)) continue
        await ingest(file)
      }
      scanned = true
    })().finally(() => {
      scanning = null
    })
  }
  return scanning
}

function summarize(c: Collection): CollectionSummary {
  return { id: c.id, name: c.name, updatedAt: c.updatedAt, requestCount: countRequests(c.children) }
}

function uniqueName(base: string): string {
  const taken = new Set<string>()
  for (const c of byId.values()) taken.add(c.name)
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Deep copy with every id regenerated, so two copies never share state. */
function withFreshIds(src: Collection, name: string): Collection {
  const copy = structuredClone(src)
  const reid = (list: KV[]): KV[] => list.map((row) => ({ ...row, id: uid() }))
  const sets: VariableSet[] = copy.sets.map((s) => ({ ...s, id: uid(), values: reid(s.values) }))
  const activeIndex = copy.sets.findIndex((s) => s.id === copy.activeSetId)
  const now = Date.now()
  return {
    ...copy,
    id: uid(),
    name,
    children: copy.children.map((n) => cloneNode(n)),
    variables: reid(copy.variables),
    headers: reid(copy.headers),
    sets,
    activeSetId: activeIndex >= 0 ? sets[activeIndex].id : (sets[0]?.id ?? null),
    createdAt: now,
    updatedAt: now,
  }
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Stable across restarts, and identical for summaries and full collections. */
const byLabel = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export async function listCollections(): Promise<CollectionSummary[]> {
  await scan()
  return [...byId.values()].map(summarize).sort(byLabel)
}

export async function loadCollection(id: string): Promise<Collection | null> {
  const cached = byId.get(id)
  if (cached) return cached
  await scan()
  return byId.get(id) ?? null
}

export async function loadAll(): Promise<Collection[]> {
  await scan()
  return [...byId.values()].sort(byLabel)
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Stamps updatedAt and returns exactly what landed on disk. */
export async function saveCollection(c: Collection): Promise<Collection> {
  // Normalising on the way in means the cache, the file and the value handed
  // back to the renderer are always the same shape.
  const next = normalizeCollection(c)
  next.updatedAt = Date.now()
  // A save that is also a rename has to know which file this id already owns,
  // otherwise the old file survives and the next scan adopts it as a duplicate.
  await scan()
  return queue(next.id, async () => {
    const previous = pathById.get(next.id)
    const file = fileFor(next)
    await writeJsonAtomic(file, next)
    byId.set(next.id, next)
    pathById.set(next.id, file)
    ingested.add(file)
    if (previous && previous !== file) {
      // The collection was renamed. The new file is already durable, so a
      // failure here only leaves a stale copy that the next scan will adopt
      // under a fresh id rather than losing anything.
      await unlink(previous).catch(() => {})
      ingested.delete(previous)
    }
    return next
  })
}

export async function createCollection(patch: Partial<Collection> = {}): Promise<Collection> {
  await scan()
  const wanted = typeof patch.id === 'string' ? patch.id : ''
  const c = newCollection({ ...patch, id: wanted && !byId.has(wanted) ? wanted : uid() })
  c.name = uniqueName(c.name)
  return saveCollection(c)
}

export async function deleteCollection(id: string): Promise<boolean> {
  await scan()
  if (!byId.has(id)) return false
  return queue(id, async () => {
    const file = pathById.get(id)
    if (file) {
      try {
        await unlink(file)
      } catch (err) {
        // Already gone is a success; anything else means the collection is
        // still on disk and would reappear on restart, so report failure.
        if (errnoCode(err) !== 'ENOENT') return false
      }
      ingested.delete(file)
    }
    byId.delete(id)
    pathById.delete(id)
    return true
  })
}

export async function duplicateCollection(id: string): Promise<Collection | null> {
  const src = await loadCollection(id)
  if (!src) return null
  return saveCollection(withFreshIds(src, uniqueName(`${src.name} copy`)))
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

export async function exportCollectionJson(id: string): Promise<string | null> {
  const c = await loadCollection(id)
  return c ? JSON.stringify(c, null, 2) : null
}

/**
 * Accepts a bare collection or one wrapped as { collection: ... }. Every id is
 * regenerated so importing the same shared file twice yields two independent
 * collections instead of one overwriting the other.
 */
export async function importCollectionJson(text: string): Promise<Collection> {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  const source = isRecord(parsed) && isRecord(parsed.collection) ? parsed.collection : parsed
  if (!isRecord(source)) throw new Error('That file does not contain a collection.')

  await scan()
  const normalized = normalizeCollection(source)
  // The name is kept verbatim: a shared file imported twice is two collections
  // with the same label but independent ids, which is what the user asked for.
  return saveCollection(withFreshIds(normalized, normalized.name))
}
