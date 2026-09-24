/**
 * curl -> ApiRequest.
 *
 * Commands arrive pasted from browser devtools, blog posts, PowerShell and cmd,
 * so nothing in here throws: anything unparseable or unrepresentable becomes a
 * warning and the rest of the command is still imported.
 */

import { kv, newRequest, uid } from '../../shared/factory'
import type {
  ApiRequest,
  BodyMode,
  KV,
  MultipartField,
  RequestSettings,
} from '../../shared/types'

export interface CurlParseResult {
  request: ApiRequest
  warnings: string[]
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

interface Token {
  text: string
  /** True when any part of the token came out of a quoted run. */
  quoted: boolean
}

interface Scan {
  text: string
  next: number
  closed: boolean
}

/**
 * Length of a line continuation starting at `i`, or 0. Covers sh (backslash),
 * cmd (caret) and PowerShell (backtick), plus the stray trailing spaces that
 * survive a copy/paste between the marker and the newline.
 */
function contLength(src: string, i: number): number {
  const c = src[i]
  if (c !== '\\' && c !== '^' && c !== '`') return 0
  let j = i + 1
  while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j++
  if (j < src.length && src[j] === '\r') j++
  if (j < src.length && src[j] === '\n') return j + 1 - i
  return 0
}

/** Single quotes are fully literal in sh - a backslash inside is just a backslash. */
function readSingle(src: string, start: number): Scan {
  const end = src.indexOf("'", start)
  if (end < 0) return { text: src.slice(start), next: src.length, closed: false }
  return { text: src.slice(start, end), next: end + 1, closed: true }
}

function readDouble(src: string, start: number): Scan {
  let out = ''
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      // cmd (and Chrome's "Copy as cURL (cmd)") escapes a quote by doubling it.
      // In sh this would be an empty concatenated run, which nobody writes.
      if (i + 1 < src.length && src[i + 1] === '"') {
        out += '"'
        i += 2
        continue
      }
      return { text: out, next: i + 1, closed: true }
    }
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1]
      i += 2
      if (n === '\n') continue
      if (n === '\r' && i < src.length && src[i] === '\n') {
        i++
        continue
      }
      if (n === '"' || n === '\\' || n === '$' || n === '`') out += n
      else if (n === 'n') out += '\n'
      else if (n === 'r') out += '\r'
      else if (n === 't') out += '\t'
      // sh keeps an unrecognised escape verbatim, backslash included.
      else out += '\\' + n
      continue
    }
    // PowerShell escapes with a backtick. Only the forms that would otherwise
    // terminate the string early are honoured, so a stray backtick in a body
    // still survives.
    if (c === '`' && i + 1 < src.length && (src[i + 1] === '"' || src[i + 1] === '`' || src[i + 1] === '$')) {
      out += src[i + 1]
      i += 2
      continue
    }
    out += c
    i++
  }
  return { text: out, next: i, closed: false }
}

/** ANSI-C quoting, $'...'. */
function readAnsiC(src: string, start: number): Scan {
  let out = ''
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === "'") return { text: out, next: i + 1, closed: true }
    if (c === '\\' && i + 1 < src.length) {
      const n = src[i + 1]
      i += 2
      switch (n) {
        case 'n': out += '\n'; break
        case 't': out += '\t'; break
        case 'r': out += '\r'; break
        case 'a': out += '\x07'; break
        case 'b': out += '\b'; break
        case 'f': out += '\f'; break
        case 'v': out += '\v'; break
        case 'e': out += '\x1b'; break
        case '0': out += '\0'; break
        case 'x': {
          const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i, i + 2))
          if (m) {
            out += String.fromCharCode(Number.parseInt(m[0], 16))
            i += m[0].length
          } else out += 'x'
          break
        }
        case 'u': {
          const m = /^[0-9a-fA-F]{1,4}/.exec(src.slice(i, i + 4))
          if (m) {
            out += String.fromCharCode(Number.parseInt(m[0], 16))
            i += m[0].length
          } else out += 'u'
          break
        }
        default: out += n
      }
      continue
    }
    out += c
    i++
  }
  return { text: out, next: i, closed: false }
}

function tokenize(src: string): { tokens: Token[]; warnings: string[] } {
  const tokens: Token[] = []
  const warnings: string[] = []
  let cur = ''
  let started = false
  let quoted = false
  let i = 0

  const flush = (): void => {
    if (!started) return
    tokens.push({ text: cur, quoted })
    cur = ''
    started = false
    quoted = false
  }

  while (i < src.length) {
    const c = src[i]
    const cont = contLength(src, i)
    if (cont > 0) {
      i += cont
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      flush()
      i++
      continue
    }
    // Adjacent runs keep appending, so 'foo'"bar" is one token.
    started = true

    if (c === "'") {
      const r = readSingle(src, i + 1)
      if (!r.closed) warnings.push("Unbalanced ' - the rest of the command was read as one value.")
      cur += r.text
      i = r.next
      quoted = true
    } else if (c === '"') {
      const r = readDouble(src, i + 1)
      if (!r.closed) warnings.push('Unbalanced " - the rest of the command was read as one value.')
      cur += r.text
      i = r.next
      quoted = true
    } else if (c === '$' && i + 1 < src.length && src[i + 1] === "'") {
      const r = readAnsiC(src, i + 2)
      if (!r.closed) warnings.push("Unbalanced $'...' - the rest of the command was read as one value.")
      cur += r.text
      i = r.next
      quoted = true
    } else if (c === '$' && i + 1 < src.length && src[i + 1] === '"') {
      const r = readDouble(src, i + 2)
      if (!r.closed) warnings.push('Unbalanced " - the rest of the command was read as one value.')
      cur += r.text
      i = r.next
      quoted = true
    } else if (c === '\\' && i + 1 < src.length) {
      cur += src[i + 1]
      i += 2
    } else {
      cur += c
      i++
    }
  }
  flush()
  return { tokens, warnings }
}

/* ------------------------------------------------------------------ */
/* Flag tables                                                         */
/* ------------------------------------------------------------------ */

type Arity = 'bool' | 'value'

/**
 * Long flag -> arity. Flags we cannot map still need the correct arity, so that
 * their argument is never mistaken for the URL.
 */
const VALUE_FLAGS =
  'request header data data-raw data-binary data-ascii data-urlencode form form-string user ' +
  'cookie cookie-jar user-agent referer max-redirs max-time connect-timeout proxy proxy-user ' +
  'url output retry retry-delay retry-max-time write-out upload-file json oauth2-bearer range ' +
  'resolve interface limit-rate continue-at dump-header time-cond speed-limit speed-time ' +
  'config cert cert-type key key-type cacert capath'

const BOOL_FLAGS =
  'location location-trusted insecure get compressed head silent verbose show-error include ' +
  'fail fail-with-body globoff no-buffer no-keepalive progress-bar path-as-is tcp-nodelay ' +
  'remote-name remote-header-name remote-time junk-session-cookies netrc raw parallel ' +
  'proxytunnel append list-only disable anyauth basic digest ntlm negotiate ipv4 ipv6 ' +
  'http1.0 http1.1 http2 http2-prior-knowledge http3 ssl-no-revoke tlsv1.2 tlsv1.3'

const SHORT_FLAGS =
  'X:request H:header d:data F:form u:user b:cookie c:cookie-jar A:user-agent e:referer ' +
  'L:location k:insecure m:max-time x:proxy U:proxy-user G:get I:head o:output O:remote-name ' +
  'J:remote-header-name R:remote-time s:silent S:show-error v:verbose w:write-out ' +
  'T:upload-file i:include f:fail g:globoff N:no-buffer #:progress-bar C:continue-at r:range ' +
  'D:dump-header E:cert K:config Y:speed-limit y:speed-time z:time-cond Z:parallel n:netrc ' +
  'j:junk-session-cookies a:append l:list-only p:proxytunnel q:disable 4:ipv4 6:ipv6'

const FLAGS: Record<string, Arity | undefined> = {}
for (const name of VALUE_FLAGS.split(' ')) FLAGS[name] = 'value'
for (const name of BOOL_FLAGS.split(' ')) FLAGS[name] = 'bool'

const SHORT: Record<string, string | undefined> = {}
for (const pair of SHORT_FLAGS.split(' ')) {
  const [ch, name] = pair.split(':')
  SHORT[ch] = name
}

/** Understood, but with nothing to map onto - worth telling the user about. */
const NOTED: Record<string, string | undefined> = {
  output: 'writes the response to a file',
  'dump-header': 'writes the response headers to a file',
  'cookie-jar': 'persists cookies to a file',
  'write-out': 'formats a summary line',
  retry: 'retries failed transfers',
  'connect-timeout': 'sets a separate connect timeout',
  range: 'requests a byte range',
  resolve: 'overrides DNS resolution',
  interface: 'binds to a network interface',
  'limit-rate': 'throttles the transfer',
  config: 'reads more options from a file',
  cert: 'uses a client certificate',
  key: 'uses a client key',
  cacert: 'uses a custom CA bundle',
  capath: 'uses a custom CA directory',
  netrc: 'reads credentials from .netrc',
  digest: 'uses Digest authentication',
  ntlm: 'uses NTLM authentication',
  negotiate: 'uses Negotiate authentication',
  anyauth: 'negotiates the authentication scheme',
  'proxy-user': 'authenticates against the proxy',
}

const SHELL_OPS = new Set(['|', '||', '&&', '&', ';', '>', '>>', '1>', '2>', '2>&1'])

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function decodeOnce(s: string, plusAsSpace = false): string {
  const t = plusAsSpace ? s.replace(/\+/g, ' ') : s
  try {
    return decodeURIComponent(t)
  } catch {
    return t
  }
}

/** RFC 3986 encoding - what --data-urlencode produces. */
function encodeComponent(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function hasScheme(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s)
}

function looksLikeUrl(s: string): boolean {
  if (hasScheme(s)) return true
  if (/^localhost(?:[:/?#]|$)/i.test(s)) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?:[:/?#]|$)/.test(s)) return true
  return /^(?:[\w-]+\.)+[a-z]{2,}(?:[:/?#]|$)/i.test(s)
}

function stripPrompt(input: string): string {
  return input.trim().replace(/^(?:PS\s+[^\r\n>]*>|[$>#])[ \t]+/, '')
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Re-indent JSON, refusing when an oversized integer literal would lose precision. */
function prettyJson(text: string): string | null {
  if (/\d{16,}/.test(text)) return null
  try {
    const value: unknown = JSON.parse(text)
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

function isJsonish(text: string): boolean {
  const t = text.trim()
  return t.startsWith('{') || t.startsWith('[')
}

const FORM_URLENCODED_RE = /^[\w.[\]%+-]+=[^&]*(?:&[\w.[\]%+-]+=[^&]*)*$/

/* ------------------------------------------------------------------ */
/* Parse                                                               */
/* ------------------------------------------------------------------ */

interface DataPart {
  /** `raw` is literal text, `urlencode` follows --data-urlencode's syntax,
   *  `file` is an unresolved @path reference. */
  kind: 'raw' | 'urlencode' | 'file'
  text: string
}

interface FormArg {
  raw: string
  /** --form-string: never interprets @, < or the ;type= suffix. */
  literal: boolean
}

interface State {
  url: string
  extraUrls: string[]
  method: string
  headers: Array<{ name: string; value: string }>
  cookieArgs: string[]
  data: DataPart[]
  forms: FormArg[]
  user: string | null
  bearer: string | null
  userAgent: string | null
  referer: string | null
  uploadFile: string | null
  jsonFlag: boolean
  getFlag: boolean
  headFlag: boolean
  follow: boolean
  maxRedirs: number | null
  insecure: boolean
  maxTime: number | null
  proxy: string | null
  compressed: boolean
}

export function parseCurl(input: string): CurlParseResult {
  const warnings: string[] = []
  const { tokens, warnings: tokenWarnings } = tokenize(stripPrompt(input))
  warnings.push(...tokenWarnings)

  // Drop `sudo`, leading env assignments and the binary itself. Only the head of
  // the command is searched, so a path segment named `curl` inside a URL cannot
  // be mistaken for the binary.
  let start = -1
  for (let n = 0; n < tokens.length && n < 4; n++) {
    const t = tokens[n].text
    if (!t.includes('://') && /^(?:[a-z]:)?(?:.*[\\/])?curl(?:\.exe)?$/i.test(t)) {
      start = n
      break
    }
  }
  const args = start >= 0 ? tokens.slice(start + 1) : tokens

  const st: State = {
    url: '',
    extraUrls: [],
    method: '',
    headers: [],
    cookieArgs: [],
    data: [],
    forms: [],
    user: null,
    bearer: null,
    userAgent: null,
    referer: null,
    uploadFile: null,
    jsonFlag: false,
    getFlag: false,
    headFlag: false,
    follow: false,
    maxRedirs: null,
    insecure: false,
    maxTime: null,
    proxy: null,
    compressed: false,
  }

  let i = 0
  const nextValue = (label: string): string | null => {
    if (i + 1 < args.length) {
      i++
      return args[i].text
    }
    warnings.push(`${label} was given without a value.`)
    return null
  }
  const skipUnknownValue = (): void => {
    if (i + 1 >= args.length) return
    const peek = args[i + 1].text
    // Never swallow the URL to feed a flag we do not understand.
    if (!peek.startsWith('-') && !looksLikeUrl(peek)) i++
  }

  while (i < args.length) {
    const token = args[i]
    const t = token.text

    if (!token.quoted && SHELL_OPS.has(t)) {
      warnings.push(`Stopped at the shell operator "${t}"; everything after it was ignored.`)
      break
    }

    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=')
      const name = (eq < 0 ? t.slice(2) : t.slice(2, eq)).toLowerCase()
      const inline = eq < 0 ? null : t.slice(eq + 1)
      const arity = FLAGS[name]

      if (arity === undefined) {
        const negated = name.startsWith('no-') ? name.slice(3) : ''
        if (negated && FLAGS[negated] === 'bool') {
          applyFlag(st, negated, null, warnings, true)
        } else {
          warnings.push(`Ignored the unsupported flag --${name}.`)
          if (inline === null) skipUnknownValue()
        }
      } else if (arity === 'bool') {
        applyFlag(st, name, null, warnings, false)
      } else {
        const value = inline ?? nextValue(`--${name}`)
        if (value !== null) applyFlag(st, name, value, warnings, false)
      }
      i++
      continue
    }

    if (t.length > 1 && t[0] === '-') {
      let c = 1
      while (c < t.length) {
        const ch = t[c]
        const name = SHORT[ch]
        if (name === undefined) {
          warnings.push(`Ignored the unsupported flag -${ch}.`)
          if (c === 1) skipUnknownValue()
          break
        }
        if (FLAGS[name] === 'value') {
          // The rest of the cluster is the value, as in -XPOST or -d@body.json.
          const rest = t.slice(c + 1)
          const value = rest.length > 0 ? rest : nextValue(`-${ch}`)
          if (value !== null) applyFlag(st, name, value, warnings, false)
          break
        }
        applyFlag(st, name, null, warnings, false)
        c++
      }
      i++
      continue
    }

    if (t.length > 0) {
      if (st.url) st.extraUrls.push(t)
      else st.url = t
    }
    i++
  }

  if (st.extraUrls.length) {
    warnings.push(
      `The command targets ${st.extraUrls.length + 1} URLs; only the first one was imported.`,
    )
  }

  return { request: build(st, warnings), warnings }
}

function applyFlag(
  st: State,
  name: string,
  value: string | null,
  warnings: string[],
  negated: boolean,
): void {
  const v = value ?? ''
  switch (name) {
    case 'request':
      st.method = v.trim().toUpperCase()
      break
    case 'header':
      st.headers.push(parseHeader(v))
      break
    case 'data':
    case 'data-ascii':
    case 'data-binary':
      st.data.push(
        v.startsWith('@')
          ? { kind: 'file', text: v.slice(1) }
          : { kind: 'raw', text: v },
      )
      break
    case 'data-raw':
      // --data-raw is the one data flag where a leading @ is literal.
      st.data.push({ kind: 'raw', text: v })
      break
    case 'data-urlencode':
      st.data.push({ kind: 'urlencode', text: v })
      break
    case 'json':
      st.jsonFlag = true
      st.data.push({ kind: 'raw', text: v })
      break
    case 'form':
      st.forms.push({ raw: v, literal: false })
      break
    case 'form-string':
      st.forms.push({ raw: v, literal: true })
      break
    case 'user':
      st.user = v
      break
    case 'oauth2-bearer':
      st.bearer = v
      break
    case 'cookie':
      st.cookieArgs.push(v)
      break
    case 'user-agent':
      st.userAgent = v
      break
    case 'referer':
      st.referer = v
      break
    case 'upload-file':
      st.uploadFile = v
      break
    case 'url':
      if (st.url) st.extraUrls.push(v)
      else st.url = v
      break
    case 'location':
    case 'location-trusted':
      st.follow = !negated
      break
    case 'max-redirs': {
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n)) warnings.push(`--max-redirs "${v}" is not a number; it was ignored.`)
      else if (n < 0) {
        // curl treats -1 as unlimited; the UI needs a real number.
        st.maxRedirs = 100
        warnings.push('--max-redirs -1 means unlimited in curl; it was capped at 100.')
      } else st.maxRedirs = n
      break
    }
    case 'insecure':
      st.insecure = !negated
      break
    case 'max-time': {
      const n = Number.parseFloat(v)
      if (Number.isFinite(n) && n >= 0) st.maxTime = n
      else warnings.push(`--max-time "${v}" is not a number; it was ignored.`)
      break
    }
    case 'proxy':
      st.proxy = v
      break
    case 'get':
      st.getFlag = true
      break
    case 'head':
      st.headFlag = true
      break
    case 'compressed':
      st.compressed = !negated
      break
    default: {
      const note = NOTED[name]
      if (note) warnings.push(`--${name} (${note}) has no equivalent here and was ignored.`)
      break
    }
  }
}

function parseHeader(raw: string): { name: string; value: string } {
  // `-H "Name;"` is curl's syntax for sending a header with an empty value.
  const semi = /^([^:]+);\s*$/.exec(raw)
  if (semi) return { name: semi[1].trim(), value: '' }
  const colon = raw.indexOf(':')
  if (colon < 0) return { name: raw.trim(), value: '' }
  return { name: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() }
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function build(st: State, warnings: string[]): ApiRequest {
  const request = newRequest()

  /* URL ------------------------------------------------------------ */

  let rawUrl = st.url.trim()
  if (!rawUrl) warnings.push('No URL was found in the command.')
  if (rawUrl && !hasScheme(rawUrl)) rawUrl = 'https://' + rawUrl

  let urlCreds: string | null = null
  const authority = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([\s\S]*)$/i.exec(rawUrl)
  if (authority) {
    const at = authority[2].lastIndexOf('@')
    if (at >= 0) {
      urlCreds = authority[2].slice(0, at)
      rawUrl = authority[1] + authority[2].slice(at + 1) + authority[3]
      warnings.push('Credentials embedded in the URL were moved to Basic auth.')
    }
  }

  const qi = rawUrl.indexOf('?')
  let base = rawUrl
  let query = ''
  if (qi >= 0) {
    base = rawUrl.slice(0, qi)
    query = rawUrl.slice(qi + 1)
    // A fragment is never sent, and keeping it would corrupt the last param.
    const frag = query.indexOf('#')
    if (frag >= 0) query = query.slice(0, frag)
  }
  request.url = base
  request.params = parseQuery(query)

  /* Headers, cookies, auth ----------------------------------------- */

  const headers = st.headers.slice()
  if (st.userAgent !== null && !findHeader(headers, 'user-agent')) {
    headers.push({ name: 'User-Agent', value: st.userAgent })
  }
  if (st.referer !== null && !findHeader(headers, 'referer')) {
    headers.push({ name: 'Referer', value: st.referer })
  }
  if (st.jsonFlag) {
    if (!findHeader(headers, 'content-type')) {
      headers.push({ name: 'Content-Type', value: 'application/json' })
    }
    if (!findHeader(headers, 'accept')) headers.push({ name: 'Accept', value: 'application/json' })
  }

  const cookies: KV[] = []
  for (const arg of st.cookieArgs) {
    if (!arg.includes('=')) {
      warnings.push(`-b "${arg}" names a cookie file; its contents were not imported.`)
      continue
    }
    cookies.push(...parseCookieString(arg, warnings))
  }

  let bearer = st.bearer
  const kept: Array<{ name: string; value: string }> = []
  for (const h of headers) {
    const lower = h.name.toLowerCase()
    if (lower === 'cookie') {
      // The UI owns cookies in their own tab.
      cookies.push(...parseCookieString(h.value, warnings))
      continue
    }
    if (lower === 'content-length') {
      warnings.push('Content-Length was dropped; it is recalculated on send.')
      continue
    }
    if (lower === 'authorization' && bearer === null && st.user === null && urlCreds === null) {
      const m = /^Bearer\s+(.+)$/i.exec(h.value)
      if (m) {
        bearer = m[1].trim()
        continue
      }
    }
    kept.push(h)
  }
  request.cookies = cookies

  const basicSource = st.user ?? urlCreds
  if (basicSource !== null) {
    const colon = basicSource.indexOf(':')
    request.auth.type = 'basic'
    request.auth.basic =
      colon < 0
        ? { username: decodeOnce(basicSource), password: '' }
        : {
            username: decodeOnce(basicSource.slice(0, colon)),
            password: decodeOnce(basicSource.slice(colon + 1)),
          }
    if (colon < 0) {
      warnings.push('-u was given without a password; curl would have prompted for one.')
    }
    if (bearer !== null) {
      warnings.push('Both -u and a bearer token were given; only the Basic credentials were kept.')
    }
  } else if (bearer !== null) {
    request.auth.type = 'bearer'
    request.auth.bearer = { token: bearer, scheme: 'Bearer' }
  }

  /* Body ----------------------------------------------------------- */

  const body = request.body
  const contentType = lastHeader(kept, 'content-type')

  if (st.forms.length) {
    if (st.data.length) warnings.push('The command mixes -F with -d; the -d data was dropped.')
    body.mode = 'multipart'
    for (const f of st.forms) {
      const field = parseFormField(f.raw, f.literal, warnings)
      if (field) body.multipart.push(field)
    }
    // We generate our own boundary, so a pasted one would not match the payload.
    for (const h of kept) {
      if (h.name.toLowerCase() === 'content-type' && /boundary=/i.test(h.value)) {
        h.value = h.value.replace(/\s*;\s*boundary=[^;]*/i, '')
        warnings.push('The multipart boundary was removed from Content-Type; it is generated on send.')
      }
    }
  } else if (st.uploadFile !== null) {
    body.mode = 'binary'
    body.binaryPath = st.uploadFile
    warnings.push(`-T references ${st.uploadFile}; the file is read from disk when the request runs.`)
  } else if (st.data.length) {
    const chunks: string[] = []
    const single = st.data.length === 1 ? st.data[0] : null
    let bodyFile: string | null = null

    for (const part of st.data) {
      if (part.kind === 'file') {
        if (part.text === '-') {
          warnings.push('The body was read from stdin (@-), which cannot be imported.')
        } else if (single !== null) {
          bodyFile = part.text
        } else {
          warnings.push(`The body references the file ${part.text}, which was not inlined.`)
        }
        continue
      }
      chunks.push(part.kind === 'urlencode' ? urlEncodeArg(part.text, warnings) : part.text)
    }

    if (bodyFile !== null) {
      body.mode = 'binary'
      body.binaryPath = bodyFile
      warnings.push(`The body is read from ${bodyFile}; the path was kept and the file is read on send.`)
    } else if (st.getFlag) {
      // -G turns the data into a query string instead of a body.
      request.params.push(...parseQuery(chunks.join('&')))
    } else {
      // curl joins repeated data flags with & rather than concatenating them.
      applyTextBody(request, chunks.join('&'), contentType, warnings)
      if (!contentType && body.mode === 'json') {
        kept.push({ name: 'Content-Type', value: 'application/json' })
      }
    }
  }

  request.headers = kept.map((h) => kv(h.name, h.value))

  /* Method --------------------------------------------------------- */

  if (st.method) request.method = st.method
  else if (st.headFlag) request.method = 'HEAD'
  else if (st.getFlag) request.method = 'GET'
  else if (st.uploadFile !== null) request.method = 'PUT'
  else if (body.mode !== 'none') request.method = 'POST'
  else request.method = 'GET'

  /* Settings ------------------------------------------------------- */

  // curl does not follow redirects unless asked, so this is always explicit.
  const settings: Partial<RequestSettings> = { followRedirects: st.follow }
  if (st.maxRedirs !== null) settings.maxRedirects = st.maxRedirs
  if (st.insecure) settings.verifyTls = false
  if (st.maxTime !== null) settings.timeoutMs = Math.round(st.maxTime * 1000)
  if (st.proxy) settings.proxy = hasScheme(st.proxy) ? st.proxy : 'http://' + st.proxy
  if (st.compressed) settings.decompress = true
  request.settings = settings

  request.name = deriveName(request.method, request.url)
  return request
}

function findHeader(
  headers: Array<{ name: string; value: string }>,
  lower: string,
): { name: string; value: string } | undefined {
  return headers.find((h) => h.name.toLowerCase() === lower)
}

function lastHeader(headers: Array<{ name: string; value: string }>, lower: string): string {
  let out = ''
  for (const h of headers) if (h.name.toLowerCase() === lower) out = h.value
  return out
}

function parseQuery(query: string): KV[] {
  const out: KV[] = []
  for (const seg of query.split('&')) {
    if (!seg) continue
    const eq = seg.indexOf('=')
    if (eq < 0) out.push(kv(decodeOnce(seg), ''))
    else out.push(kv(decodeOnce(seg.slice(0, eq)), decodeOnce(seg.slice(eq + 1))))
  }
  return out
}

function parseCookieString(raw: string, warnings: string[]): KV[] {
  const out: KV[] = []
  for (const seg of raw.split(';')) {
    const s = seg.trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq < 0) {
      warnings.push(`The cookie "${s}" has no value; it was imported with an empty one.`)
      out.push(kv(s, ''))
      continue
    }
    out.push(kv(s.slice(0, eq).trim(), s.slice(eq + 1)))
  }
  return out
}

/** --data-urlencode: curl splits on the first `=` or `@`, whichever comes first. */
function urlEncodeArg(arg: string, warnings: string[]): string {
  const sep = arg.search(/[=@]/)
  if (sep < 0) return encodeComponent(arg)
  const name = arg.slice(0, sep)
  const rest = arg.slice(sep + 1)
  if (arg[sep] === '@') {
    warnings.push(`--data-urlencode reads ${rest} from disk; that field was imported empty.`)
    return name ? name + '=' : ''
  }
  return name ? name + '=' + encodeComponent(rest) : encodeComponent(rest)
}

function applyTextBody(
  request: ApiRequest,
  text: string,
  contentType: string,
  warnings: string[],
): void {
  const body = request.body
  const ct = contentType.toLowerCase()
  body.text = text

  let mode: BodyMode
  if (ct) {
    if (ct.includes('json')) mode = 'json'
    else if (ct.includes('x-www-form-urlencoded')) mode = 'form-urlencoded'
    else if (ct.includes('xml')) mode = 'xml'
    else if (ct.includes('html')) mode = 'html'
    else if (ct.includes('javascript') || ct.includes('ecmascript')) mode = 'javascript'
    else mode = 'text'
  } else if (isJsonish(text) && parsesAsJson(text)) {
    mode = 'json'
  } else if (FORM_URLENCODED_RE.test(text)) {
    mode = 'form-urlencoded'
  } else {
    mode = 'text'
  }
  body.mode = mode

  if (mode === 'json') {
    // Only reachable with an explicit JSON content type; a sniffed body parses.
    if (text.trim() && !parsesAsJson(text)) {
      warnings.push('The body is declared as JSON but does not parse; it was imported verbatim.')
    } else {
      const pretty = prettyJson(text)
      if (pretty !== null) body.text = pretty
    }
  } else if (mode === 'form-urlencoded') {
    for (const seg of text.split('&')) {
      if (!seg) continue
      const eq = seg.indexOf('=')
      // A urlencoded body is the one place where `+` unambiguously means a space.
      if (eq < 0) body.form.push(kv(decodeOnce(seg, true), ''))
      else {
        body.form.push(kv(decodeOnce(seg.slice(0, eq), true), decodeOnce(seg.slice(eq + 1), true)))
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* -F parsing                                                          */
/* ------------------------------------------------------------------ */

/** Only a `;` that introduces a known option ends the value; the rest is data. */
const FORM_OPTION_RE = /;\s*(type|filename|headers|encoder)\s*=/i

function splitFormOptions(s: string): { main: string; opts: Array<[string, string]> } {
  const opts: Array<[string, string]> = []
  const first = FORM_OPTION_RE.exec(s)
  if (!first) return { main: s, opts }
  const main = s.slice(0, first.index)
  let rest = s.slice(first.index)
  while (rest.length > 0) {
    const m = FORM_OPTION_RE.exec(rest)
    if (!m || m.index !== 0) break
    const key = m[1].toLowerCase()
    let tail = rest.slice(m[0].length)
    let value: string
    if (tail.startsWith('"')) {
      const end = tail.indexOf('"', 1)
      value = end < 0 ? tail.slice(1) : tail.slice(1, end)
      tail = end < 0 ? '' : tail.slice(end + 1)
    } else {
      const next = FORM_OPTION_RE.exec(tail)
      const cut = next ? next.index : tail.length
      value = tail.slice(0, cut).trim()
      tail = tail.slice(cut)
    }
    opts.push([key, value])
    rest = tail
  }
  return { main, opts }
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s
}

function parseFormField(raw: string, literal: boolean, warnings: string[]): MultipartField | null {
  const eq = raw.indexOf('=')
  if (eq < 0) {
    warnings.push(`Skipped the malformed form field "${raw}"; it has no "=".`)
    return null
  }
  const key = raw.slice(0, eq)
  const rest = raw.slice(eq + 1)
  const field: MultipartField = { id: uid(), enabled: true, key, kind: 'text', value: '' }

  if (literal) {
    field.value = rest
    return field
  }

  const fromFile = rest.startsWith('@') || rest.startsWith('<')
  const { main, opts } = splitFormOptions(fromFile ? rest.slice(1) : rest)
  if (fromFile) {
    field.kind = 'file'
    field.filePath = unquote(main)
    if (rest.startsWith('<')) {
      warnings.push(
        `The form field "${key}" takes its value from ${field.filePath} (<); it became a file part.`,
      )
    }
  } else {
    field.value = main
  }

  for (const [name, value] of opts) {
    if (name === 'type') field.contentType = value
    else if (name === 'filename') field.fileName = value
    else warnings.push(`Ignored the ";${name}=" option on the form field "${key}".`)
  }
  return field
}

/* ------------------------------------------------------------------ */
/* Naming                                                              */
/* ------------------------------------------------------------------ */

function isMeaningfulSegment(s: string): boolean {
  if (!s) return false
  if (s.includes('{{') || /^[:{$]/.test(s)) return false
  if (/^v\d+(?:\.\d+)*$/i.test(s)) return false
  if (/^\d+$/.test(s)) return false
  if (/^[0-9a-f]{8,}$/i.test(s)) return false
  if (/^[0-9a-f-]{16,}$/i.test(s)) return false
  return /[a-z]/i.test(s)
}

function humanize(seg: string): string {
  const words = decodeOnce(seg)
    .replace(/\.(?:json|xml|html?|php|aspx?|jsp|do)$/i, '')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-+.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!words) return seg
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function deriveName(method: string, url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  const slash = withoutScheme.indexOf('/')
  const host = (slash < 0 ? withoutScheme : withoutScheme.slice(0, slash)).replace(/^[^@]*@/, '')
  const segments = slash < 0 ? [] : withoutScheme.slice(slash).split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    if (isMeaningfulSegment(segments[i])) return `${method} ${humanize(segments[i])}`
  }
  if (host) return `${method} ${host}`
  return `${method} request`
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

export function looksLikeCurl(input: string): boolean {
  const trimmed = stripPrompt(input)
  if (!trimmed) return false
  if (/^curl(?:\.exe)?(?:\s|$)/i.test(trimmed)) return true
  return /(?:^|\n)[ \t]*(?:[$>#][ \t]*)?curl(?:\.exe)?[ \t]/i.test(input)
}
