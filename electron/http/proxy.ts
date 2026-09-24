import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import type { Duplex } from 'node:stream'

/**
 * Connection agents. One agent is built per execution and thrown away after it:
 * keepAlive is off so every call measures a real DNS/TCP/TLS handshake instead
 * of inheriting a pooled socket's timings.
 */

interface ProxyEndpoint {
  host: string
  port: number
  /** The hop to the proxy itself is TLS (an https:// proxy URL). */
  secure: boolean
  /** Ready-made Proxy-Authorization value, or null when the URL carries no credentials. */
  auth: string | null
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const HEAD_TERMINATOR = '\r\n\r\n'
const HEAD_END = Buffer.from(HEAD_TERMINATOR)
/** Never buffer an unbounded CONNECT response head. */
const MAX_HEAD_BYTES = 32 * 1024

/* ------------------------------------------------------------------ */
/* Proxy URL                                                           */
/* ------------------------------------------------------------------ */

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

function basicAuth(url: URL): string | null {
  if (!url.username && !url.password) return null
  const pair = `${safeDecode(url.username)}:${safeDecode(url.password)}`
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`
}

/** Brackets are part of URL.hostname for IPv6 but not of a socket address. */
const unbracket = (host: string): string => host.replace(/^\[|\]$/g, '')

function parseProxy(raw: string): ProxyEndpoint {
  const text = raw.trim()
  let url: URL
  try {
    // Bare 'host:port' is how people usually type a proxy; assume http://.
    url = new URL(SCHEME.test(text) ? text : `http://${text}`)
  } catch {
    throw new Error(`Invalid proxy "${raw}": expected http://host:port`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid proxy "${raw}": only http and https proxies are supported`)
  }
  const host = unbracket(url.hostname)
  if (!host) throw new Error(`Invalid proxy "${raw}": missing host`)
  const secure = url.protocol === 'https:'
  const port = url.port ? Number(url.port) : secure ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid proxy "${raw}": port out of range`)
  }
  return { host, port, secure, auth: basicAuth(url) }
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/**
 * Proxy-Authorization value for a plain-http-over-proxy request, or null.
 * Tunnelled (https) requests carry these credentials inside the CONNECT
 * handshake instead, so this only ever applies to http:// targets.
 */
export function proxyAuthHeader(proxy: string): string | null {
  if (!proxy.trim()) return null
  try {
    return parseProxy(proxy).auth
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Sockets                                                             */
/* ------------------------------------------------------------------ */

function dialProxy(proxy: ProxyEndpoint, verifyTls: boolean): net.Socket {
  // verifyTls is the user's single TLS switch; it covers the proxy hop too.
  const socket = proxy.secure
    ? tls.connect({
        host: proxy.host,
        port: proxy.port,
        // RFC 6066: SNI carries host names only, never IP literals.
        servername: net.isIP(proxy.host) ? undefined : proxy.host,
        rejectUnauthorized: verifyTls,
      })
    : net.connect({ host: proxy.host, port: proxy.port })
  socket.setNoDelay(true)
  return socket
}

/** One-shot deadline on the connect phase only, so a live response is never cut off. */
function armConnectTimeout(socket: net.Socket, secure: boolean, ms: number, label: string): void {
  if (ms <= 0) return
  const timer = setTimeout(() => {
    socket.destroy(new Error(`${label} timed out after ${ms}ms`))
  }, ms)
  const clear = (): void => clearTimeout(timer)
  socket.once(secure ? 'secureConnect' : 'connect', clear)
  socket.once('error', clear)
  socket.once('close', clear)
}

/* ------------------------------------------------------------------ */
/* CONNECT tunnel                                                      */
/* ------------------------------------------------------------------ */

function openTunnel(
  target: URL,
  proxy: ProxyEndpoint,
  verifyTls: boolean,
  timeoutMs: number,
  done: (err: Error | null, socket?: Duplex) => void,
): void {
  const authority = `${target.hostname}:${portOf(target)}`
  const via = `${proxy.host}:${proxy.port}`
  const ready = proxy.secure ? 'secureConnect' : 'connect'
  const socket = dialProxy(proxy, verifyTls)
  let settled = false
  let head: Buffer = Buffer.alloc(0)

  const sendConnect = (): void => {
    const lines = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      'Proxy-Connection: keep-alive',
    ]
    if (proxy.auth) lines.push(`Proxy-Authorization: ${proxy.auth}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
  }

  const onData = (chunk: Buffer): void => {
    if (settled) return
    head = head.length ? Buffer.concat([head, chunk]) : chunk

    // The head can straddle several reads; wait for the blank line.
    const end = head.indexOf(HEAD_END)
    if (end < 0) {
      if (head.length > MAX_HEAD_BYTES) {
        fail(new Error(`Proxy ${via} sent an oversized CONNECT response`))
      }
      return
    }

    const statusLine = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? ''
    const m = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})[ \t]*(.*)$/.exec(statusLine)
    if (!m) {
      fail(new Error(`Proxy ${via} sent a malformed CONNECT response: ${statusLine.slice(0, 120)}`))
      return
    }
    const status = Number(m[1])
    // A reason phrase is attacker-controlled and only bounded by MAX_HEAD_BYTES.
    const reason = m[2].trim().slice(0, 120)
    if (status < 200 || status > 299) {
      fail(
        new Error(
          `Proxy ${via} refused CONNECT to ${authority}: ${status}${reason ? ` ${reason}` : ''}`,
        ),
      )
      return
    }

    settled = true
    cleanup()

    // Bytes past the blank line already belong to the tunnel - push them back
    // so the TLS wrap picks them up instead of losing them.
    const rest = head.subarray(end + HEAD_END.length)
    socket.pause()
    if (rest.length) socket.unshift(rest)

    const hostname = unbracket(target.hostname)
    let tunnel: tls.TLSSocket
    try {
      tunnel = tls.connect({
        socket,
        host: hostname,
        port: portOf(target),
        servername: net.isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: verifyTls,
        // This client only speaks HTTP/1.1; never let a server negotiate h2.
        ALPNProtocols: ['http/1.1'],
      })
    } catch (err) {
      // We are inside a socket 'data' handler: a synchronous throw here would
      // be an uncaught exception in the main process rather than a failed call.
      socket.once('error', () => {})
      socket.destroy()
      done(err instanceof Error ? err : new Error(String(err)))
      return
    }
    done(null, tunnel)
  }

  const onError = (err: Error): void => {
    fail(new Error(`Proxy ${via} connection failed: ${err.message}`))
  }

  const onClose = (): void => {
    fail(new Error(`Proxy ${via} closed the connection before completing CONNECT to ${authority}`))
  }

  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    socket.removeListener(ready, sendConnect)
    socket.removeListener('data', onData)
    socket.removeListener('error', onError)
    socket.removeListener('close', onClose)
  }

  const fail = (err: Error): void => {
    if (settled) return
    settled = true
    cleanup()
    // A late socket error after we have already reported the real cause would
    // otherwise be an unhandled 'error' event, which kills the main process.
    socket.once('error', () => {})
    socket.destroy()
    done(err)
  }

  const timer: NodeJS.Timeout | null =
    timeoutMs > 0
      ? setTimeout(() => {
          fail(
            new Error(`Proxy ${via} did not complete CONNECT to ${authority} within ${timeoutMs}ms`),
          )
        }, timeoutMs)
      : null

  socket.once(ready, sendConnect)
  socket.on('data', onData)
  socket.once('error', onError)
  socket.once('close', onClose)
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * Node serialises a request's whole header block inside the ClientRequest
 * constructor, before the agent is ever consulted, so req.setHeader() is
 * already too late by the time an agent could add Proxy-Authorization. Splice
 * the line into the serialised block instead - rebuilding it from the header
 * map (what http-proxy-agent does) would drop the ordered/duplicated array
 * form of headers this app relies on. Any unexpected shape is left alone.
 */
function injectProxyAuth(req: http.ClientRequest, auth: string): void {
  const holder = req as unknown as { _header?: unknown }
  const head = holder._header
  if (typeof head !== 'string' || !head.endsWith(HEAD_TERMINATOR)) return
  if (/\r\nproxy-authorization[ \t]*:/i.test(head)) return
  holder._header = `${head.slice(0, -2)}Proxy-Authorization: ${auth}${HEAD_TERMINATOR}`
}

/** @types/node omits Agent#addRequest even though it is the documented hook. */
interface AgentAddRequest {
  addRequest(this: http.Agent, req: http.ClientRequest, options: http.ClientRequestArgs): void
}

/** http:// target through a proxy: same request, but the socket goes to the proxy. */
class ProxyHttpAgent extends http.Agent {
  constructor(
    private readonly proxy: ProxyEndpoint,
    private readonly verifyTls: boolean,
    private readonly timeoutMs: number,
  ) {
    super({ keepAlive: false })
  }

  addRequest(req: http.ClientRequest, options: http.ClientRequestArgs): void {
    // Tunnelled requests authenticate inside CONNECT; a plain-http request has
    // to carry the credentials itself or the proxy answers 407.
    if (this.proxy.auth) injectProxyAuth(req, this.proxy.auth)
    ;(http.Agent.prototype as unknown as AgentAddRequest).addRequest.call(this, req, options)
  }

  override createConnection(): Duplex {
    const socket = dialProxy(this.proxy, this.verifyTls)
    const label = `Connection to proxy ${this.proxy.host}:${this.proxy.port}`
    armConnectTimeout(socket, this.proxy.secure, this.timeoutMs, label)
    return socket
  }
}

/** https:// target through a proxy: CONNECT first, then TLS inside the tunnel. */
class TunnelAgent extends https.Agent {
  constructor(
    private readonly target: URL,
    private readonly proxy: ProxyEndpoint,
    private readonly verifyTls: boolean,
    private readonly timeoutMs: number,
  ) {
    super({ keepAlive: false, rejectUnauthorized: verifyTls })
  }

  override createConnection(
    _options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    // The agent calls this callback with the error alone when the socket never
    // materialised, which the published signature does not express.
    const done = callback as ((err: Error | null, stream?: Duplex) => void) | undefined
    openTunnel(this.target, this.proxy, this.verifyTls, this.timeoutMs, (err, socket) => {
      if (!done) {
        socket?.destroy()
        return
      }
      done(err, socket)
    })
    return undefined
  }
}

export function makeAgent(
  target: URL,
  opts: { proxy: string; verifyTls: boolean; timeoutMs: number },
): http.Agent {
  const secureTarget = target.protocol === 'https:'
  if (!opts.proxy.trim()) {
    return secureTarget
      ? new https.Agent({ keepAlive: false, rejectUnauthorized: opts.verifyTls })
      : new http.Agent({ keepAlive: false })
  }
  const endpoint = parseProxy(opts.proxy)
  return secureTarget
    ? new TunnelAgent(target, endpoint, opts.verifyTls, opts.timeoutMs)
    : new ProxyHttpAgent(endpoint, opts.verifyTls, opts.timeoutMs)
}

/**
 * An HTTP proxy expects the absolute form of the request target (RFC 9112 3.2.2).
 * A tunnelled https request is an ordinary origin-form request inside the tunnel.
 */
export function proxyRequestPath(target: URL, proxy: string): string {
  if (proxy.trim() && target.protocol === 'http:') {
    // Neither the fragment nor userinfo may appear in a request target, and
    // userinfo would additionally be handed to the proxy in clear text.
    const absolute = new URL(target.href)
    absolute.password = ''
    absolute.username = ''
    absolute.hash = ''
    return absolute.href
  }
  return `${target.pathname}${target.search}`
}

/** Releases sockets after a request. Must never throw over the real result. */
export function closeAgent(agent: http.Agent): void {
  try {
    agent.destroy()
  } catch {
    // Best-effort cleanup.
  }
}
