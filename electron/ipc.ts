import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { CH, type AppInfo, type ImportOutcome, type FileMeta } from '../shared/api'
import { looksLikeNativeCollection, normalizeCollection } from '../shared/normalize'
import { cloneNode, countFolders, countRequests, uid } from '../shared/factory'
import type {
  AppSettings,
  Collection,
  HistoryEntry,
  StreamEvent,
  WireRequest,
} from '../shared/types'

import { CookieJar } from './http/cookies'
import { createExecutor, type Executor } from './http/engine'
import { paths } from './store/paths'
import {
  createCollection,
  deleteCollection,
  duplicateCollection,
  exportCollectionJson,
  listCollections,
  loadAll,
  loadCollection,
  saveCollection,
} from './store/collections'
import {
  addHistory,
  clearHistory,
  deleteHistory,
  loadHistory,
  setHistoryLimit,
} from './store/history'
import { currentSettings, loadSettings, saveSettings } from './store/settings'
import { importOpenApi, looksLikeOpenApi } from './import/openapi'
import { importPostman, looksLikePostman } from './import/postman'
import { parseCurl } from './import/curl'
import { toCurl } from './export/curl'

let executor: Executor
let jar: CookieJar

/** Parses a document that may be JSON or YAML. Throws with a readable message. */
function parseDocument(text: string, name: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to YAML */
  }
  try {
    return parseYaml(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`${name} is neither valid JSON nor valid YAML: ${detail}`)
  }
}

/** Re-ids an imported collection so importing the same file twice never collides. */
function freshIds(collection: Collection): Collection {
  collection.id = uid()
  collection.children = collection.children.map((n) => cloneNode(n))
  collection.variables = collection.variables.map((v) => ({ ...v, id: uid() }))
  const setIdMap = new Map<string, string>()
  collection.sets = collection.sets.map((s) => {
    const next = uid()
    setIdMap.set(s.id, next)
    return { ...s, id: next, values: s.values.map((v) => ({ ...v, id: uid() })) }
  })
  collection.activeSetId = collection.activeSetId
    ? setIdMap.get(collection.activeSetId) ?? collection.sets[0]?.id ?? null
    : collection.sets[0]?.id ?? null
  return collection
}

/** Auto-detects the format of an imported document. */
function importDocument(text: string, sourceName: string): ImportOutcome {
  const doc = parseDocument(text, sourceName)

  if (looksLikeNativeCollection(doc)) {
    const collection = freshIds(normalizeCollection(doc))
    return {
      kind: 'native',
      collection,
      warnings: [],
      stats: {
        folders: countFolders(collection.children),
        requests: countRequests(collection.children),
        variables: collection.variables.length,
      },
    }
  }

  if (looksLikePostman(doc)) {
    const r = importPostman(text, sourceName)
    return { kind: 'postman', collection: freshIds(r.collection), warnings: r.warnings, stats: r.stats }
  }

  if (looksLikeOpenApi(doc)) {
    const r = importOpenApi(text, sourceName)
    return { kind: 'openapi', collection: freshIds(r.collection), warnings: r.warnings, stats: r.stats }
  }

  throw new Error(
    `Could not recognise ${sourceName}. Supported: a Deadsimple collection, an OpenAPI 3.x / Swagger 2.0 spec, or a Postman v2 collection.`,
  )
}

/**
 * Electron's dialog overloads take either (options) or (parentWindow, options).
 * Passing an explicit undefined parent matches neither, so callers route
 * through these helpers instead of branching at every call site.
 */
function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

function saveDialog(
  win: BrowserWindow | undefined,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function openDialog(
  win: BrowserWindow | undefined,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

export async function registerIpc(getWindow: () => BrowserWindow | null): Promise<void> {
  const settings = await loadSettings()
  setHistoryLimit(settings.historyLimit)

  jar = new CookieJar(paths().cookies)
  await jar.load()

  executor = createExecutor({
    jar,
    inlineBodyCap: settings.inlineBodyCapBytes,
    overflowDir: paths().tmp,
  })

  /* ---------------------------------------------------------------- */
  /* App                                                               */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    dataDir: paths().root,
  }))

  ipcMain.on(CH.appMinimize, () => getWindow()?.minimize())
  ipcMain.on(CH.appToggleMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(CH.appClose, () => getWindow()?.close())

  ipcMain.handle(CH.appOpenExternal, async (_e, url: string) => {
    // Only ever hand http(s) to the OS; anything else could launch a local handler.
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
  })

  ipcMain.handle(CH.appRevealDataDir, async () => {
    await shell.openPath(paths().root)
  })

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.httpSend, async (event, req: WireRequest) => {
    const sender = event.sender
    return executor.execute(req, {
      onStream: (ev: StreamEvent) => {
        if (!sender.isDestroyed()) sender.send(CH.httpStream, ev)
      },
    })
  })

  ipcMain.handle(CH.httpCancel, (_e, execId: string) => executor.cancel(execId))

  /* ---------------------------------------------------------------- */
  /* Collections                                                       */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.colList, () => listCollections())
  ipcMain.handle(CH.colLoadAll, () => loadAll())
  ipcMain.handle(CH.colLoad, (_e, id: string) => loadCollection(id))
  ipcMain.handle(CH.colSave, (_e, c: Collection) => saveCollection(c))
  ipcMain.handle(CH.colCreate, (_e, patch?: Partial<Collection>) => createCollection(patch))
  ipcMain.handle(CH.colRemove, (_e, id: string) => deleteCollection(id))
  ipcMain.handle(CH.colDuplicate, (_e, id: string) => duplicateCollection(id))

  ipcMain.handle(CH.colExport, async (event, id: string): Promise<string | null> => {
    const json = await exportCollectionJson(id)
    if (json === null) return null
    const collection = await loadCollection(id)
    const win = windowOf(event)
    const result = await saveDialog(win, {
      title: 'Share collection',
      defaultPath: `${(collection?.name ?? 'collection').replace(/[<>:"/\\|?*]/g, '-')}.deadsimple.json`,
      filters: [
        { name: 'Deadsimple collection', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, json, 'utf8')
    return result.filePath
  })

  ipcMain.handle(CH.colImportFile, async (event): Promise<ImportOutcome[] | null> => {
    const win = windowOf(event)
    const result = await openDialog(win, {
      title: 'Import collection or API spec',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Collections and specs', extensions: ['json', 'yaml', 'yml'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) return null

    const outcomes: ImportOutcome[] = []
    for (const file of result.filePaths) {
      const text = await readFile(file, 'utf8')
      const outcome = importDocument(text, basename(file))
      if (!outcome.collection.name || outcome.collection.name === 'Untitled collection') {
        outcome.collection.name = basename(file, extname(file))
      }
      outcome.sourcePath = file
      await saveCollection(outcome.collection)
      outcomes.push(outcome)
    }
    return outcomes
  })

  ipcMain.handle(
    CH.colImportText,
    async (_e, text: string, sourceName = 'pasted document'): Promise<ImportOutcome> => {
      const outcome = importDocument(text, sourceName)
      await saveCollection(outcome.collection)
      return outcome
    },
  )

  /* ---------------------------------------------------------------- */
  /* History, settings, cookies                                        */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.hisList, () => loadHistory())
  ipcMain.handle(CH.hisAdd, (_e, entry: HistoryEntry) => addHistory(entry))
  ipcMain.handle(CH.hisRemove, (_e, id: string) => deleteHistory(id))
  ipcMain.handle(CH.hisClear, () => clearHistory())

  ipcMain.handle(CH.setGet, () => currentSettings())
  ipcMain.handle(CH.setSet, async (_e, patch: Partial<AppSettings>) => {
    const next = await saveSettings(patch)
    setHistoryLimit(next.historyLimit)
    return next
  })

  ipcMain.handle(CH.ckList, () => jar.all())
  ipcMain.handle(CH.ckRemove, (_e, name: string, domain: string, path: string) =>
    jar.remove((c) => c.name === name && c.domain === domain && c.path === path),
  )
  ipcMain.handle(CH.ckClear, () => jar.clear())

  /* ---------------------------------------------------------------- */
  /* curl                                                              */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.curlParse, (_e, text: string) => parseCurl(text))
  ipcMain.handle(CH.curlGen, (_e, req: WireRequest, opts) => toCurl(req, opts))

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(CH.filePick, async (event, opts): Promise<string[]> => {
    const win = windowOf(event)
    const result = await openDialog(win, {
      title: opts?.title ?? 'Select file',
      properties: opts?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts?.filters,
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle(
    CH.fileSaveAs,
    async (event, defaultName: string, data: Uint8Array): Promise<string | null> => {
      const win = windowOf(event)
      const ext = extname(defaultName).replace('.', '')
      const result = await saveDialog(win, {
        title: 'Save response body',
        defaultPath: defaultName,
        filters: ext
          ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }]
          : [{ name: 'All files', extensions: ['*'] }],
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, Buffer.from(data))
      return result.filePath
    },
  )

  ipcMain.handle(CH.fileStat, async (_e, path: string): Promise<FileMeta> => {
    try {
      const s = await stat(path)
      return { path, name: basename(path), size: s.size, exists: s.isFile() }
    } catch {
      return { path, name: basename(path), size: 0, exists: false }
    }
  })

  ipcMain.handle(CH.fileOverflow, async (_e, path: string): Promise<Uint8Array | null> => {
    // Guard: only ever read back from our own temp directory.
    if (!path.startsWith(paths().tmp)) return null
    try {
      return new Uint8Array(await readFile(path))
    } catch {
      return null
    }
  })
}

export function shutdownIpc(): void {
  executor?.cancelAll()
  void jar?.save()
}
