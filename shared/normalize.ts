import { emptyAuth, emptyBody, newCollection, uid } from './factory'
import {
  APP_SCHEMA_VERSION,
  type ApiRequest,
  type Auth,
  type Body,
  type Collection,
  type Folder,
  type KV,
  type MultipartField,
  type RequestSettings,
  type TreeNode,
  type VariableSet,
} from './types'

/**
 * Defensive coercion of untrusted JSON (a shared collection file, a hand-edited
 * file on disk, an older schema) into a fully-formed Collection. Never throws:
 * anything unrecognised is dropped rather than crashing the app on startup.
 */

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function normKV(raw: unknown): KV {
  const o = obj(raw)
  return {
    id: str(o.id) || uid(),
    enabled: bool(o.enabled, true),
    key: str(o.key),
    value: str(o.value),
    description: str(o.description) || undefined,
    secret: o.secret === true || undefined,
  }
}

const normKVs = (raw: unknown): KV[] => arr(raw).map(normKV)

function normAuth(raw: unknown, fallbackType: Auth['type'] = 'inherit'): Auth {
  const o = obj(raw)
  const base = emptyAuth(fallbackType)
  const t = str(o.type)
  if (t === 'inherit' || t === 'none' || t === 'bearer' || t === 'basic' || t === 'apikey') {
    base.type = t
  }
  const bearer = obj(o.bearer)
  base.bearer = { token: str(bearer.token), scheme: str(bearer.scheme) || 'Bearer' }
  const basic = obj(o.basic)
  base.basic = { username: str(basic.username), password: str(basic.password) }
  const apikey = obj(o.apikey)
  base.apikey = {
    key: str(apikey.key),
    value: str(apikey.value),
    in: apikey.in === 'query' ? 'query' : 'header',
  }
  return base
}

function normMultipart(raw: unknown): MultipartField {
  const o = obj(raw)
  return {
    id: str(o.id) || uid(),
    enabled: bool(o.enabled, true),
    key: str(o.key),
    kind: o.kind === 'file' ? 'file' : 'text',
    value: str(o.value),
    filePath: str(o.filePath) || undefined,
    fileName: str(o.fileName) || undefined,
    contentType: str(o.contentType) || undefined,
  }
}

const BODY_MODES: Body['mode'][] = [
  'none', 'json', 'text', 'xml', 'html', 'javascript',
  'form-urlencoded', 'multipart', 'binary', 'graphql',
]

function normBody(raw: unknown): Body {
  const o = obj(raw)
  const base = emptyBody()
  const mode = str(o.mode) as Body['mode']
  if (BODY_MODES.includes(mode)) base.mode = mode
  base.text = str(o.text)
  base.form = normKVs(o.form)
  base.multipart = arr(o.multipart).map(normMultipart)
  base.binaryPath = str(o.binaryPath)
  const gql = obj(o.graphql)
  base.graphql = {
    query: str(gql.query),
    variables: str(gql.variables) || '{}',
    operationName: str(gql.operationName) || undefined,
  }
  return base
}

function normSettings(raw: unknown): Partial<RequestSettings> {
  const o = obj(raw)
  const out: Partial<RequestSettings> = {}
  if ('followRedirects' in o) out.followRedirects = bool(o.followRedirects, true)
  if ('maxRedirects' in o) out.maxRedirects = Math.max(0, num(o.maxRedirects, 10))
  if ('timeoutMs' in o) out.timeoutMs = Math.max(0, num(o.timeoutMs, 60_000))
  if ('verifyTls' in o) out.verifyTls = bool(o.verifyTls, true)
  if ('encodeUrl' in o) out.encodeUrl = bool(o.encodeUrl, true)
  if ('sendCookies' in o) out.sendCookies = bool(o.sendCookies, true)
  if ('storeCookies' in o) out.storeCookies = bool(o.storeCookies, true)
  if ('decompress' in o) out.decompress = bool(o.decompress, true)
  if ('streamResponse' in o) out.streamResponse = bool(o.streamResponse, true)
  if ('proxy' in o) out.proxy = str(o.proxy)
  return out
}

function normRequest(raw: unknown): ApiRequest {
  const o = obj(raw)
  return {
    kind: 'request',
    id: str(o.id) || uid(),
    protocol: 'http',
    name: str(o.name) || 'Untitled request',
    method: (str(o.method) || 'GET').toUpperCase(),
    url: str(o.url),
    params: normKVs(o.params),
    pathParams: normKVs(o.pathParams),
    headers: normKVs(o.headers),
    cookies: normKVs(o.cookies),
    body: normBody(o.body),
    auth: normAuth(o.auth, 'inherit'),
    settings: normSettings(o.settings),
    docs: str(o.docs),
  }
}

function normFolder(raw: unknown, depth: number): Folder {
  const o = obj(raw)
  return {
    kind: 'folder',
    id: str(o.id) || uid(),
    name: str(o.name) || 'Untitled folder',
    children: normNodes(o.children, depth + 1),
    auth: normAuth(o.auth, 'inherit'),
    headers: normKVs(o.headers),
    docs: str(o.docs),
  }
}

/** Depth cap stops a malformed/cyclic file from blowing the stack. */
const MAX_DEPTH = 64

function normNodes(raw: unknown, depth = 0): TreeNode[] {
  if (depth > MAX_DEPTH) return []
  const out: TreeNode[] = []
  for (const item of arr(raw)) {
    const o = obj(item)
    const isFolder = o.kind === 'folder' || (!('kind' in o) && Array.isArray(o.children))
    out.push(isFolder ? normFolder(o, depth) : normRequest(o))
  }
  return out
}

function normSet(raw: unknown): VariableSet {
  const o = obj(raw)
  return {
    id: str(o.id) || uid(),
    name: str(o.name) || 'Unnamed set',
    values: normKVs(o.values),
  }
}

export function normalizeCollection(raw: unknown): Collection {
  const o = obj(raw)
  const base = newCollection({
    id: str(o.id) || uid(),
    name: str(o.name) || 'Untitled collection',
    children: normNodes(o.children),
    variables: normKVs(o.variables),
    sets: arr(o.sets).map(normSet),
    auth: normAuth(o.auth, 'none'),
    headers: normKVs(o.headers),
    settings: normSettings(o.settings),
    docs: str(o.docs),
    createdAt: num(o.createdAt, Date.now()),
    updatedAt: num(o.updatedAt, Date.now()),
  })
  base.schemaVersion = APP_SCHEMA_VERSION
  const wanted = str(o.activeSetId)
  base.activeSetId = base.sets.some((s) => s.id === wanted)
    ? wanted
    : base.sets[0]?.id ?? null
  return base
}

/** True when the JSON looks like one of our own exported collections. */
export function looksLikeNativeCollection(raw: unknown): boolean {
  const o = obj(raw)
  return typeof o.schemaVersion === 'number' && Array.isArray(o.children) && 'variables' in o
}
