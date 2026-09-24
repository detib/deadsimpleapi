import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'node:path'

import { CH } from '../shared/api'
import { ensureDirs, initPaths } from './store/paths'
import { flushSettings, loadSettings } from './store/settings'
import { flushHistory } from './store/history'
import { registerIpc, shutdownIpc } from './ipc'
import { flushWindowState, loadWindowState, trackWindowState } from './window-state'

const DEV_URL = process.env.VITE_DEV_SERVER_URL
const isDev = Boolean(DEV_URL)

let mainWindow: BrowserWindow | null = null

// A single instance owns the collection files on disk; a second one would race it.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// Occlusion calculation costs measurable startup time on Windows and buys us
// nothing: this window is either visible or minimised, never partially covered
// in a way we care about.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

async function createWindow(): Promise<BrowserWindow> {
  const state = await loadWindowState()

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 560,
    show: false,
    frame: false,
    // Matches --chassis so there is no white flash before React paints.
    backgroundColor: '#1A1D23',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The renderer only ever loads our own bundle.
      webSecurity: true,
      backgroundThrottling: false,
    },
  })

  if (state.maximized) win.maximize()

  win.once('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })

  const notifyMaximized = () => {
    if (!win.isDestroyed()) win.webContents.send(CH.appMaximized, win.isMaximized())
  }
  win.on('maximize', notifyMaximized)
  win.on('unmaximize', notifyMaximized)

  // Nothing in this app should ever open a second window or navigate away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  trackWindowState(win)

  // A renderer that paints nothing (a bundle that threw, say) would otherwise
  // leave an invisible window and no way to reach the app.
  const failsafe = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show()
  }, 4000)
  win.once('ready-to-show', () => clearTimeout(failsafe))
  win.on('closed', () => clearTimeout(failsafe))

  return win
}

/**
 * Kept separate from createWindow so IPC handlers can be registered first: the
 * renderer calls settings.get() and collections.loadAll() the moment its bundle
 * evaluates, and those invokes reject outright if no handler exists yet.
 */
async function loadRenderer(win: BrowserWindow): Promise<void> {
  if (DEV_URL) await win.loadURL(DEV_URL)
  else await win.loadFile(join(__dirname, '../dist/index.html'))
}

/**
 * The window is frameless, so this menu is never drawn. It exists purely to
 * register the standard editing and zoom accelerators, which Chromium will not
 * bind on its own once an application menu is absent.
 */
function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  initPaths(app.getPath('userData'))
  await ensureDirs()

  installMenu()

  // Window shell and settings load concurrently; neither touches IPC yet.
  const [win] = await Promise.all([createWindow(), loadSettings()])
  mainWindow = win

  // Handlers must exist before the renderer's first invoke.
  await registerIpc(() => mainWindow)
  await loadRenderer(win)

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createWindow()
      await loadRenderer(mainWindow)
    }
  })
})

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let flushed = false
app.on('before-quit', async (event) => {
  if (flushed) return
  event.preventDefault()
  flushed = true
  shutdownIpc()
  try {
    if (mainWindow && !mainWindow.isDestroyed()) await flushWindowState(mainWindow)
    await Promise.all([flushHistory(), flushSettings()])
  } catch {
    // Never block quitting on a failed write.
  }
  app.quit()
})
