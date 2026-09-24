import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import type { WireBody, WirePart } from '../../shared/types'

/**
 * Turns a resolved WireBody into something writable to a socket: either a
 * Buffer (small, fully known up front) or a Readable (files, multipart), plus
 * the exact byte count so the engine can send Content-Length over chunked.
 */
export interface PreparedBody {
  /** Exactly one of stream/buffer is non-null; both null means no body at all. */
  stream: Readable | null
  buffer: Buffer | null
  /** undefined asks for chunked transfer-encoding. */
  contentLength: number | undefined
  /** Set only when this body owns the type; see prepareBody for the multipart rule. */
  contentType: string | undefined
}

/* ------------------------------------------------------------------ */
/* Extension -> MIME                                                   */
/* ------------------------------------------------------------------ */

// A Map, not an object literal: an object lookup for a name like "dump.constructor"
// or "x.__proto__" returns an inherited value instead of undefined, which would
// put a function or an object where a media type is expected.
const MIME_BY_EXT = new Map<string, string>([
  ['json', 'application/json'],
  ['ndjson', 'application/x-ndjson'],
  ['xml', 'application/xml'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['css', 'text/css'],
  ['js', 'text/javascript'],
  ['mjs', 'text/javascript'],
  ['txt', 'text/plain'],
  ['md', 'text/markdown'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['yaml', 'application/yaml'],
  ['yml', 'application/yaml'],
  ['pdf', 'application/pdf'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
  ['bmp', 'image/bmp'],
  ['zip', 'application/zip'],
  ['gz', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['woff2', 'font/woff2'],
  ['bin', 'application/octet-stream'],
])

export const DEFAULT_BINARY_TYPE = 'application/octet-stream'

/** Best-effort MIME for a path or bare filename. undefined when unrecognised. */
export function guessContentType(pathOrName: string): string | undefined {
  const ext = extname(pathOrName).slice(1).toLowerCase()
  if (!ext) return undefined
  return MIME_BY_EXT.get(ext)
}

/* ------------------------------------------------------------------ */
/* Multipart encoding                                                  */
/* ------------------------------------------------------------------ */

const CRLF = '\r\n'

function newBoundary(): string {
  return '----DeadsimpleBoundary' + randomBytes(12).toString('hex')
}

/**
 * RFC 7578 leaves quoting underspecified; browsers drop CR/LF outright and
 * percent-escape a literal quote rather than backslash-escaping it.
 */
function escapeParam(value: string): string {
  return value.replace(/[\r\n]/g, '').replace(/"/g, '%22')
}

/**
 * A part's Content-Type is free text typed by the user. A CR/LF inside it would
 * forge extra part headers (or an early blank line) and corrupt the framing,
 * while the precomputed Content-Length stayed technically correct.
 */
function sanitizeMediaType(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]/g, '').trim()
}

/** A literal run of bytes, or a file to splice in at this position. */
type Segment =
  | { kind: 'bytes'; data: Buffer }
  | { kind: 'file'; path: string; size: number }

async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path)
    if (!st.isFile()) throw new Error('not a regular file')
    return st.size
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot read file: ${path} (${reason})`)
  }
}

function partHeader(
  boundary: string,
  name: string,
  filename: string | null,
  type: string | undefined,
): Buffer {
  let head = `--${boundary}${CRLF}`
  head += `Content-Disposition: form-data; name="${escapeParam(name)}"`
  if (filename !== null) head += `; filename="${escapeParam(filename)}"`
  head += CRLF
  if (type) head += `Content-Type: ${type}${CRLF}`
  head += CRLF
  return Buffer.from(head, 'utf8')
}

/** The renderer has already dropped disabled fields, so every part is encoded. */
async function multipartSegments(parts: WirePart[], boundary: string): Promise<Segment[]> {
  const segments: Segment[] = []
  const tail = Buffer.from(CRLF, 'utf8')

  for (const part of parts) {
    if (part.kind === 'file') {
      const path = part.filePath ?? ''
      if (!path) throw new Error(`Multipart field "${part.name}" has no file selected`)
      const size = await fileSize(path)
      const filename = part.fileName || basename(path)
      const type =
        sanitizeMediaType(part.contentType) || guessContentType(path) || DEFAULT_BINARY_TYPE
      segments.push({ kind: 'bytes', data: partHeader(boundary, part.name, filename, type) })
      segments.push({ kind: 'file', path, size })
      segments.push({ kind: 'bytes', data: tail })
    } else {
      const head = partHeader(boundary, part.name, null, sanitizeMediaType(part.contentType))
      segments.push({
        kind: 'bytes',
        data: Buffer.concat([head, Buffer.from(part.value, 'utf8'), tail]),
      })
    }
  }

  segments.push({ kind: 'bytes', data: Buffer.from(`--${boundary}--${CRLF}`, 'utf8') })
  return segments
}

function segmentsLength(segments: Segment[]): number {
  let total = 0
  for (const seg of segments) total += seg.kind === 'bytes' ? seg.data.byteLength : seg.size
  return total
}

function segmentsStream(segments: Segment[]): Readable {
  async function* pump(): AsyncGenerator<Buffer> {
    for (const seg of segments) {
      if (seg.kind === 'bytes') {
        yield seg.data
        continue
      }
      // Streamed, never buffered: an upload can be far larger than memory.
      //
      // Content-Length was already committed from stat(), so a file that has
      // changed on disk since then must still produce exactly seg.size bytes.
      // Overshooting makes the client throw ERR_HTTP_CONTENT_LENGTH_MISMATCH,
      // and undershooting leaves the server waiting for bytes that never come
      // (a request that never settles when the timeout is disabled). Growth is
      // clamped, the way curl does it; a file that shrank cannot be repaired,
      // so it fails with a message naming the path.
      if (seg.size === 0) continue
      const rs = createReadStream(seg.path)
      let sent = 0
      try {
        for await (const chunk of rs as AsyncIterable<Buffer>) {
          if (chunk.byteLength === 0) continue
          const room = seg.size - sent
          if (chunk.byteLength >= room) {
            sent = seg.size
            yield chunk.subarray(0, room)
            break
          }
          sent += chunk.byteLength
          yield chunk
        }
      } finally {
        rs.destroy()
      }
      if (sent < seg.size) throw new Error(`File shrank while being sent: ${seg.path}`)
    }
  }
  // objectMode off so http.ClientRequest receives a plain byte stream.
  return Readable.from(pump(), { objectMode: false })
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * `callerContentType` is whatever the request's own headers already say. A body
 * reports a contentType only when it genuinely owns it, so the engine never has
 * to guess whether it may overwrite a header the user typed.
 *
 * Multipart is the one exception: its contentType MUST override any
 * caller-supplied Content-Type, because the boundary is generated here and a
 * hand-written `multipart/form-data; boundary=...` would name a boundary that
 * appears nowhere in the payload.
 */
export async function prepareBody(
  body: WireBody,
  callerContentType: string | undefined,
): Promise<PreparedBody> {
  switch (body.kind) {
    case 'none':
      return { stream: null, buffer: null, contentLength: 0, contentType: undefined }

    case 'text': {
      // Raw bodies get their Content-Type from the editor's mode, set upstream.
      const buffer = Buffer.from(body.text, 'utf8')
      return { stream: null, buffer, contentLength: buffer.byteLength, contentType: undefined }
    }

    case 'file': {
      if (!body.path) throw new Error('No file selected for the request body')
      const size = await fileSize(body.path)
      return {
        // Not a bare createReadStream: this wrapper pins the payload to the
        // size Content-Length was computed from. See segmentsStream.
        stream: segmentsStream([{ kind: 'file', path: body.path, size }]),
        buffer: null,
        contentLength: size,
        contentType: callerContentType
          ? undefined
          : guessContentType(body.path) ?? DEFAULT_BINARY_TYPE,
      }
    }

    case 'multipart': {
      const boundary = newBoundary()
      const segments = await multipartSegments(body.parts, boundary)
      return {
        stream: segmentsStream(segments),
        buffer: null,
        contentLength: segmentsLength(segments),
        contentType: `multipart/form-data; boundary=${boundary}`,
      }
    }

    default:
      // Unreachable for a well-formed WireBody, but a re-fired history snapshot
      // or an imported collection can carry a kind this build does not know.
      // Sending no body beats resolving to undefined and crashing the engine.
      return { stream: null, buffer: null, contentLength: 0, contentType: undefined }
  }
}
