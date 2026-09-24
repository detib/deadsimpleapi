import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/primitives.css'
import './styles/layout.css'

import { App } from './App'
import { useStore } from './state/store'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root')

// Kick persistence reads off before React mounts; the shell renders instantly
// and fills in as the promises land.
void useStore.getState().bootstrap()

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
