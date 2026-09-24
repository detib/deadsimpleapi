/**
 * The request executor. One call to execute() owns one agent, one timeout, one
 * redirect chain and exactly one settle path: it never rejects, and no event
 * handler is left able to throw into the void.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { request as httpRequest, type Agent, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Readable } from 'node:stream'
import type { PeerCertificate } from 'node:tls'

import type {
  RedirectHop,
  ResponseCookie,
  StreamEvent,
  Timing,
  TlsInfo,
  WireRequest,
  WireResponse,
} from '../../shared/types'
import { parseSetCookie, type CookieJar } from './cookies'
import { acceptEncodingValue, createDecodeStream } from './decode'
import { prepareBody, type PreparedBody } from './multipart'
import { closeAgent, makeAgent, proxyAuthHeader, proxyRequestPath } from './proxy'

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface ExecuteHooks {
  /** Only called when settings.streamResponse is on. */
  onStream?: (ev: StreamEvent) => void
}

export interface Executor {
  execute(req: WireRequest, hooks?: ExecuteHooks): Promise<WireResponse>
  cancel(execId: string): boolean
  cancelAll(): void
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const USER_AGENT = 'Deadsimple/1.0'
const STREAM_FLUSH_MS = 50
const STREAM_FLUSH_BYTES = 64 * 1024
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const TLS_HINT = 'You can turn off "Verify TLS certificate" in request settings.'

/** Hard ceiling on a single decoded response, well above any real payload. */
const MAX_DECODED_BYTES = 2 * 1024 * 1024 * 1024

const formatGb = (n: number): string => `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`

const NO_BODY: PreparedBody = {
  stream: null,
  buffer: null,
  contentLength: undefined,
  contentType: undefined,
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const dur = (from: number, to: number): number => Math.round(Math.max(0, to - from) * 100) / 100

function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'string') return err
  return String(err)
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/**
 * Buffer slices live inside a shared 8KB pool, and structured-cloning one over
 * IPC copies the whole pool. Only alias when the view owns its ArrayBuffer.
 */
function toBytes(buf: Buffer): Uint8Array {
  if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
    return new Uint8Array(buf.buffer)
  }
  return new Uint8Array(buf)
}

function pairFlat(flat: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

function indexOfHeader(flat: readonly string[], lower: string): number {
  for (let i = 0; i < flat.length; i += 2) {
    if (flat[i].toLowerCase() === lower) return i
  }
  return -1
}

const hasHeader = (flat: readonly string[], lower: string): boolean => indexOfHeader(flat, lower) >= 0

/**
 * Replaces the first occurrence in place - keeping the caller's casing and
 * position - and drops any later duplicates.
 */
function replaceHeader(flat: string[], name: string, value: string): void {
  const lower = name.toLowerCase()
  let found = false
  let i = 0
  while (i < flat.length) {
    if (flat[i].toLowerCase() === lower) {
      if (found) {
        flat.splice(i, 2)
        continue
      }
      flat[i + 1] = value
      found = true
    }
    i += 2
  }
  if (!found) flat.push(name, value)
}

function firstHeaderValue(
  headers: ReadonlyArray<[string, string]>,
  lower: string,
): string | undefined {
  for (const [key, value] of headers) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

/** Characters `new URL` leaves alone in a path or query even though a server is
 *  entitled to reject them. */
const LOOSE_CHARS = new Set([' ', '"', '<', '>', '{', '}', '|', '\\', '^', '`'])

function percentEncodeLoose(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || LOOSE_CHARS.has(ch)) {
      out += '%' + code.toString(16).toUpperCase().padStart(2, '0')
    } else if (code > 0x7f) {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0')
      }
    } else {
      out += ch
    }
  }
  return out
}

/** Safe to assign straight back: the setters do not re-encode an existing `%`. */
function tightenUrl(url: URL): void {
  const path = percentEncodeLoose(url.pathname)
  if (path !== url.pathname) url.pathname = path
  const search = percentEncodeLoose(url.search)
  if (search !== url.search) url.search = search
}

function parseTarget(raw: string, encode: boolean): URL {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    const hint = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? '' : ' - add http:// or https://'
    throw new Error(`Invalid URL: ${trimmed || '(empty)'}${hint}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${url.protocol}" - only http and https can be sent`)
  }
  if (encode) tightenUrl(url)
  return url
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/* ------------------------------------------------------------------ */
/* Response inspection                                                 */
/* ------------------------------------------------------------------ */

function readSetCookies(res: IncomingMessage): ResponseCookie[] {
  const raw = res.headers['set-cookie']
  if (!raw || raw.length === 0) return []
  const out: ResponseCookie[] = []
  for (const line of raw) {
    const parsed = parseSetCookie(line)
    if (parsed) out.push(parsed)
  }
  return out
}

/** Approximates the bytes the header block occupied on the wire. */
function headerByteSize(statusLine: string, headers: ReadonlyArray<[string, string]>): number {
  // Status line CRLF plus the blank line that closes the block.
  let n = statusLine.length + 2 + 2
  for (const [key, value] of headers) n += key.length + value.length + 4
  return n
}

interface TlsLikeSocket {
  authorized?: boolean
  authorizationError?: Error | string | null
  getPeerCertificate?: (detailed?: boolean) => PeerCertificate | undefined
  getProtocol?: () => string | null
  getCipher?: () => { name: string; version: string } | undefined
}

const certField = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? v[0] ?? '' : v ?? ''

/** All of this is missing on a plain socket and can be missing on a reused one,
 *  so every access is guarded. */
function readTls(socket: Socket | null | undefined): TlsInfo | undefined {
  const s = socket as (Socket & TlsLikeSocket) | null | undefined
  if (!s || typeof s.getPeerCertificate !== 'function') return undefined

  let cert: PeerCertificate | undefined
  let protocol = ''
  let cipher: { name: string } | undefined
  try {
    cert = s.getPeerCertificate(false)
  } catch {
    cert = undefined
  }
  try {
    protocol = (typeof s.getProtocol === 'function' ? s.getProtocol() : null) ?? ''
  } catch {
    protocol = ''
  }
  try {
    cipher = typeof s.getCipher === 'function' ? s.getCipher() : undefined
  } catch {
    cipher = undefined
  }

  const hasCert = !!cert && Object.keys(cert).length > 0
  if (!hasCert && !protocol && !cipher) return undefined

  const authError = s.authorizationError
  return {
    protocol,
    cipher: cipher?.name ?? '',
    issuer: certField(cert?.issuer?.CN) || certField(cert?.issuer?.O),
    subject: certField(cert?.subject?.CN),
    validFrom: cert?.valid_from ?? '',
    validTo: cert?.valid_to ?? '',
    authorized: s.authorized === true,
    authorizationError: authError ? errText(authError) : undefined,
  }
}

/* ------------------------------------------------------------------ */
/* Error text                                                          */
/* ------------------------------------------------------------------ */

function describeError(err: unknown, target: URL, proxy: string): string {
  const host = target.host
  const via = proxy ? ` (via proxy ${proxy})` : ''
  switch (codeOf(err)) {
    case 'ENOTFOUND':
      return `Could not resolve host ${target.hostname}${via}`
    case 'EAI_AGAIN':
      return `Could not resolve host ${target.hostname} - the name server did not answer${via}`
    case 'ECONNREFUSED':
      return `Connection refused by ${host}${via}`
    case 'ECONNRESET':
      return `Connection reset by ${host}${via}`
    case 'ECONNABORTED':
      return `Connection to ${host} was aborted before the response completed${via}`
    case 'EHOSTUNREACH':
      return `No route to host ${host}${via}`
    case 'ENETUNREACH':
      return `Network is unreachable, ${host} cannot be contacted${via}`
    case 'EPIPE':
      return `Connection to ${host} closed while the request was still being sent${via}`
    case 'ETIMEDOUT':
      return `Connection to ${host} timed out${via}`
    case 'CERT_HAS_EXPIRED':
      return `The TLS certificate for ${target.hostname} has expired. ${TLS_HINT}`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return `${target.hostname} is using a self-signed TLS certificate. ${TLS_HINT}`
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return `The TLS chain for ${target.hostname} contains a self-signed certificate. ${TLS_HINT}`
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `The TLS certificate for ${target.hostname} could not be verified - the server may be sending an incomplete chain. ${TLS_HINT}`
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The TLS certificate does not cover ${target.hostname}. ${TLS_HINT}`
    case 'EPROTO':
      return `TLS handshake with ${host} failed - the server may not speak HTTPS on this port. ${TLS_HINT}`
    default:
      return errText(err)
  }
}

/** Node only defaults to chunked framing outside these three. */
const NO_DEFAULT_BODY_METHODS = new Set(['GET', 'HEAD', 'DELETE'])

/** Method and body rewriting for a redirect hop. */
function redirectMethod(status: number, method: string): { method: string; dropBody: boolean } {
  if (status === 303) return { method: 'GET', dropBody: true }
  // Every browser and curl downgrade a redirected POST to GET on 301/302.
  if ((status === 301 || status === 302) && method.toUpperCase() === 'POST') {
    return { method: 'GET', dropBody: true }
  }
  return { method, dropBody: false }
}

/* ------------------------------------------------------------------ */
/* Executor                                                            */
/* ------------------------------------------------------------------ */

export function createExecutor(opts: {
  jar: CookieJar
  inlineBodyCap: number
  overflowDir: string
}): Executor {
  const { jar, inlineBodyCap, overflowDir } = opts
  const live = new Map<string, { abort(): void }>()

  function execute(wire: WireRequest, hooks?: ExecuteHooks): Promise<WireResponse> {
    const { execId, settings } = wire
    const startedAt = Date.now()
    const t0 = performance.now()

    return new Promise<WireResponse>((resolve) => {
      /* ---------------- execution-wide state ---------------- */
      let settled = false
      let agent: Agent | null = null
      let clientReq: ClientRequest | null = null
      let bodyStream: Readable | null = null
      let overflow: WriteStream | null = null
      let timeoutTimer: NodeJS.Timeout | null = null
      let flushTimer: NodeJS.Timeout | null = null

      let prepared: PreparedBody = NO_BODY
      let streamConsumed = false
      let stripSensitive = false
      let hopGen = 0
      let basicFromUrl: string | undefined
      const redirects: RedirectHop[] = []

      /* ---------------- timing marks (final hop only) ---------------- */
      let hopStart = t0
      let lookupAt: number | undefined
      let connectAt: number | undefined
      let secureAt: number | undefined
      let sentAt: number | undefined
      let firstByteAt: number | undefined

      const resetMarks = (): void => {
        hopStart = performance.now()
        lookupAt = undefined
        connectAt = undefined
        secureAt = undefined
        sentAt = undefined
        firstByteAt = undefined
      }

      const buildTiming = (endMark: number): Timing => {
        const timing: Timing = { total: dur(t0, endMark), startedAt }
        if (lookupAt !== undefined) timing.dns = dur(hopStart, lookupAt)
        if (connectAt !== undefined) timing.tcp = dur(lookupAt ?? hopStart, connectAt)
        if (secureAt !== undefined && connectAt !== undefined) timing.tls = dur(connectAt, secureAt)
        if (firstByteAt !== undefined) {
          timing.wait = dur(sentAt ?? secureAt ?? connectAt ?? hopStart, firstByteAt)
          timing.download = dur(firstByteAt, endMark)
        }
        return timing
      }

      /* ---------------- settle path ---------------- */
      const cleanup = (): void => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (flushTimer) clearTimeout(flushTimer)
        timeoutTimer = null
        flushTimer = null
        live.delete(execId)
        if (bodyStream) {
          bodyStream.destroy()
          bodyStream = null
        }
        if (overflow && !overflow.writableFinished) overflow.destroy()
        overflow = null
        if (clientReq && !clientReq.destroyed) clientReq.destroy()
        clientReq = null
        if (agent) closeAgent(agent)
        agent = null
      }

      const settle = (res: WireResponse): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(res)
      }

      const fail = (message: string, code?: string): void => {
        settle({ ok: false, execId, error: message, code, timing: buildTiming(performance.now()) })
      }

      live.set(execId, {
        abort() {
          if (settled) return
          settle({
            ok: false,
            execId,
            error: 'Request canceled',
            canceled: true,
            timing: buildTiming(performance.now()),
          })
        },
      })

      // One timer for the whole execution, redirects included.
      if (settings.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          fail(`Request timed out after ${settings.timeoutMs}ms`, 'ETIMEDOUT')
        }, settings.timeoutMs)
      }

      /* ---------------- streaming ---------------- */
      const onStream = settings.streamResponse ? hooks?.onStream : undefined
      let pending: Buffer[] = []
      let pendingBytes = 0
      let decodedBytes = 0

      const emit = (ev: StreamEvent): void => {
        if (!onStream) return
        try {
          onStream(ev)
        } catch {
          // A listener that throws must not abort the transfer.
        }
      }

      const flushChunks = (): void => {
        if (flushTimer) {
          clearTimeout(flushTimer)
          flushTimer = null
        }
        if (pendingBytes === 0) return
        const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
        pending = []
        pendingBytes = 0
        emit({ execId, phase: 'chunk', chunk: toBytes(buf), receivedBytes: decodedBytes })
      }

      /** Coalesce, then emit every 64KB or every 50ms, whichever lands first. */
      const queueChunk = (chunk: Buffer): void => {
        pending.push(chunk)
        pendingBytes += chunk.length
        if (pendingBytes >= STREAM_FLUSH_BYTES) flushChunks()
        else if (!flushTimer) flushTimer = setTimeout(flushChunks, STREAM_FLUSH_MS)
      }

      /* ---------------- headers ---------------- */
      const buildHeaders = (
        target: URL,
        method: string,
        sendBody: boolean,
        bodyDropped: boolean,
      ): string[] => {
        const flat: string[] = []
        for (const [name, value] of wire.headers) {
          if (!name.trim()) continue
          const lower = name.toLowerCase()
          if (
            stripSensitive &&
            (lower === 'authorization' || lower === 'cookie' || lower.startsWith('proxy-'))
          ) {
            continue
          }
          // A redirect that drops the body must not keep its framing headers.
          if (
            bodyDropped &&
            (lower === 'content-type' || lower === 'content-length' || lower === 'transfer-encoding')
          ) {
            continue
          }
          flat.push(name, value)
        }

        if (settings.decompress && !hasHeader(flat, 'accept-encoding')) {
          flat.push('Accept-Encoding', acceptEncodingValue())
        }

        if (sendBody && prepared.contentType) {
          if (wire.body.kind === 'multipart') {
            // The boundary in the header has to match the one in the body, so
            // this is the one value that overrides what the user typed.
            replaceHeader(flat, 'Content-Type', prepared.contentType)
          } else if (!hasHeader(flat, 'content-type')) {
            flat.push('Content-Type', prepared.contentType)
          }
        }

        if (settings.sendCookies) {
          const fromJar = jar.cookieHeaderFor(target)
          if (fromJar) {
            const at = indexOfHeader(flat, 'cookie')
            if (at >= 0) flat[at + 1] = flat[at + 1] ? `${flat[at + 1]}; ${fromJar}` : fromJar
            else flat.push('Cookie', fromJar)
          }
        }

        if (basicFromUrl && !stripSensitive && !hasHeader(flat, 'authorization')) {
          flat.push('Authorization', basicFromUrl)
        }
        if (!hasHeader(flat, 'user-agent')) flat.push('User-Agent', USER_AGENT)
        if (!hasHeader(flat, 'accept')) flat.push('Accept', '*/*')

        // A tunnelled request authenticates inside CONNECT; a plain-http one
        // has to carry the proxy credentials on the request itself.
        if (target.protocol === 'http:' && !hasHeader(flat, 'proxy-authorization')) {
          const proxyAuth = proxyAuthHeader(settings.proxy)
          if (proxyAuth) flat.push('Proxy-Authorization', proxyAuth)
        }

        // Node derives Host and the framing headers only when `headers` is an
        // object; given the flat array form it sends exactly what it is handed,
        // so both have to be supplied here.
        if (!hasHeader(flat, 'host')) flat.push('Host', target.host)
        if (!hasHeader(flat, 'content-length') && !hasHeader(flat, 'transfer-encoding')) {
          if (sendBody && prepared.contentLength !== undefined) {
            flat.push('Content-Length', String(prepared.contentLength))
          } else if (sendBody) {
            flat.push('Transfer-Encoding', 'chunked')
          } else if (!NO_DEFAULT_BODY_METHODS.has(method.toUpperCase())) {
            // Without this Node frames a bodyless POST as chunked, which is
            // both surprising and invisible to the `sent` echo below.
            flat.push('Content-Length', '0')
          }
        }
        return flat
      }

      /* ---------------- one hop ---------------- */
      const hop = (target: URL, method: string, withBody: boolean, bodyDropped: boolean): void => {
        if (settled) return
        try {
          runHop(target, method, withBody, bodyDropped)
        } catch (err) {
          // Node validates header names, header values and the path eagerly.
          fail(describeError(err, target, settings.proxy), codeOf(err))
        }
      }

      const runHop = (
        target: URL,
        method: string,
        withBody: boolean,
        bodyDropped: boolean,
      ): void => {
        // Tearing an intermediate hop down makes its socket emit late errors.
        // Anything from a superseded hop has to be ignored, not settled on.
        const gen = ++hopGen
        const stale = (): boolean => settled || gen !== hopGen

        resetMarks()
        const sendBody = withBody && (prepared.buffer !== null || prepared.stream !== null)
        const flat = buildHeaders(target, method, sendBody, bodyDropped)
        const isHttps = target.protocol === 'https:'

        const hopAgent = makeAgent(target, {
          proxy: settings.proxy,
          verifyTls: settings.verifyTls,
          timeoutMs: settings.timeoutMs,
        })
        agent = hopAgent

        const options: RequestOptions = {
          method,
          protocol: target.protocol,
          // url.hostname keeps the brackets around an IPv6 literal; the socket
          // layer wants the bare address.
          hostname: target.hostname.replace(/^\[|\]$/g, ''),
          port: target.port || (isHttps ? '443' : '80'),
          path: proxyRequestPath(target, settings.proxy),
          headers: flat,
          agent: hopAgent,
          rejectUnauthorized: settings.verifyTls,
        }

        const req = (isHttps ? httpsRequest : httpRequest)(options)
        clientReq = req

        req.on('socket', (socket: Socket) => {
          // A pooled socket never re-emits these, which is exactly why the
          // matching phases end up omitted from the timing.
          socket.once('lookup', () => {
            if (!stale()) lookupAt = performance.now()
          })
          socket.once('connect', () => {
            if (!stale()) connectAt = performance.now()
          })
          socket.once('secureConnect', () => {
            if (!stale()) secureAt = performance.now()
          })
        })

        req.on('finish', () => {
          if (!stale()) sentAt = performance.now()
        })

        req.on('error', (err) => {
          if (stale()) return
          fail(describeError(err, target, settings.proxy), codeOf(err))
        })

        req.on('response', (res: IncomingMessage) => {
          if (stale()) {
            res.on('error', () => {})
            res.resume()
            return
          }
          try {
            onResponse(res, target, method, flat, isHttps)
          } catch (err) {
            res.on('error', () => {})
            res.resume()
            fail(errText(err), codeOf(err))
          }
        })

        if (!sendBody) {
          req.end()
          return
        }
        if (prepared.buffer) {
          req.end(prepared.buffer)
          return
        }
        const source = prepared.stream
        if (!source) {
          req.end()
          return
        }
        bodyStream = source
        streamConsumed = true
        source.on('error', (err) => {
          if (!stale()) fail(`Could not read the request body: ${errText(err)}`, codeOf(err))
          req.destroy()
        })
        source.pipe(req)
      }

      /* ---------------- response ---------------- */
      const onResponse = (
        res: IncomingMessage,
        target: URL,
        method: string,
        flat: string[],
        isHttps: boolean,
      ): void => {
        if (settled) {
          res.on('error', () => {})
          res.resume()
          return
        }
        // Listening for 'readable' would take the response out of flowing mode
        // and stall the pipe below, so the response head - the first bytes off
        // the wire either way - is the first-byte mark.
        firstByteAt = performance.now()

        const status = res.statusCode ?? 0
        const cookies = readSetCookies(res)
        if (settings.storeCookies && cookies.length > 0) {
          try {
            jar.store(target, cookies)
          } catch {
            // A jar write must never fail the request.
          }
        }

        const location = res.headers.location
        if (settings.followRedirects && REDIRECT_STATUS.has(status) && location) {
          followRedirect(res, target, method, status, location)
          return
        }

        // rawHeaders, not headers: duplicates and order have to survive.
        const headers = pairFlat(res.rawHeaders)
        const statusText = res.statusMessage ?? ''
        const httpVersion = res.httpVersion
        const remoteAddress = res.socket?.remoteAddress
        const remotePort = res.socket?.remotePort
        const tls = isHttps ? readTls(res.socket) : undefined
        const headerSize = headerByteSize(`HTTP/${httpVersion} ${status} ${statusText}`, headers)

        emit({ execId, phase: 'headers', status, statusText, headers })

        let transferBytes = 0
        let inlineBytes = 0
        let truncated = false
        let overflowPath: string | undefined
        const chunks: Buffer[] = []

        // A response that cannot carry a body would hand the decoder zero
        // bytes, which zlib reports as Z_BUF_ERROR.
        const bodyless =
          method.toUpperCase() === 'HEAD' || status === 204 || status === 304 || status < 200

        const complete = (endMark: number): void => {
          if (settled) return
          flushChunks()
          emit({ execId, phase: 'end', receivedBytes: decodedBytes })

          const done = (): void => {
            if (settled) return
            const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, inlineBytes)
            settle({
              ok: true,
              execId,
              status,
              statusText,
              httpVersion,
              headers,
              body: toBytes(body),
              truncated,
              overflowPath,
              size: { transfer: transferBytes, decoded: decodedBytes, headers: headerSize },
              timing: buildTiming(endMark),
              redirects,
              cookies,
              remoteAddress,
              remotePort,
              tls,
              sent: { method, url: target.href, headers: pairFlat(flat) },
            })
          }

          // Settle only once the spill file holds the whole body.
          if (overflow) overflow.end(done)
          else done()
        }

        let src: Readable = res
        if (settings.decompress && !bodyless) {
          const decoder = createDecodeStream(res.headers['content-encoding'])
          if (decoder) {
            decoder.on('error', (err) => {
              if (settled) return
              // Servers do advertise an encoding on an empty body; zlib calls
              // that a Z_BUF_ERROR. There was nothing to decode, so finish.
              if (transferBytes === 0 && decodedBytes === 0) complete(performance.now())
              else fail(`Could not decompress the response body: ${errText(err)}`, codeOf(err))
            })
            res.pipe(decoder)
            src = decoder
          }
        }

        // Counted ahead of the decoder, so this is what came off the socket.
        res.on('data', (chunk: Buffer) => {
          transferBytes += chunk.length
        })
        res.on('aborted', () => {
          if (!settled) {
            fail('The connection closed before the response was complete', 'ECONNABORTED')
          }
        })
        res.on('error', (err) => {
          if (!settled) fail(describeError(err, target, settings.proxy), codeOf(err))
        })

        const openOverflow = (): boolean => {
          try {
            mkdirSync(overflowDir, { recursive: true })
            const file = join(overflowDir, `${execId}.bin`)
            const ws = createWriteStream(file)
            ws.on('error', (err) => {
              if (!settled) {
                fail(`Could not write the response to ${file}: ${errText(err)}`, codeOf(err))
              }
            })
            overflow = ws
            overflowPath = file
            truncated = true
            return true
          } catch (err) {
            fail(`Could not write the response overflow file: ${errText(err)}`, codeOf(err))
            return false
          }
        }

        // src.pause() does not take effect until the current emit batch drains,
        // so more chunks can still arrive while we are already waiting. Without
        // this guard each one would add another 'drain' listener.
        let awaitingDrain = false

        const writeOverflow = (chunk: Buffer): void => {
          const ws = overflow
          if (!ws) return
          if (!ws.write(chunk) && !awaitingDrain) {
            awaitingDrain = true
            src.pause()
            ws.once('drain', () => {
              awaitingDrain = false
              if (!settled) src.resume()
            })
          }
        }

        src.on('data', (chunk: Buffer) => {
          if (settled) return
          decodedBytes += chunk.length

          // Compression ratios are unbounded, so a small response can decode to
          // an arbitrarily large stream. Memory is already capped by the spill
          // to disk, but the disk is not; stop rather than fill the volume.
          if (decodedBytes > MAX_DECODED_BYTES) {
            fail(
              `Response exceeded the ${formatGb(MAX_DECODED_BYTES)} decoded-size limit after ` +
                `${formatGb(decodedBytes)}. The server may be sending a decompression bomb.`,
              'EBODYTOOLARGE',
            )
            return
          }

          if (onStream) queueChunk(chunk)

          if (overflow) {
            writeOverflow(chunk)
            return
          }
          if (inlineBytes + chunk.length <= inlineBodyCap) {
            chunks.push(chunk)
            inlineBytes += chunk.length
            return
          }
          // Spill: the file gets everything, memory keeps the first cap bytes.
          const buffered = chunks.slice()
          if (!openOverflow()) return
          for (const earlier of buffered) writeOverflow(earlier)
          writeOverflow(chunk)
          const room = inlineBodyCap - inlineBytes
          if (room > 0) {
            chunks.push(chunk.subarray(0, room))
            inlineBytes += room
          }
        })

        src.on('end', () => {
          complete(performance.now())
        })
      }

      /* ---------------- redirects ---------------- */
      const followRedirect = (
        res: IncomingMessage,
        target: URL,
        method: string,
        status: number,
        location: string,
      ): void => {
        redirects.push({ status, url: target.href, location })
        // Drain and let go of the socket; nothing here wants the interim body.
        res.on('error', () => {})
        res.resume()

        if (redirects.length > settings.maxRedirects) {
          fail(`Too many redirects (${settings.maxRedirects})`)
          return
        }

        let next: URL
        try {
          next = new URL(location, target)
        } catch {
          fail(`Invalid redirect: the server sent Location: ${location}`)
          return
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          fail(`Redirect to unsupported protocol "${next.protocol}" (${location})`)
          return
        }
        if (settings.encodeUrl) tightenUrl(next)

        if (next.protocol !== target.protocol || next.host !== target.host) {
          // Cross-origin: credentials do not travel. The jar is consulted again
          // for the new origin when the next hop builds its headers.
          stripSensitive = true
        }

        const { method: nextMethod, dropBody } = redirectMethod(status, method)
        const hadBody = prepared.buffer !== null || prepared.stream !== null
        const keepBody = hadBody && !dropBody

        if (keepBody && (prepared.buffer === null || streamConsumed)) {
          fail(
            `Cannot follow the ${status} redirect to ${next.href}: a streamed body (file or ` +
              'multipart upload) cannot be replayed. Send the body as text, or turn off ' +
              'Follow redirects and repeat the request against the new URL.',
          )
          return
        }

        clientReq = null
        if (agent) closeAgent(agent)
        agent = null
        hop(next, nextMethod, keepBody, hadBody && dropBody)
      }

      /* ---------------- drive ---------------- */
      const run = async (): Promise<void> => {
        let target: URL
        try {
          target = parseTarget(wire.url, settings.encodeUrl)
        } catch (err) {
          fail(errText(err))
          return
        }

        // Credentials in the URL are not sent as userinfo by any modern client.
        if (target.username || target.password) {
          const user = safeDecode(target.username)
          const pass = safeDecode(target.password)
          basicFromUrl = 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')
          target.username = ''
          target.password = ''
        }

        try {
          prepared = await prepareBody(wire.body, firstHeaderValue(wire.headers, 'content-type'))
        } catch (err) {
          fail(errText(err), codeOf(err))
          return
        }
        if (settled) {
          prepared.stream?.destroy()
          return
        }

        hop(target, wire.method, true, false)
      }

      void run().catch((err: unknown) => {
        fail(errText(err), codeOf(err))
      })
    })
  }

  return {
    execute,
    cancel(execId: string): boolean {
      const handle = live.get(execId)
      if (!handle) return false
      handle.abort()
      return true
    },
    cancelAll(): void {
      for (const handle of [...live.values()]) handle.abort()
    },
  }
}
