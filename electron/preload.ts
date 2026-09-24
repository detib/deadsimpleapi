import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CH, type DeadsimpleApi } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

/** Wraps a main->renderer channel so callers get an unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DeadsimpleApi = {
  app: {
    info: () => invoke(CH.appInfo),
    minimize: () => ipcRenderer.send(CH.appMinimize),
    toggleMaximize: () => ipcRenderer.send(CH.appToggleMaximize),
    close: () => ipcRenderer.send(CH.appClose),
    onMaximizeChange: (cb) => subscribe<boolean>(CH.appMaximized, cb),
    openExternal: (url) => invoke(CH.appOpenExternal, url),
    revealDataDir: () => invoke(CH.appRevealDataDir),
  },

  http: {
    send: (req) => invoke(CH.httpSend, req),
    cancel: (execId) => invoke(CH.httpCancel, execId),
    onStream: (cb) => subscribe(CH.httpStream, cb),
  },

  collections: {
    list: () => invoke(CH.colList),
    loadAll: () => invoke(CH.colLoadAll),
    load: (id) => invoke(CH.colLoad, id),
    save: (collection) => invoke(CH.colSave, collection),
    create: (patch) => invoke(CH.colCreate, patch),
    remove: (id) => invoke(CH.colRemove, id),
    duplicate: (id) => invoke(CH.colDuplicate, id),
    exportToFile: (id) => invoke(CH.colExport, id),
    importFromFile: () => invoke(CH.colImportFile),
    importFromText: (text, sourceName) => invoke(CH.colImportText, text, sourceName),
  },

  history: {
    list: () => invoke(CH.hisList),
    add: (entry) => invoke(CH.hisAdd, entry),
    remove: (id) => invoke(CH.hisRemove, id),
    clear: () => invoke(CH.hisClear),
  },

  settings: {
    get: () => invoke(CH.setGet),
    set: (patch) => invoke(CH.setSet, patch),
  },

  cookies: {
    list: () => invoke(CH.ckList),
    remove: (name, domain, path) => invoke(CH.ckRemove, name, domain, path),
    clear: () => invoke(CH.ckClear),
  },

  curl: {
    parse: (text) => invoke(CH.curlParse, text),
    generate: (req, opts) => invoke(CH.curlGen, req, opts),
  },

  files: {
    pick: (opts) => invoke(CH.filePick, opts),
    saveAs: (defaultName, data) => invoke(CH.fileSaveAs, defaultName, data),
    stat: (path) => invoke(CH.fileStat, path),
    readOverflow: (path) => invoke(CH.fileOverflow, path),
  },
}

contextBridge.exposeInMainWorld('api', api)
