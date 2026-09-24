import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JarCookie, ResponseCookie } from '../../shared/types'

/* ------------------------------------------------------------------ */
/* Set-Cookie parsing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Parses one Set-Cookie header value. Follows RFC 6265 5.2 loosely: unknown
 * attributes are ignored rather than invalidating the cookie, which is what
 * real user agents do.
 */
export function parseSetCookie(header: string): ResponseCookie | null {
  const parts = header.split(';')
  const first = parts.shift()
  if (!first) return null
  const eq = first.indexOf('=')
  if (eq < 0) return null

  const name = first.slice(0, eq).trim()
  if (!name) return null
  let value = first.slice(eq + 1).trim()
  // A quoted value keeps its quotes on the wire but not in the jar.
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1)
  }

  const out: ResponseCookie = { name, value, secure: false, httpOnly: false }

  for (const raw of parts) {
    const seg = raw.trim()
    if (!seg) continue
    const i = seg.indexOf('=')
    const attr = (i < 0 ? seg : seg.slice(0, i)).trim().toLowerCase()
    const val = i < 0 ? '' : seg.slice(i + 1).trim()

    switch (attr) {
      case 'expires':
        out.expires = val
        break
      case 'max-age': {
        const n = Number.parseInt(val, 10)
        if (Number.isFinite(n)) out.maxAge = n
        break
      }
      case 'domain':
        out.domain = val.replace(/^\./, '').toLowerCase()
        break
      case 'path':
        out.path = val
        break
      case 'secure':
        out.secure = true
        break
      case 'httponly':
        out.httpOnly = true
        break
      case 'samesite':
        out.sameSite = val
        break
    }
  }
  return out
}

/** RFC 6265 5.1.4 — the default path is the directory of the request path. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/'
  const i = pathname.lastIndexOf('/')
  return i <= 0 ? '/' : pathname.slice(0, i)
}

export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true
  return host.endsWith('.' + domain) && !isIpAddress(host)
}

export function pathMatch(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath[cookiePath.length] === '/'
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')
}

function expiryOf(c: ResponseCookie, now: number): number | undefined {
  if (typeof c.maxAge === 'number') return now + c.maxAge * 1000
  if (c.expires) {
    const t = Date.parse(c.expires)
    if (Number.isFinite(t)) return t
  }
  return undefined // session cookie
}

/* ------------------------------------------------------------------ */
/* Jar                                                                 */
/* ------------------------------------------------------------------ */

/**
 * A small persistent cookie jar. Session cookies (no expiry) live only for the
 * lifetime of the app process and are stripped on save.
 */
export class CookieJar {
  private cookies: JarCookie[] = []
  private dirty = false
  private saving: Promise<void> | null = null

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const now = Date.now()
        this.cookies = (parsed as JarCookie[]).filter(
          (c) => c && typeof c.name === 'string' && (c.expires === undefined || c.expires > now),
        )
      }
    } catch {
      this.cookies = []
    }
  }

  all(): JarCookie[] {
    this.prune()
    return this.cookies.slice()
  }

  clear(): void {
    this.cookies = []
    this.dirty = true
    void this.save()
  }

  remove(predicate: (c: JarCookie) => boolean): number {
    const before = this.cookies.length
    this.cookies = this.cookies.filter((c) => !predicate(c))
    const removed = before - this.cookies.length
    if (removed) {
      this.dirty = true
      void this.save()
    }
    return removed
  }

  private prune(): void {
    const now = Date.now()
    const before = this.cookies.length
    this.cookies = this.cookies.filter((c) => c.expires === undefined || c.expires > now)
    if (this.cookies.length !== before) this.dirty = true
  }

  /** Header value for a request, or '' when nothing matches. */
  cookieHeaderFor(url: URL): string {
    this.prune()
    const host = url.hostname.toLowerCase()
    const path = url.pathname || '/'
    const isSecure = url.protocol === 'https:'

    const matched = this.cookies.filter((c) => {
      if (c.secure && !isSecure) return false
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) return false
      return pathMatch(path, c.path)
    })

    // RFC 6265 5.4: longer paths first, then oldest first.
    matched.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
    return matched.map((c) => `${c.name}=${c.value}`).join('; ')
  }

  /** Stores cookies from a response. Returns what was actually accepted. */
  store(url: URL, parsed: ResponseCookie[]): ResponseCookie[] {
    const now = Date.now()
    const host = url.hostname.toLowerCase()
    const accepted: ResponseCookie[] = []

    for (const c of parsed) {
      const hostOnly = !c.domain
      const domain = (c.domain || host).toLowerCase()

      // Reject cookies scoped to a domain the origin has no authority over.
      if (!hostOnly && !domainMatch(host, domain)) continue

      const path = c.path && c.path.startsWith('/') ? c.path : defaultPath(url.pathname || '/')
      const expires = expiryOf(c, now)

      // Same identity tuple replaces in place.
      const idx = this.cookies.findIndex(
        (x) => x.name === c.name && x.domain === domain && x.path === path,
      )

      // A cookie that has already expired is a deletion instruction.
      if (expires !== undefined && expires <= now) {
        if (idx >= 0) this.cookies.splice(idx, 1)
        this.dirty = true
        accepted.push(c)
        continue
      }

      const entry: JarCookie = {
        name: c.name,
        value: c.value,
        domain,
        path,
        expires,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        hostOnly,
        createdAt: idx >= 0 ? this.cookies[idx].createdAt : now,
      }
      if (idx >= 0) this.cookies[idx] = entry
      else this.cookies.push(entry)
      this.dirty = true
      accepted.push(c)
    }

    if (this.dirty) void this.save()
    return accepted
  }

  /** Coalesced write; persistent cookies only. */
  async save(): Promise<void> {
    if (!this.dirty || this.saving) return this.saving ?? undefined
    this.dirty = false
    this.saving = (async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        const persistent = this.cookies.filter((c) => c.expires !== undefined)
        await writeFile(this.file, JSON.stringify(persistent, null, 2), 'utf8')
      } catch {
        // A jar that fails to persist must not break request execution.
      } finally {
        this.saving = null
      }
    })()
    return this.saving
  }
}
