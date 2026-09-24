/**
 * Display helpers. Pure formatting - no React, no DOM, no Electron.
 */

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB', 'PB']

/** SI units, matching what browsers and curl report. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '0 B'
  const sign = n < 0 ? '-' : ''
  let value = Math.abs(n)
  let unit = 0
  const render = (): string =>
    unit === 0 ? String(Math.round(value)) : value >= 100 ? value.toFixed(0) : value.toFixed(1)
  // Steps on the *rendered* number, not the raw one: 999_999 rounds up to
  // "1000 kB" at one decimal, which has to become "1.0 MB".
  while (unit < BYTE_UNITS.length - 1 && Number(render()) >= 1000) {
    value /= 1000
    unit++
  }
  return `${sign}${render()} ${BYTE_UNITS[unit]}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  if (ms < 1) return '<1 ms'
  // Same rounding-boundary rule as formatBytes: 999.6 ms is "1.00 s", not
  // "1000 ms", and 59_999 ms is "1 m 00 s", not "60.00 s".
  const wholeMs = Math.round(ms)
  if (wholeMs < 1000) return `${wholeMs} ms`
  const asSeconds = Number((ms / 1000).toFixed(2))
  if (asSeconds < 60) return `${asSeconds.toFixed(2)} s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes} m ${String(seconds).padStart(2, '0')} s`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} m`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function formatRelativeTime(then: number, now: number): string {
  if (!Number.isFinite(then)) return ''
  const diff = now - then
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`
  const date = new Date(then)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  })
}

export function statusClass(
  status: number,
): 'info' | 'success' | 'redirect' | 'client-error' | 'server-error' {
  if (status >= 500) return 'server-error'
  if (status >= 400) return 'client-error'
  if (status >= 300) return 'redirect'
  if (status >= 200) return 'success'
  if (status >= 100) return 'info'
  // 0 means the transport never produced a status; render it as a failure.
  return 'server-error'
}

/** IANA HTTP status code registry. */
const STATUS_TEXT: Record<number, string | undefined> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  306: 'Unused',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  // Reserved by RFC 9110, but every client shows the RFC 2324 phrase.
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  510: 'Not Extended',
  511: 'Network Authentication Required',
}

const STATUS_FAMILY: Record<number, string | undefined> = {
  1: 'Informational',
  2: 'Success',
  3: 'Redirection',
  4: 'Client Error',
  5: 'Server Error',
}

export function statusText(status: number): string {
  const known = STATUS_TEXT[status]
  if (known) return known
  if (!Number.isFinite(status) || status < 100 || status > 599) return ''
  return STATUS_FAMILY[Math.floor(status / 100)] ?? ''
}

/**
 * Only the methods that components.css actually defines a colour for. TRACE,
 * QUERY and anything custom share the neutral `.m-other` treatment rather than
 * resolving to a class that does not exist.
 */
const STYLED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** Returns the CSS class itself (`m-get`), matching the `.m-*` rules in components.css. */
export function methodClass(method: string): string {
  const upper = method.trim().toUpperCase()
  return STYLED_METHODS.has(upper) ? `m-${upper.toLowerCase()}` : 'm-other'
}

export function prettyJson(text: string): string {
  const parsed = tryParse(text)
  return parsed === MISS ? text : JSON.stringify(parsed, null, 2)
}

export function minifyJson(text: string): string {
  const parsed = tryParse(text)
  return parsed === MISS ? text : JSON.stringify(parsed)
}

/** Distinguishes "parsed to undefined" from "did not parse". */
const MISS = Symbol('parse-miss')

function tryParse(text: string): unknown {
  if (!text.trim()) return MISS
  try {
    return JSON.parse(text) as unknown
  } catch {
    return MISS
  }
}

export function truncateMiddle(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '')
}

/** Non-overlapping, case-insensitive [start, end) ranges for search highlighting. */
export function highlightRanges(haystack: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (!haystack || !needle) return out
  let hay = haystack.toLowerCase()
  let pin = needle.toLowerCase()
  // Some locales change length when lowercased; offsets would then be wrong.
  if (hay.length !== haystack.length || pin.length !== needle.length) {
    hay = haystack
    pin = needle
  }
  let from = 0
  for (;;) {
    const i = hay.indexOf(pin, from)
    if (i < 0) return out
    out.push([i, i + pin.length])
    from = i + pin.length
  }
}
