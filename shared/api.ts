import type {
  AppSettings,
  Collection,
  CollectionSummary,
  HistoryEntry,
  JarCookie,
  StreamEvent,
  WireRequest,
  WireResponse,
} from './types'

/**
 * The complete surface exposed to the renderer as `window.api`.
 * Every member is asynchronous and crosses an IPC boundary, except the
 * `on*` subscribers, which return an unsubscribe function.
 */

export type ImportKind = 'native' | 'openapi' | 'postman'

export interface ImportOutcome {
  kind: ImportKind
  collection: Collection
  warnings: string[]
  stats: { folders: number; requests: number; variables: number }
  sourcePath?: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  platform: NodeJS.Platform | string
  dataDir: string
}

export interface PickFileOptions {
  title?: string
  multiple?: boolean
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface FileMeta {
  path: string
  name: string
  size: number
  exists: boolean
}

export interface CurlGenOptions {
  multiline?: boolean
  platform?: 'sh' | 'powershell' | 'cmd'
  longFlags?: boolean
}

export interface CurlParsed {
  request: unknown
  warnings: string[]
}

export interface DeadsimpleApi {
  app: {
    info(): Promise<AppInfo>
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizeChange(cb: (maximized: boolean) => void): () => void
    openExternal(url: string): Promise<void>
    revealDataDir(): Promise<void>
  }

  http: {
    send(req: WireRequest): Promise<WireResponse>
    cancel(execId: string): Promise<boolean>
    onStream(cb: (ev: StreamEvent) => void): () => void
  }

  collections: {
    list(): Promise<CollectionSummary[]>
    loadAll(): Promise<Collection[]>
    load(id: string): Promise<Collection | null>
    save(collection: Collection): Promise<Collection>
    create(patch?: Partial<Collection>): Promise<Collection>
    remove(id: string): Promise<boolean>
    duplicate(id: string): Promise<Collection | null>
    /** Opens a save dialog. Resolves null when the user cancels. */
    exportToFile(id: string): Promise<string | null>
    /** Opens an open dialog and auto-detects native / OpenAPI / Postman. */
    importFromFile(): Promise<ImportOutcome[] | null>
    importFromText(text: string, sourceName?: string): Promise<ImportOutcome>
  }

  history: {
    list(): Promise<HistoryEntry[]>
    add(entry: HistoryEntry): Promise<void>
    remove(id: string): Promise<void>
    clear(): Promise<void>
  }

  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }

  cookies: {
    list(): Promise<JarCookie[]>
    remove(name: string, domain: string, path: string): Promise<number>
    clear(): Promise<void>
  }

  curl: {
    parse(text: string): Promise<CurlParsed>
    generate(req: WireRequest, opts?: CurlGenOptions): Promise<string>
  }

  files: {
    pick(opts?: PickFileOptions): Promise<string[]>
    /** Writes bytes to a user-chosen path. Resolves null when canceled. */
    saveAs(defaultName: string, data: Uint8Array): Promise<string | null>
    stat(path: string): Promise<FileMeta>
    /** Reads a body that was too large to inline over IPC. */
    readOverflow(path: string): Promise<Uint8Array | null>
  }
}

declare global {
  interface Window {
    api: DeadsimpleApi
  }
}

/** Channel names, shared so main and preload cannot drift apart. */
export const CH = {
  appInfo: 'app:info',
  appMinimize: 'app:minimize',
  appToggleMaximize: 'app:toggle-maximize',
  appClose: 'app:close',
  appMaximized: 'app:maximized',
  appOpenExternal: 'app:open-external',
  appRevealDataDir: 'app:reveal-data-dir',

  httpSend: 'http:send',
  httpCancel: 'http:cancel',
  httpStream: 'http:stream',

  colList: 'col:list',
  colLoadAll: 'col:load-all',
  colLoad: 'col:load',
  colSave: 'col:save',
  colCreate: 'col:create',
  colRemove: 'col:remove',
  colDuplicate: 'col:duplicate',
  colExport: 'col:export',
  colImportFile: 'col:import-file',
  colImportText: 'col:import-text',

  hisList: 'his:list',
  hisAdd: 'his:add',
  hisRemove: 'his:remove',
  hisClear: 'his:clear',

  setGet: 'set:get',
  setSet: 'set:set',

  ckList: 'ck:list',
  ckRemove: 'ck:remove',
  ckClear: 'ck:clear',

  curlParse: 'curl:parse',
  curlGen: 'curl:gen',

  filePick: 'file:pick',
  fileSaveAs: 'file:save-as',
  fileStat: 'file:stat',
  fileOverflow: 'file:overflow',
} as const
