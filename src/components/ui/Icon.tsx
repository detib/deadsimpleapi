/**
 * A single inline SVG sprite. Every glyph is drawn on a 16x16 grid with a
 * 1.4 stroke so the set reads as one hand at the sizes this app uses.
 */

export type IconName =
  | 'chevron-right' | 'chevron-down' | 'chevron-up' | 'chevron-left'
  | 'folder' | 'folder-open' | 'file' | 'plus' | 'minus'
  | 'search' | 'close' | 'check' | 'dots' | 'dots-v'
  | 'copy' | 'trash' | 'edit' | 'save' | 'send' | 'stop'
  | 'alert' | 'info' | 'clock' | 'link' | 'external'
  | 'upload' | 'download' | 'share' | 'refresh' | 'history'
  | 'table' | 'braces' | 'list' | 'eye' | 'eye-off' | 'filter'
  | 'sort-asc' | 'sort-desc' | 'settings' | 'cookie' | 'terminal'
  | 'key' | 'lock' | 'variable' | 'grip' | 'expand' | 'collapse'
  | 'wrap' | 'columns' | 'pin' | 'play' | 'fullscreen' | 'fullscreen-exit'
  | 'panel-left'

const PATHS: Record<IconName, string> = {
  'chevron-right': 'M6 3.5L10.5 8L6 12.5',
  'chevron-down': 'M3.5 6L8 10.5L12.5 6',
  'chevron-up': 'M3.5 10L8 5.5L12.5 10',
  'chevron-left': 'M10 3.5L5.5 8L10 12.5',
  folder: 'M2 4.5a1 1 0 011-1h3.2l1.3 1.5H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z',
  'folder-open': 'M2 12.5V4.5a1 1 0 011-1h3.2l1.3 1.5H13a1 1 0 011 1v1M2 12.5l1.8-5H15l-1.8 5z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  search: 'M7.2 11.4a4.2 4.2 0 100-8.4 4.2 4.2 0 000 8.4zM10.4 10.4L13.5 13.5',
  close: 'M4 4l8 8M12 4l-8 8',
  check: 'M3.5 8.5l3 3 6-7',
  dots: 'M4 8h.01M8 8h.01M12 8h.01',
  'dots-v': 'M8 4v.01M8 8v.01M8 12v.01',
  copy: 'M5.5 5.5V3.2a.7.7 0 01.7-.7h6.6a.7.7 0 01.7.7v6.6a.7.7 0 01-.7.7h-2.3M3.2 5.5h6.6a.7.7 0 01.7.7v6.6a.7.7 0 01-.7.7H3.2a.7.7 0 01-.7-.7V6.2a.7.7 0 01.7-.7z',
  trash: 'M2.8 4.2h10.4M6 4.2V2.8h4v1.4M4.2 4.2l.6 9h6.4l.6-9M6.6 6.8v4M9.4 6.8v4',
  edit: 'M11.2 2.8l2 2L6 12H4v-2zM9.8 4.2l2 2',
  save: 'M3 3h7.5L13 5.5V13H3zM5.5 3v3.5h5V3M5.5 13v-3.5h5V13',
  send: 'M14 2L2 6.8l4.6 1.9M14 2L9.4 14l-2.8-5.3M14 2L6.6 8.7',
  stop: 'M4.5 4.5h7v7h-7z',
  alert: 'M8 2.5l6 10.5H2zM8 6.5v3M8 11.4v.01',
  info: 'M8 14.2A6.2 6.2 0 108 1.8a6.2 6.2 0 000 12.4zM8 7.4v4M8 4.9v.01',
  clock: 'M8 14.2A6.2 6.2 0 108 1.8a6.2 6.2 0 000 12.4zM8 4.6V8l2.4 1.6',
  link: 'M6.6 9.4a2.6 2.6 0 000 0l3-3M6.9 4.4l1.4-1.4a2.8 2.8 0 014 4l-1.4 1.4M9.1 11.6l-1.4 1.4a2.8 2.8 0 01-4-4l1.4-1.4',
  external: 'M9.5 3H13v3.5M13 3L7.5 8.5M11.5 9.5V13H3V4.5h3.5',
  upload: 'M8 11V2.8M4.8 6L8 2.8 11.2 6M2.8 11v2.2h10.4V11',
  download: 'M8 2.8V11M4.8 7.8L8 11l3.2-3.2M2.8 11v2.2h10.4V11',
  share: 'M11.5 5.6a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8zM4.5 9.9a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8zM11.5 14.2a1.9 1.9 0 100-3.8 1.9 1.9 0 000 3.8zM6.2 7.1l3.6-1.8M6.2 8.9l3.6 1.8',
  refresh: 'M13.2 7.2a5.2 5.2 0 10-.7 3.6M13.2 3.4v3.8h-3.8',
  history: 'M2.8 7.9a5.2 5.2 0 105.2-5.1 5.2 5.2 0 00-4.4 2.4M2.8 2.9v2.6h2.6M8 5.4V8l2 1.4',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.6h11M6.4 6.6v5.9M10.2 6.6v5.9',
  braces: 'M6.4 2.6c-1.6 0-1.6 1.5-1.6 2.7S4.5 8 3.4 8c1.1 0 1.4.9 1.4 2.7s0 2.7 1.6 2.7M9.6 2.6c1.6 0 1.6 1.5 1.6 2.7s.3 2.7 1.4 2.7c-1.1 0-1.4.9-1.4 2.7s0 2.7-1.6 2.7',
  list: 'M5.5 4.2h8M5.5 8h8M5.5 11.8h8M2.8 4.2h.01M2.8 8h.01M2.8 11.8h.01',
  eye: 'M8 3.4c3.4 0 6 3 6.6 4.6-.6 1.6-3.2 4.6-6.6 4.6S2 9.6 1.4 8C2 6.4 4.6 3.4 8 3.4zM8 10a2 2 0 100-4 2 2 0 000 4z',
  'eye-off': 'M2.4 2.4l11.2 11.2M6.3 6.4A2 2 0 008 10a2 2 0 001.6-.8M4.6 4.7C2.9 5.8 1.8 7.3 1.4 8c.6 1.6 3.2 4.6 6.6 4.6 1.2 0 2.3-.4 3.2-.9M9.6 3.7A6.4 6.4 0 008 3.4c-.5 0-1 .1-1.4.2M12.2 5.3c1 .9 1.8 1.9 2.4 2.7-.3.8-1 1.8-2 2.7',
  filter: 'M2.5 3.5h11l-4.2 5v4.2l-2.6-1.4V8.5z',
  'sort-asc': 'M4.5 12V4M2.2 6.3L4.5 4l2.3 2.3M9 5h5M9 8h4M9 11h3',
  'sort-desc': 'M4.5 4v8M2.2 9.7L4.5 12l2.3-2.3M9 5h3M9 8h4M9 11h5',
  settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM12.9 9.7l.9.7-1.2 2-1.1-.4a4.6 4.6 0 01-1.1.6l-.2 1.2H7.8l-.2-1.2a4.6 4.6 0 01-1.1-.6l-1.1.4-1.2-2 .9-.7a4.7 4.7 0 010-1.4l-.9-.7 1.2-2 1.1.4a4.6 4.6 0 011.1-.6l.2-1.2h2.4l.2 1.2c.4.1.8.3 1.1.6l1.1-.4 1.2 2-.9.7a4.7 4.7 0 010 1.4z',
  cookie: 'M8 14A6 6 0 118 2a3.4 3.4 0 003.2 3.1A3 3 0 0014 8a6 6 0 01-6 6zM6 6.5v.01M9.6 8.4v.01M6.5 10.6v.01',
  terminal: 'M2.5 3.5h11v9h-11zM4.8 6.4L6.9 8.4l-2.1 2M8.6 10.6h3',
  key: 'M9.8 6.2a2.6 2.6 0 11-3.7 3.7L2.5 13.5v-2h2v-2h2l1.6-1.6a2.6 2.6 0 011.7-1.7zM11 5.1v.01',
  lock: 'M4.2 7.2h7.6v6H4.2zM6 7.2V5a2 2 0 014 0v2.2M8 9.6v1.4',
  variable: 'M5.2 2.8C3.6 4.4 3.6 11.6 5.2 13.2M10.8 2.8c1.6 1.6 1.6 8.8 0 10.4M6.4 6.2l3.2 3.6M9.6 6.2l-3.2 3.6',
  grip: 'M6 4h.01M6 8h.01M6 12h.01M10 4h.01M10 8h.01M10 12h.01',
  expand: 'M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9',
  collapse: 'M13 3L9 7M9 7V3.5M9 7h3.5M3 13l4-4M7 9v3.5M7 9H3.5',
  wrap: 'M2.5 4h11M2.5 8h8.2a2.2 2.2 0 010 4.4H8.4M10 10.6L8.4 12.4 10 14M2.5 12h3',
  columns: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  pin: 'M9.4 2.2l4.4 4.4-1.6.6-.8 3-4.2-4.2 3-.8zM7.2 6l-4.4 7.2L10 8.8',
  play: 'M5 3.4l7 4.6-7 4.6z',
  fullscreen: 'M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10',
  'panel-left': 'M2.5 3.5h11v9h-11zM6.4 3.5v9',
  'fullscreen-exit': 'M2.5 6H6V2.5M13.5 6H10V2.5M2.5 10H6v3.5M13.5 10H10v3.5',
}

const FILLED = new Set<IconName>(['stop', 'play'])
const DOT_ONLY = new Set<IconName>(['dots', 'dots-v', 'grip'])

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  title?: string
}

export function Icon({ name, size = 14, className, title }: IconProps) {
  const d = PATHS[name]
  const filled = FILLED.has(name)
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.4}
      strokeLinecap={DOT_ONLY.has(name) ? 'round' : 'round'}
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  )
}

/** Directional caret used by tree rows; rotates rather than swapping glyphs. */
export function Caret({ open, size = 12 }: { open: boolean; size?: number }) {
  return (
    <svg
      className={`caret${open ? ' is-open' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 3.5L10.5 8L6 12.5" />
    </svg>
  )
}
