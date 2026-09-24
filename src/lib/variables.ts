/**
 * {{variable}} resolution. Pure logic: no React, no DOM, no Electron.
 *
 * Precedence, highest first: the collection's active variable set, then the
 * collection-wide variables. Dynamic variables ({{$uuid}} and friends) are not
 * part of a scope because they are evaluated fresh on every resolve().
 */

import type { Collection } from '../../shared/types'

export interface VarScope {
  name: string
  origin: 'set' | 'collection' | 'dynamic'
  value: string
  secret?: boolean
}

export interface VarSpan {
  start: number
  end: number
  name: string
  resolved: string | null
  known: boolean
}

/** Whitespace inside the braces is tolerated: {{ baseUrl }} === {{baseUrl}}. */
const tokenRe = (): RegExp => /\{\{([^{}]*)\}\}/g

/** Stops a variable graph from expanding forever. */
const MAX_DEPTH = 10

/** Stops a cyclic object graph handed to resolveDeep from recursing forever. */
const MAX_WALK = 32

export function buildScope(collection: Collection | null): Map<string, VarScope> {
  const scope = new Map<string, VarScope>()
  if (!collection) return scope

  for (const row of collection.variables) {
    if (!row.enabled) continue
    const name = row.key.trim()
    if (!name) continue
    scope.set(name, { name, origin: 'collection', value: row.value, secret: row.secret })
  }

  const active = collection.sets.find((s) => s.id === collection.activeSetId)
  if (active) {
    for (const row of active.values) {
      if (!row.enabled) continue
      const name = row.key.trim()
      if (!name) continue
      scope.set(name, { name, origin: 'set', value: row.value, secret: row.secret })
    }
  }
  return scope
}

export function resolve(input: string, scope: Map<string, VarScope>): string {
  if (!input || !input.includes('{{')) return input
  return expand(input, scope, [], 0)
}

export function resolveDeep<T>(value: T, scope: Map<string, VarScope>): T {
  return walkValue(value, scope, 0) as T
}

export function scanVars(input: string): VarSpan[] {
  const out: VarSpan[] = []
  if (!input || !input.includes('{{')) return out
  const re = tokenRe()
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      name: m[1].trim(),
      resolved: null,
      known: false,
    })
  }
  return out
}

export function annotate(input: string, scope: Map<string, VarScope>): VarSpan[] {
  return scanVars(input).map((span) => {
    if (!span.name) return span
    const raw = lookup(span.name, scope)
    if (raw === null) return span
    // Seed the cycle stack with this name so a self-reference stays literal.
    const resolved = raw.includes('{{') ? expand(raw, scope, [span.name], 1) : raw
    return { ...span, resolved, known: true }
  })
}

/* ------------------------------------------------------------------ */
/* Expansion                                                           */
/* ------------------------------------------------------------------ */

function expand(
  input: string,
  scope: Map<string, VarScope>,
  stack: string[],
  depth: number,
): string {
  return input.replace(tokenRe(), (match: string, raw: string): string => {
    const name = raw.trim()
    // An empty name, an unknown name or a cycle keeps the literal token, so the
    // user sees what is missing instead of a silently empty string.
    if (!name || stack.includes(name)) return match
    const value = lookup(name, scope)
    if (value === null) return match
    if (depth >= MAX_DEPTH || !value.includes('{{')) return value
    stack.push(name)
    const out = expand(value, scope, stack, depth + 1)
    stack.pop()
    return out
  })
}

function lookup(name: string, scope: Map<string, VarScope>): string | null {
  const hit = scope.get(name)
  if (hit) return hit.value
  return dynamicValue(name)
}

function walkValue(value: unknown, scope: Map<string, VarScope>, depth: number): unknown {
  if (typeof value === 'string') return resolve(value, scope)
  if (depth >= MAX_WALK) return value
  if (Array.isArray(value)) return value.map((item) => walkValue(item, scope, depth + 1))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) out[key] = walkValue(value[key], scope, depth + 1)
    return out
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/* ------------------------------------------------------------------ */
/* Dynamic variables                                                   */
/* ------------------------------------------------------------------ */

/** Autocomplete list; entries taking arguments show their shape. */
export const DYNAMIC_VARS: readonly string[] = [
  '$uuid',
  '$guid',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
  '$randomInt:min:max',
  '$randomHex:n',
  '$randomString:n',
  '$randomEmail',
  '$randomFirstName',
  '$randomLastName',
  '$randomCompany',
  '$randomUrl',
  '$randomIp',
]

const DYNAMIC_BASES = new Set([
  '$uuid',
  '$guid',
  '$timestamp',
  '$isoTimestamp',
  '$randomInt',
  '$randomHex',
  '$randomString',
  '$randomEmail',
  '$randomFirstName',
  '$randomLastName',
  '$randomCompany',
  '$randomUrl',
  '$randomIp',
])

export function isDynamicVar(name: string): boolean {
  const colon = name.indexOf(':')
  return DYNAMIC_BASES.has(colon < 0 ? name : name.slice(0, colon))
}

const FIRST_NAMES = [
  'Ada', 'Bruno', 'Clara', 'Dario', 'Elena', 'Felix', 'Greta', 'Hugo',
  'Iris', 'Jonas', 'Kira', 'Leon', 'Mila', 'Nadia', 'Omar', 'Paula',
  'Quentin', 'Rosa', 'Silas', 'Tessa', 'Uma', 'Viktor', 'Wanda', 'Yusuf',
]

const LAST_NAMES = [
  'Almeida', 'Berger', 'Costa', 'Duarte', 'Engel', 'Fischer', 'Gallo', 'Hoffman',
  'Ibarra', 'Jensen', 'Kovac', 'Lindqvist', 'Moreau', 'Novak', 'Olsen', 'Petrov',
  'Quintana', 'Rossi', 'Sokolov', 'Tanaka', 'Ustinov', 'Vargas', 'Weber', 'Zhang',
]

const COMPANY_HEADS = [
  'North', 'Bright', 'Iron', 'Quiet', 'Blue', 'Open', 'Solid', 'Rapid',
  'Clear', 'Amber', 'Silver', 'Novel',
]

const COMPANY_TAILS = [
  'Works', 'Labs', 'Systems', 'Dynamics', 'Analytics', 'Logic', 'Foundry',
  'Networks', 'Robotics', 'Digital', 'Partners', 'Industries',
]

const URL_PATHS = ['', 'docs', 'pricing', 'about', 'blog/latest', 'api/v1/status', 'contact']

const TLDS = ['com', 'io', 'dev', 'net', 'org', 'app']

const HEX = '0123456789abcdef'
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const source = globalThis.crypto
  if (source && typeof source.getRandomValues === 'function') source.getRandomValues(out)
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  return out
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]
}

function uuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  let hex = ''
  for (let i = 0; i < 16; i++) hex += b[i].toString(16).padStart(2, '0')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function fromAlphabet(alphabet: string, length: number): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

function intArg(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

function clampLength(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(4096, Math.floor(n))
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function dynamicValue(name: string): string | null {
  const args = name.split(':')
  switch (args[0]) {
    case '$uuid':
    case '$guid':
      return uuid()
    case '$timestamp':
      return String(Math.floor(Date.now() / 1000))
    case '$isoTimestamp':
      return new Date().toISOString()
    case '$randomInt':
      return String(randomInt(intArg(args[1], 0), intArg(args[2], 1000)))
    case '$randomHex':
      return fromAlphabet(HEX, clampLength(intArg(args[1], 8)))
    case '$randomString':
      return fromAlphabet(ALNUM, clampLength(intArg(args[1], 16)))
    case '$randomEmail': {
      const host = slug(pick(COMPANY_HEADS) + pick(COMPANY_TAILS))
      return `${slug(pick(FIRST_NAMES))}.${slug(pick(LAST_NAMES))}@${host}.${pick(TLDS)}`
    }
    case '$randomFirstName':
      return pick(FIRST_NAMES)
    case '$randomLastName':
      return pick(LAST_NAMES)
    case '$randomCompany':
      return `${pick(COMPANY_HEADS)} ${pick(COMPANY_TAILS)}`
    case '$randomUrl': {
      const host = slug(pick(COMPANY_HEADS) + pick(COMPANY_TAILS))
      const path = pick(URL_PATHS)
      return `https://${host}.${pick(TLDS)}${path ? '/' + path : ''}`
    }
    case '$randomIp':
      return `${randomInt(1, 254)}.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`
    default:
      return null
  }
}
