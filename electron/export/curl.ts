/**
 * ApiRequest -> curl. The input is the resolved WireRequest, so the command a
 * user copies is byte-for-byte what Deadsimple would have put on the wire.
 */

import type { WireBody, WirePart, WireRequest } from '../../shared/types'

export type CurlPlatform = 'sh' | 'powershell' | 'cmd'

export interface CurlGenOptions {
  /** One flag per line with the platform's continuation character. Default true. */
  multiline?: boolean
  /** Quoting dialect. Default 'sh'. */
  platform?: CurlPlatform
  /** --request instead of -X, and so on. Default false. */
  longFlags?: boolean
  /** Re-indent a JSON body with 2 spaces. Default false: the bytes are copied as-is. */
  prettyBody?: boolean
}

const CONTINUATION: Record<CurlPlatform, string> = {
  sh: '\\',
  powershell: '`',
  cmd: '^',
}

/**
 * Characters that survive unquoted. `%` is left out for cmd (variable
 * expansion) and `@` for PowerShell (splatting), even though both are only
 * special in certain positions.
 */
const BARE: Record<CurlPlatform, RegExp> = {
  sh: /^[A-Za-z0-9_@%+=:,.\/-]+$/,
  powershell: /^[A-Za-z0-9_+=:,.\/-]+$/,
  cmd: /^[A-Za-z0-9_+=:,.\/-]+$/,
}

function quote(s: string, platform: CurlPlatform): string {
  if (s.length > 0 && BARE[platform].test(s)) return s
  switch (platform) {
    case 'powershell':
      // Single quotes are literal in PowerShell; '' is the only escape needed.
      return `'${s.split("'").join("''")}'`
    case 'cmd':
      // The C runtime unescapes \" and \\, so backslashes that run into a quote
      // (or the closing quote) have to be doubled first.
      return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
    default:
      // sh cannot escape a quote inside single quotes, so close, insert, reopen.
      return `'${s.split("'").join(`'"'"'`)}'`
  }
}

/** 60000 -> "60", 1500 -> "1.5". */
function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(3)))
}

function reserializeJson(text: string, indent: number): string | null {
  // Re-serialising an oversized integer literal would silently change the body.
  if (/\d{16,}/.test(text)) return null
  try {
    const value: unknown = JSON.parse(text)
    return JSON.stringify(value, null, indent)
  } catch {
    return null
  }
}

function formArgument(part: WirePart): string {
  let out =
    part.kind === 'file' ? `${part.name}=@${part.filePath ?? ''}` : `${part.name}=${part.value}`
  if (part.kind === 'file' && part.fileName) out += `;filename=${part.fileName}`
  if (part.contentType) out += `;type=${part.contentType}`
  return out
}

function bodyFlags(
  body: WireBody,
  platform: CurlPlatform,
  opts: CurlGenOptions,
  flag: (short: string, long: string) => string,
  q: (s: string) => string,
): string[] {
  switch (body.kind) {
    case 'text': {
      let text = body.text
      if (opts.prettyBody) text = reserializeJson(text, 2) ?? text
      // cmd cannot carry a newline inside a quoted argument at all.
      if (platform === 'cmd' && text.includes('\n')) text = reserializeJson(text, 0) ?? text
      // -d would strip newlines and re-interpret @, so always --data-raw.
      return [`--data-raw ${q(text)}`]
    }
    case 'file':
      return [`--data-binary ${q('@' + body.path)}`]
    case 'multipart':
      return body.parts.map((p) => `${flag('-F', '--form')} ${q(formArgument(p))}`)
    case 'none':
      return []
  }
}

export function toCurl(req: WireRequest, opts: CurlGenOptions = {}): string {
  const platform = opts.platform ?? 'sh'
  const multiline = opts.multiline ?? true
  const q = (s: string): string => quote(s, platform)
  const flag = (short: string, long: string): string => (opts.longFlags ? long : short)

  // `curl` is an alias for Invoke-WebRequest in Windows PowerShell 5.1.
  const binary = platform === 'powershell' ? 'curl.exe' : 'curl'
  const parts: string[] = [`${binary} ${q(req.url)}`]

  const method = req.method || 'GET'
  if (method.toUpperCase() !== 'GET' || req.body.kind !== 'none') {
    parts.push(`${flag('-X', '--request')} ${q(method)}`)
  }

  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase()
    // curl derives both of these from the request it builds.
    if (lower === 'content-length' || lower === 'host') continue
    parts.push(`${flag('-H', '--header')} ${q(`${name}: ${value}`)}`)
  }

  parts.push(...bodyFlags(req.body, platform, opts, flag, q))

  const s = req.settings
  if (s.followRedirects) {
    parts.push(flag('-L', '--location'))
    if (s.maxRedirects !== 10) parts.push(`--max-redirs ${Math.max(0, Math.floor(s.maxRedirects))}`)
  }
  if (!s.verifyTls) parts.push(flag('-k', '--insecure'))
  if (s.timeoutMs > 0) parts.push(`${flag('-m', '--max-time')} ${seconds(s.timeoutMs)}`)
  if (s.proxy) parts.push(`${flag('-x', '--proxy')} ${q(s.proxy)}`)
  if (s.decompress) parts.push('--compressed')

  return multiline ? parts.join(` ${CONTINUATION[platform]}\n  `) : parts.join(' ')
}
