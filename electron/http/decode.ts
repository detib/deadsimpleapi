import { Buffer } from 'node:buffer'
import { Transform, type TransformCallback } from 'node:stream'
import * as zlib from 'node:zlib'

/**
 * Content-Encoding and charset handling. Everything here is deliberately
 * forgiving: a body we cannot decompress is still worth showing as raw bytes,
 * and a body in an encoding we cannot name is still worth showing as UTF-8.
 */

/** zstd support landed in Node 22.15; an older Electron runtime lacks it. */
const HAS_ZSTD = 'createZstdDecompress' in zlib && typeof zlib.createZstdDecompress === 'function'

/**
 * Plenty of servers close the connection without writing the final block. The
 * default Z_FINISH makes zlib throw on those; Z_SYNC_FLUSH keeps what arrived.
 */
const LENIENT: zlib.ZlibOptions = { finishFlush: zlib.constants.Z_SYNC_FLUSH }

/**
 * Same leniency for zstd. On a runtime without zstd the constant is undefined,
 * which zlib reads as "use the default" - and we never build a decompressor
 * there anyway.
 */
const ZSTD_LENIENT: zlib.ZstdOptions = { finishFlush: zlib.constants.ZSTD_e_flush }

function brotliOptions(): zlib.BrotliOptions {
  const params: Record<number, number> = {}
  const largeWindow = zlib.constants.BROTLI_DECODER_PARAM_LARGE_WINDOW
  if (typeof largeWindow === 'number') params[largeWindow] = 1
  return {
    params,
    // Same leniency as Z_SYNC_FLUSH: it is BROTLI_OPERATION_FINISH that turns
    // a truncated stream into an "unexpected end of file" error.
    finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH,
  }
}

/** Lowercased codings, outermost last, with the no-op ones dropped. */
function parseEncodings(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0 && token !== 'identity')
}

type DecoderFactory = () => Transform

function decoderFor(token: string): DecoderFactory | null {
  switch (token) {
    case 'gzip':
    case 'x-gzip':
    // LZW (.Z) has no decoder in zlib. The few servers still emitting these
    // labels send gzip, so treat them the same rather than refusing outright.
    case 'compress':
    case 'x-compress':
      return () => zlib.createGunzip(LENIENT)
    case 'deflate':
      return inflateDecoder
    case 'br':
      return () => zlib.createBrotliDecompress(brotliOptions())
    case 'zstd':
      return HAS_ZSTD ? () => zlib.createZstdDecompress(ZSTD_LENIENT) : null
    default:
      return null
  }
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

type StageFactory = (first: Buffer) => Transform[]

/**
 * Presents a pipeline of zlib transforms as a single Transform, so the caller
 * only ever has one thing to pipe into and destroy. The stages may be chosen
 * from the first bytes of the stream, which is what deflate needs.
 */
class DecodeChain extends Transform {
  private stages: Transform[] = []
  private head: Transform | null = null
  private tail: Transform | null = null
  private held: Buffer[] = []
  private heldLen = 0
  private flushCb: TransformCallback | null = null
  private innerDone = false

  /** `sniffBytes` is how much input to hold back before calling the factory. */
  constructor(
    private readonly factory: StageFactory,
    private readonly sniffBytes: number = 0,
  ) {
    super()
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const head = this.head
    if (head) {
      this.writeInner(head, chunk, cb)
      return
    }
    this.held.push(chunk)
    this.heldLen += chunk.length
    if (this.heldLen < this.sniffBytes) {
      cb()
      return
    }
    const first = this.takeHeld()
    this.writeInner(this.begin(first), first, cb)
  }

  override _flush(cb: TransformCallback): void {
    let head = this.head
    if (!head) {
      // Fewer bytes arrived than we wanted to sniff; decide on what we have.
      const first = this.takeHeld()
      head = this.begin(first)
      if (first.length > 0) head.write(first)
    }
    if (this.innerDone) {
      cb()
      return
    }
    this.flushCb = cb
    head.end()
  }

  override _read(size: number): void {
    // Our readable side drained, so let the tail push again.
    this.tail?.resume()
    super._read(size)
  }

  override _destroy(err: Error | null, cb: (e: Error | null) => void): void {
    this.innerDone = true
    this.flushCb = null
    for (const stage of this.stages) stage.destroy()
    cb(err)
  }

  private takeHeld(): Buffer {
    const first = this.held.length === 1 ? this.held[0] : Buffer.concat(this.held)
    this.held = []
    this.heldLen = 0
    return first
  }

  private begin(first: Buffer): Transform {
    const stages = this.factory(first)
    this.stages = stages
    const head = stages[0]
    const tail = stages[stages.length - 1]
    for (let i = 0; i < stages.length - 1; i++) stages[i].pipe(stages[i + 1])
    tail.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) tail.pause()
    })
    tail.on('end', () => this.innerFinished())
    // A stage destroyed without ending would otherwise strand _flush forever.
    tail.on('close', () => this.innerFinished())
    for (const stage of stages) stage.on('error', (err: Error) => this.destroy(err))
    this.head = head
    this.tail = tail
    return head
  }

  private innerFinished(): void {
    if (this.innerDone) return
    this.innerDone = true
    const cb = this.flushCb
    this.flushCb = null
    if (cb) cb()
  }

  private writeInner(head: Transform, chunk: Buffer, cb: TransformCallback): void {
    if (head.write(chunk)) cb()
    else head.once('drain', cb)
  }
}

/**
 * `Content-Encoding: deflate` is specified as the zlib wrapper (RFC 9110 8.4.1)
 * but a stubborn minority of servers send a bare deflate stream. Two bytes tell
 * them apart: CM must be 8 and the 16-bit header must be a multiple of 31.
 */
function inflateDecoder(): Transform {
  return new DecodeChain(
    (first) =>
      isZlibHeader(first) ? [zlib.createInflate(LENIENT)] : [zlib.createInflateRaw(LENIENT)],
    2,
  )
}

function isZlibHeader(bytes: Buffer): boolean {
  if (bytes.length < 2) return false
  const cmf = bytes[0]
  const flg = bytes[1]
  return (cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0
}

/**
 * A Transform that undoes `contentEncoding`, or null when there is nothing to
 * undo and the caller should pass the bytes through untouched. An unknown
 * coding anywhere in the list also yields null: half-decoded bytes would be
 * less useful than the original ones.
 */
export function createDecodeStream(contentEncoding: string | undefined): Transform | null {
  const tokens = parseEncodings(contentEncoding)
  if (tokens.length === 0) return null

  const factories: DecoderFactory[] = []
  for (const token of tokens) {
    const make = decoderFor(token)
    if (!make) return null
    factories.push(make)
  }
  // The header lists codings in the order they were applied; undo them backwards.
  factories.reverse()

  if (factories.length === 1) return factories[0]()
  return new DecodeChain(() => factories.map((make) => make()))
}

/* ------------------------------------------------------------------ */
/* One-shot                                                            */
/* ------------------------------------------------------------------ */

function oneShot(run: (cb: zlib.CompressCallback) => void): Promise<Buffer | null> {
  return new Promise((resolve) => {
    try {
      run((err, result) => resolve(err ? null : result))
    } catch {
      resolve(null)
    }
  })
}

function decodeOne(buf: Buffer, token: string): Promise<Buffer | null> {
  switch (token) {
    case 'gzip':
    case 'x-gzip':
    case 'compress':
    case 'x-compress':
      return oneShot((cb) => zlib.gunzip(buf, LENIENT, cb))
    case 'deflate':
      return inflateOne(buf)
    case 'br':
      return oneShot((cb) => zlib.brotliDecompress(buf, brotliOptions(), cb))
    case 'zstd':
      return HAS_ZSTD
        ? oneShot((cb) => zlib.zstdDecompress(buf, ZSTD_LENIENT, cb))
        : Promise.resolve(null)
    default:
      return Promise.resolve(null)
  }
}

async function inflateOne(buf: Buffer): Promise<Buffer | null> {
  if (isZlibHeader(buf)) {
    const wrapped = await oneShot((cb) => zlib.inflate(buf, LENIENT, cb))
    if (wrapped) return wrapped
  }
  return oneShot((cb) => zlib.inflateRaw(buf, LENIENT, cb))
}

/**
 * Buffered equivalent of createDecodeStream. Resolves with the input untouched
 * when the coding is unknown or the payload is corrupt - a body that will not
 * decompress must still be inspectable.
 */
export async function decodeBuffer(
  buf: Buffer,
  contentEncoding: string | undefined,
): Promise<Buffer> {
  const tokens = parseEncodings(contentEncoding)
  if (tokens.length === 0) return buf

  let out = buf
  for (let i = tokens.length - 1; i >= 0; i--) {
    const next = await decodeOne(out, tokens[i])
    if (!next) return buf
    out = next
  }
  return out
}

/** What we advertise in Accept-Encoding. */
export function acceptEncodingValue(): string {
  return HAS_ZSTD ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br'
}

/* ------------------------------------------------------------------ */
/* Charset                                                             */
/* ------------------------------------------------------------------ */

function normalizeLabel(raw: string): string {
  const label = raw.trim().replace(/^["']|["']$/g, '').trim().toLowerCase()
  switch (label) {
    case 'utf8':
    case 'utf-8':
      return 'utf-8'
    case 'latin1':
    case 'binary':
    case 'iso-8859-1':
    case 'iso8859-1':
    case 'iso_8859-1':
      return 'latin1'
    case 'utf16':
    case 'utf-16':
    case 'utf16le':
    case 'utf-16le':
      return 'utf-16le'
    case 'utf16be':
    case 'utf-16be':
      return 'utf-16be'
    default:
      return label
  }
}

function charsetFromHeader(contentType: string | undefined): string {
  if (!contentType) return ''
  const m = /;\s*charset\s*=\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(contentType)
  return m ? normalizeLabel(m[1]) : ''
}

function charsetFromBom(body: Uint8Array): string {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) return 'utf-8'
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf-16le'
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf-16be'
  return ''
}

const MARKUP_SNIFF_BYTES = 2048

const XML_ENCODING = /<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/i
/** Matches both `<meta charset=x>` and the http-equiv Content-Type form. */
const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i

function charsetFromMarkup(head: string): string {
  const xml = XML_ENCODING.exec(head)
  if (xml) return normalizeLabel(xml[1])
  const meta = META_CHARSET.exec(head)
  if (meta) return normalizeLabel(meta[1])
  return ''
}

/**
 * Best guess at a body's encoding: the header wins, then a BOM, then the
 * document's own declaration, then UTF-8.
 */
export function detectCharset(contentType: string | undefined, body: Uint8Array): string {
  const declared = charsetFromHeader(contentType)
  const bom = charsetFromBom(body)
  if (declared) {
    // `charset=utf-16` names no endianness and is routinely sent big-endian;
    // when a BOM disagrees with the header it is the BOM that is right.
    const utf16 = declared === 'utf-16le' || declared === 'utf-16be'
    if (utf16 && (bom === 'utf-16le' || bom === 'utf-16be')) return bom
    return declared
  }
  if (bom) return bom

  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase()
  const head = Buffer.from(body.subarray(0, MARKUP_SNIFF_BYTES)).toString('latin1')
  // With no usable Content-Type, let the bytes decide whether this is markup.
  const markup = mime ? mime.includes('xml') || mime.includes('html') : /^\s*</.test(head)
  if (markup) {
    const sniffed = charsetFromMarkup(head)
    if (sniffed) return sniffed
  }
  return 'utf-8'
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Never throws: an unsupported label degrades to UTF-8 rather than failing. */
export function decodeText(body: Uint8Array, charset: string): string {
  const label = normalizeLabel(charset) || 'utf-8'
  try {
    return stripBom(new TextDecoder(label).decode(body))
  } catch {
    // A Node build without full ICU only knows utf-8 and utf-16le.
  }
  try {
    if (label === 'utf-16be' || label === 'utf-16le') {
      const buf = Buffer.from(body)
      if (label === 'utf-16be') buf.swap16()
      return stripBom(buf.toString('utf16le'))
    }
    if (label === 'latin1') return stripBom(Buffer.from(body).toString('latin1'))
  } catch {
    // swap16 rejects an odd byte count; fall through to UTF-8.
  }
  return stripBom(Buffer.from(body).toString('utf8'))
}
