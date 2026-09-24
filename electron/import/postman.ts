import {
  countFolders,
  countRequests,
  emptyAuth,
  emptyBody,
  kv,
  newCollection,
  newFolder,
  newRequest,
  newVariableSet,
  uid,
} from '../../shared/factory'
import type {
  ApiRequest,
  Auth,
  Body,
  Folder,
  ImportResult,
  KV,
  MultipartField,
  TreeNode,
} from '../../shared/types'

/**
 * Postman Collection Format v2.0 / v2.1 importer.
 *
 * Postman's {{variable}} syntax is identical to ours, so URLs, headers and
 * bodies are carried across verbatim - only the structure is translated.
 */

/** Matches normalize.ts so a hostile file cannot blow the stack. */
const MAX_DEPTH = 64
const MAX_WARNINGS = 200

/* ------------------------------------------------------------------ */
/* Untrusted-JSON helpers                                              */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : fallback

/** A Postman description is either a plain string or { content, type }. */
function descOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v)) return str(v.content)
  return ''
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const plural = (n: number): string => (n === 1 ? '' : 's')

const cloneKV = (row: KV): KV => ({ ...row, id: uid() })

class Warnings {
  private readonly seen = new Set<string>()
  private readonly list: string[] = []
  private suppressed = 0

  add(message: string): void {
    if (this.seen.has(message)) return
    this.seen.add(message)
    if (this.list.length >= MAX_WARNINGS) {
      this.suppressed++
      return
    }
    this.list.push(message)
  }

  drain(): string[] {
    const out = this.list.slice()
    if (this.suppressed > 0) {
      out.push(`${this.suppressed} further warning${plural(this.suppressed)} suppressed.`)
    }
    return out
  }
}

interface Ctx {
  readonly warnings: Warnings
  scripts: number
  behaviors: number
  tooDeep: boolean
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

/** v1 is a flat `requests` array plus an `order` of ids at the top level. */
function looksLikeV1(o: Record<string, unknown>): boolean {
  return Array.isArray(o.requests) && ('order' in o || 'folders' in o)
}

/** The Postman API hands back a collection wrapped as { collection: {...} }. */
function unwrap(doc: Record<string, unknown>): Record<string, unknown> {
  const inner = doc.collection
  if (isObj(inner) && (isObj(inner.info) || Array.isArray(inner.item))) return inner
  return doc
}

export function looksLikePostman(doc: unknown): boolean {
  if (!isObj(doc)) return false
  const root = unwrap(doc)
  if (looksLikeV1(root)) return true
  const info = isObj(root.info) ? root.info : null
  if (!info) return false
  if (typeof info._postman_id === 'string') return true
  if (typeof info.schema === 'string' && info.schema.includes('collection.json')) return true
  return typeof info.name === 'string' && Array.isArray(root.item)
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/** v2.1 stores auth params as [{key,value,type}], v2.0 as a plain object. */
function authFields(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObj(entry)) continue
      const key = str(entry.key).toLowerCase()
      if (key) out.set(key, str(entry.value))
    }
  } else if (isObj(raw)) {
    for (const [key, value] of Object.entries(raw)) out.set(key.toLowerCase(), str(value))
  }
  return out
}

/** First value of a v2.1 param array, for exports that drop the key name. */
function firstFieldValue(raw: unknown): string {
  if (!Array.isArray(raw)) return ''
  for (const entry of raw) {
    if (!isObj(entry)) continue
    const value = str(entry.value)
    if (value) return value
  }
  return ''
}

/** Returns null when Postman declared no auth, or one we cannot express. */
function mapAuth(raw: unknown, label: string, ctx: Ctx): Auth | null {
  if (!isObj(raw)) return null
  const type = str(raw.type).toLowerCase()
  if (!type) return null

  switch (type) {
    // Postman omits `auth` to mean inherit; converters sometimes spell it out.
    case 'inherit':
      return emptyAuth('inherit')
    case 'noauth':
      return emptyAuth('none')
    case 'bearer': {
      const auth = emptyAuth('bearer')
      auth.bearer.token = authFields(raw.bearer).get('token') ?? firstFieldValue(raw.bearer)
      return auth
    }
    case 'basic': {
      const fields = authFields(raw.basic)
      const auth = emptyAuth('basic')
      auth.basic = {
        username: fields.get('username') ?? '',
        password: fields.get('password') ?? '',
      }
      return auth
    }
    case 'apikey': {
      const fields = authFields(raw.apikey)
      const auth = emptyAuth('apikey')
      auth.apikey = {
        key: fields.get('key') ?? '',
        value: fields.get('value') ?? '',
        in: fields.get('in') === 'query' ? 'query' : 'header',
      }
      return auth
    }
    default:
      ctx.warnings.add(`${label}: "${type}" auth is not supported - left as Inherit.`)
      return null
  }
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

function segment(v: unknown): string {
  if (typeof v === 'string') return v
  if (isObj(v)) return str(v.value)
  return ''
}

function joinUrlParts(o: Record<string, unknown>): string {
  const protocol = str(o.protocol)
  const host = Array.isArray(o.host)
    ? o.host.map(segment).filter((part) => part !== '').join('.')
    : str(o.host)
  const port = str(o.port)

  let path = ''
  if (Array.isArray(o.path)) {
    if (o.path.length > 0) path = '/' + o.path.map(segment).join('/')
  } else if (typeof o.path === 'string' && o.path) {
    path = o.path.startsWith('/') ? o.path : '/' + o.path
  }

  let out = protocol ? `${protocol}://` : ''
  out += host
  if (port) out += `:${port}`
  return out + path
}

/** Everything from the first slash after the authority. '' when there is none. */
function pathPortion(url: string): string {
  const noScheme = url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, '')
  const i = noScheme.indexOf('/')
  return i >= 0 ? noScheme.slice(i) : ''
}

function kvRows(raw: unknown): KV[] {
  const rows: KV[] = []
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    const key = str(entry.key)
    const value = str(entry.value)
    if (!key && !value) continue
    rows.push(kv(key, value, entry.disabled !== true, descOf(entry.description)))
  }
  return rows
}

/** Kept exactly as written - percent-decoding here would mangle {{vars}}. */
function queryRowsFromString(queryString: string): KV[] {
  const rows: KV[] = []
  for (const piece of queryString.split('&')) {
    if (!piece) continue
    const i = piece.indexOf('=')
    rows.push(i < 0 ? kv(piece, '') : kv(piece.slice(0, i), piece.slice(i + 1)))
  }
  return rows
}

function mapPathParams(base: string, o: Record<string, unknown> | null): KV[] {
  const declared = new Map<string, { value: string; description: string }>()
  for (const entry of asArr(o?.variable)) {
    if (!isObj(entry)) continue
    const key = str(entry.key)
    if (!key) continue
    declared.set(key, { value: str(entry.value), description: descOf(entry.description) })
  }

  // Only after a slash, so neither a scheme (https:) nor a port (:8080) matches.
  const pattern = /(?:^|\/):([A-Za-z_][A-Za-z0-9_-]*)/g
  const rows: KV[] = []
  const seen = new Set<string>()
  for (const match of pathPortion(base).matchAll(pattern)) {
    const name = match[1]
    if (seen.has(name)) continue
    seen.add(name)
    const found = declared.get(name)
    rows.push(kv(name, found?.value ?? '', true, found?.description ?? ''))
  }
  for (const [key, found] of declared) {
    if (!seen.has(key)) rows.push(kv(key, found.value, true, found.description))
  }
  return rows
}

interface UrlParts {
  url: string
  params: KV[]
  pathParams: KV[]
}

/** A url is a string, or { raw, protocol, host, path, query, variable }. */
function mapUrl(raw: unknown): UrlParts {
  const o = isObj(raw) ? raw : null
  let text = ''
  if (typeof raw === 'string') text = raw.trim()
  else if (o) text = str(o.raw).trim() || joinUrlParts(o)

  let hash = ''
  const h = text.indexOf('#')
  if (h >= 0) {
    hash = text.slice(h)
    text = text.slice(0, h)
  } else if (o && str(o.hash)) {
    hash = `#${str(o.hash)}`
  }

  const q = text.indexOf('?')
  const base = q >= 0 ? text.slice(0, q) : text
  const queryString = q >= 0 ? text.slice(q + 1) : ''

  // The query array wins over the raw string: it carries the disabled flags and
  // descriptions that a query string cannot express.
  const declared = o ? asArr(o.query) : []
  const params = declared.length > 0 ? kvRows(declared) : queryRowsFromString(queryString)

  return { url: base + hash, params, pathParams: mapPathParams(base, o) }
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

function mapHeaders(raw: unknown): KV[] {
  const rows: KV[] = []
  if (typeof raw === 'string') {
    for (const line of raw.split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i <= 0) continue
      rows.push(kv(line.slice(0, i).trim(), line.slice(i + 1).trim()))
    }
    return rows
  }
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    // system:true marks headers Postman generates itself (Content-Type, Cookie).
    if (entry.system === true) continue
    const key = str(entry.key)
    if (!key) continue
    rows.push(kv(key, str(entry.value), entry.disabled !== true, descOf(entry.description)))
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

// A Map, not an object literal: an object would resolve a hostile language of
// "constructor" through the prototype chain and yield a non-BodyMode value.
const RAW_MODES = new Map<string, Body['mode']>([
  ['json', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['javascript', 'javascript'],
  ['text', 'text'],
])

function sniffRaw(text: string): Body['mode'] {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 'text'
  try {
    JSON.parse(trimmed)
    return 'json'
  } catch {
    // A JSON body peppered with {{vars}} cannot parse but is still JSON.
    return /\{\{[^{}]+\}\}/.test(trimmed) ? 'json' : 'text'
  }
}

function firstSrc(src: unknown, label: string, ctx: Ctx): string {
  if (typeof src === 'string') return src
  if (Array.isArray(src)) {
    ctx.warnings.add(`${label}: file source was a list of ${src.length}; kept the first entry.`)
    const first = src.find((item) => typeof item === 'string' && item !== '')
    return typeof first === 'string' ? first : ''
  }
  return ''
}

function mapFormData(raw: unknown, label: string, ctx: Ctx): MultipartField[] {
  const fields: MultipartField[] = []
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    const key = str(entry.key)
    const isFile = str(entry.type) === 'file'
    const field: MultipartField = {
      id: uid(),
      enabled: entry.disabled !== true,
      key,
      kind: isFile ? 'file' : 'text',
      value: isFile ? '' : str(entry.value),
    }
    if (isFile) {
      const path = firstSrc(entry.src, `${label} (form field "${key}")`, ctx)
      if (path) field.filePath = path
    }
    const contentType = str(entry.contentType)
    if (contentType) field.contentType = contentType
    fields.push(field)
  }
  return fields
}

function graphqlVariables(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim() ? raw : '{}'
  if (isObj(raw)) return JSON.stringify(raw, null, 2)
  return '{}'
}

function mapBody(raw: unknown, label: string, ctx: Ctx): Body {
  const body = emptyBody()
  if (!isObj(raw)) return body

  const mode = str(raw.mode)
  switch (mode) {
    case 'raw': {
      const text = str(raw.raw)
      const options = isObj(raw.options) ? raw.options : null
      const rawOptions = options && isObj(options.raw) ? options.raw : null
      const language = str(rawOptions?.language).toLowerCase()
      body.mode = RAW_MODES.get(language) ?? sniffRaw(text)
      body.text = text
      return body
    }
    case 'urlencoded':
      body.mode = 'form-urlencoded'
      body.form = kvRows(raw.urlencoded)
      return body
    case 'formdata':
      body.mode = 'multipart'
      body.multipart = mapFormData(raw.formdata, label, ctx)
      return body
    case 'file': {
      const file = isObj(raw.file) ? raw.file : null
      body.mode = 'binary'
      body.binaryPath = file ? firstSrc(file.src, label, ctx) : ''
      return body
    }
    case 'graphql': {
      const gql = isObj(raw.graphql) ? raw.graphql : null
      body.mode = 'graphql'
      body.graphql = { query: str(gql?.query), variables: graphqlVariables(gql?.variables) }
      const operationName = str(gql?.operationName)
      if (operationName) body.graphql.operationName = operationName
      return body
    }
    case '':
    case 'none':
      return body
    default:
      ctx.warnings.add(`${label}: body mode "${mode}" is not supported - body dropped.`)
      return body
  }
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

/** Postman writes empty script stubs everywhere; only real code counts. */
function hasScript(raw: unknown): boolean {
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    const script = isObj(entry.script) ? entry.script : null
    if (!script) continue
    if (typeof script.src === 'string' && script.src.trim()) return true
    const exec = script.exec
    if (typeof exec === 'string' && exec.trim()) return true
    if (Array.isArray(exec) && exec.some((line) => typeof line === 'string' && line.trim() !== '')) {
      return true
    }
  }
  return false
}

function fallbackName(method: string, url: string): string {
  const path = pathPortion(url) || url
  return path ? `${method} ${path}` : method
}

function mapRequest(item: Record<string, unknown>, raw: unknown, ctx: Ctx): ApiRequest {
  // `request` also has a shorthand string form: a bare URL, implying GET.
  const req = isObj(raw) ? raw : null
  const urlSource = req ? req.url : typeof raw === 'string' ? raw : undefined
  const method = (req ? str(req.method) : '').trim().toUpperCase() || 'GET'
  const { url, params, pathParams } = mapUrl(urlSource)
  const name = str(item.name).trim() || fallbackName(method, url)

  return newRequest({
    name,
    method,
    url,
    params,
    pathParams,
    headers: mapHeaders(req?.header),
    body: mapBody(req?.body, `Request "${name}"`, ctx),
    auth: mapAuth(req?.auth, `Request "${name}"`, ctx) ?? emptyAuth('inherit'),
    docs: descOf(req?.description) || descOf(item.description),
  })
}

function mapFolder(item: Record<string, unknown>, depth: number, ctx: Ctx): Folder {
  const name = str(item.name).trim() || 'Untitled folder'
  return newFolder({
    name,
    children: mapItems(item.item, depth + 1, ctx),
    auth: mapAuth(item.auth, `Folder "${name}"`, ctx) ?? emptyAuth('inherit'),
    docs: descOf(item.description),
  })
}

function noteIgnored(node: Record<string, unknown>, ctx: Ctx): void {
  if (hasScript(node.event)) ctx.scripts++
  const behavior = node.protocolProfileBehavior
  if (isObj(behavior) && Object.keys(behavior).length > 0) ctx.behaviors++
}

function mapItem(item: Record<string, unknown>, depth: number, ctx: Ctx): TreeNode | null {
  noteIgnored(item, ctx)
  if (Array.isArray(item.item)) return mapFolder(item, depth, ctx)
  if ('request' in item) return mapRequest(item, item.request, ctx)
  // Some exporters flatten the request onto the item itself.
  if ('url' in item || 'method' in item) return mapRequest(item, item, ctx)
  return null
}

function mapItems(raw: unknown, depth: number, ctx: Ctx): TreeNode[] {
  const out: TreeNode[] = []
  if (depth > MAX_DEPTH) {
    ctx.tooDeep = true
    return out
  }
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    const label = str(entry.name).trim() || '(unnamed)'
    try {
      const node = mapItem(entry, depth, ctx)
      if (node) out.push(node)
      else ctx.warnings.add(`Skipped "${label}" - neither a folder nor a request.`)
    } catch (err) {
      // One malformed item must never cost the caller the other two hundred.
      ctx.warnings.add(`Skipped "${label}" - ${errText(err)}`)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

/** Collection variables carry `disabled`, environment values carry `enabled`. */
function mapVariables(raw: unknown): KV[] {
  const rows: KV[] = []
  for (const entry of asArr(raw)) {
    if (!isObj(entry)) continue
    const key = str(entry.key)
    if (!key) continue
    const enabled = entry.disabled !== true && entry.enabled !== false
    const row = kv(key, str(entry.value), enabled, descOf(entry.description))
    if (str(entry.type) === 'secret') row.secret = true
    rows.push(row)
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

export function importPostman(text: string, sourceName?: string): ImportResult {
  let doc: unknown
  try {
    doc = JSON.parse(text) as unknown
  } catch (err) {
    throw new Error(`Not valid JSON: ${errText(err)}`)
  }
  if (!isObj(doc)) throw new Error('Not a Postman collection: expected a JSON object.')
  const root = unwrap(doc)

  if (looksLikeV1(root)) {
    throw new Error(
      'This is a Postman v1 collection. Deadsimple reads Collection Format v2.0 and v2.1 - ' +
        'open it in Postman and export it again as "Collection v2.1".',
    )
  }

  const info = isObj(root.info) ? root.info : null
  if (!info && !Array.isArray(root.item)) {
    throw new Error('Not a Postman collection: no "info" block and no "item" array.')
  }

  const ctx: Ctx = { warnings: new Warnings(), scripts: 0, behaviors: 0, tooDeep: false }

  const schema = str(info?.schema)
  if (schema && !schema.includes('v2.0.0') && !schema.includes('v2.1.0')) {
    ctx.warnings.add(`Unrecognised collection schema "${schema}" - read as v2.1.`)
  }
  if (!Array.isArray(root.item)) ctx.warnings.add('The collection has no "item" array.')

  noteIgnored(root, ctx)

  const children = mapItems(root.item, 0, ctx)
  const variables = mapVariables(root.variable)
  const name = str(info?.name).trim() || (sourceName ?? '').trim() || 'Imported collection'

  const collection = newCollection({
    name,
    children,
    variables,
    // Postman has no notion of variable sets; seed one so the switcher is never empty.
    sets: [newVariableSet('default', variables.map(cloneKV))],
    auth: mapAuth(root.auth, 'The collection', ctx) ?? emptyAuth('none'),
    docs: descOf(info?.description),
  })

  const summary: string[] = []
  if (ctx.scripts > 0) {
    summary.push(
      `Ignored pre-request/test scripts on ${ctx.scripts} item${plural(ctx.scripts)} - ` +
        'Deadsimple does not run scripts.',
    )
  }
  if (ctx.behaviors > 0) {
    summary.push(`Ignored protocolProfileBehavior on ${ctx.behaviors} item${plural(ctx.behaviors)}.`)
  }
  if (ctx.tooDeep) summary.push(`Items nested deeper than ${MAX_DEPTH} levels were dropped.`)

  return {
    collection,
    warnings: [...summary, ...ctx.warnings.drain()],
    stats: {
      folders: countFolders(collection.children),
      requests: countRequests(collection.children),
      variables: variables.length,
    },
  }
}

/** Parses a Postman environment or globals export. Null when it is neither. */
export function importPostmanEnvironment(text: string): { name: string; values: KV[] } | null {
  let doc: unknown
  try {
    doc = JSON.parse(text) as unknown
  } catch {
    return null
  }
  if (!isObj(doc)) return null
  if (Array.isArray(doc.item) || isObj(doc.info)) return null
  if (!Array.isArray(doc.values)) return null

  const scope = str(doc._postman_variable_scope)
  if (scope && scope !== 'environment' && scope !== 'globals') return null

  const fallback = scope === 'globals' ? 'Globals' : 'Imported environment'
  return { name: str(doc.name).trim() || fallback, values: mapVariables(doc.values) }
}
