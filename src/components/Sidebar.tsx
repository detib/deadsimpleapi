import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { countRequests } from '../../shared/factory'
import type { Collection, HistoryEntry, TreeNode } from '../../shared/types'
import {
  formatBytes,
  formatDuration,
  formatRelativeTime,
  highlightRanges,
  methodClass,
  statusClass,
} from '../lib/format'
import { useStore } from '../state/store'
import { allFolderIds, flatten, isDescendant, searchTree, type DropPosition } from '../state/tree'
import { ContextMenu, type MenuItem } from './ui/ContextMenu'
import { Caret, Icon } from './ui/Icon'
import { Waveform } from './ui/Waveform'
import './Sidebar.css'

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** One rung of the ladder drawn behind the rows, per depth step. */
const INDENT = 13

/**
 * The badge is a fixed-width gutter, so every standard verb fits in full and
 * the names still line up. Only a long custom method gets clipped, and it
 * keeps its full text in the row's title attribute.
 */
function abbrevMethod(method: string): string {
  const upper = method.trim().toUpperCase()
  return upper.length > 7 ? upper.slice(0, 6) + '…' : upper
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}` || '/'
  } catch {
    return url
  }
}

const DAY_MS = 86_400_000

function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = new Date(at)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  })
}

/** A clock, not an animation: relative stamps go stale if nothing re-renders. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function Highlight({ text, query }: { text: string; query: string }): JSX.Element {
  const ranges = query ? highlightRanges(text, query) : []
  if (!ranges.length) return <>{text}</>

  const parts: JSX.Element[] = []
  let at = 0
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(<span key={`t${i}`}>{text.slice(at, start)}</span>)
    parts.push(
      <mark className="sb-mark" key={`m${i}`}>
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  })
  if (at < text.length) parts.push(<span key="tail">{text.slice(at)}</span>)
  return <>{parts}</>
}

/* ------------------------------------------------------------------ */
/* Inline rename                                                       */
/* ------------------------------------------------------------------ */

function RenameField(props: {
  initial: string
  label: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  // Escape cancels, and the blur it triggers must not then commit as well.
  const settled = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    const next = ref.current?.value.trim() ?? ''
    if (next) props.onCommit(next)
    else props.onCancel()
  }

  const cancel = () => {
    if (settled.current) return
    settled.current = true
    props.onCancel()
  }

  return (
    <input
      ref={ref}
      type="text"
      className="sb-rename"
      defaultValue={props.initial}
      aria-label={props.label}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Row model                                                           */
/* ------------------------------------------------------------------ */

type RowKind = 'collection' | 'folder' | 'request'

interface Row {
  kind: RowKind
  id: string
  collectionId: string
  name: string
  /** Collections sit at 0, their direct children at 1. */
  depth: number
  parentId: string | null
  expandable: boolean
  open: boolean
  count: number
  method?: string
  url?: string
  collection?: Collection
}

interface MenuTarget {
  kind: RowKind
  collectionId: string
  id: string
  name: string
}

type MenuAnchor = MenuTarget & { x: number; y: number }

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

export function Sidebar(): JSX.Element {
  const sidebarTab = useStore((s) => s.sidebarTab)
  const setSidebarTab = useStore((s) => s.setSidebarTab)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const historyCount = useStore((s) => s.history.length)

  const query = search.trim()

  const newCollection = useCallback(() => {
    void useStore
      .getState()
      .createCollection()
      // A fresh collection lands in rename mode, the same as a new request.
      .then((created) => useStore.getState().setRenaming(created.id))
  }, [])

  const clearHistory = useCallback(() => {
    const store = useStore.getState()
    store.openModal({
      kind: 'confirm',
      title: 'Clear history',
      message: `All ${store.history.length} recorded calls will be discarded. This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: () => void useStore.getState().clearHistory(),
    })
  }, [])

  return (
    <div className="sidebar">
      <div className="panel-bar sidebar-bar" role="tablist" aria-label="Sidebar sections">
        <button
          type="button"
          role="tab"
          className="tab sb-tab"
          aria-selected={sidebarTab === 'collections'}
          aria-controls="sb-panel-collections"
          onClick={() => setSidebarTab('collections')}
        >
          Collections
        </button>
        <button
          type="button"
          role="tab"
          className="tab sb-tab"
          aria-selected={sidebarTab === 'history'}
          aria-controls="sb-panel-history"
          onClick={() => setSidebarTab('history')}
        >
          History
        </button>

        <span className="sb-bar-spacer" />

        {sidebarTab === 'history' && historyCount > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearHistory}
            title="Discard every recorded call"
          >
            <Icon name="trash" size={12} />
            Clear
          </button>
        )}
      </div>

      <div className="sb-search">
        <Icon name="search" size={13} className="sb-search-icon" />
        <input
          type="text"
          className="sb-search-input"
          data-focus="search"
          value={search}
          placeholder={sidebarTab === 'collections' ? 'Search requests' : 'Search history'}
          aria-label={sidebarTab === 'collections' ? 'Search requests' : 'Search history'}
          spellCheck={false}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.preventDefault()
              setSearch('')
            }
          }}
        />
        {search && (
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-xs sb-search-clear"
            aria-label="Clear search"
            onClick={() => setSearch('')}
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>

      {sidebarTab === 'collections' ? (
        <CollectionsPanel query={query} onNewCollection={newCollection} />
      ) : (
        <HistoryPanel query={query} />
      )}

      <div className="sb-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={newCollection}>
          <Icon name="plus" size={12} />
          New collection
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void useStore.getState().importFromFile()}
          title="Import an OpenAPI, Postman or Deadsimple file"
        >
          <Icon name="download" size={12} />
          Import
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Collections tab                                                     */
/* ------------------------------------------------------------------ */

function CollectionsPanel({
  query,
  onNewCollection,
}: {
  query: string
  onNewCollection: () => void
}): JSX.Element {
  const collections = useStore((s) => s.collections)
  const expanded = useStore((s) => s.expanded)
  const selectedNodeId = useStore((s) => s.selectedNodeId)
  const renamingId = useStore((s) => s.renamingId)

  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const [drop, setDrop] = useState<{ id: string; position: DropPosition } | null>(null)

  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const dragging = useRef<{ collectionId: string; id: string } | null>(null)

  const searching = query.length > 0

  const { rows, matches } = useMemo(() => {
    const out: Row[] = []
    let hitCount = 0

    const pushNodes = (
      collectionId: string,
      nodes: TreeNode[],
      openMap: Record<string, boolean>,
      visible: Set<string> | null,
    ) => {
      for (const flat of flatten(nodes, openMap)) {
        const node = flat.node
        if (visible && !visible.has(node.id)) continue
        const base = {
          id: node.id,
          collectionId,
          name: node.name,
          depth: flat.depth + 1,
          parentId: flat.parentId ?? collectionId,
        }
        if (node.kind === 'folder') {
          out.push({
            ...base,
            kind: 'folder',
            expandable: node.children.length > 0,
            // While filtering, "open" means "has visible children right now".
            open: visible
              ? node.children.some((child) => visible.has(child.id))
              : Boolean(openMap[node.id]),
            count: node.children.length,
          })
        } else {
          out.push({
            ...base,
            kind: 'request',
            expandable: false,
            open: false,
            count: 0,
            method: node.method,
            url: node.url,
          })
        }
      }
    }

    for (const collection of collections) {
      if (!searching) {
        out.push({
          kind: 'collection',
          id: collection.id,
          collectionId: collection.id,
          name: collection.name,
          depth: 0,
          parentId: null,
          expandable: collection.children.length > 0,
          open: Boolean(expanded[collection.id]),
          count: countRequests(collection.children),
          collection,
        })
        if (expanded[collection.id]) pushNodes(collection.id, collection.children, expanded, null)
        continue
      }

      const hits = searchTree(collection.children, query)
      if (!hits.length) continue
      hitCount += hits.length

      // Reveal every hit by forcing its ancestors open, which leaves the real
      // expansion state untouched for when the search is cleared.
      const visible = new Set<string>()
      const openMap: Record<string, boolean> = {}
      for (const hit of hits) {
        visible.add(hit.node.id)
        for (const ancestor of hit.path) {
          visible.add(ancestor)
          openMap[ancestor] = true
        }
      }

      out.push({
        kind: 'collection',
        id: collection.id,
        collectionId: collection.id,
        name: collection.name,
        depth: 0,
        parentId: null,
        expandable: true,
        open: true,
        count: hits.length,
        collection,
      })
      pushNodes(collection.id, collection.children, openMap, visible)
    }

    return { rows: out, matches: hitCount }
  }, [collections, expanded, query, searching])

  const tabbableId =
    focusedId && rows.some((r) => r.id === focusedId) ? focusedId : rows[0]?.id ?? null

  const focusRow = useCallback((id: string) => {
    setFocusedId(id)
    rowRefs.current.get(id)?.focus()
  }, [])

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const newRequest = useCallback((collectionId: string, folderId: string | null) => {
    const store = useStore.getState()
    // addRequest only opens the parent folder, so a collapsed root would hide
    // the row the store just put into rename mode.
    store.setExpanded([collectionId], true)
    store.addRequest(collectionId, folderId)
  }, [])

  const newFolder = useCallback((collectionId: string, folderId: string | null) => {
    const store = useStore.getState()
    store.setExpanded([collectionId], true)
    store.addFolder(collectionId, folderId)
  }, [])

  const removeTarget = useCallback((target: MenuTarget) => {
    const store = useStore.getState()
    const run =
      target.kind === 'collection'
        ? () => void useStore.getState().deleteCollection(target.collectionId)
        : () => useStore.getState().deleteNode(target.collectionId, target.id)

    if (!store.settings.confirmDelete) {
      run()
      return
    }
    store.openModal({
      kind: 'confirm',
      title:
        target.kind === 'collection'
          ? 'Delete collection'
          : target.kind === 'folder'
            ? 'Delete folder'
            : 'Delete request',
      message:
        target.kind === 'request'
          ? `"${target.name}" will be permanently removed.`
          : `"${target.name}" and everything inside it will be permanently removed.`,
      confirmLabel: 'Delete',
      onConfirm: run,
    })
  }, [])

  const copyAsCurl = useCallback((collectionId: string, requestId: string) => {
    const store = useStore.getState()
    // The export modal is addressed by tab id, so the request has to be open.
    store.openRequest(collectionId, requestId)
    const tab = useStore
      .getState()
      .tabs.find((t) => t.collectionId === collectionId && t.requestId === requestId)
    if (tab) store.openModal({ kind: 'curl-export', tabId: tab.id })
  }, [])

  const activate = useCallback(
    (row: Row, preview = false) => {
      const store = useStore.getState()
      if (row.kind === 'request') {
        store.openRequest(row.collectionId, row.id, { preview })
        return
      }
      store.select(row.id)
      // Collapsing while filtering would only hide matches, so it is inert.
      if (!searching) store.toggleFolder(row.id)
    },
    [searching],
  )

  /* ---------------------------------------------------------------- */
  /* Context menus                                                     */
  /* ---------------------------------------------------------------- */

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const { kind, collectionId, id, name } = menu
    const target: MenuTarget = { kind, collectionId, id, name }

    if (kind === 'collection') {
      return [
        { label: 'New request', icon: 'plus', onSelect: () => newRequest(collectionId, null) },
        { label: 'New folder', icon: 'folder', onSelect: () => newFolder(collectionId, null) },
        { label: '', separator: true },
        {
          label: 'Rename',
          icon: 'edit',
          shortcut: 'F2',
          onSelect: () => useStore.getState().setRenaming(id),
        },
        {
          label: 'Duplicate',
          icon: 'copy',
          onSelect: () => void useStore.getState().duplicateCollection(id),
        },
        {
          label: 'Share…',
          icon: 'share',
          onSelect: () => void useStore.getState().exportCollection(id),
        },
        { label: '', separator: true },
        {
          label: 'Collection settings…',
          icon: 'variable',
          onSelect: () => useStore.getState().openModal({ kind: 'collection', collectionId }),
        },
        { label: '', separator: true },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeTarget(target) },
      ]
    }

    if (kind === 'folder') {
      return [
        { label: 'New request', icon: 'plus', onSelect: () => newRequest(collectionId, id) },
        { label: 'New folder', icon: 'folder', onSelect: () => newFolder(collectionId, id) },
        { label: '', separator: true },
        {
          label: 'Rename',
          icon: 'edit',
          shortcut: 'F2',
          onSelect: () => useStore.getState().setRenaming(id),
        },
        {
          label: 'Duplicate',
          icon: 'copy',
          onSelect: () => useStore.getState().duplicateNode(collectionId, id),
        },
        { label: '', separator: true },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeTarget(target) },
      ]
    }

    return [
      {
        label: 'Open',
        icon: 'external',
        onSelect: () => useStore.getState().openRequest(collectionId, id),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        onSelect: () => useStore.getState().duplicateNode(collectionId, id),
      },
      {
        label: 'Rename',
        icon: 'edit',
        shortcut: 'F2',
        onSelect: () => useStore.getState().setRenaming(id),
      },
      { label: '', separator: true },
      { label: 'Copy as curl', icon: 'terminal', onSelect: () => copyAsCurl(collectionId, id) },
      { label: '', separator: true },
      { label: 'Delete', icon: 'trash', danger: true, onSelect: () => removeTarget(target) },
    ]
  }, [menu, newRequest, newFolder, removeTarget, copyAsCurl])

  /* ---------------------------------------------------------------- */
  /* Drag and drop                                                     */
  /* ---------------------------------------------------------------- */

  const dropPositionFor = useCallback(
    (row: Row, event: React.DragEvent<HTMLDivElement>): DropPosition | null => {
      const drag = dragging.current
      if (!drag) return null
      // Reparenting across collections would strip folder and collection
      // defaults out from under the request, so it is refused outright.
      if (drag.collectionId !== row.collectionId) return null
      if (drag.id === row.id) return null

      const collection = useStore.getState().collections.find((c) => c.id === row.collectionId)
      if (!collection) return null
      // A folder cannot swallow itself; never even draw the hint.
      if (isDescendant(collection.children, drag.id, row.id)) return null

      if (row.kind === 'collection') return 'inside'

      const rect = event.currentTarget.getBoundingClientRect()
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5
      if (row.kind === 'folder') {
        if (ratio < 0.34) return 'before'
        if (ratio > 0.66) return 'after'
        return 'inside'
      }
      return ratio < 0.5 ? 'before' : 'after'
    },
    [],
  )

  /* ---------------------------------------------------------------- */
  /* Keyboard                                                          */
  /* ---------------------------------------------------------------- */

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, row: Row, index: number) => {
    // The rename field and the set switcher own their own keys.
    if (event.target !== event.currentTarget) return
    const store = useStore.getState()

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault()
        const next = rows[index + 1]
        if (next) focusRow(next.id)
        break
      }
      case 'ArrowUp': {
        event.preventDefault()
        const prev = rows[index - 1]
        if (prev) focusRow(prev.id)
        break
      }
      case 'ArrowRight': {
        event.preventDefault()
        if (row.expandable && !row.open && !searching) {
          store.toggleFolder(row.id)
        } else {
          const next = rows[index + 1]
          if (next && next.depth > row.depth) focusRow(next.id)
        }
        break
      }
      case 'ArrowLeft': {
        event.preventDefault()
        if (row.expandable && row.open && !searching) store.toggleFolder(row.id)
        else if (row.parentId) focusRow(row.parentId)
        break
      }
      case 'Home': {
        event.preventDefault()
        if (rows[0]) focusRow(rows[0].id)
        break
      }
      case 'End': {
        event.preventDefault()
        const last = rows[rows.length - 1]
        if (last) focusRow(last.id)
        break
      }
      case 'Enter':
      case ' ': {
        event.preventDefault()
        activate(row, true)
        break
      }
      case 'F2': {
        event.preventDefault()
        store.setRenaming(row.id)
        break
      }
      case 'Delete': {
        event.preventDefault()
        removeTarget({ kind: row.kind, collectionId: row.collectionId, id: row.id, name: row.name })
        break
      }
      default:
        break
    }
  }

  /* ---------------------------------------------------------------- */

  if (!collections.length) {
    return (
      <div className="sb-body" id="sb-panel-collections" role="tabpanel" aria-label="Collections">
        <div className="empty-state">
          <Icon name="folder" size={20} />
          <span>No collections yet</span>
          <div className="empty-actions">
            <button type="button" className="btn btn-sm" onClick={onNewCollection}>
              New collection
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void useStore.getState().importFromFile()}
            >
              Import
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="sb-body" id="sb-panel-collections" role="tabpanel" aria-label="Collections">
      {searching && (
        <p className="sb-count-line">
          {matches} {matches === 1 ? 'match' : 'matches'}
        </p>
      )}

      {searching && !rows.length ? (
        <div className="empty-state">
          <Icon name="search" size={18} />
          <span>Nothing matches “{query}”</span>
          <p className="empty-hint">Names, methods and URLs are searched.</p>
        </div>
      ) : (
        <div
          className="sb-tree scroll-y"
          role="tree"
          aria-label="Collections"
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null)
          }}
        >
          {rows.map((row, index) => {
            const isRenaming = renamingId === row.id
            const isSelected = selectedNodeId === row.id
            const className = [
              'sb-row',
              `is-${row.kind}`,
              isSelected ? 'is-selected' : '',
              isRenaming ? 'is-renaming' : '',
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <div
                key={row.id}
                ref={(el) => {
                  if (el) rowRefs.current.set(row.id, el)
                  else rowRefs.current.delete(row.id)
                }}
                className={className}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.expandable ? row.open : undefined}
                aria-selected={isSelected}
                aria-label={
                  row.kind === 'request' ? `${row.method ?? ''} ${row.name}`.trim() : row.name
                }
                tabIndex={tabbableId === row.id ? 0 : -1}
                data-drop={drop && drop.id === row.id ? drop.position : undefined}
                title={
                  row.kind === 'request'
                    ? `${row.method ?? ''} ${row.name}\n${row.url ?? ''}`.trim()
                    : row.name
                }
                draggable={row.kind !== 'collection' && !searching && !isRenaming}
                onFocus={() => setFocusedId(row.id)}
                onClick={() => {
                  if (isRenaming) return
                  setFocusedId(row.id)
                  activate(row, true)
                }}
                onDoubleClick={() => {
                  if (isRenaming || row.kind !== 'request') return
                  useStore.getState().pinTab(useStore.getState().activeTabId ?? '')
                }}
                onKeyDown={(event) => onRowKeyDown(event, row, index)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setFocusedId(row.id)
                  useStore.getState().select(row.id)
                  setMenu({
                    x: event.clientX,
                    y: event.clientY,
                    kind: row.kind,
                    collectionId: row.collectionId,
                    id: row.id,
                    name: row.name,
                  })
                }}
                onDragStart={(event) => {
                  dragging.current = { collectionId: row.collectionId, id: row.id }
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', row.name)
                }}
                onDragEnd={() => {
                  dragging.current = null
                  setDrop(null)
                }}
                onDragOver={(event) => {
                  const position = dropPositionFor(row, event)
                  if (!position) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (drop?.id !== row.id || drop.position !== position) {
                    setDrop({ id: row.id, position })
                  }
                }}
                onDrop={(event) => {
                  const position = dropPositionFor(row, event)
                  const drag = dragging.current
                  event.preventDefault()
                  setDrop(null)
                  dragging.current = null
                  if (!position || !drag) return
                  useStore
                    .getState()
                    .moveNode(
                      row.collectionId,
                      drag.id,
                      row.kind === 'collection' ? null : row.id,
                      position,
                    )
                }}
              >
                <span
                  className="sb-indent"
                  style={{ width: row.depth * INDENT }}
                  aria-hidden="true"
                />

                <span className="sb-caret" aria-hidden="true">
                  {row.expandable ? <Caret open={row.open} /> : null}
                </span>

                {row.kind === 'folder' && (
                  <Icon name={row.open ? 'folder-open' : 'folder'} size={13} className="sb-glyph" />
                )}

                {row.kind === 'request' && (
                  <span className={`sb-method method-badge is-sm ${methodClass(row.method ?? 'GET')}`}>
                    {abbrevMethod(row.method ?? 'GET')}
                  </span>
                )}

                {isRenaming ? (
                  <RenameField
                    initial={row.name}
                    label={`Rename ${row.name}`}
                    onCommit={(name) => {
                      const store = useStore.getState()
                      if (row.kind === 'collection') {
                        store.renameCollection(row.id, name)
                        store.setRenaming(null)
                      } else {
                        store.renameNode(row.collectionId, row.id, name)
                      }
                      rowRefs.current.get(row.id)?.focus()
                    }}
                    onCancel={() => useStore.getState().setRenaming(null)}
                  />
                ) : (
                  <span className="sb-name truncate">
                    <Highlight text={row.name} query={searching ? query : ''} />
                  </span>
                )}

                {row.kind === 'collection' && row.collection && !isRenaming && (
                  <TreeToggle collection={row.collection} />
                )}

                {row.kind !== 'request' && !isRenaming && (
                  <span
                    className="sb-badge mono"
                    title={
                      row.kind === 'collection'
                        ? searching
                          ? `${row.count} matches`
                          : `${row.count} requests`
                        : `${row.count} items`
                    }
                  >
                    {row.count}
                  </span>
                )}

                {row.kind === 'collection' && row.collection && (
                  <SetSwitcher collection={row.collection} />
                )}
              </div>
            )
          })}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Variable set switcher                                               */
/* ------------------------------------------------------------------ */

/** Collapsing is the useful direction once a tree is open, so it leads. */
function TreeToggle({ collection }: { collection: Collection }): JSX.Element | null {
  const expanded = useStore((s) => s.expanded)
  const ids = useMemo(() => allFolderIds(collection.children), [collection.children])
  if (!ids.length) return null

  const anyOpen = ids.some((id) => expanded[id])
  const store = useStore.getState()

  return (
    <button
      type="button"
      className="sb-treetoggle"
      aria-label={`${anyOpen ? 'Collapse' : 'Expand'} all folders in ${collection.name}`}
      title={anyOpen ? 'Collapse all folders' : 'Expand all folders'}
      onClick={(e) => {
        e.stopPropagation()
        if (anyOpen) store.collapseAll(collection.id)
        else store.expandAll(collection.id)
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <Icon name={anyOpen ? 'collapse' : 'expand'} size={11} />
    </button>
  )
}

/**
 * The row control is a button rather than a bare <select> because it has two
 * jobs: switching the active set and getting to the editor. A select only ever
 * reads as the former, which left the variables themselves unfindable.
 */
function SetSwitcher({ collection }: { collection: Collection }): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  const active = collection.sets.find((s) => s.id === collection.activeSetId) ?? null
  const label = collection.sets.length === 0 ? 'set up' : active?.name ?? 'no set'

  const open = () => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setMenu({ x: rect.left, y: rect.bottom + 2 })
  }

  const items: MenuItem[] = [
    ...collection.sets.map((set) => ({
      label: set.name,
      icon: (set.id === collection.activeSetId ? 'check' : undefined) as MenuItem['icon'],
      onSelect: () => useStore.getState().setActiveSet(collection.id, set.id),
    })),
    ...(collection.sets.length > 0 ? [{ label: '', separator: true }] : []),
    {
      label: 'Collection settings…',
      icon: 'variable',
      onSelect: () => useStore.getState().openModal({ kind: 'collection', collectionId: collection.id }),
    },
  ]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`sb-setsel${menu ? ' is-open' : ''}`}
        aria-label={`Variables for ${collection.name}`}
        aria-haspopup="menu"
        aria-expanded={menu ? true : false}
        title={
          collection.sets.length === 0
            ? 'No variable sets yet — click to add one'
            : `Active variable set: ${active?.name ?? 'none'}
Click to switch or edit`
        }
        onClick={(e) => {
          e.stopPropagation()
          open()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="variable" size={11} className="sb-setsel-glyph" />
        <span className="sb-setsel-name truncate">{label}</span>
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />
      )}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* History tab                                                         */
/* ------------------------------------------------------------------ */

interface HistoryGroup {
  label: string
  entries: HistoryEntry[]
}

function HistoryPanel({ query }: { query: string }): JSX.Element {
  const history = useStore((s) => s.history)
  const now = useNow(30_000)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: HistoryEntry } | null>(null)

  const needle = query.toLowerCase()

  const groups = useMemo((): HistoryGroup[] => {
    const out: HistoryGroup[] = []
    for (const entry of history) {
      if (
        needle &&
        !`${entry.method} ${entry.name} ${entry.url} ${entry.status ?? ''}`
          .toLowerCase()
          .includes(needle)
      ) {
        continue
      }
      const label = dayLabel(entry.at, now)
      const last = out[out.length - 1]
      if (last && last.label === label) last.entries.push(entry)
      else out.push({ label, entries: [entry] })
    }
    return out
  }, [history, needle, now])

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const entry = menu.entry
    return [
      {
        label: 'Open',
        icon: 'external',
        onSelect: () => useStore.getState().replayHistory(entry.id),
      },
      {
        label: 'Copy URL',
        icon: 'copy',
        onSelect: () => {
          void navigator.clipboard
            .writeText(entry.url)
            .then(() => useStore.getState().toast('success', 'URL copied'))
            .catch(() => useStore.getState().toast('error', 'Could not copy the URL'))
        },
      },
      { label: '', separator: true },
      {
        label: 'Remove',
        icon: 'trash',
        danger: true,
        onSelect: () => void useStore.getState().removeHistory(entry.id),
      },
    ]
  }, [menu])

  if (!groups.length) {
    return (
      <div className="sb-body" id="sb-panel-history" role="tabpanel" aria-label="History">
        <div className="empty-state">
          <Icon name="history" size={20} />
          <span>{query ? `Nothing matches “${query}”` : 'No calls yet'}</span>
          {!query && <p className="empty-hint">Every request you send is recorded here.</p>}
        </div>
      </div>
    )
  }

  return (
    <div className="sb-body" id="sb-panel-history" role="tabpanel" aria-label="History">
      <div className="sb-history scroll-y">
        {groups.map((group) => (
          <section className="sb-hgroup" key={group.label}>
            <h3 className="sb-hgroup-label plate">{group.label}</h3>
            {group.entries.map((entry) => (
              <HistoryRow
                key={entry.id}
                entry={entry}
                now={now}
                query={query}
                onMenu={(x, y) => setMenu({ x, y, entry })}
              />
            ))}
          </section>
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

function HistoryRow({
  entry,
  now,
  query,
  onMenu,
}: {
  entry: HistoryEntry
  now: number
  query: string
  onMenu: (x: number, y: number) => void
}): JSX.Element {
  const label = entry.name || shortUrl(entry.url)
  const open = () => useStore.getState().replayHistory(entry.id)

  return (
    <div
      className={`sb-hrow${entry.ok ? '' : ' is-failed'}`}
      role="button"
      tabIndex={0}
      aria-label={`${entry.method} ${label}, ${
        entry.ok ? `status ${entry.status ?? 0}` : entry.error || 'failed'
      }, ${formatDuration(entry.durationMs)}`}
      title={`${entry.method} ${entry.url}\n${formatRelativeTime(entry.at, now)} · ${formatDuration(
        entry.durationMs,
      )} · ${formatBytes(entry.responseSize)}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(event.clientX, event.clientY)
      }}
    >
      <div className="sb-hrow-top">
        <span className={`sb-method method-badge is-sm ${methodClass(entry.method)}`}>
          {abbrevMethod(entry.method)}
        </span>
        {entry.ok && typeof entry.status === 'number' ? (
          <span className={`sb-hstatus mono st-${statusClass(entry.status)}`}>{entry.status}</span>
        ) : (
          <span className="sb-hstatus mono sb-hfail">ERR</span>
        )}
        <span className="sb-name truncate">
          <Highlight text={label} query={query} />
        </span>
        <span className="sb-htime mono">{formatRelativeTime(entry.at, now)}</span>
      </div>

      <div className="sb-hrow-bot">
        {entry.ok ? (
          <span className="sb-hurl mono truncate">{shortUrl(entry.url)}</span>
        ) : (
          <span className="sb-herr truncate">{entry.error || 'Request failed'}</span>
        )}
        {entry.timing ? (
          <Waveform timing={entry.timing} size="sm" className="sb-hwave" />
        ) : (
          <span className="sb-hwave-gap" aria-hidden="true" />
        )}
        <span className="sb-hdur mono">{formatDuration(entry.durationMs)}</span>
      </div>
    </div>
  )
}
