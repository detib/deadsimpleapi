/**
 * ApiRequest -> WireRequest. The single place that decides what actually goes
 * on the wire: variable resolution, URL assembly, inheritance, auth, headers,
 * body encoding. Pure - nothing here mutates its input or touches the DOM.
 */

import { emptyAuth } from '../../shared/factory'
import type {
  ApiRequest,
  Auth,
  Collection,
  Folder,
  KV,
  RequestSettings,
  WireBody,
  WirePart,
  WireRequest,
} from '../../shared/types'
import { buildScope, isDynamicVar, resolve, scanVars, type VarScope } from './variables'

export interface BuildContext {
  collection: Collection | null
  /** Ancestor chain of the request, root-first. */
  folders: Folder[]
  appDefaults: RequestSettings
  execId: string
}

export interface BuildResult {
  wire: WireRequest
  issues: string[]
}

type Header = [string, string]

/* ------------------------------------------------------------------ */
/* Inheritance                                                         */
/* ------------------------------------------------------------------ */

export function effectiveSettings(req: ApiRequest, ctx: BuildContext): RequestSettings {
  return applyPatch(applyPatch(ctx.appDefaults, ctx.collection?.settings), req.settings)
}

function applyPatch(base: RequestSettings, over?: Partial<RequestSettings>): RequestSettings {
  const out: RequestSettings = { ...base }
  if (!over) return out
  // Written through a record view so a new RequestSettings field is picked up
  // without touching this function.
  const target = out as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(over)) {
    if (value !== undefined && key in base) target[key] = value
  }
  return out
}

export function effectiveAuth(req: ApiRequest, ctx: BuildContext): Auth {
  if (req.auth.type !== 'inherit') return req.auth
  for (let i = ctx.folders.length - 1; i >= 0; i--) {
    const folderAuth = ctx.folders[i].auth
    if (folderAuth.type !== 'inherit') return folderAuth
  }
  const collectionAuth = ctx.collection?.auth
  if (collectionAuth && collectionAuth.type !== 'inherit') return collectionAuth
  return emptyAuth('none')
}

/* ------------------------------------------------------------------ */
/* URL                                                                 */
/* ------------------------------------------------------------------ */

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const COLON_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_-]*)/g
// A lone {name}. The lookarounds keep an unresolved {{token}} intact: without
// them `{{id}}` would match its inner `{id}` and be rewritten to `{42}`.
const BRACE_PARAM_RE = /(?<!\{)\{([^{}/?#\s]+)\}(?!\})/g

export function effectiveUrl(req: ApiRequest, scope: Map<string, VarScope>): string {
  const raw = resolve(req.url, scope).trim()
  if (!raw) return ''

  const [beforeHash, hash] = splitHash(raw)
  const q = beforeHash.indexOf('?')
  const literalQuery = q < 0 ? '' : beforeHash.slice(q + 1)
  let base = q < 0 ? beforeHash : beforeHash.slice(0, q)

  base = withScheme(substitutePathParams(base, req.pathParams, scope))

  const pairs: string[] = []
  // The query typed into the URL bar is passed through verbatim: re-encoding it
  // would corrupt anything the user encoded themselves.
  for (const segment of literalQuery.split('&')) {
    if (segment) pairs.push(segment)
  }
  for (const row of req.params) {
    if (!row.enabled) continue
    const key = resolve(row.key, scope).trim()
    if (!key) continue
    pairs.push(`${encodeOnce(key)}=${encodeOnce(resolve(row.value, scope))}`)
  }

  return base + (pairs.length ? '?' + pairs.join('&') : '') + hash
}

function splitHash(url: string): [string, string] {
  const i = url.indexOf('#')
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i)]
}

/**
 * Both :name and {name} templating. Values are substituted literally - the path
 * belongs to the user, and the main process owns final URL encoding.
 */
function substitutePathParams(url: string, rows: KV[], scope: Map<string, VarScope>): string {
  const values = new Map<string, string>()
  for (const row of rows) {
    if (!row.enabled) continue
    const key = row.key.trim()
    if (key) values.set(key, resolve(row.value, scope))
  }
  if (!values.size) return url

  return url
    .replace(COLON_PARAM_RE, (match, name: string) => values.get(name) ?? match)
    .replace(BRACE_PARAM_RE, (match, name: string) => values.get(name.trim()) ?? match)
}

function withScheme(url: string): string {
  if (!url || SCHEME_RE.test(url)) return url
  const bare = url.startsWith('//') ? url.slice(2) : url
  const authority = bare.split(/[/?#]/, 1)[0]
  const host = (authority.split('@').pop() ?? authority).replace(/:\d+$/, '').toLowerCase()
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.startsWith('[') ||
    IPV4_RE.test(host)
  return (local ? 'http://' : 'https://') + bare
}

function appendQuery(url: string, key: string, value: string): string {
  const [beforeHash, hash] = splitHash(url)
  const sep = beforeHash.endsWith('?') ? '' : beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${sep}${encodeOnce(key)}=${encodeOnce(value)}${hash}`
}

const isHexDigit = (c: string | undefined): boolean =>
  c !== undefined && ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))

/** encodeURIComponent, but an existing %XX escape is left alone (no double encoding). */
function encodeOnce(input: string): string {
  if (!input) return ''
  if (!input.includes('%')) return encodeURIComponent(input)
  let out = ''
  let i = 0
  while (i < input.length) {
    if (input[i] === '%' && isHexDigit(input[i + 1]) && isHexDigit(input[i + 2])) {
      out += input.slice(i, i + 3)
      i += 3
      continue
    }
    let j = i
    while (
      j < input.length &&
      !(input[j] === '%' && isHexDigit(input[j + 1]) && isHexDigit(input[j + 2]))
    ) {
      j++
    }
    out += encodeURIComponent(input.slice(i, j))
    i = j
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * CR, LF and NUL are never legal in a field name or value. A variable holding a
 * pasted multi-line string would otherwise splice extra headers into the
 * request (and Node rejects the whole call outright), so strip them here.
 */
function headerSafe(input: string): string {
  return input.replace(/[\r\n\0]/g, '')
}

/** Later wins: replaces in place, keeping the later name's casing. */
function putHeader(headers: Header[], rawName: string, rawValue: string): void {
  const name = headerSafe(rawName)
  const value = headerSafe(rawValue)
  const lower = name.toLowerCase()
  const i = headers.findIndex(([existing]) => existing.toLowerCase() === lower)
  if (i >= 0) headers[i] = [name, value]
  else headers.push([name, value])
}

function takeHeader(headers: Header[], lowerName: string): string | null {
  const i = headers.findIndex(([existing]) => existing.toLowerCase() === lowerName)
  if (i < 0) return null
  return headers.splice(i, 1)[0][1]
}

function hasHeader(headers: Header[], lowerName: string): boolean {
  return headers.some(([existing]) => existing.toLowerCase() === lowerName)
}

/* ------------------------------------------------------------------ */
/* Base64                                                              */
/* ------------------------------------------------------------------ */

/** btoa throws on anything outside Latin-1, so encode to UTF-8 bytes first. */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string | undefined> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  graphql: 'application/json',
  'form-urlencoded': 'application/x-www-form-urlencoded',
}

interface BuiltBody {
  body: WireBody
  /** '' when the mode owns no default Content-Type (multipart, binary, none). */
  contentType: string
}

function buildBody(req: ApiRequest, res: (input: string) => string, issues: string[]): BuiltBody {
  const body = req.body
  const contentType = CONTENT_TYPES[body.mode] ?? ''

  switch (body.mode) {
    case 'none':
      return { body: { kind: 'none' }, contentType: '' }

    case 'json':
    case 'text':
    case 'xml':
    case 'html':
    case 'javascript':
      return { body: { kind: 'text', text: res(body.text) }, contentType }

    case 'graphql': {
      const query = res(body.graphql.query)
      const rawVariables = res(body.graphql.variables).trim()
      let variables: unknown = {}
      if (rawVariables) {
        try {
          const parsed: unknown = JSON.parse(rawVariables)
          variables = parsed === null ? {} : parsed
        } catch {
          issues.push('GraphQL variables are not valid JSON - sent as {}')
        }
      }
      const operationName = res(body.graphql.operationName ?? '').trim()
      const payload: { query: string; variables: unknown; operationName?: string } = {
        query,
        variables,
      }
      if (operationName) payload.operationName = operationName
      return { body: { kind: 'text', text: JSON.stringify(payload) }, contentType }
    }

    case 'form-urlencoded': {
      const pairs: string[] = []
      for (const row of body.form) {
        if (!row.enabled) continue
        const key = res(row.key).trim()
        if (!key) continue
        pairs.push(`${encodeOnce(key)}=${encodeOnce(res(row.value))}`)
      }
      return { body: { kind: 'text', text: pairs.join('&') }, contentType }
    }

    case 'multipart': {
      const parts: WirePart[] = []
      for (const field of body.multipart) {
        if (!field.enabled) continue
        const name = res(field.key).trim()
        if (!name) continue
        const filePath = field.filePath ? res(field.filePath) : ''
        if (field.kind === 'file' && !filePath) {
          issues.push(`Multipart field "${name}" has no file selected`)
          continue
        }
        const part: WirePart = {
          name,
          kind: field.kind,
          value: field.kind === 'text' ? res(field.value) : '',
        }
        if (field.kind === 'file') part.filePath = filePath
        if (field.fileName) part.fileName = res(field.fileName)
        if (field.contentType) part.contentType = res(field.contentType)
        parts.push(part)
      }
      return { body: { kind: 'multipart', parts }, contentType: '' }
    }

    case 'binary': {
      const path = res(body.binaryPath).trim()
      if (!path) {
        issues.push('Binary body has no file selected')
        return { body: { kind: 'none' }, contentType: '' }
      }
      return { body: { kind: 'file', path }, contentType: '' }
    }

    default:
      return { body: { kind: 'none' }, contentType: '' }
  }
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

export function buildWire(req: ApiRequest, ctx: BuildContext): BuildResult {
  const scope = buildScope(ctx.collection)
  const issues: string[] = []
  const unknown = new Set<string>()

  const note = (input: string): void => {
    for (const span of scanVars(input)) {
      if (span.name && !scope.has(span.name) && !isDynamicVar(span.name)) unknown.add(span.name)
    }
  }
  const res = (input: string): string => {
    note(input)
    return resolve(input, scope)
  }

  // effectiveUrl does the resolving; this only records what is missing.
  note(req.url)
  for (const row of req.pathParams) if (row.enabled) note(row.value)
  for (const row of req.params) {
    if (!row.enabled) continue
    note(row.key)
    note(row.value)
  }

  let url = effectiveUrl(req, scope)
  if (!url) issues.push('Request URL is empty')

  const headers: Header[] = []
  const addRows = (rows: KV[]): void => {
    for (const row of rows) {
      if (!row.enabled) continue
      const key = res(row.key).trim()
      if (!key) continue
      putHeader(headers, key, res(row.value).trim())
    }
  }

  if (ctx.collection) addRows(ctx.collection.headers)
  for (const folder of ctx.folders) addRows(folder.headers)
  addRows(req.headers)

  const auth = effectiveAuth(req, ctx)
  switch (auth.type) {
    case 'bearer': {
      const scheme = res(auth.bearer.scheme).trim() || 'Bearer'
      const token = res(auth.bearer.token).trim()
      if (token) {
        const prefixed = token.toLowerCase().startsWith(scheme.toLowerCase() + ' ')
        putHeader(headers, 'Authorization', prefixed ? token : `${scheme} ${token}`)
      }
      break
    }
    case 'basic': {
      const username = res(auth.basic.username)
      const password = res(auth.basic.password)
      if (username || password) {
        putHeader(headers, 'Authorization', 'Basic ' + base64Utf8(`${username}:${password}`))
      }
      break
    }
    case 'apikey': {
      const key = res(auth.apikey.key).trim()
      const value = res(auth.apikey.value)
      if (key) {
        if (auth.apikey.in === 'query') url = appendQuery(url, key, value)
        else putHeader(headers, key, value)
      }
      break
    }
    case 'none':
    case 'inherit':
      break
  }

  const built = buildBody(req, res, issues)
  if (built.contentType && !hasHeader(headers, 'content-type')) {
    headers.push(['Content-Type', built.contentType])
  }

  const cookiePairs: string[] = []
  for (const row of req.cookies) {
    if (!row.enabled) continue
    const key = headerSafe(res(row.key)).trim()
    if (!key) continue
    cookiePairs.push(`${key}=${headerSafe(res(row.value))}`)
  }
  if (cookiePairs.length) {
    // Cookie rows extend a hand-written Cookie header rather than dropping it.
    const existing = takeHeader(headers, 'cookie')
    const merged = existing ? `${existing}; ${cookiePairs.join('; ')}` : cookiePairs.join('; ')
    headers.push(['Cookie', merged])
  }

  for (const name of unknown) issues.push(`Unknown variable {{${name}}}`)

  const wire: WireRequest = {
    execId: ctx.execId,
    method: req.method.trim() || 'GET',
    url,
    headers,
    body: built.body,
    settings: effectiveSettings(req, ctx),
  }
  return { wire, issues }
}
