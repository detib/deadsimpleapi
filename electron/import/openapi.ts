/**
 * OpenAPI 3.0 / 3.1 and Swagger 2.0 -> Collection.
 *
 * The aim is a collection you can fire straight away: every parameter, header
 * and body field arrives with a plausible preset value instead of an empty box.
 * Nothing in here throws once the document has parsed - a single broken
 * operation is reported as a warning and the rest of the document still lands.
 */

import { parse as parseYaml } from 'yaml'
import {
  countFolders,
  countRequests,
  emptyAuth,
  emptyBody,
  kv,
  newCollection,
  newFolder,
  newRequest,
  uid,
} from '../../shared/factory'
import type {
  ApiRequest,
  Auth,
  Body,
  BodyMode,
  ImportResult,
  KV,
  MultipartField,
  TreeNode,
  VariableSet,
} from '../../shared/types'

/* ------------------------------------------------------------------ */
/* Untrusted-document accessors                                        */
/* ------------------------------------------------------------------ */

type Dict = Record<string, unknown>

const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const asDict = (v: unknown): Dict => (isObj(v) ? v : {})
const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const str = (v: unknown): string => asString(v).trim()
const asNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const strings = (v: unknown): string[] =>
  asArray(v).filter((x): x is string => typeof x === 'string')
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function oneLine(value: string, max = 200): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** YAML happily turns an unquoted `swagger: 2.0` into the number 2. */
function versionString(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return str(v)
}

/* ------------------------------------------------------------------ */
/* Import context                                                      */
/* ------------------------------------------------------------------ */

interface Ctx {
  root: Dict
  /** Swagger 2.0 rather than OpenAPI 3.x. */
  v2: boolean
  warnings: string[]
  warned: Set<string>
  suppressed: number
}

const MAX_WARNINGS = 200

function warn(ctx: Ctx, message: string): void {
  if (ctx.warned.has(message)) return
  ctx.warned.add(message)
  if (ctx.warnings.length >= MAX_WARNINGS) {
    ctx.suppressed++
    return
  }
  ctx.warnings.push(message)
}

/* ------------------------------------------------------------------ */
/* Parsing and detection                                               */
/* ------------------------------------------------------------------ */

function parseDocument(source: string): unknown {
  const cleaned = source.replace(/^\uFEFF/, '')
  try {
    const json: unknown = JSON.parse(cleaned)
    return json
  } catch {
    try {
      // The alias budget is raised for large real-world specs but still bounded,
      // so an alias bomb cannot expand without limit.
      const yaml: unknown = parseYaml(cleaned, { maxAliasCount: 4096 })
      return yaml
    } catch (err) {
      throw new Error(`Could not parse the document as JSON or YAML. ${errMessage(err)}`)
    }
  }
}

export function looksLikeOpenApi(doc: unknown): boolean {
  if (!isObj(doc)) return false
  const version = versionString(doc.openapi) || versionString(doc.swagger)
  if (!/^[23](\.|$)/.test(version)) return false
  return (
    isObj(doc.paths) ||
    isObj(doc.info) ||
    isObj(doc.components) ||
    isObj(doc.definitions) ||
    isObj(doc.webhooks)
  )
}

/* ------------------------------------------------------------------ */
/* $ref resolution                                                     */
/* ------------------------------------------------------------------ */

const MAX_SCHEMA_DEPTH = 12
const MAX_PROPS = 40
const MAX_ARRAY_ITEMS = 5

/** RFC 6901 pointer lookup against the document root. */
function jsonPointer(root: Dict, ref: string): unknown {
  const hash = ref.indexOf('#')
  const fragment = hash < 0 ? '' : ref.slice(hash + 1)
  if (!fragment || fragment === '/') return root
  let cur: unknown = root
  for (const raw of fragment.replace(/^\//, '').split('/')) {
    let seg = raw
    try {
      seg = decodeURIComponent(raw)
    } catch {
      // A malformed escape is used verbatim rather than failing the whole ref.
    }
    seg = seg.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      const i = Number.parseInt(seg, 10)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined
      cur = cur[i]
    } else if (isObj(cur)) {
      cur = cur[seg]
    } else {
      return undefined
    }
  }
  return cur
}

/**
 * A node with its $ref chain followed and its allOf / oneOf branches folded in,
 * plus the ref scope to use when descending into it. `seen` grows down the
 * expansion path only, so a cycle terminates while two siblings can each expand
 * the same schema once.
 */
interface Flat {
  schema: Dict
  seen: Set<string>
}

function flatten(ctx: Ctx, node: unknown, seen: Set<string>, depth: number): Flat | null {
  if (depth > MAX_SCHEMA_DEPTH || !isObj(node)) return null
  let cur: Dict = node
  let scope = seen

  for (let hops = 0; typeof cur.$ref === 'string' && hops < 32; hops++) {
    const ref = cur.$ref
    if (!ref.startsWith('#')) {
      warn(ctx, `External $ref left unresolved: ${ref}`)
      return null
    }
    if (scope.has(ref)) return null // circular - the caller emits a placeholder
    const target = jsonPointer(ctx.root, ref)
    if (!isObj(target)) {
      warn(ctx, `Unresolved $ref: ${ref}`)
      return null
    }
    scope = new Set(scope).add(ref)
    // OpenAPI 3.1 allows keywords next to $ref; they override the target.
    const overrides: Dict = { ...cur }
    delete overrides.$ref
    cur = Object.keys(overrides).length > 0 ? { ...target, ...overrides } : target
  }
  if (typeof cur.$ref === 'string') return null

  if (asArray(cur.allOf).length > 0) cur = mergeAllOf(ctx, cur, scope, depth)

  if (!('type' in cur) && !('properties' in cur)) {
    const branch = asArray(cur.oneOf)[0] ?? asArray(cur.anyOf)[0]
    if (branch !== undefined) {
      const flat = flatten(ctx, branch, scope, depth + 1)
      if (flat) {
        const overrides: Dict = { ...cur }
        delete overrides.oneOf
        delete overrides.anyOf
        cur = { ...flat.schema, ...overrides }
        scope = flat.seen
      }
    }
  }

  return { schema: cur, seen: scope }
}

function mergeAllOf(ctx: Ctx, node: Dict, seen: Set<string>, depth: number): Dict {
  const self: Dict = { ...node }
  delete self.allOf
  const out: Dict = {}
  const properties: Dict = {}
  const required: string[] = []

  // The node's own keywords are merged last so they win over the branches.
  for (const branch of [...asArray(node.allOf), self]) {
    const flat = flatten(ctx, branch, seen, depth + 1)
    if (!flat) continue
    for (const [key, value] of Object.entries(flat.schema)) {
      if (key === 'properties' || key === 'required') continue
      out[key] = value
    }
    Object.assign(properties, asDict(flat.schema.properties))
    for (const name of strings(flat.schema.required)) {
      if (!required.includes(name)) required.push(name)
    }
  }

  if (Object.keys(properties).length > 0) out.properties = properties
  if (required.length > 0) out.required = required
  return out
}

/* ------------------------------------------------------------------ */
/* Preset values                                                       */
/* ------------------------------------------------------------------ */

const FORMAT_VALUES: Record<string, string> = {
  'date-time': '2024-01-01T00:00:00Z',
  date: '2024-01-01',
  time: '00:00:00',
  duration: 'P1D',
  uuid: '00000000-0000-0000-0000-000000000000',
  email: 'user@example.com',
  'idn-email': 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  'uri-reference': 'https://example.com',
  iri: 'https://example.com',
  hostname: 'example.com',
  'idn-hostname': 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'ZXhhbXBsZQ==',
  base64: 'ZXhhbXBsZQ==',
  binary: '',
  password: 'password',
}

const NUMERIC_FORMATS = new Set(['int32', 'int64', 'float', 'double'])

/** Ordered - the first match wins, so the specific patterns come first. */
const NAME_HINTS: Array<[RegExp, string]> = [
  [/mail/i, 'user@example.com'],
  [/(^|_)(password|passwd|secret)($|_)/i, 'password'],
  [/(uuid|guid)$/i, '00000000-0000-0000-0000-000000000000'],
  [/(url|uri|href|link|website|homepage)$/i, 'https://example.com'],
  [/(^|_)id$|^id$|Id$/, '1'],
  [/(created|updated|deleted|modified)_?(at|on)$/i, '2024-01-01T00:00:00Z'],
  [/(timestamp|datetime)$/i, '2024-01-01T00:00:00Z'],
  [/date$/i, '2024-01-01'],
  [/(phone|mobile|msisdn)$/i, '+15555550123'],
  [/first_?name$/i, 'Jane'],
  [/(last_?name|surname)$/i, 'Doe'],
  [/(user_?name|login|handle)$/i, 'jane.doe'],
  [/name$/i, 'Example'],
  [/(status|state)$/i, 'active'],
  [/country(_?code)?$/i, 'US'],
  [/currency$/i, 'USD'],
  [/(locale|language|lang)$/i, 'en'],
  [/colou?r$/i, '#3b82f6'],
  [/(zip|postal_?code|postcode)$/i, '10001'],
  [/city$/i, 'Springfield'],
  [/(^|_)(sort|order_?by)$/i, 'created_at'],
]

function hintExample(name: string): string | undefined {
  if (!name) return undefined
  for (const [pattern, value] of NAME_HINTS) if (pattern.test(name)) return value
  return undefined
}

interface Gen {
  /** Property or parameter name - the best clue we have for a bare string. */
  hint: string
  /**
   * Whether an unrecognised name may be used as the value itself. True for body
   * fields, where echoing the name documents the shape; false for query and
   * header rows, where it would put nonsense on the wire.
   */
  echo: boolean
  seen: Set<string>
  depth: number
}

function firstExample(ctx: Ctx, examples: unknown, seen: Set<string>): unknown {
  if (Array.isArray(examples)) return examples.length > 0 ? examples[0] : undefined
  if (!isObj(examples)) return undefined
  for (const entry of Object.values(examples)) {
    const flat = flatten(ctx, entry, seen, 0)
    const node: unknown = flat ? flat.schema : entry
    if (isObj(node)) {
      if ('value' in node) return node.value
      if ('externalValue' in node) continue // a URL we will not fetch
    }
    if (node !== undefined) return node
  }
  return undefined
}

/** example -> examples -> default -> enum[0] -> const. */
function explicitValue(ctx: Ctx, s: Dict, seen: Set<string>): unknown {
  if (s.example !== undefined) return s.example
  if (s['x-example'] !== undefined) return s['x-example']
  const fromExamples = firstExample(ctx, s.examples, seen)
  if (fromExamples !== undefined) return fromExamples
  if (s.default !== undefined) return s.default
  const choices = asArray(s.enum)
  if (choices.length > 0) return choices[0]
  if (s.const !== undefined) return s.const
  return undefined
}

function schemaType(s: Dict): string {
  const raw = s.type
  if (typeof raw === 'string' && raw) return raw.toLowerCase()
  if (Array.isArray(raw)) {
    const named = strings(raw).map((t) => t.toLowerCase())
    const useful = named.find((t) => t !== 'null')
    if (useful) return useful
    if (named.length > 0) return 'null'
  }
  if (isObj(s.properties) || isObj(s.additionalProperties) || s.additionalProperties === true) {
    return 'object'
  }
  if ('items' in s || 'prefixItems' in s) return 'array'
  if (NUMERIC_FORMATS.has(str(s.format).toLowerCase())) return 'number'
  if (s.nullable === true) return 'null'
  return 'string'
}

function numberExample(s: Dict): number {
  const minimum = asNum(s.minimum)
  const exclusive = asNum(s.exclusiveMinimum) // a number in 3.1, a boolean in 3.0
  let value = minimum ?? (exclusive !== undefined ? exclusive + 1 : 0)
  const maximum = asNum(s.maximum)
  if (maximum !== undefined && value > maximum) value = maximum
  return value
}

function padTo(value: string, length: number): string {
  let out = value
  while (out.length < length) out += value
  return out.slice(0, length)
}

function stringExample(s: Dict, hint: string, echo: boolean): string {
  const format = str(s.format).toLowerCase()
  const byFormat = format ? FORMAT_VALUES[format] : undefined
  let out = byFormat ?? hintExample(hint) ?? (echo ? hint : '')
  const min = asNum(s.minLength)
  if (min !== undefined && out.length < min) {
    const target = Math.min(min, 512)
    out = out ? padTo(out, target) : 'x'.repeat(target)
  }
  const max = asNum(s.maxLength)
  if (max !== undefined && max >= 0 && out.length > max) out = out.slice(0, max)
  return out
}

function cloneValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function genExample(ctx: Ctx, node: unknown, gen: Gen): unknown {
  const flat = flatten(ctx, node, gen.seen, gen.depth)
  // Circular, external or too deep: a null placeholder and no further descent.
  if (!flat) return null
  const s = flat.schema
  const seen = flat.seen

  const explicit = explicitValue(ctx, s, seen)
  if (explicit !== undefined) return explicit

  switch (schemaType(s)) {
    case 'object':
      return objectExample(ctx, s, seen, gen.depth)
    case 'array':
      return arrayExample(ctx, s, seen, gen)
    case 'boolean':
      return false
    case 'integer':
      return Math.round(numberExample(s))
    case 'number':
      return numberExample(s)
    case 'null':
      return null
    default:
      return stringExample(s, gen.hint, gen.echo)
  }
}

function objectExample(ctx: Ctx, s: Dict, seen: Set<string>, depth: number): Dict {
  const props = asDict(s.properties)
  const required = strings(s.required)
  const names = [
    ...required.filter((name) => name in props),
    ...Object.keys(props).filter((name) => !required.includes(name)),
  ]

  const out: Dict = {}
  let used = 0
  for (const name of names) {
    if (used >= MAX_PROPS) break
    const prop = props[name]
    // readOnly fields must not be sent in a request body.
    if (isObj(prop) && prop.readOnly === true) continue
    out[name] = genExample(ctx, prop, { hint: name, echo: true, seen, depth: depth + 1 })
    used++
  }

  if (used === 0 && isObj(s.additionalProperties)) {
    out.key = genExample(ctx, s.additionalProperties, {
      hint: 'key',
      echo: true,
      seen,
      depth: depth + 1,
    })
  }
  return out
}

function arrayExample(ctx: Ctx, s: Dict, seen: Set<string>, gen: Gen): unknown[] {
  const prefix = asArray(s.prefixItems)
  if (prefix.length > 0) {
    return prefix
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) =>
        genExample(ctx, item, { hint: gen.hint, echo: gen.echo, seen, depth: gen.depth + 1 }),
      )
  }
  if (!isObj(s.items)) return []
  const count = Math.min(Math.max(asNum(s.minItems) ?? 1, 1), MAX_ARRAY_ITEMS)
  const first = genExample(ctx, s.items, {
    hint: singular(gen.hint),
    echo: gen.echo,
    seen,
    depth: gen.depth + 1,
  })
  const out: unknown[] = [first]
  for (let i = 1; i < count; i++) out.push(cloneValue(first))
  return out
}

function jsonText(value: unknown): string {
  try {
    const out = JSON.stringify(value, null, 2)
    return out === undefined ? '' : out
  } catch {
    // A YAML anchor can build a genuinely cyclic value.
    return ''
  }
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    // Comma-joined, which is the default `form` serialisation for a query array.
    return value
      .map((item) => (isObj(item) || Array.isArray(item) ? jsonText(item) : stringifyValue(item)))
      .join(',')
  }
  return jsonText(value)
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

/** Kept plural: singularising these produces nonsense. */
const KEEP_PLURAL = new Set([
  'status', 'address', 'data', 'media', 'news', 'series', 'species', 'info', 'analytics',
])

function singular(word: string): string {
  if (!word) return word
  const lower = word.toLowerCase()
  if (KEEP_PLURAL.has(lower)) return word
  if (/(ss|us|is|os)$/i.test(word)) return word
  if (/ies$/i.test(word)) return `${word.slice(0, -3)}y`
  if (/(ch|sh|x|z|s)es$/i.test(word)) return word.slice(0, -2)
  if (/s$/i.test(word) && word.length > 2) return word.slice(0, -1)
  return word
}

/** "getProductById" -> "get Product By Id" */
function deCamel(raw: string): string {
  return raw
    .replace(/[_\-.:/]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Deliberately excludes "by", which reads as a real word in these names. */
const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'for', 'from', 'in', 'into', 'nor', 'of',
  'on', 'or', 'per', 'the', 'to', 'via', 'with',
])

function titleCase(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => {
      // Anything with an internal capital is an acronym or already styled.
      if (/[A-Z]/.test(word.slice(1))) return word
      const lower = word.toLowerCase()
      if (i > 0 && SMALL_WORDS.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

const METHOD_VERBS: Record<string, string> = {
  GET: 'get',
  HEAD: 'check',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
  OPTIONS: 'options',
  TRACE: 'trace',
  QUERY: 'query',
}

function templateName(segment: string): string | null {
  const match = /^\{(.+)\}$/.exec(segment)
  return match ? match[1].trim() : null
}

function pathTemplateNames(path: string): string[] {
  const out: string[] = []
  for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1].trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

/** "GET /products/{id}" -> "get product by id" */
function phraseFromPath(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean)
  const words: string[] = [METHOD_VERBS[method.toUpperCase()] ?? method.toLowerCase()]

  segments.forEach((segment, i) => {
    const param = templateName(segment)
    if (param !== null) {
      // Intermediate ids only repeat the collection name that precedes them.
      if (i === segments.length - 1) words.push('by', deCamel(param))
      return
    }
    const next = segments[i + 1]
    const nextIsParam = next !== undefined && templateName(next) !== null
    words.push(deCamel(nextIsParam ? singular(segment) : segment))
  })

  if (words.length === 1) words.push('root')
  return words.join(' ')
}

function requestName(op: Dict, method: string, path: string): string {
  const summary = oneLine(str(op.summary), 90).replace(/\.$/, '')
  const operationId = str(op.operationId)
  let readable = ''
  if (summary) readable = titleCase(summary)
  else if (operationId) readable = titleCase(deCamel(operationId))
  else readable = titleCase(phraseFromPath(method, path))

  readable = readable.slice(0, 90).trim() || 'Request'
  const name = `${method.toUpperCase()} ${readable}`
  return op.deprecated === true ? `${name} (deprecated)` : name
}

/* ------------------------------------------------------------------ */
/* Parameters                                                          */
/* ------------------------------------------------------------------ */

const METHODS = [
  'get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query',
] as const

/** Per the spec these are described by the body / auth / response, not by a row. */
const IGNORED_HEADER_PARAMS = new Set(['accept', 'content-type', 'authorization'])

function paramSchema(p: Dict): Dict {
  if (isObj(p.schema)) return p.schema
  const content = asDict(p.content)
  const first = Object.keys(content)[0]
  if (first !== undefined) {
    const media = asDict(content[first])
    if (isObj(media.schema)) return media.schema
  }
  // Swagger 2.0 keeps type / format / items on the parameter itself.
  return p
}

function paramValue(ctx: Ctx, p: Dict, echo: boolean, seen: Set<string>): string {
  if (p.example !== undefined) return stringifyValue(p.example)
  const fromExamples = firstExample(ctx, p.examples, seen)
  if (fromExamples !== undefined) return stringifyValue(fromExamples)
  const gen: Gen = { hint: str(p.name), echo, seen, depth: 0 }
  return stringifyValue(genExample(ctx, paramSchema(p), gen))
}

function paramNote(p: Dict): string {
  const parts: string[] = []
  const description = oneLine(str(p.description))
  if (description) parts.push(description)
  if (p.deprecated === true) parts.push('deprecated')
  if (!description) {
    const choices = asArray(paramSchema(p).enum)
    if (choices.length > 0) {
      parts.push(`one of: ${choices.slice(0, 8).map(stringifyValue).join(', ')}`)
    }
  }
  return parts.join(' - ')
}

function paramRow(
  ctx: Ctx,
  p: Dict,
  options: { echoName: boolean; alwaysEnabled: boolean },
  seen: Set<string>,
): KV {
  const value = paramValue(ctx, p, options.echoName, seen)
  // Optional rows stay in the table but disabled, so they are discoverable
  // without spamming the wire with thirty empty query parameters.
  const enabled = options.alwaysEnabled || p.required === true
  return kv(str(p.name), value, enabled, paramNote(p))
}

/** Operation parameters override path-item ones with the same name and location. */
function collectParams(ctx: Ctx, pathItem: Dict, op: Dict, seen: Set<string>): Dict[] {
  const byKey = new Map<string, Dict>()
  for (const raw of [...asArray(pathItem.parameters), ...asArray(op.parameters)]) {
    const flat = flatten(ctx, raw, seen, 0)
    if (!flat) continue
    const p = flat.schema
    const name = str(p.name)
    const where = str(p.in).toLowerCase()
    if (!name || !where) continue
    byKey.set(`${where} ${name}`, p)
  }
  return [...byKey.values()]
}

const requiredFirst = (params: Dict[]): Dict[] => [
  ...params.filter((p) => p.required === true),
  ...params.filter((p) => p.required !== true),
]

/* ------------------------------------------------------------------ */
/* Bodies                                                              */
/* ------------------------------------------------------------------ */

const CONTENT_RANK: Array<[RegExp, number]> = [
  [/^application\/json$/i, 0],
  [/^application\/[\w.+-]*\+json$/i, 1],
  [/^text\/json$/i, 1],
  [/^application\/x-www-form-urlencoded$/i, 2],
  [/^multipart\/form-data$/i, 3],
  [/^text\//i, 4],
]

const BINARY_TYPES =
  /^(application\/(octet-stream|pdf|zip|gzip|x-tar|x-7z-compressed|vnd\.[\w.+-]*(excel|sheet|word|powerpoint|openxml)[\w.+-]*)|image\/|audio\/|video\/|font\/)/i

const mediaTypeOf = (raw: string): string => raw.split(';')[0].trim()

function pickContentType(types: string[]): string | null {
  let best: string | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const raw of types) {
    const type = mediaTypeOf(raw)
    if (!type) continue
    let rank = 5
    for (const [pattern, value] of CONTENT_RANK) {
      if (pattern.test(type)) {
        rank = value
        break
      }
    }
    if (rank < bestRank) {
      best = type
      bestRank = rank
    }
  }
  return best
}

function bodyModeFor(mediaType: string): BodyMode {
  const type = mediaTypeOf(mediaType).toLowerCase()
  if (type === 'application/json' || type === 'text/json' || /\+json$/.test(type)) return 'json'
  if (type === 'application/x-www-form-urlencoded') return 'form-urlencoded'
  if (type.startsWith('multipart/')) return 'multipart'
  if (type === 'application/xml' || type === 'text/xml' || /\+xml$/.test(type)) return 'xml'
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'application/javascript' || type === 'text/javascript') return 'javascript'
  if (type.startsWith('text/')) return 'text'
  if (BINARY_TYPES.test(type)) return 'binary'
  return 'text'
}

function isBinarySchema(s: Dict, depth = 0): boolean {
  if (depth > 3) return false
  if (str(s.format).toLowerCase() === 'binary') return true
  if (str(s.type).toLowerCase() === 'file') return true // Swagger 2.0 formData
  if (typeof s.contentMediaType === 'string') return true
  if (isObj(s.items)) return isBinarySchema(s.items, depth + 1)
  return false
}

interface FieldRow {
  name: string
  value: string
  binary: boolean
  description: string
}

/** One row per property for a form or multipart body; empty for a non-object schema. */
function objectRows(ctx: Ctx, schemaNode: unknown, encoding: Dict, seen: Set<string>): FieldRow[] {
  const flat = flatten(ctx, schemaNode, seen, 0)
  if (!flat) return []
  const props = asDict(flat.schema.properties)
  const required = strings(flat.schema.required)
  const names = [
    ...required.filter((name) => name in props),
    ...Object.keys(props).filter((name) => !required.includes(name)),
  ].slice(0, MAX_PROPS)

  const rows: FieldRow[] = []
  for (const name of names) {
    const propFlat = flatten(ctx, props[name], flat.seen, 1)
    const prop = propFlat ? propFlat.schema : {}
    if (prop.readOnly === true) continue
    const declared = mediaTypeOf(str(asDict(encoding[name]).contentType))
    const binary = isBinarySchema(prop) || (declared !== '' && BINARY_TYPES.test(declared))
    const value = genExample(ctx, props[name], {
      hint: name,
      echo: true,
      seen: flat.seen,
      depth: 1,
    })
    rows.push({
      name,
      value: binary ? '' : stringifyValue(value),
      binary,
      description: oneLine(str(prop.description)),
    })
  }
  return rows
}

function multipartFields(rows: FieldRow[]): MultipartField[] {
  return rows.map((row) => ({
    id: uid(),
    enabled: true,
    key: row.name,
    kind: row.binary ? 'file' : 'text',
    value: row.binary ? '' : row.value,
    filePath: row.binary ? '' : undefined,
  }))
}

function xmlName(raw: string): string {
  const cleaned = raw.replace(/[^\w.-]/g, '_')
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`
}

const xmlEscape = (raw: string): string =>
  raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function toXml(value: unknown, name: string, indent = 0): string {
  const pad = '  '.repeat(indent)
  const tag = xmlName(name)
  if (Array.isArray(value)) {
    return value.map((item) => toXml(item, singular(name) || 'item', indent)).join('\n')
  }
  if (isObj(value)) {
    const inner = Object.entries(value)
      .map(([key, child]) => toXml(child, key, indent + 1))
      .join('\n')
    return inner ? `${pad}<${tag}>\n${inner}\n${pad}</${tag}>` : `${pad}<${tag}/>`
  }
  if (value === null || value === undefined) return `${pad}<${tag}/>`
  return `${pad}<${tag}>${xmlEscape(String(value))}</${tag}>`
}

interface BuiltBody {
  body: Body
  contentType: string
}

function renderBody(
  ctx: Ctx,
  mediaType: string,
  schemaNode: unknown,
  media: Dict,
  seen: Set<string>,
): BuiltBody {
  const body = emptyBody()
  body.mode = bodyModeFor(mediaType)

  const explicit =
    media.example !== undefined ? media.example : firstExample(ctx, media.examples, seen)
  const value =
    explicit !== undefined
      ? explicit
      : isObj(schemaNode)
        ? genExample(ctx, schemaNode, { hint: '', echo: true, seen, depth: 0 })
        : undefined

  // A string example is already serialised; anything else is rendered.
  const asText = typeof value === 'string' ? value : value === undefined ? '' : jsonText(value)

  switch (body.mode) {
    case 'form-urlencoded':
      body.form = objectRows(ctx, schemaNode, asDict(media.encoding), seen).map((row) =>
        kv(row.name, row.value, true, row.description),
      )
      break
    case 'multipart':
      body.multipart = multipartFields(objectRows(ctx, schemaNode, asDict(media.encoding), seen))
      break
    case 'binary':
      body.binaryPath = ''
      break
    case 'xml': {
      const flat = flatten(ctx, schemaNode, seen, 0)
      const root = str(asDict(flat?.schema.xml).name) || str(flat?.schema.title) || 'root'
      body.text =
        typeof value === 'string' || value === undefined
          ? asText
          : `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(value, root)}`
      break
    }
    default:
      body.text = asText
      break
  }

  return { body, contentType: mediaType }
}

function buildBody(ctx: Ctx, op: Dict, params: Dict[], seen: Set<string>): BuiltBody | null {
  if (!ctx.v2) {
    if (op.requestBody === undefined) return null
    const flat = flatten(ctx, op.requestBody, seen, 0)
    if (!flat) return null
    const content = asDict(flat.schema.content)
    const chosen = pickContentType(Object.keys(content))
    if (!chosen) return null
    const media = asDict(content[chosen])
    return renderBody(ctx, chosen, media.schema, media, flat.seen)
  }

  const consumes = strings(asArray(op.consumes).length > 0 ? op.consumes : ctx.root.consumes)
  const bodyParam = params.find((p) => str(p.in).toLowerCase() === 'body')
  if (bodyParam) {
    const chosen = pickContentType(consumes) ?? 'application/json'
    return renderBody(ctx, chosen, bodyParam.schema, {}, seen)
  }

  const formParams = requiredFirst(params.filter((p) => str(p.in).toLowerCase() === 'formdata'))
  if (formParams.length === 0) return null

  const rows: FieldRow[] = formParams.map((p) => {
    const name = str(p.name)
    const binary = str(p.type).toLowerCase() === 'file'
    return {
      name,
      value: binary ? '' : paramValue(ctx, p, true, seen),
      binary,
      description: paramNote(p),
    }
  })

  const hasFile = rows.some((row) => row.binary)
  const chosen = hasFile
    ? 'multipart/form-data'
    : (pickContentType(consumes.filter((type) => /form-urlencoded|multipart/i.test(type))) ??
      'application/x-www-form-urlencoded')

  const body = emptyBody()
  body.mode = bodyModeFor(chosen)
  if (body.mode === 'multipart') body.multipart = multipartFields(rows)
  else body.form = rows.map((row) => kv(row.name, row.value, true, row.description))
  return { body, contentType: chosen }
}

function acceptHeader(ctx: Ctx, op: Dict): string {
  if (ctx.v2) {
    const produces = strings(asArray(op.produces).length > 0 ? op.produces : ctx.root.produces)
    return pickContentType(produces) ?? ''
  }
  const responses = asDict(op.responses)
  const keys = Object.keys(responses)
  const preferred = [
    ...keys.filter((key) => /^2\d\d$/.test(key) || key.toUpperCase() === '2XX'),
    ...keys.filter((key) => key === 'default'),
  ]
  for (const key of preferred.length > 0 ? preferred : keys) {
    const flat = flatten(ctx, responses[key], new Set(), 0)
    if (!flat) continue
    const chosen = pickContentType(Object.keys(asDict(flat.schema.content)))
    if (chosen) return chosen
  }
  return ''
}

/* ------------------------------------------------------------------ */
/* Security                                                            */
/* ------------------------------------------------------------------ */

interface SecurityPlan {
  auth: Auth
  vars: KV[]
}

const secretKv = (key: string, description: string): KV => ({
  ...kv(key, '', true, description),
  secret: true,
})

function bearerPlan(scheme: string, variable: string): SecurityPlan {
  const auth = emptyAuth('bearer')
  auth.bearer = { token: `{{${variable}}}`, scheme: 'Bearer' }
  return { auth, vars: [secretKv(variable, `Bearer token for the "${scheme}" security scheme.`)] }
}

function basicPlan(scheme: string): SecurityPlan {
  const auth = emptyAuth('basic')
  auth.basic = { username: '{{username}}', password: '{{password}}' }
  return {
    auth,
    vars: [
      kv('username', '', true, `Username for the "${scheme}" security scheme.`),
      secretKv('password', `Password for the "${scheme}" security scheme.`),
    ],
  }
}

function mapScheme(ctx: Ctx, name: string, scheme: Dict): SecurityPlan | null {
  const type = str(scheme.type).toLowerCase()
  switch (type) {
    case 'http': {
      const sub = str(scheme.scheme).toLowerCase()
      if (sub === 'bearer') return bearerPlan(name, 'authToken')
      if (sub === 'basic') return basicPlan(name)
      if (!sub) {
        warn(ctx, `Security scheme "${name}" declares no HTTP scheme; imported as bearer.`)
        return bearerPlan(name, 'authToken')
      }
      warn(ctx, `Security scheme "${name}" uses the unsupported HTTP scheme "${sub}".`)
      return null
    }
    case 'basic': // Swagger 2.0
      return basicPlan(name)
    case 'apikey': {
      const key = str(scheme.name)
      const where = str(scheme.in).toLowerCase()
      if (!key) {
        warn(ctx, `Security scheme "${name}" is an API key with no name.`)
        return null
      }
      if (where !== 'header' && where !== 'query') {
        warn(
          ctx,
          `Security scheme "${name}" sends its API key in "${where || 'an unknown location'}", which is not supported as collection auth.`,
        )
        return null
      }
      const auth = emptyAuth('apikey')
      auth.apikey = { key, value: '{{apiKey}}', in: where }
      return { auth, vars: [secretKv('apiKey', `API key for the "${name}" security scheme.`)] }
    }
    case 'oauth2':
    case 'openidconnect':
      warn(
        ctx,
        `Security scheme "${name}" uses ${type === 'oauth2' ? 'OAuth 2' : 'OpenID Connect'}; the token flow is not automated - paste a token into the accessToken variable.`,
      )
      return bearerPlan(name, 'accessToken')
    default:
      warn(ctx, `Unsupported security scheme "${name}"${type ? ` (type: ${type})` : ''}.`)
      return null
  }
}

/** Scheme names in the order we would like to apply them. */
function securityCandidates(ctx: Ctx, schemes: Dict): string[] {
  const out: string[] = []
  const add = (requirements: unknown): void => {
    for (const requirement of asArray(requirements)) {
      for (const name of Object.keys(asDict(requirement))) {
        if (name && !out.includes(name)) out.push(name)
      }
    }
  }
  add(ctx.root.security)
  for (const item of Object.values(asDict(ctx.root.paths))) {
    if (!isObj(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (isObj(op)) add(op.security)
    }
  }
  for (const name of Object.keys(schemes)) if (!out.includes(name)) out.push(name)
  return out
}

function planSecurity(ctx: Ctx): SecurityPlan {
  const schemes = ctx.v2
    ? asDict(ctx.root.securityDefinitions)
    : asDict(asDict(ctx.root.components).securitySchemes)
  const names = securityCandidates(ctx, schemes)

  for (const name of names) {
    if (schemes[name] === undefined) {
      warn(ctx, `Security scheme "${name}" is required but never defined.`)
      continue
    }
    const flat = flatten(ctx, schemes[name], new Set(), 0)
    if (!flat) continue
    const plan = mapScheme(ctx, name, flat.schema)
    if (!plan) continue
    if (names.length > 1) {
      warn(
        ctx,
        `The document declares several security schemes; "${name}" was applied at the collection level.`,
      )
    }
    return plan
  }
  return { auth: emptyAuth('none'), vars: [] }
}

function securityNote(op: Dict): string {
  if (!Array.isArray(op.security)) return ''
  if (op.security.length === 0) return 'Security: none (this operation overrides the collection auth).'
  const names: string[] = []
  for (const requirement of op.security) {
    for (const [name, scopes] of Object.entries(asDict(requirement))) {
      const list = strings(scopes)
      const label = list.length > 0 ? `${name} (${list.join(', ')})` : name
      if (!names.includes(label)) names.push(label)
    }
  }
  return names.length > 0 ? `Security: ${names.join(', ')}` : ''
}

/* ------------------------------------------------------------------ */
/* Variable sets                                                       */
/* ------------------------------------------------------------------ */

function hostOf(url: string): string {
  const match = /^[A-Za-z][\w+.-]*:\/\/([^/?#]+)/.exec(url)
  return match ? match[1].replace(/[{}]/g, '') : ''
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  let n = 2
  while (taken.has(name)) name = `${base} (${n++})`
  taken.add(name)
  return name
}

function swagger2Servers(ctx: Ctx): Dict[] {
  const host = str(ctx.root.host)
  let basePath = str(ctx.root.basePath)
  if (basePath && !basePath.startsWith('/')) basePath = `/${basePath}`
  basePath = basePath.replace(/\/+$/, '')

  const declared = strings(ctx.root.schemes).map((s) => s.toLowerCase())
  const schemes = declared.filter((s) => s === 'http' || s === 'https')
  if (declared.length > 0 && schemes.length === 0) {
    warn(ctx, `Ignored non-HTTP schemes: ${declared.join(', ')}.`)
  }
  if (!host) return basePath ? [{ url: basePath }] : []

  const list = schemes.length > 0 ? schemes : ['https']
  return list.map((scheme) => ({
    url: `${scheme}://${host}${basePath}`,
    description: list.length > 1 ? `${scheme}://${host}` : '',
  }))
}

interface SetsResult {
  sets: VariableSet[]
  shared: KV[]
}

function buildVariableSets(ctx: Ctx): SetsResult {
  const servers = ctx.v2 ? swagger2Servers(ctx) : asArray(ctx.root.servers).filter(isObj)
  const sets: VariableSet[] = []
  const taken = new Set<string>()

  servers.forEach((server, i) => {
    const rawUrl = str(server.url)
    const definitions = asDict(server.variables)
    const names: string[] = []
    // {version} style templating becomes our own {{version}} so the extra rows
    // below actually resolve at send time.
    let url = rawUrl.replace(/\{([^{}/]+)\}/g, (match: string, raw: string) => {
      const name = raw.trim()
      if (!name) return match
      if (!names.includes(name)) names.push(name)
      return `{{${name}}}`
    })
    url = url.replace(/\/+$/, '')

    const description = oneLine(str(server.description), 60)
    const values: KV[] = [kv('baseUrl', url, true, description)]
    for (const name of names) {
      const definition = asDict(definitions[name])
      const fallback = asArray(definition.enum)[0]
      const value =
        definition.default !== undefined
          ? stringifyValue(definition.default)
          : fallback !== undefined
            ? stringifyValue(fallback)
            : ''
      if (!isObj(definitions[name])) {
        warn(ctx, `Server variable "{${name}}" in "${rawUrl}" has no definition.`)
      }
      values.push(kv(name, value, true, oneLine(str(definition.description))))
    }

    const name = uniqueName(description || hostOf(rawUrl) || `Server ${i + 1}`, taken)
    sets.push({ id: uid(), name, values })
  })

  if (sets.length === 0) {
    warn(ctx, 'The document declares no servers; baseUrl was left empty.')
    sets.push({ id: uid(), name: 'default', values: [kv('baseUrl', '', true, '')] })
  }

  // A variable every server agrees on belongs in the shared list, not in each set.
  const shared: KV[] = []
  if (sets.length > 1) {
    for (const row of [...sets[0].values]) {
      if (row.key === 'baseUrl') continue
      const common = sets.every((set) =>
        set.values.some((v) => v.key === row.key && v.value === row.value),
      )
      if (!common) continue
      shared.push(kv(row.key, row.value, true, row.description ?? ''))
      for (const set of sets) set.values = set.values.filter((v) => v.key !== row.key)
    }
  }

  return { sets, shared }
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

const UNTAGGED = 'default'

function groupOf(op: Dict): string {
  for (const tag of asArray(op.tags)) {
    const name = str(tag)
    if (name) return name
  }
  return UNTAGGED
}

function requestDocs(ctx: Ctx, op: Dict): string {
  const blocks: string[] = []
  const description = str(op.description)
  if (description) blocks.push(description)

  const meta: string[] = []
  if (op.deprecated === true) meta.push('Deprecated.')
  const operationId = str(op.operationId)
  if (operationId) meta.push(`Operation id: ${operationId}`)
  const note = securityNote(op)
  if (note) meta.push(note)
  const externalUrl = str(asDict(op.externalDocs).url)
  if (externalUrl) meta.push(`More: ${externalUrl}`)

  if (meta.length > 0) blocks.push(meta.join('\n'))
  return blocks.join('\n\n')
}

function buildOperation(
  ctx: Ctx,
  path: string,
  method: string,
  pathItem: Dict,
  op: Dict,
): ApiRequest {
  const seen = new Set<string>()
  const params = collectParams(ctx, pathItem, op, seen)

  const query: KV[] = []
  const headers: KV[] = []
  const cookies: KV[] = []
  const pathParams = new Map<string, Dict>()

  for (const p of requiredFirst(params)) {
    const name = str(p.name)
    switch (str(p.in).toLowerCase()) {
      case 'query':
        query.push(paramRow(ctx, p, { echoName: false, alwaysEnabled: false }, seen))
        break
      case 'header':
        if (!IGNORED_HEADER_PARAMS.has(name.toLowerCase())) {
          headers.push(paramRow(ctx, p, { echoName: false, alwaysEnabled: false }, seen))
        }
        break
      case 'cookie':
        cookies.push(paramRow(ctx, p, { echoName: false, alwaysEnabled: false }, seen))
        break
      case 'path':
        pathParams.set(name, p)
        break
      default:
        break // body / formData are handled by the body builder
    }
  }

  // Path rows follow the order the templates appear in the URL.
  const rows: KV[] = []
  for (const name of pathTemplateNames(path)) {
    const declared = pathParams.get(name)
    if (declared) {
      rows.push(paramRow(ctx, declared, { echoName: true, alwaysEnabled: true }, seen))
      pathParams.delete(name)
    } else {
      rows.push(kv(name, hintExample(name) ?? name, true, 'Not declared in the specification.'))
    }
  }
  for (const p of pathParams.values()) {
    rows.push(paramRow(ctx, p, { echoName: true, alwaysEnabled: true }, seen))
  }

  const built = buildBody(ctx, op, params, seen)
  const leading: KV[] = []
  const accept = acceptHeader(ctx, op)
  if (accept) leading.push(kv('Accept', accept, true))
  // Multipart is deliberately left out: only the sender knows the boundary.
  if (built && built.body.mode !== 'multipart') {
    leading.push(kv('Content-Type', built.contentType, true))
  }

  const auth = emptyAuth('inherit')
  if (Array.isArray(op.security) && op.security.length === 0) auth.type = 'none'

  return newRequest({
    name: requestName(op, method, path),
    method: method.toUpperCase(),
    url: `{{baseUrl}}${path}`,
    params: query,
    pathParams: rows,
    headers: [...leading, ...headers],
    cookies,
    body: built ? built.body : emptyBody(),
    auth,
    docs: requestDocs(ctx, op),
  })
}

function tagDocs(ctx: Ctx, tag: string): string {
  for (const entry of asArray(ctx.root.tags)) {
    if (!isObj(entry)) continue
    if (str(entry.name) !== tag) continue
    const description = str(entry.description)
    const externalUrl = str(asDict(entry.externalDocs).url)
    return [description, externalUrl ? `More: ${externalUrl}` : ''].filter(Boolean).join('\n\n')
  }
  return ''
}

function buildTree(ctx: Ctx): TreeNode[] {
  const groups = new Map<string, ApiRequest[]>()

  if (!isObj(ctx.root.paths)) {
    warn(ctx, 'The document has no `paths` object; no requests were imported.')
  }
  if (Object.keys(asDict(ctx.root.webhooks)).length > 0) {
    warn(ctx, 'Webhook definitions were skipped; only `paths` operations are imported.')
  }

  for (const [rawPath, rawItem] of Object.entries(asDict(ctx.root.paths))) {
    if (rawPath.startsWith('x-')) continue
    const flat = flatten(ctx, rawItem, new Set(), 0)
    if (!flat) {
      warn(ctx, `Skipped "${rawPath}": the path item is missing or could not be resolved.`)
      continue
    }
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
    if (path !== rawPath) {
      warn(ctx, `Path "${rawPath}" does not start with "/"; imported as "${path}".`)
    }
    if (asArray(flat.schema.servers).length > 0) {
      warn(ctx, `Server overrides on "${path}" were ignored; every request uses {{baseUrl}}.`)
    }

    for (const method of METHODS) {
      const op = flat.schema[method]
      if (!isObj(op)) {
        if (op !== undefined) {
          warn(ctx, `Skipped ${method.toUpperCase()} ${path}: the operation is not an object.`)
        }
        continue
      }
      try {
        if (asArray(op.servers).length > 0) {
          warn(
            ctx,
            `Server overrides on ${method.toUpperCase()} ${path} were ignored; every request uses {{baseUrl}}.`,
          )
        }
        const request = buildOperation(ctx, path, method, flat.schema, op)
        const tag = groupOf(op)
        const bucket = groups.get(tag)
        if (bucket) bucket.push(request)
        else groups.set(tag, [request])
      } catch (err) {
        warn(ctx, `Skipped ${method.toUpperCase()} ${path}: ${errMessage(err)}`)
      }
    }
  }

  const declared: string[] = []
  for (const entry of asArray(ctx.root.tags)) {
    const name = isObj(entry) ? str(entry.name) : ''
    if (name && !declared.includes(name)) declared.push(name)
  }
  const rest = [...groups.keys()]
    .filter((tag) => !declared.includes(tag))
    .sort((a, b) => a.localeCompare(b))
  const order = [...declared.filter((tag) => groups.has(tag)), ...rest]

  // A document with no tags at all does not need a wrapper folder.
  if (order.length === 1 && order[0] === UNTAGGED) return groups.get(UNTAGGED) ?? []

  return order.map((tag) =>
    newFolder({ name: tag, docs: tagDocs(ctx, tag), children: groups.get(tag) ?? [] }),
  )
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function collectionName(info: Dict, sourceName?: string): string {
  const title = str(info.title)
  const version = versionString(info.version)
  if (title) return version ? `${title} ${version}` : title
  const source = str(sourceName).replace(/\.(json|ya?ml)$/i, '')
  return source || 'Imported API'
}

export function importOpenApi(text: string, sourceName?: string): ImportResult {
  const parsed = parseDocument(text)
  if (!isObj(parsed)) {
    throw new Error('The document did not contain an OpenAPI object.')
  }

  const openapi = versionString(parsed.openapi)
  const swagger = versionString(parsed.swagger)
  const ctx: Ctx = {
    root: parsed,
    v2: !openapi && swagger.startsWith('2'),
    warnings: [],
    warned: new Set(),
    suppressed: 0,
  }

  if (!openapi && !swagger) {
    warn(ctx, 'No `openapi` or `swagger` version field; the document was read as OpenAPI 3.')
  } else if (openapi && !openapi.startsWith('3')) {
    warn(ctx, `Unrecognised OpenAPI version "${openapi}"; the document was read as 3.x.`)
  } else if (!openapi && !ctx.v2) {
    warn(ctx, `Unrecognised Swagger version "${swagger}"; the document was read as OpenAPI 3.`)
  }

  const info = asDict(parsed.info)
  const { sets, shared } = buildVariableSets(ctx)
  const security = planSecurity(ctx)

  const variables: KV[] = []
  for (const row of [...shared, ...security.vars]) {
    if (variables.some((existing) => existing.key === row.key)) continue
    variables.push(row)
  }

  const children = buildTree(ctx)

  const externalUrl = str(asDict(parsed.externalDocs).url)
  const docs = [str(info.description), externalUrl ? `More: ${externalUrl}` : '']
    .filter(Boolean)
    .join('\n\n')

  const collection = newCollection({
    name: collectionName(info, sourceName),
    children,
    variables,
    sets,
    activeSetId: sets[0]?.id ?? null,
    auth: security.auth,
    docs,
  })

  if (ctx.suppressed > 0) {
    ctx.warnings.push(`${ctx.suppressed} further warning(s) were suppressed.`)
  }

  return {
    collection,
    warnings: ctx.warnings,
    stats: {
      folders: countFolders(children),
      requests: countRequests(children),
      variables: variables.length + sets.reduce((n, set) => n + set.values.length, 0),
    },
  }
}
