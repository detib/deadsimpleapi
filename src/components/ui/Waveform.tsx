import { useMemo, useState } from 'react'

import type { Timing } from '../../../shared/types'
import { formatDuration } from '../../lib/format'

/**
 * The app's signature element: a latency trace.
 *
 * Every response draws its own timing breakdown as one segmented bar, sized
 * proportionally by phase. The same encoding repeats at small size in the
 * history list, so a slow call is recognisable before you read a single number.
 */

const PHASES = [
  { key: 'dns', label: 'DNS lookup' },
  { key: 'tcp', label: 'TCP connect' },
  { key: 'tls', label: 'TLS handshake' },
  { key: 'wait', label: 'Waiting (TTFB)' },
  { key: 'download', label: 'Download' },
] as const

export interface WaveformProps {
  timing: Timing
  size?: 'sm' | 'lg'
  /** Renders a phase legend with millisecond values beneath the bar. */
  legend?: boolean
  className?: string
}

export function Waveform({ timing, size = 'sm', legend = false, className }: WaveformProps) {
  const [hover, setHover] = useState<string | null>(null)

  const segments = useMemo(() => {
    const measured: Array<{ key: string; label: string; ms: number }> = PHASES.map((phase) => ({
      key: phase.key as string,
      label: phase.label as string,
      ms: typeof timing[phase.key] === 'number' ? (timing[phase.key] as number) : 0,
    })).filter((phase) => phase.ms > 0)

    const accounted = measured.reduce((sum, phase) => sum + phase.ms, 0)
    // Anything the phase marks did not capture (proxying, redirects, queueing)
    // is real time the user waited, so it gets its own segment rather than
    // being silently dropped.
    const rest = Math.max(0, timing.total - accounted)
    if (rest > 0.5) {
      measured.push({ key: 'other', label: 'Other', ms: rest })
    }
    return measured
  }, [timing])

  const total = segments.reduce((sum, s) => sum + s.ms, 0) || 1

  return (
    <div className={`waveform-wrap${className ? ` ${className}` : ''}`}>
      <div
        className={`waveform${size === 'lg' ? ' waveform-lg' : ''}`}
        role="img"
        aria-label={`Total ${formatDuration(timing.total)}: ${segments
          .map((s) => `${s.label} ${formatDuration(s.ms)}`)
          .join(', ')}`}
      >
        {segments.map((seg) => (
          <div
            key={seg.key}
            className={`waveform-seg${hover === seg.key ? ' is-hover' : ''}`}
            data-phase={seg.key}
            style={{ flexGrow: seg.ms / total }}
            onMouseEnter={() => setHover(seg.key)}
            onMouseLeave={() => setHover(null)}
            title={`${seg.label} — ${formatDuration(seg.ms)}`}
          />
        ))}
      </div>

      {legend && (
        <ul className="waveform-legend">
          {segments.map((seg) => (
            <li
              key={seg.key}
              className={hover === seg.key ? 'is-hover' : undefined}
              onMouseEnter={() => setHover(seg.key)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="waveform-dot" data-phase={seg.key} />
              <span className="waveform-label">{seg.label}</span>
              <span className="waveform-value mono">{formatDuration(seg.ms)}</span>
            </li>
          ))}
          <li className="waveform-total">
            <span className="waveform-dot is-blank" />
            <span className="waveform-label">Total</span>
            <span className="waveform-value mono">{formatDuration(timing.total)}</span>
          </li>
        </ul>
      )}
    </div>
  )
}
