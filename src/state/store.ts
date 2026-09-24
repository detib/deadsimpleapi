import { create } from 'zustand'

import type { ImportOutcome } from '../../shared/api'
import {
  DEFAULT_APP_SETTINGS,
  type ApiRequest,
  type AppSettings,
  type Collection,
  type Folder,
  type HistoryEntry,
  type KV,
  type StreamEvent,
  type TreeNode,
  type VariableSet,
  type WireRequest,
  type WireResponse,
} from '../../shared/types'
import {
  cloneNode,
  countRequests,
  kv,
  newCollection,
  newFolder,
  newRequest,
  newVariableSet,
  uid,
} from '../../shared/factory'
import { buildWire } from '../lib/wire'
import {
  allFolderIds,
  findAny,
  findRequest,
  folderPath,
  insertNode,
  moveNode,
  removeNode,
  updateNode,
  updateRequest,
  type DropPosition,
} from './tree'

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ReqTabKey = 'params' | 'body' | 'headers' | 'auth' | 'cookies' | 'settings' | 'docs'
export type ResTabKey = 'body' | 'table' | 'headers' | 'cookies' | 'timing' | 'sent'
export type SidebarTab = 'collections' | 'history'

export interface LiveStream {
  status?: number
  statusText?: string
  headers?: Array<[string, string]>
  bytes: number
  text: string
}

export interface ExecState {
  status: 'idle' | 'sending' | 'done' | 'error' | 'canceled'
  execId: string | null
  response: WireResponse | null
  wire: WireRequest | null
  stream: LiveStream | null
  startedAt: number | null
  elapsedMs: number
  issues: string[]
}

export interface Tab {
  id: string
  /** null on both means a scratch request living only in this tab. */
  collectionId: string | null
  requestId: string | null
  reqTab: ReqTabKey
  resTab: ResTabKey
  exec: ExecState
  /**
   * A preview tab is the single slot that a plain click in the sidebar reuses,
   * so browsing a folder does not leave a trail of tabs behind. Any real
   * interaction promotes it to a normal tab.
   */
  preview?: boolean
}

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
  detail?: string
}

/** Which pane the collection dialog opens on. */
export type CollectionTab = 'variables' | 'auth' | 'headers'

export type ModalKind =
  | null
  | { kind: 'settings' }
  | { kind: 'cookies' }
  | { kind: 'curl-import'; tabId: string | null }
  | { kind: 'curl-export'; tabId: string }
  | { kind: 'collection'; collectionId: string; tab?: CollectionTab }
  | { kind: 'import-report'; outcomes: ImportOutcome[] }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; onConfirm: () => void }

function idleExec(): ExecState {
  return {
    status: 'idle',
    execId: null,
    response: null,
    wire: null,
    stream: null,
    startedAt: null,
    elapsedMs: 0,
    issues: [],
  }
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}

function newTab(patch: Partial<Tab> = {}): Tab {
  return {
    id: uid(),
    collectionId: null,
    requestId: null,
    reqTab: 'params',
    resTab: 'body',
    exec: idleExec(),
    ...patch,
  }
}

/* ------------------------------------------------------------------ */
/* Persistence scheduling                                              */
/* ------------------------------------------------------------------ */

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const SAVE_DEBOUNCE = 500

/** Stream decoders, keyed by execId, so multi-byte characters survive chunking. */
const decoders = new Map<string, TextDecoder>()

const EXPANDED_KEY = 'ds.expanded'
const TABS_KEY = 'ds.tabs'

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota or private mode; UI state is not worth failing over.
  }
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

interface State {
  ready: boolean
  settings: AppSettings
  collections: Collection[]
  scratch: Record<string, ApiRequest>
  tabs: Tab[]
  activeTabId: string | null
  history: HistoryEntry[]
  expanded: Record<string, boolean>
  search: string
  sidebarTab: SidebarTab
  selectedNodeId: string | null
  renamingId: string | null
  modal: ModalKind
  toasts: Toast[]
  sidebarWidth: number
  responseWidth: number
  sidebarCollapsed: boolean
  theme: 'dark' | 'light'

  /* lifecycle */
  bootstrap(): Promise<void>

  /* settings */
  patchSettings(patch: Partial<AppSettings>): Promise<void>
  setTheme(theme: 'dark' | 'light'): void

  /* collections */
  createCollection(name?: string): Promise<Collection>
  renameCollection(id: string, name: string): void
  deleteCollection(id: string): Promise<void>
  duplicateCollection(id: string): Promise<void>
  exportCollection(id: string): Promise<void>
  importFromFile(): Promise<void>
  importFromText(text: string, sourceName?: string): Promise<void>
  patchCollection(id: string, patch: Partial<Collection>): void

  /* variables */
  setActiveSet(collectionId: string, setId: string | null): void
  addVariableSet(collectionId: string, name: string): void
  renameVariableSet(collectionId: string, setId: string, name: string): void
  deleteVariableSet(collectionId: string, setId: string): void
  setSetValues(collectionId: string, setId: string, values: KV[]): void
  setSharedVariables(collectionId: string, values: KV[]): void

  /* tree */
  addRequest(collectionId: string, parentFolderId: string | null, patch?: Partial<ApiRequest>): string
  addFolder(collectionId: string, parentFolderId: string | null): string
  renameNode(collectionId: string, nodeId: string, name: string): void
  deleteNode(collectionId: string, nodeId: string): void
  duplicateNode(collectionId: string, nodeId: string): void
  moveNode(collectionId: string, dragId: string, targetId: string | null, position: DropPosition): void
  patchFolder(collectionId: string, folderId: string, patch: Partial<Folder>): void
  toggleFolder(folderId: string): void
  setExpanded(ids: string[], open: boolean): void
  expandAll(collectionId: string): void
  collapseAll(collectionId: string): void

  /* tabs */
  openRequest(collectionId: string, requestId: string, opts?: { preview?: boolean }): void
  /** Promotes a preview tab so the next sidebar click stops reusing it. */
  pinTab(tabId: string): void
  openScratch(request: ApiRequest, title?: string): string
  closeTab(tabId: string): void
  closeOtherTabs(tabId: string): void
  closeAllTabs(): void
  setActiveTab(tabId: string): void
  setReqTab(tabId: string, key: ReqTabKey): void
  setResTab(tabId: string, key: ResTabKey): void
  reorderTabs(fromId: string, toId: string): void

  /* editing */
  getRequest(tabId: string): ApiRequest | null
  patchRequest(tabId: string, patch: Partial<ApiRequest>): void
  saveScratchAs(tabId: string, collectionId: string, folderId: string | null, name: string): void

  /* execution */
  send(tabId: string): Promise<void>
  cancel(tabId: string): Promise<void>
  applyStream(ev: StreamEvent): void
  replayHistory(entryId: string): void
  clearHistory(): Promise<void>
  removeHistory(id: string): Promise<void>

  /* ui */
  setSearch(q: string): void
  setSidebarTab(tab: SidebarTab): void
  select(nodeId: string | null): void
  setRenaming(id: string | null): void
  openModal(modal: ModalKind): void
  closeModal(): void
  toast(kind: Toast['kind'], text: string, detail?: string): void
  dismissToast(id: string): void
  setSidebarWidth(px: number): void
  setResponseWidth(px: number): void
  toggleSidebar(force?: boolean): void
}

export const useStore = create<State>((set, get) => {
  /* -------------------------------------------------------------- */
  /* internals                                                       */
  /* -------------------------------------------------------------- */

  function persist(collectionId: string): void {
    const existing = saveTimers.get(collectionId)
    if (existing) clearTimeout(existing)
    saveTimers.set(
      collectionId,
      setTimeout(() => {
        saveTimers.delete(collectionId)
        const collection = get().collections.find((c) => c.id === collectionId)
        if (!collection) return
        void window.api.collections.save(collection).catch((err: unknown) => {
          get().toast('error', 'Could not save collection', String(err))
        })
      }, SAVE_DEBOUNCE),
    )
  }

  /** Applies an immutable update to one collection and schedules a write. */
  function mutate(collectionId: string, fn: (c: Collection) => Collection): void {
    set((s) => ({
      collections: s.collections.map((c) => (c.id === collectionId ? fn(c) : c)),
    }))
    persist(collectionId)
  }

  function patchExec(tabId: string, patch: Partial<ExecState>): void {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, exec: { ...t.exec, ...patch } } : t)),
    }))
  }

  function rememberTabs(): void {
    const s = get()
    writeLocal(
      TABS_KEY,
      s.tabs
        .filter((t) => t.collectionId && t.requestId)
        .map((t) => ({ collectionId: t.collectionId, requestId: t.requestId, id: t.id })),
    )
  }

  return {
    ready: false,
    settings: DEFAULT_APP_SETTINGS,
    collections: [],
    scratch: {},
    tabs: [],
    activeTabId: null,
    history: [],
    expanded: readLocal<Record<string, boolean>>(EXPANDED_KEY, {}),
    search: '',
    sidebarTab: 'collections',
    selectedNodeId: null,
    renamingId: null,
    modal: null,
    toasts: [],
    sidebarWidth: DEFAULT_APP_SETTINGS.sidebarWidth,
    responseWidth: DEFAULT_APP_SETTINGS.responseWidth,
    sidebarCollapsed: DEFAULT_APP_SETTINGS.sidebarCollapsed,
    theme: 'dark',

    /* ------------------------------------------------------------ */

    async bootstrap() {
      // A failure here must still produce a usable window: fall back to
      // defaults and surface the problem rather than sitting on a boot screen.
      let settings = DEFAULT_APP_SETTINGS
      let collections: Collection[] = []
      let history: HistoryEntry[] = []
      let bootError: string | null = null
      try {
        ;[settings, collections, history] = await Promise.all([
          window.api.settings.get(),
          window.api.collections.loadAll(),
          window.api.history.list(),
        ])
      } catch (err) {
        bootError = err instanceof Error ? err.message : String(err)
      }

      window.api.http.onStream((ev) => get().applyStream(ev))

      // Restore whichever tabs still point at requests that exist.
      const remembered = readLocal<Array<{ collectionId: string; requestId: string; id: string }>>(
        TABS_KEY,
        [],
      )
      const tabs: Tab[] = []
      for (const entry of remembered) {
        const collection = collections.find((c) => c.id === entry.collectionId)
        if (!collection) continue
        if (!findRequest(collection.children, entry.requestId)) continue
        tabs.push(newTab({ id: entry.id, collectionId: entry.collectionId, requestId: entry.requestId }))
      }

      document.documentElement.dataset.theme = settings.theme
      document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale))

      set({
        ready: true,
        settings,
        collections,
        history,
        tabs,
        activeTabId: tabs[0]?.id ?? null,
        sidebarWidth: settings.sidebarWidth,
        responseWidth: settings.responseWidth,
        sidebarCollapsed: settings.sidebarCollapsed,
        theme: settings.theme,
        selectedNodeId: tabs[0]?.requestId ?? null,
      })

      if (bootError) {
        get().toast('error', 'Could not load your saved data', bootError)
        return
      }

      // A first-run install should not open to a blank void.
      if (!collections.length) {
        const collection = await get().createCollection('My workspace')
        get().addRequest(collection.id, null, {
          name: 'GET Example',
          method: 'GET',
          url: 'https://httpbin.org/get',
        })
      }
    },

    /* ------------------------------------------------------------ */

    async patchSettings(patch) {
      const settings = await window.api.settings.set(patch)
      if (patch.theme) document.documentElement.dataset.theme = settings.theme
      if (patch.uiScale !== undefined) {
        document.documentElement.style.setProperty('--ui-scale', String(settings.uiScale))
      }
      set({ settings, theme: settings.theme })
    },

    setTheme(theme) {
      void get().patchSettings({ theme })
    },

    /* ------------------------------------------------------------ */

    async createCollection(name) {
      const created = await window.api.collections.create(
        newCollection({
          name: name ?? 'New collection',
          sets: [newVariableSet('default', [kv('baseUrl', '')])],
        }),
      )
      set((s) => ({ collections: [...s.collections, created] }))
      set((s) => ({ expanded: { ...s.expanded, [created.id]: true } }))
      return created
    },

    renameCollection(id, name) {
      mutate(id, (c) => ({ ...c, name }))
    },

    async deleteCollection(id) {
      await window.api.collections.remove(id)
      set((s) => ({
        collections: s.collections.filter((c) => c.id !== id),
        tabs: s.tabs.filter((t) => t.collectionId !== id),
      }))
      set((s) => ({
        activeTabId: s.tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : s.tabs[0]?.id ?? null,
      }))
      rememberTabs()
    },

    async duplicateCollection(id) {
      const copy = await window.api.collections.duplicate(id)
      if (!copy) return
      set((s) => ({ collections: [...s.collections, copy] }))
      get().toast('success', `Duplicated "${copy.name}"`)
    },

    async exportCollection(id) {
      try {
        const path = await window.api.collections.exportToFile(id)
        if (path) get().toast('success', 'Collection shared', path)
      } catch (err) {
        get().toast('error', 'Export failed', String(err))
      }
    },

    async importFromFile() {
      try {
        const outcomes = await window.api.collections.importFromFile()
        if (!outcomes?.length) return
        set((s) => ({ collections: [...s.collections, ...outcomes.map((o) => o.collection)] }))
        set((s) => ({
          expanded: outcomes.reduce(
            (acc, o) => ({ ...acc, [o.collection.id]: true }),
            { ...s.expanded },
          ),
        }))
        get().openModal({ kind: 'import-report', outcomes })
      } catch (err) {
        get().toast('error', 'Import failed', err instanceof Error ? err.message : String(err))
      }
    },

    async importFromText(text, sourceName) {
      try {
        const outcome = await window.api.collections.importFromText(text, sourceName)
        set((s) => ({ collections: [...s.collections, outcome.collection] }))
        set((s) => ({ expanded: { ...s.expanded, [outcome.collection.id]: true } }))
        get().openModal({ kind: 'import-report', outcomes: [outcome] })
      } catch (err) {
        get().toast('error', 'Import failed', err instanceof Error ? err.message : String(err))
      }
    },

    patchCollection(id, patch) {
      mutate(id, (c) => ({ ...c, ...patch }))
    },

    /* ------------------------------------------------------------ */

    setActiveSet(collectionId, setId) {
      mutate(collectionId, (c) => ({ ...c, activeSetId: setId }))
    },

    addVariableSet(collectionId, name) {
      const created = newVariableSet(name)
      mutate(collectionId, (c) => ({
        ...c,
        sets: [...c.sets, created],
        activeSetId: c.activeSetId ?? created.id,
      }))
    },

    renameVariableSet(collectionId, setId, name) {
      mutate(collectionId, (c) => ({
        ...c,
        sets: c.sets.map((s) => (s.id === setId ? { ...s, name } : s)),
      }))
    },

    deleteVariableSet(collectionId, setId) {
      mutate(collectionId, (c) => {
        const sets = c.sets.filter((s) => s.id !== setId)
        return {
          ...c,
          sets,
          activeSetId: c.activeSetId === setId ? sets[0]?.id ?? null : c.activeSetId,
        }
      })
    },

    setSetValues(collectionId, setId, values) {
      mutate(collectionId, (c) => ({
        ...c,
        sets: c.sets.map((s: VariableSet) => (s.id === setId ? { ...s, values } : s)),
      }))
    },

    setSharedVariables(collectionId, values) {
      mutate(collectionId, (c) => ({ ...c, variables: values }))
    },

    /* ------------------------------------------------------------ */

    addRequest(collectionId, parentFolderId, patch) {
      const request = newRequest(patch)
      mutate(collectionId, (c) => ({
        ...c,
        children: insertNode(c.children, parentFolderId, request),
      }))
      if (parentFolderId) set((s) => ({ expanded: { ...s.expanded, [parentFolderId]: true } }))
      get().openRequest(collectionId, request.id)
      set({ renamingId: request.id })
      return request.id
    },

    addFolder(collectionId, parentFolderId) {
      const folder = newFolder()
      mutate(collectionId, (c) => ({
        ...c,
        children: insertNode(c.children, parentFolderId, folder),
      }))
      set((s) => ({
        expanded: { ...s.expanded, [folder.id]: true, ...(parentFolderId ? { [parentFolderId]: true } : {}) },
        renamingId: folder.id,
        selectedNodeId: folder.id,
      }))
      return folder.id
    },

    renameNode(collectionId, nodeId, name) {
      mutate(collectionId, (c) => ({
        ...c,
        children: updateNode(c.children, nodeId, (n) => ({ ...n, name })),
      }))
      set({ renamingId: null })
    },

    deleteNode(collectionId, nodeId) {
      mutate(collectionId, (c) => ({ ...c, children: removeNode(c.children, nodeId).nodes }))
      set((s) => {
        const tabs = s.tabs.filter((t) => t.requestId !== nodeId)
        return {
          tabs,
          activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null,
          selectedNodeId: s.selectedNodeId === nodeId ? null : s.selectedNodeId,
        }
      })
      rememberTabs()
    },

    duplicateNode(collectionId, nodeId) {
      const collection = get().collections.find((c) => c.id === collectionId)
      if (!collection) return
      const node = findAny(collection.children, nodeId)
      if (!node) return
      const copy = cloneNode(node)
      copy.name = `${node.name} copy`
      const parents = folderPath(collection.children, nodeId) ?? []
      const parentId = parents.length ? parents[parents.length - 1].id : null
      mutate(collectionId, (c) => ({ ...c, children: insertNode(c.children, parentId, copy) }))
    },

    moveNode(collectionId, dragId, targetId, position) {
      mutate(collectionId, (c) => ({
        ...c,
        children: moveNode(c.children, dragId, targetId, position),
      }))
    },

    patchFolder(collectionId, folderId, patch) {
      mutate(collectionId, (c) => ({
        ...c,
        children: updateNode(c.children, folderId, (n) =>
          n.kind === 'folder' ? { ...n, ...patch } : n,
        ),
      }))
    },

    toggleFolder(folderId) {
      set((s) => {
        const expanded = { ...s.expanded, [folderId]: !s.expanded[folderId] }
        writeLocal(EXPANDED_KEY, expanded)
        return { expanded }
      })
    },

    setExpanded(ids, open) {
      set((s) => {
        const expanded = { ...s.expanded }
        for (const id of ids) expanded[id] = open
        writeLocal(EXPANDED_KEY, expanded)
        return { expanded }
      })
    },

    expandAll(collectionId) {
      const collection = get().collections.find((c) => c.id === collectionId)
      if (!collection) return
      get().setExpanded([collectionId, ...allFolderIds(collection.children)], true)
    },

    collapseAll(collectionId) {
      const collection = get().collections.find((c) => c.id === collectionId)
      if (!collection) return
      get().setExpanded(allFolderIds(collection.children), false)
    },

    /* ------------------------------------------------------------ */

    openRequest(collectionId, requestId, opts) {
      const preview = opts?.preview === true
      const existing = get().tabs.find(
        (t) => t.collectionId === collectionId && t.requestId === requestId,
      )
      if (existing) {
        // Asking for it outright is the promotion: a double click, a menu pick.
        set((s) => ({
          tabs: preview
            ? s.tabs
            : s.tabs.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)),
          activeTabId: existing.id,
          selectedNodeId: requestId,
        }))
        if (!preview) rememberTabs()
        return
      }

      const slot = preview ? get().tabs.find((t) => t.preview) : undefined
      if (slot) {
        // Reuse the slot in place so the tab strip does not shuffle around.
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === slot.id
              ? { ...newTab({ collectionId, requestId, preview: true }), id: t.id }
              : t,
          ),
          activeTabId: slot.id,
          selectedNodeId: requestId,
          scratch: omit(s.scratch, slot.id),
        }))
        rememberTabs()
        return
      }

      const tab = newTab({ collectionId, requestId, preview })
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, selectedNodeId: requestId }))
      rememberTabs()
    },

    pinTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.preview) return
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)) }))
      rememberTabs()
    },

    openScratch(request) {
      const tab = newTab()
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: tab.id,
        scratch: { ...s.scratch, [tab.id]: request },
      }))
      return tab.id
    },

    closeTab(tabId) {
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === tabId)
        const tabs = s.tabs.filter((t) => t.id !== tabId)
        const scratch = { ...s.scratch }
        delete scratch[tabId]
        let activeTabId = s.activeTabId
        if (s.activeTabId === tabId) {
          activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
        }
        return { tabs, scratch, activeTabId }
      })
      rememberTabs()
    },

    closeOtherTabs(tabId) {
      set((s) => ({
        tabs: s.tabs.filter((t) => t.id === tabId),
        activeTabId: tabId,
      }))
      rememberTabs()
    },

    closeAllTabs() {
      set({ tabs: [], activeTabId: null, scratch: {} })
      rememberTabs()
    },

    setActiveTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId)
      set({ activeTabId: tabId, selectedNodeId: tab?.requestId ?? null })
    },

    setReqTab(tabId, key) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, reqTab: key, preview: false } : t)),
      }))
      rememberTabs()
    },

    setResTab(tabId, key) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, resTab: key } : t)) }))
    },

    reorderTabs(fromId, toId) {
      set((s) => {
        const from = s.tabs.findIndex((t) => t.id === fromId)
        const to = s.tabs.findIndex((t) => t.id === toId)
        if (from < 0 || to < 0 || from === to) return {}
        const tabs = s.tabs.slice()
        const [moved] = tabs.splice(from, 1)
        tabs.splice(to, 0, moved)
        return { tabs }
      })
      rememberTabs()
    },

    /* ------------------------------------------------------------ */

    getRequest(tabId) {
      const s = get()
      const tab = s.tabs.find((t) => t.id === tabId)
      if (!tab) return null
      if (!tab.collectionId || !tab.requestId) return s.scratch[tabId] ?? null
      const collection = s.collections.find((c) => c.id === tab.collectionId)
      if (!collection) return null
      return findRequest(collection.children, tab.requestId)
    },

    patchRequest(tabId, patch) {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab) return
      get().pinTab(tabId)
      if (!tab.collectionId || !tab.requestId) {
        set((s) => {
          const current = s.scratch[tabId]
          if (!current) return {}
          return { scratch: { ...s.scratch, [tabId]: { ...current, ...patch } } }
        })
        return
      }
      const collectionId = tab.collectionId
      const requestId = tab.requestId
      mutate(collectionId, (c) => ({
        ...c,
        children: updateRequest(c.children, requestId, (r) => ({ ...r, ...patch })),
      }))
    },

    saveScratchAs(tabId, collectionId, folderId, name) {
      const request = get().scratch[tabId]
      if (!request) return
      const saved: ApiRequest = { ...request, id: uid(), name }
      mutate(collectionId, (c) => ({ ...c, children: insertNode(c.children, folderId, saved) }))
      set((s) => {
        const scratch = { ...s.scratch }
        delete scratch[tabId]
        return {
          scratch,
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, collectionId, requestId: saved.id } : t,
          ),
          selectedNodeId: saved.id,
        }
      })
      if (folderId) set((s) => ({ expanded: { ...s.expanded, [folderId]: true } }))
      rememberTabs()
      get().toast('success', `Saved "${name}"`)
    },

    /* ------------------------------------------------------------ */

    async send(tabId) {
      const s = get()
      const tab = s.tabs.find((t) => t.id === tabId)
      const request = s.getRequest(tabId)
      if (!tab || !request) return
      // A response is worth keeping, so sending settles the tab for good.
      s.pinTab(tabId)

      const collection = tab.collectionId
        ? s.collections.find((c) => c.id === tab.collectionId) ?? null
        : null
      const folders =
        collection && tab.requestId ? folderPath(collection.children, tab.requestId) ?? [] : []

      const execId = uid()
      const { wire, issues } = buildWire(request, {
        collection,
        folders,
        appDefaults: s.settings.defaultSettings,
        execId,
      })

      if (!wire.url) {
        patchExec(tabId, { status: 'error', issues: ['Enter a URL before sending.'] })
        return
      }

      patchExec(tabId, {
        status: 'sending',
        execId,
        response: null,
        wire,
        stream: null,
        startedAt: Date.now(),
        elapsedMs: 0,
        issues,
      })
      decoders.set(execId, new TextDecoder('utf-8'))

      let response: WireResponse
      try {
        response = await window.api.http.send(wire)
      } catch (err) {
        patchExec(tabId, {
          status: 'error',
          response: {
            ok: false,
            execId,
            error: err instanceof Error ? err.message : String(err),
            timing: { total: 0, startedAt: Date.now() },
          },
        })
        decoders.delete(execId)
        return
      }

      decoders.delete(execId)

      const stillMine = get().tabs.find((t) => t.id === tabId)?.exec.execId === execId
      if (!stillMine) return

      patchExec(tabId, {
        status: response.ok ? 'done' : response.canceled ? 'canceled' : 'error',
        response,
        elapsedMs: response.timing.total,
        // A failed send should land the user on the body pane, not a stale table.
        stream: null,
      })

      if (!response.ok && !response.canceled) {
        set((st) => ({ tabs: st.tabs.map((t) => (t.id === tabId ? { ...t, resTab: 'body' } : t)) }))
      }

      const entry: HistoryEntry = {
        id: uid(),
        at: Date.now(),
        method: wire.method,
        url: wire.url,
        name: request.name,
        collectionId: tab.collectionId ?? undefined,
        requestId: tab.requestId ?? undefined,
        status: response.ok ? response.status : undefined,
        statusText: response.ok ? response.statusText : undefined,
        ok: response.ok,
        error: response.ok ? undefined : response.error,
        durationMs: response.timing.total,
        responseSize: response.ok ? response.size.decoded : 0,
        timing: response.timing,
        snapshot: wire,
      }
      set((st) => ({ history: [entry, ...st.history].slice(0, st.settings.historyLimit || 500) }))
      void window.api.history.add(entry)
    },

    async cancel(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId)
      if (!tab?.exec.execId) return
      await window.api.http.cancel(tab.exec.execId)
    },

    applyStream(ev) {
      const tab = get().tabs.find((t) => t.exec.execId === ev.execId)
      if (!tab) return

      if (ev.phase === 'headers') {
        patchExec(tab.id, {
          stream: {
            status: ev.status,
            statusText: ev.statusText,
            headers: ev.headers,
            bytes: 0,
            text: '',
          },
        })
        return
      }

      if (ev.phase === 'chunk' && ev.chunk) {
        const decoder = decoders.get(ev.execId) ?? new TextDecoder('utf-8')
        decoders.set(ev.execId, decoder)
        const piece = decoder.decode(ev.chunk, { stream: true })
        set((s) => ({
          tabs: s.tabs.map((t) => {
            if (t.id !== tab.id || !t.exec.stream) return t
            // Cap the live buffer; the full body arrives with the final response.
            const text = (t.exec.stream.text + piece).slice(-2_000_000)
            return {
              ...t,
              exec: {
                ...t.exec,
                stream: { ...t.exec.stream, text, bytes: ev.receivedBytes ?? t.exec.stream.bytes },
              },
            }
          }),
        }))
      }
    },

    replayHistory(entryId) {
      const entry = get().history.find((h) => h.id === entryId)
      if (!entry) return

      if (entry.collectionId && entry.requestId) {
        const collection = get().collections.find((c) => c.id === entry.collectionId)
        if (collection && findRequest(collection.children, entry.requestId)) {
          get().openRequest(entry.collectionId, entry.requestId)
          return
        }
      }

      // The original request is gone; rebuild an editable scratch copy.
      const wire = entry.snapshot
      const request = newRequest({
        name: entry.name || `${entry.method} ${entry.url}`,
        method: entry.method,
        url: entry.url,
        headers: wire.headers.map(([k, v]) => kv(k, v)),
      })
      if (wire.body.kind === 'text') {
        request.body.mode = 'text'
        request.body.text = wire.body.text
      }
      get().openScratch(request)
    },

    async clearHistory() {
      await window.api.history.clear()
      set({ history: [] })
    },

    async removeHistory(id) {
      await window.api.history.remove(id)
      set((s) => ({ history: s.history.filter((h) => h.id !== id) }))
    },

    /* ------------------------------------------------------------ */

    setSearch(q) {
      set({ search: q })
    },
    setSidebarTab(sidebarTab) {
      set({ sidebarTab })
    },
    select(selectedNodeId) {
      set({ selectedNodeId })
    },
    setRenaming(renamingId) {
      set({ renamingId })
    },
    openModal(modal) {
      set({ modal })
    },
    closeModal() {
      set({ modal: null })
    },
    toast(kind, text, detail) {
      const entry: Toast = { id: uid(), kind, text, detail }
      set((s) => ({ toasts: [...s.toasts, entry] }))
      setTimeout(() => get().dismissToast(entry.id), kind === 'error' ? 8000 : 3500)
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    },
    setSidebarWidth(px) {
      set({ sidebarWidth: px })
      void window.api.settings.set({ sidebarWidth: px })
    },
    setResponseWidth(px) {
      set({ responseWidth: px })
      void window.api.settings.set({ responseWidth: px })
    },
    toggleSidebar(force) {
      const next = force ?? !get().sidebarCollapsed
      set({ sidebarCollapsed: next })
      void window.api.settings.set({ sidebarCollapsed: next })
    },
  }
})

/* ------------------------------------------------------------------ */
/* Selectors                                                           */
/* ------------------------------------------------------------------ */

export function useActiveTab(): Tab | null {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)
}

export function useTabRequest(tabId: string | null): ApiRequest | null {
  return useStore((s) => {
    if (!tabId) return null
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) return null
    if (!tab.collectionId || !tab.requestId) return s.scratch[tabId] ?? null
    const collection = s.collections.find((c) => c.id === tab.collectionId)
    return collection ? findRequest(collection.children, tab.requestId) : null
  })
}

export function useCollection(id: string | null): Collection | null {
  return useStore((s) => (id ? s.collections.find((c) => c.id === id) ?? null : null))
}

/** The collection a tab belongs to, for variable resolution. */
export function useTabCollection(tabId: string | null): Collection | null {
  return useStore((s) => {
    if (!tabId) return null
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab?.collectionId) return null
    return s.collections.find((c) => c.id === tab.collectionId) ?? null
  })
}
