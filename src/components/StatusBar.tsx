import { useEffect, useState } from 'react'

import type { AppInfo } from '../../shared/api'
import { useStore } from '../state/store'
import { formatBytes } from '../lib/format'

export function StatusBar() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const historyCount = useStore((s) => s.history.length)
  const collectionCount = useStore((s) => s.collections.length)

  const exec = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.exec ?? null
  })

  useEffect(() => {
    void window.api.app.info().then(setInfo)
  }, [])

  const live = exec?.stream

  return (
    <footer className="statusbar">
      {exec?.status === 'sending' && (
        <span className="statusbar-item">
          <span className="spinner" style={{ width: 9, height: 9 }} />
          {live?.status ? `${live.status} · streaming ${formatBytes(live.bytes)}` : 'Sending…'}
        </span>
      )}

      <span className="statusbar-spacer" />

      <span className="statusbar-item">
        {collectionCount} collection{collectionCount === 1 ? '' : 's'}
      </span>
      <span className="statusbar-item">{historyCount} in history</span>

      <button
        onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        title="Switch theme"
      >
        {theme === 'dark' ? 'Dark' : 'Light'}
      </button>

      <button onClick={() => void window.api.app.revealDataDir()} title={info?.dataDir}>
        Data folder
      </button>

      {info && <span className="statusbar-item">v{info.version}</span>}
    </footer>
  )
}
