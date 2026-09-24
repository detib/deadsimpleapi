import { useCallback, useEffect, useRef, useState } from 'react'

import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { RequestPanel } from './components/RequestPanel'
import { ResponsePanel } from './components/ResponsePanel'
import { Modals } from './components/Modals'
import { TabBar } from './components/TabBar'
import { StatusBar } from './components/StatusBar'
import { Toasts } from './components/Toasts'
import { Icon } from './components/ui/Icon'

const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 560
const RESPONSE_MIN = 320
const RESPONSE_MAX = 1100
/** Below this width the response panel stacks under the editor instead. */
const STACK_BREAKPOINT = 1080

type DragTarget = 'sidebar' | 'response' | null

export function App() {
  const ready = useStore((s) => s.ready)
  const sidebarWidth = useStore((s) => s.sidebarWidth)
  const responseWidth = useStore((s) => s.responseWidth)
  const activeTabId = useStore((s) => s.activeTabId)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const hasTabs = useStore((s) => s.tabs.length > 0)

  const [stacked, setStacked] = useState(false)
  const dragRef = useRef<DragTarget>(null)
  const [dragging, setDragging] = useState<DragTarget>(null)

  /* ---------------------------------------------------------------- */
  /* Panel resizing                                                    */
  /* ---------------------------------------------------------------- */

  const onPointerDown = useCallback((target: Exclude<DragTarget, null>) => {
    return (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      dragRef.current = target
      setDragging(target)
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }, [])

  useEffect(() => {
    if (!dragging) return

    const onMove = (event: PointerEvent) => {
      const store = useStore.getState()
      if (dragRef.current === 'sidebar') {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, event.clientX))
        store.setSidebarWidth(Math.round(next))
      } else if (dragRef.current === 'response') {
        const next = Math.min(RESPONSE_MAX, Math.max(RESPONSE_MIN, window.innerWidth - event.clientX))
        store.setResponseWidth(Math.round(next))
      }
    }

    const onUp = () => {
      dragRef.current = null
      setDragging(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging])

  /** Keyboard resizing keeps the splitters usable without a mouse. */
  const onResizerKey = useCallback(
    (target: Exclude<DragTarget, null>) => (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 40 : 12
      const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
      if (!delta) return
      event.preventDefault()
      const store = useStore.getState()
      if (target === 'sidebar') {
        store.setSidebarWidth(
          Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, store.sidebarWidth + delta)),
        )
      } else {
        store.setResponseWidth(
          Math.min(RESPONSE_MAX, Math.max(RESPONSE_MIN, store.responseWidth - delta)),
        )
      }
    },
    [],
  )

  /* ---------------------------------------------------------------- */
  /* Responsive stacking                                               */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const check = () => setStacked(window.innerWidth < STACK_BREAKPOINT)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  /* ---------------------------------------------------------------- */
  /* Global shortcuts                                                  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const store = useStore.getState()
      const mod = event.ctrlKey || event.metaKey
      const tabId = store.activeTabId

      if (mod && event.key === 'Enter' && tabId) {
        event.preventDefault()
        const tab = store.tabs.find((t) => t.id === tabId)
        if (tab?.exec.status === 'sending') void store.cancel(tabId)
        else void store.send(tabId)
        return
      }

      if (mod && !event.shiftKey && event.key.toLowerCase() === 'w' && tabId) {
        event.preventDefault()
        store.closeTab(tabId)
        return
      }

      if (mod && !event.shiftKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        store.toggleSidebar()
        return
      }

      if (mod && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        document.querySelector<HTMLElement>('[data-focus="url"]')?.focus()
        return
      }

      if (mod && event.key.toLowerCase() === 'p') {
        event.preventDefault()
        document.querySelector<HTMLElement>('[data-focus="search"]')?.focus()
        return
      }

      // Variables for whichever collection the active tab belongs to, falling
      // back to the only collection when there is no ambiguity to resolve.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        const tab = store.tabs.find((t) => t.id === tabId)
        const collectionId = tab?.collectionId ?? (store.collections.length === 1 ? store.collections[0].id : null)
        if (collectionId) store.openModal({ kind: 'collection', collectionId })
        else store.toast('info', 'Open a request first, so Deadsimple knows which collection to edit')
        return
      }

      if (mod && event.key.toLowerCase() === ',') {
        event.preventDefault()
        store.openModal({ kind: 'settings' })
        return
      }

      if (mod && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        store.openModal({ kind: 'curl-import', tabId: store.activeTabId })
        return
      }

      if (event.key === 'Escape' && store.modal) {
        event.preventDefault()
        store.closeModal()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) {
    return <div className="boot">Deadsimple</div>
  }

  return (
    <div className="app">
      <TitleRail />

      <div
        className={`workbench${stacked ? ' is-stacked' : ''}${
          sidebarCollapsed ? ' is-sidebar-collapsed' : ''
        }`}
      >
        {sidebarCollapsed && (
          <div className="sidebar-rail" aria-hidden="true">
            <span className="sidebar-rail-grip" />
          </div>
        )}

        <aside className="pane-sidebar" style={{ width: sidebarWidth }}>
          <Sidebar />
        </aside>

        {!sidebarCollapsed && (
          <div
            className={`pane-resizer${dragging === 'sidebar' ? ' is-active' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            tabIndex={0}
            onPointerDown={onPointerDown('sidebar')}
            onKeyDown={onResizerKey('sidebar')}
          />
        )}

        <main className="pane-center">
          <TabBar />
          {activeTabId ? <RequestPanel key={activeTabId} tabId={activeTabId} /> : <NoTab />}
        </main>

        {!stacked && hasTabs && (
          <div
            className={`pane-resizer${dragging === 'response' ? ' is-active' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize response panel"
            tabIndex={0}
            onPointerDown={onPointerDown('response')}
            onKeyDown={onResizerKey('response')}
          />
        )}

        {hasTabs && (
          <section
            className="pane-response"
            style={stacked ? undefined : { width: responseWidth }}
          >
            {activeTabId && <ResponsePanel key={activeTabId} tabId={activeTabId} />}
          </section>
        )}
      </div>

      <StatusBar />
      <Modals />
      <Toasts />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TitleRail() {
  const [maximized, setMaximized] = useState(false)
  const openModal = useStore((s) => s.openModal)
  const importFromFile = useStore((s) => s.importFromFile)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  useEffect(() => window.api.app.onMaximizeChange(setMaximized), [])

  return (
    <header className="titlebar">
      <button
        className="btn-icon titlebar-toggle"
        aria-pressed={sidebarCollapsed}
        aria-label={sidebarCollapsed ? 'Pin the sidebar open' : 'Auto-hide the sidebar'}
        title={`${sidebarCollapsed ? 'Pin the sidebar open' : 'Auto-hide the sidebar'}  (Ctrl+B)`}
        onClick={() => toggleSidebar()}
      >
        <Icon name="panel-left" />
      </button>

      <div className="titlebar-brand">
        <svg className="titlebar-mark" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M1 6h2.2l1.4-3.4L7.4 9.4 8.8 6H11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Deadsimple
      </div>

      <div className="titlebar-drag" />

      <div className="titlebar-actions">
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => openModal({ kind: 'curl-import', tabId: useStore.getState().activeTabId })}
          title="Import a curl command  (Ctrl+Shift+V)"
        >
          <Icon name="terminal" /> curl
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void importFromFile()} title="Import OpenAPI, Postman or a shared collection">
          <Icon name="download" /> Import
        </button>
        <button className="btn-icon" onClick={() => openModal({ kind: 'cookies' })} title="Cookie jar" aria-label="Cookie jar">
          <Icon name="cookie" />
        </button>
        <button className="btn-icon" onClick={() => openModal({ kind: 'settings' })} title="Settings  (Ctrl+,)" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </div>

      <div className="window-controls">
        <button className="window-btn" onClick={() => window.api.app.minimize()} aria-label="Minimise">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5h8" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
        <button className="window-btn" onClick={() => window.api.app.toggleMaximize()} aria-label={maximized ? 'Restore' : 'Maximise'}>
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 3.5h4v4h-4zM3.5 2.5h4v4" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
          )}
        </button>
        <button className="window-btn is-close" onClick={() => window.api.app.close()} aria-label="Close">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" /></svg>
        </button>
      </div>
    </header>
  )
}

function NoTab() {
  const collections = useStore((s) => s.collections)
  const addRequest = useStore((s) => s.addRequest)
  const importFromFile = useStore((s) => s.importFromFile)
  const openModal = useStore((s) => s.openModal)

  return (
    <div className="empty-state">
      <p className="plate">No request open</p>
      <p>Pick one from the left, or start something new.</p>
      <div className="empty-actions">
        <button
          className="btn btn-primary"
          disabled={!collections.length}
          onClick={() => collections[0] && addRequest(collections[0].id, null)}
        >
          New request
        </button>
        <button className="btn" onClick={() => openModal({ kind: 'curl-import', tabId: null })}>
          Paste curl
        </button>
        <button className="btn" onClick={() => void importFromFile()}>
          Import a spec
        </button>
      </div>
      <p className="empty-hint">
        <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> sends ·{' '}
        <span className="kbd">Ctrl</span>+<span className="kbd">L</span> focuses the URL ·{' '}
        <span className="kbd">Ctrl</span>+<span className="kbd">P</span> searches requests
      </p>
    </div>
  )
}
