import { useMemo, useRef, useState } from 'react'

import { useStore } from '../state/store'
import { findRequest } from '../state/tree'
import { methodClass } from '../lib/format'
import { Icon } from './ui/Icon'
import { ContextMenu, type MenuItem } from './ui/ContextMenu'
import './TabBar.css'

interface TabView {
  id: string
  name: string
  method: string
  scratch: boolean
  missing: boolean
  preview: boolean
  status: 'idle' | 'sending' | 'done' | 'error' | 'canceled'
  code?: number
}

export function TabBar() {
  const activeTabId = useStore((s) => s.activeTabId)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const closeTab = useStore((s) => s.closeTab)
  const reorderTabs = useStore((s) => s.reorderTabs)
  const pinTab = useStore((s) => s.pinTab)

  // Each of these is a stable store reference; the view rows are derived with
  // useMemo instead of inside the selector. A selector that built this array
  // would return a new value on every call, which makes zustand's snapshot
  // unstable and sends React into an infinite render loop.
  const openTabs = useStore((s) => s.tabs)
  const collections = useStore((s) => s.collections)
  const scratch = useStore((s) => s.scratch)

  const tabs = useMemo<TabView[]>(
    () =>
      openTabs.map((tab) => {
        const request =
          tab.collectionId && tab.requestId
            ? findRequest(
                collections.find((c) => c.id === tab.collectionId)?.children ?? [],
                tab.requestId,
              )
            : scratch[tab.id] ?? null
        const response = tab.exec.response
        return {
          id: tab.id,
          name: request?.name || 'Untitled',
          method: request?.method || 'GET',
          scratch: !tab.requestId,
          missing: !request,
          preview: tab.preview === true,
          status: tab.exec.status,
          code: response?.ok ? response.status : undefined,
        }
      }),
    [openTabs, collections, scratch],
  )

  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const dragId = useRef<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  const menuItems = useMemo((): MenuItem[] => {
    if (!menu) return []
    const store = useStore.getState()
    return [
      { label: 'Close', onSelect: () => store.closeTab(menu.tabId), shortcut: 'Ctrl+W' },
      { label: 'Close others', onSelect: () => store.closeOtherTabs(menu.tabId) },
      { label: 'Close all', onSelect: () => store.closeAllTabs() },
    ]
  }, [menu])

  if (!tabs.length) return null

  return (
    <div className="tabbar">
      <div className="tabbar-strip scroll-x" ref={stripRef} role="tablist" aria-label="Open requests">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeTabId}
            className={`reqtab${tab.id === activeTabId ? ' is-active' : ''}${
              tab.missing ? ' is-missing' : ''
            }${tab.preview ? ' is-preview' : ''}`}
            draggable
            onDragStart={() => (dragId.current = tab.id)}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId.current && dragId.current !== tab.id) reorderTabs(dragId.current, tab.id)
              dragId.current = null
            }}
            onClick={() => setActiveTab(tab.id)}
            onDoubleClick={() => pinTab(tab.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveTab(tab.id)
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(tab.id)
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
            }}
            title={tab.preview ? `${tab.name}
Double-click to keep this tab open` : tab.name}
          >
            <span className={`reqtab-method method-badge is-sm ${methodClass(tab.method)}`}>{tab.method}</span>
            <span className="reqtab-name">{tab.name}</span>

            {tab.status === 'sending' ? (
              <span className="spinner reqtab-spinner" aria-label="Sending" />
            ) : tab.scratch ? (
              <span className="reqtab-dot" title="Unsaved request" />
            ) : null}

            <button
              className="reqtab-close"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation()
                closeTab(tab.id)
              }}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
