/**
 * Renderer-side decoding of response bytes. The main process hands us raw
 * (already un-gzipped) bytes; turning those into something displayable is a
 * presentation concern and belongs here.
 */

const BOMS: Array<{ bytes: number[]; charset: string }> = [
  { bytes: [0xef, 0xbb, 0xbf], charset: 'utf-8' },
  { bytes: [0xff, 0xfe], charset: 'utf-16le' },
  { bytes: [0xfe, 0xff], charset: 'utf-16be' },
]

export function detectCharset(contentType: string | undefined, body: Uint8Array): string {
  const declared = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')?.[1]
  if (declared) return normalizeCharset(declared)

  for (const bom of BOMS) {
    if (bom.bytes.every((b, i) => body[i] === b)) return bom.charset
  }

  // XML and HTML declare their own encoding in the first few hundred bytes.
  if (/xml|html/i.test(contentType ?? '') || body.length === 0) {
    const head = new TextDecoder('latin1').decode(body.subarray(0, 2048))
    const meta =
      /<\?xml[^>]*encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1] ??
      /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]
    if (meta) return normalizeCharset(meta)
  }

  return 'utf-8'
}

function normalizeCharset(label: string): string {
  const s = label.trim().toLowerCase()
  if (s === 'utf8') return 'utf-8'
  if (s === 'iso-8859-1' || s === 'latin-1') return 'latin1'
  if (s === 'utf16' || s === 'utf-16') return 'utf-16le'
  return s
}

export function decodeText(body: Uint8Array, contentType?: string): string {
  const charset = detectCharset(contentType, body)
  let text: string
  try {
    text = new TextDecoder(charset, { fatal: false }).decode(body)
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(body)
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Heuristic binary check: a NUL byte in the first 8KB, or a high proportion of
 * bytes outside the printable/UTF-8 range. Text formats never do either.
 */
export function looksBinary(body: Uint8Array): boolean {
  const limit = Math.min(body.length, 8192)
  if (limit === 0) return false
  let suspicious = 0
  for (let i = 0; i < limit; i++) {
    const b = body[i]
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious++
  }
  return suspicious / limit > 0.1
}

export type BodyKind =
  | 'json'
  | 'xml'
  | 'html'
  | 'javascript'
  | 'css'
  | 'csv'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'binary'
  | 'event-stream'
  | 'empty'

/** Classifies a response for the viewer, trusting Content-Type then sniffing. */
export function classifyBody(contentType: string | undefined, body: Uint8Array): BodyKind {
  if (body.length === 0) return 'empty'
  const ct = (contentType ?? '').toLowerCase().split(';')[0].trim()

  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct.startsWith('video/')) return 'video'
  if (ct === 'application/pdf') return 'pdf'
  if (ct === 'text/event-stream') return 'event-stream'
  if (ct.includes('json') || ct.endsWith('+json')) return 'json'
  if (ct.includes('xml') || ct.endsWith('+xml')) return 'xml'
  if (ct === 'text/html' || ct === 'application/xhtml+xml') return 'html'
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'javascript'
  if (ct === 'text/css') return 'css'
  if (ct === 'text/csv') return 'csv'
  if (ct.startsWith('text/')) return 'text'

  if (looksBinary(body)) return 'binary'

  // No usable Content-Type: sniff the first non-whitespace character.
  const head = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 512)).trimStart()
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  if (head.startsWith('<?xml')) return 'xml'
  if (/^<(!doctype html|html)/i.test(head)) return 'html'
  return 'text'
}

/** Data URL for inline preview of an image or PDF response. */
export function toDataUrl(body: Uint8Array, contentType: string | undefined): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < body.length; i += chunk) {
    binary += String.fromCharCode(...body.subarray(i, i + chunk))
  }
  const mime = (contentType ?? 'application/octet-stream').split(';')[0].trim()
  return `data:${mime};base64,${btoa(binary)}`
}

/** Filename suggestion for "save response as", derived from the URL and type. */
export function suggestFileName(url: string, contentType: string | undefined): string {
  let base = 'response'
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    if (segments.length) base = segments[segments.length - 1].replace(/[^\w.-]/g, '_')
  } catch {
    /* keep the default */
  }
  if (/\.\w{1,6}$/.test(base)) return base

  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase()
  const ext =
    (
      {
        'application/json': 'json',
        'application/xml': 'xml',
        'text/xml': 'xml',
        'text/html': 'html',
        'text/plain': 'txt',
        'text/csv': 'csv',
        'application/pdf': 'pdf',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'application/zip': 'zip',
        'application/javascript': 'js',
      } as Record<string, string>
    )[ct] ?? 'bin'
  return `${base}.${ext}`
}
