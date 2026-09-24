import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { paths } from './store/paths'

interface WindowState extends Partial<Rectangle> {
  maximized?: boolean
}

const DEFAULTS: Required<Pick<Rectangle, 'width' | 'height'>> = { width: 1440, height: 900 }

let file = ''
let pending: NodeJS.Timeout | null = null

function stateFile(): string {
  if (!file) file = join(paths().root, 'window.json')
  return file
}

/** Keeps the window on a display that actually exists right now. */
function isVisibleOnSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const wa = display.workArea
    return (
      bounds.x < wa.x + wa.width &&
      bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height &&
      bounds.y + bounds.height > wa.y
    )
  })
}

export async function loadWindowState(): Promise<WindowState> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), 'utf8')) as WindowState
    const width = Math.max(900, Math.min(raw.width ?? DEFAULTS.width, 8000))
    const height = Math.max(560, Math.min(raw.height ?? DEFAULTS.height, 6000))
    const state: WindowState = { width, height, maximized: raw.maximized === true }
    if (typeof raw.x === 'number' && typeof raw.y === 'number') {
      const candidate = { x: raw.x, y: raw.y, width, height }
      if (isVisibleOnSomeDisplay(candidate)) {
        state.x = raw.x
        state.y = raw.y
      }
    }
    return state
  } catch {
    return { ...DEFAULTS }
  }
}

/** Debounced: resize/move fire continuously while dragging. */
export function trackWindowState(win: BrowserWindow): void {
  const save = () => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      void persist(win)
    }, 500)
  }
  win.on('resize', save)
  win.on('move', save)
  win.on('maximize', save)
  win.on('unmaximize', save)
}

export async function persist(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  try {
    const maximized = win.isMaximized()
    // Normal bounds so un-maximizing later restores the real size, not the screen.
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    const state: WindowState = { ...bounds, maximized }
    await writeFile(stateFile(), JSON.stringify(state), 'utf8')
  } catch {
    // Window geometry is a convenience; never let it break shutdown.
  }
}

export function flushWindowState(win: BrowserWindow): Promise<void> {
  if (pending) {
    clearTimeout(pending)
    pending = null
  }
  return persist(win)
}
