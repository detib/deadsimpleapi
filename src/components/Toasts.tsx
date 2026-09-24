import { useStore } from '../state/store'
import { Icon } from './ui/Icon'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  if (!toasts.length) return null

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast is-${toast.kind}`} role="status">
          <div>
            <div className="toast-text">{toast.text}</div>
            {toast.detail && <div className="toast-detail">{toast.detail}</div>}
          </div>
          <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label="Dismiss">
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
