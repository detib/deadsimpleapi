/**
 * Generates build/icon.ico with no image dependencies.
 *
 * The mark is the app's signature: an oscilloscope pulse traced in amber on the
 * graphite chassis colour, matching the titlebar glyph.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../build/icon.ico')

const BG = [0x1a, 0x1d, 0x23]
const EDGE = [0x3a, 0x40, 0x4c]
const SIGNAL = [0xf0, 0xa0, 0x2a]

/** Pulse polyline in unit coordinates. */
const PULSE = [
  [0.13, 0.5],
  [0.31, 0.5],
  [0.4, 0.26],
  [0.55, 0.775],
  [0.645, 0.5],
  [0.87, 0.5],
]

const SS = 4 // supersampling factor

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectSdf(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r)
  const qy = Math.abs(py - h / 2) - (h / 2 - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

function renderRgba(size) {
  const n = size * SS
  const buf = Buffer.alloc(n * n * 4)

  const radius = n * 0.22
  const stroke = Math.max(n * 0.055, 1)
  const points = PULSE.map(([x, y]) => [x * n, y * n])

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const i = (y * n + x) * 4

      const d = roundedRectSdf(px, py, n, n, radius)
      if (d > 0) continue // outside the tile stays transparent

      // Border ring sits just inside the edge.
      const ring = d > -Math.max(n * 0.012, 1)
      const base = ring ? EDGE : BG
      buf[i] = base[0]
      buf[i + 1] = base[1]
      buf[i + 2] = base[2]
      buf[i + 3] = 255

      let best = Infinity
      for (let s = 0; s < points.length - 1; s++) {
        const dd = distToSegment(px, py, points[s][0], points[s][1], points[s + 1][0], points[s + 1][1])
        if (dd < best) best = dd
      }
      if (best <= stroke / 2) {
        buf[i] = SIGNAL[0]
        buf[i + 1] = SIGNAL[1]
        buf[i + 2] = SIGNAL[2]
        buf[i + 3] = 255
      }
    }
  }

  // Box downsample to the target size; this is where the antialiasing comes from.
  const out = Buffer.alloc(size * size * 4)
  const area = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4
          const alpha = buf[i + 3]
          r += buf[i] * alpha
          g += buf[i + 1] * alpha
          b += buf[i + 2] * alpha
          a += alpha
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
      }
      out[o + 3] = Math.round(a / area)
    }
  }
  return out
}

/* ---------------------------- PNG encoding ------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const off = y * (size * 4 + 1)
    raw[off] = 0
    rgba.copy(raw, off + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------------------- ICO container ------------------------ */

function buildIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(entries.length, 4)

  const dir = Buffer.alloc(16 * entries.length)
  let offset = header.length + dir.length

  entries.forEach((entry, i) => {
    const at = i * 16
    dir[at] = entry.size >= 256 ? 0 : entry.size
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size
    dir[at + 2] = 0
    dir[at + 3] = 0
    dir.writeUInt16LE(1, at + 4) // colour planes
    dir.writeUInt16LE(32, at + 6) // bits per pixel
    dir.writeUInt32BE(0, at + 8)
    dir.writeUInt32LE(entry.png.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const entries = SIZES.map((size) => ({ size, png: encodePng(renderRgba(size), size) }))

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, buildIco(entries))
console.log(`[icon] wrote ${OUT} (${SIZES.join(', ')}px)`)
