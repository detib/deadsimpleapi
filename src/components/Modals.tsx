import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import type { AppInfo, ImportKind, ImportOutcome } from '../../shared/api'
import type {
  ApiRequest,
  AppSettings,
  Auth,
  AuthType,
  Body,
  Collection,
  JarCookie,
  RequestSettings,
  VariableSet,
} from '../../shared/types'
import { newRequest, uid } from '../../shared/factory'
import { formatBytes, methodClass, truncateMiddle } from '../lib/format'
import { DYNAMIC_VARS, buildScope, resolve, type VarScope } from '../lib/variables'
import { buildWire, effectiveAuth } from '../lib/wire'
import { folderPath } from '../state/tree'
import {
  useCollection,
  useStore,
  useTabCollection,
  useTabRequest,
  type CollectionTab,
} from '../state/store'
import { AuthEditor } from './RequestPanel'
import { CodeEditor } from './ui/CodeEditor'
import { Icon, type IconName } from './ui/Icon'
import { KVTable } from './ui/KVTable'
import './Modals.css'

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const EMPTY_SCOPE: Map<string, VarScope> = new Map()

function notify(kind: 'info' | 'success' | 'error', text: string, detail?: string): void {
  useStore.getState().toast(kind, text, detail)
}

function copyToClipboard(value: string, success: string): void {
  void navigator.clipboard.writeText(value).then(
    () => notify('success', success),
    (err: unknown) => notify('error', 'Could not copy', String(err)),
  )
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function byteLength(input: string): number {
  return new TextEncoder().encode(input).length
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export function Modals(): JSX.Element | null {
  const modal = useStore((s) => s.modal)
  if (!modal) return null

  switch (modal.kind) {
    case 'settings':
      return <SettingsDialog />
    case 'cookies':
      return <CookiesDialog />
    case 'curl-import':
      return <CurlImportDialog tabId={modal.tabId} />
    case 'curl-export':
      return <CurlExportDialog tabId={modal.tabId} />
    case 'collection':
      return <CollectionDialog collectionId={modal.collectionId} initialTab={modal.tab} />
    case 'import-report':
      return <ImportReportDialog outcomes={modal.outcomes} />
    case 'confirm':
      return (
        <ConfirmDialog
          title={modal.title}
          message={modal.message}
          confirmLabel={modal.confirmLabel}
          onConfirm={modal.onConfirm}
        />
      )
  }
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

const FOCUSABLE = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface ShellProps {
  title: string
  children: ReactNode
  onClose: () => void
  foot?: ReactNode
  headExtra?: ReactNode
  /** Width and height variants appended to .modal. */
  className?: string
  bodyClassName?: string
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

/**
 * The frame every dialog shares: portalled to body, focus-trapped, and
 * restoring focus to whatever opened it. Escape is handled globally in App.
 */
function ModalShell({
  title,
  children,
  onClose,
  foot,
  headExtra,
  className,
  bodyClassName,
  onKeyDown,
}: ShellProps): JSX.Element {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = ref.current
    if (root) {
      const target =
        root.querySelector<HTMLElement>('[data-autofocus]') ??
        root.querySelector<HTMLElement>(FOCUSABLE)
      target?.focus()
      // A disabled or unfocusable target would leave focus on <body>, from
      // where Tab escapes into the app behind the scrim.
      if (!root.contains(document.activeElement)) root.focus()
    }
    return () => {
      // The opener can be gone by now: a deleted row, a closed tab.
      if (previous && document.contains(previous)) previous.focus()
    }
  }, [])

  // The trap lives on the document, not on the dialog element: when the control
  // holding focus is removed (a deleted row, a footer that swapped buttons)
  // focus falls back to <body>, and a keydown there never reaches the dialog.
  useEffect(() => {
    const onTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented) return
      const root = ref.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      const active = document.activeElement
      if (!items.length) {
        event.preventDefault()
        root.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const inside = active !== root && active instanceof HTMLElement && root.contains(active)
      if (!inside) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // Bubble phase, so a control that wants Tab for itself can preventDefault first.
    document.addEventListener('keydown', onTab)
    return () => document.removeEventListener('keydown', onTab)
  }, [])

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {headExtra}
          <div className="mdl-head-spacer" />
          <button className="btn-icon" onClick={onClose} aria-label="Close dialog" title="Close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>

        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ------------------------------------------------------------------ */
/* Form primitives                                                     */
/* ------------------------------------------------------------------ */

function Field(props: {
  label: string
  hint?: string
  controlId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="mdl-field">
      <div className="mdl-field-text">
        {/* A <label> pointing at nothing is worse than none: the control it
            describes (a segmented group, a button) carries its own name. */}
        {props.controlId ? (
          <label className="mdl-field-label" htmlFor={props.controlId}>
            {props.label}
          </label>
        ) : (
          <span className="mdl-field-label">{props.label}</span>
        )}
        {props.hint && <p className="mdl-field-hint">{props.hint}</p>}
      </div>
      <div className="mdl-field-control">{props.children}</div>
    </div>
  )
}

function SwitchField(props: {
  label: string
  hint?: string
  checked: boolean
  onChange: (value: boolean) => void
}): JSX.Element {
  const id = useId()
  return (
    <Field label={props.label} hint={props.hint} controlId={id}>
      <input
        id={id}
        type="checkbox"
        className="switch"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </Field>
  )
}

function NumberField(props: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  onCommit: (value: number) => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(() => String(props.value))

  // Only re-sync when the store really diverged, so typing is never clobbered.
  useEffect(() => {
    setDraft((current) => (Number(current) === props.value ? current : String(props.value)))
  }, [props.value])

  const change = (raw: string) => {
    setDraft(raw)
    const parsed = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(parsed)) return
    if (parsed < props.min || parsed > props.max) return
    if (parsed !== props.value) props.onCommit(parsed)
  }

  const settle = () => {
    const parsed = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(parsed)) {
      setDraft(String(props.value))
      return
    }
    const clamped = Math.min(props.max, Math.max(props.min, parsed))
    setDraft(String(clamped))
    if (clamped !== props.value) props.onCommit(clamped)
  }

  return (
    <Field label={props.label} hint={props.hint} controlId={id}>
      <div className="mdl-number">
        <input
          id={id}
          className="input mdl-number-input"
          type="number"
          inputMode="numeric"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={draft}
          onChange={(event) => change(event.target.value)}
          onBlur={settle}
        />
        {props.suffix && <span className="plate mdl-suffix">{props.suffix}</span>}
      </div>
    </Field>
  )
}

function TextField(props: {
  label: string
  hint?: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(props.value)
  const editing = useRef(false)

  // Settings round-trip through IPC before they land back in the store, so a
  // directly controlled value snaps back to the pre-patch string for a frame
  // and drags the caret to the end of the field on every keystroke.
  useEffect(() => {
    if (!editing.current) setDraft(props.value)
  }, [props.value])

  return (
    <Field label={props.label} hint={props.hint} controlId={id}>
      <input
        id={id}
        className="input"
        type="text"
        value={draft}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => {
          editing.current = true
        }}
        onBlur={() => {
          editing.current = false
          // The main process normalises what it stores (a proxy is trimmed).
          setDraft(props.value)
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          props.onChange(event.target.value)
        }}
      />
    </Field>
  )
}

/** A slider whose readout tracks the drag while the store is written at most every 120ms. */
function RangeField(props: {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onCommit: (value: number) => void
}): JSX.Element {
  const id = useId()
  const [local, setLocal] = useState(props.value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitRef = useRef(props.onCommit)
  commitRef.current = props.onCommit

  useEffect(() => {
    setLocal(props.value)
  }, [props.value])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const change = (next: number) => {
    setLocal(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commitRef.current(next), 120)
  }

  return (
    <Field label={props.label} hint={props.hint} controlId={id}>
      <div className="mdl-range">
        <input
          id={id}
          className="mdl-range-input"
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={local}
          onChange={(event) => change(Number(event.target.value))}
        />
        <span className="mono mdl-range-value">{props.format(local)}</span>
      </div>
    </Field>
  )
}

function Segmented<T extends string>(props: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  ariaLabel: string
  autofocus?: boolean
}): JSX.Element {
  return (
    <div className="mdl-seg" role="group" aria-label={props.ariaLabel}>
      {props.options.map((option) => {
        const selected = option.value === props.value
        return (
          <button
            key={option.value}
            type="button"
            className="mdl-seg-btn"
            aria-pressed={selected}
            data-autofocus={props.autofocus && selected ? '' : undefined}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Inline name entry, used for adding and renaming variable sets. */
function InlineName(props: {
  initial: string
  ariaLabel: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    if (settled.current) return
    settled.current = true
    props.onCommit(ref.current?.value ?? '')
  }

  return (
    <input
      ref={ref}
      className="input mdl-inline-name"
      defaultValue={props.initial}
      aria-label={props.ariaLabel}
      spellCheck={false}
      autoComplete="off"
      data-autofocus=""
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          // Otherwise App's global Escape handler would close the whole dialog.
          event.stopPropagation()
          event.preventDefault()
          settled.current = true
          props.onCancel()
        }
      }}
    />
  )
}

/* ------------------------------------------------------------------ */
/* 1. Settings                                                         */
/* ------------------------------------------------------------------ */

const MEBIBYTE = 1024 * 1024

function SettingsDialog(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const patchSettings = useStore((s) => s.patchSettings)
  const close = useStore((s) => s.closeModal)
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.app.info().then(
      (result) => {
        if (alive) setInfo(result)
      },
      (err: unknown) => notify('error', 'Could not read app info', errorText(err)),
    )
    return () => {
      alive = false
    }
  }, [])

  const apply = useCallback(
    (patch: Partial<AppSettings>) => {
      void patchSettings(patch).catch((err: unknown) =>
        notify('error', 'Could not save settings', errorText(err)),
      )
    },
    [patchSettings],
  )

  const applyDefault = useCallback(
    (patch: Partial<RequestSettings>) => {
      const current = useStore.getState().settings.defaultSettings
      apply({ defaultSettings: { ...current, ...patch } })
    },
    [apply],
  )

  const defaults = settings.defaultSettings

  return (
    <ModalShell
      title="Settings"
      onClose={close}
      className="mdl-w-lg"
      foot={
        <button className="btn btn-primary" onClick={close}>
          Close
        </button>
      }
    >
      <p className="mdl-lede">Every change here takes effect immediately.</p>

      <section className="mdl-sec">
        <h3 className="plate mdl-sec-title">Appearance</h3>
        <div className="mdl-fields">
          <Field label="Theme" hint="Graphite chassis, or a paper-white faceplate.">
            <Segmented
              value={settings.theme}
              ariaLabel="Theme"
              autofocus
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(theme) => apply({ theme })}
            />
          </Field>

          <RangeField
            label="UI scale"
            hint="Scales type and control heights across the window."
            value={settings.uiScale}
            min={0.8}
            max={1.6}
            step={0.05}
            format={(value) => `${Math.round(value * 100)}%`}
            onCommit={(uiScale) => apply({ uiScale })}
          />

          <RangeField
            label="Editor font size"
            hint="Request bodies and the response viewer."
            value={settings.editorFontSize}
            min={9}
            max={24}
            step={0.5}
            format={(value) => `${value} px`}
            onCommit={(editorFontSize) => apply({ editorFontSize })}
          />

          <SwitchField
            label="Wrap lines"
            hint="Soft-wrap long lines instead of scrolling sideways."
            checked={settings.wrapLines}
            onChange={(wrapLines) => apply({ wrapLines })}
          />
        </div>
      </section>

      <section className="mdl-sec">
        <h3 className="plate mdl-sec-title">Requests</h3>
        <p className="mdl-sec-note">
          App-wide defaults. A collection or a single request can override any of them.
        </p>
        <div className="mdl-fields">
          <SwitchField
            label="Follow redirects"
            checked={defaults.followRedirects}
            onChange={(followRedirects) => applyDefault({ followRedirects })}
          />
          <NumberField
            label="Maximum redirects"
            hint="How many hops before the chain is treated as a loop."
            value={defaults.maxRedirects}
            min={0}
            max={50}
            onCommit={(maxRedirects) => applyDefault({ maxRedirects })}
          />
          <NumberField
            label="Timeout"
            hint="0 waits forever."
            value={defaults.timeoutMs}
            min={0}
            max={3600000}
            step={1000}
            suffix="ms"
            onCommit={(timeoutMs) => applyDefault({ timeoutMs })}
          />
          <SwitchField
            label="Verify TLS certificates"
            hint="Off accepts self-signed and expired certificates."
            checked={defaults.verifyTls}
            onChange={(verifyTls) => applyDefault({ verifyTls })}
          />
          <SwitchField
            label="Encode URL"
            hint="Percent-encode the path and query before sending."
            checked={defaults.encodeUrl}
            onChange={(encodeUrl) => applyDefault({ encodeUrl })}
          />
          <SwitchField
            label="Send cookies"
            hint="Attach matching cookies from the local jar."
            checked={defaults.sendCookies}
            onChange={(sendCookies) => applyDefault({ sendCookies })}
          />
          <SwitchField
            label="Store cookies"
            hint="Keep Set-Cookie responses in the local jar."
            checked={defaults.storeCookies}
            onChange={(storeCookies) => applyDefault({ storeCookies })}
          />
          <SwitchField
            label="Decompress"
            hint="Send Accept-Encoding and unpack the response body."
            checked={defaults.decompress}
            onChange={(decompress) => applyDefault({ decompress })}
          />
          <SwitchField
            label="Stream response"
            hint="Show chunks as they arrive, for SSE and long polls."
            checked={defaults.streamResponse}
            onChange={(streamResponse) => applyDefault({ streamResponse })}
          />
          <TextField
            label="Proxy"
            hint="Empty means no proxy."
            value={defaults.proxy}
            placeholder="http://127.0.0.1:8080"
            onChange={(proxy) => applyDefault({ proxy })}
          />
        </div>
      </section>

      <section className="mdl-sec">
        <h3 className="plate mdl-sec-title">Data</h3>
        <div className="mdl-fields">
          <NumberField
            label="History limit"
            hint="Older calls fall off the end of the list."
            value={settings.historyLimit}
            min={0}
            max={10000}
            step={50}
            suffix="calls"
            onCommit={(historyLimit) => apply({ historyLimit })}
          />
          <NumberField
            label="Inline body cap"
            hint="Bigger bodies are spilled to a file instead of crossing IPC."
            value={Math.round((settings.inlineBodyCapBytes / MEBIBYTE) * 10) / 10}
            min={1}
            max={512}
            step={1}
            suffix="MB"
            onCommit={(mb) => apply({ inlineBodyCapBytes: Math.round(mb * MEBIBYTE) })}
          />
          <SwitchField
            label="Confirm before deleting"
            hint="Ask before removing a request, folder or collection."
            checked={settings.confirmDelete}
            onChange={(confirmDelete) => apply({ confirmDelete })}
          />
          <Field label="Data folder" hint="Collections, history, cookies and settings live here.">
            <button className="btn" onClick={() => void window.api.app.revealDataDir()}>
              <Icon name="external" size={12} /> Open data folder
            </button>
          </Field>
        </div>
        <p className="mono mdl-path">{info?.dataDir ?? '—'}</p>
      </section>

      <section className="mdl-sec">
        <h3 className="plate mdl-sec-title">About</h3>
        <dl className="mdl-about">
          <div className="mdl-about-row">
            <dt className="plate">Deadsimple</dt>
            <dd className="mono">{info?.version ?? '—'}</dd>
          </div>
          <div className="mdl-about-row">
            <dt className="plate">Electron</dt>
            <dd className="mono">{info?.electron ?? '—'}</dd>
          </div>
          <div className="mdl-about-row">
            <dt className="plate">Chromium</dt>
            <dd className="mono">{info?.chrome ?? '—'}</dd>
          </div>
          <div className="mdl-about-row">
            <dt className="plate">Node</dt>
            <dd className="mono">{info?.node ?? '—'}</dd>
          </div>
          <div className="mdl-about-row">
            <dt className="plate">Platform</dt>
            <dd className="mono">{info?.platform ?? '—'}</dd>
          </div>
        </dl>
      </section>
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Cookie jar                                                       */
/* ------------------------------------------------------------------ */

type CookieSort = 'name' | 'value' | 'domain' | 'path' | 'expires'

const COOKIE_COLUMNS: ReadonlyArray<{ key: CookieSort; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'value', label: 'Value' },
  { key: 'domain', label: 'Domain' },
  { key: 'path', label: 'Path' },
  { key: 'expires', label: 'Expires' },
]

interface CookieGroup {
  domain: string
  rows: JarCookie[]
}

function cookieKey(cookie: JarCookie): string {
  return `${cookie.domain}|${cookie.path}|${cookie.name}`
}

function expiryText(cookie: JarCookie): string {
  if (!cookie.expires) return 'session'
  const at = new Date(cookie.expires)
  return Number.isFinite(at.getTime()) ? at.toLocaleString() : 'session'
}

function CookiesDialog(): JSX.Element {
  const close = useStore((s) => s.closeModal)
  const [cookies, setCookies] = useState<JarCookie[] | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: CookieSort; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [confirmingClear, setConfirmingClear] = useState(false)
  const keepRef = useRef<HTMLButtonElement>(null)

  // The button that raised the question is unmounted with it: React reuses the
  // <button> slot rather than remounting, so autoFocus would never fire.
  useEffect(() => {
    if (confirmingClear) keepRef.current?.focus()
  }, [confirmingClear])

  const refresh = useCallback(() => {
    void window.api.cookies.list().then(
      (list) => setCookies(list),
      (err: unknown) => {
        setCookies([])
        notify('error', 'Could not read the cookie jar', errorText(err))
      },
    )
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const groups = useMemo<CookieGroup[]>(() => {
    const needle = query.trim().toLowerCase()
    const matched = (cookies ?? []).filter((cookie) =>
      needle
        ? `${cookie.name} ${cookie.value} ${cookie.domain} ${cookie.path}`
            .toLowerCase()
            .includes(needle)
        : true,
    )

    const key = sort.key
    const dir = sort.dir
    const compare = (a: JarCookie, b: JarCookie): number => {
      if (key === 'expires') {
        // Session cookies sort last: they outlive every dated one in practice.
        const left = a.expires ?? Number.POSITIVE_INFINITY
        const right = b.expires ?? Number.POSITIVE_INFINITY
        return (left === right ? 0 : left < right ? -1 : 1) * dir
      }
      return a[key].localeCompare(b[key]) * dir
    }

    const byDomain = new Map<string, JarCookie[]>()
    for (const cookie of matched) {
      const bucket = byDomain.get(cookie.domain)
      if (bucket) bucket.push(cookie)
      else byDomain.set(cookie.domain, [cookie])
    }

    return [...byDomain.entries()]
      .map(([domain, rows]) => ({ domain, rows: rows.slice().sort(compare) }))
      .sort((a, b) => a.domain.localeCompare(b.domain) * (sort.key === 'domain' ? sort.dir : 1))
  }, [cookies, query, sort])

  const total = cookies?.length ?? 0
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0)

  const remove = (cookie: JarCookie) => {
    void window.api.cookies.remove(cookie.name, cookie.domain, cookie.path).then(
      () => refresh(),
      (err: unknown) => notify('error', 'Could not delete cookie', errorText(err)),
    )
  }

  const clearAll = () => {
    setConfirmingClear(false)
    void window.api.cookies.clear().then(
      () => {
        refresh()
        notify('success', 'Cookie jar emptied')
      },
      (err: unknown) => notify('error', 'Could not clear the jar', errorText(err)),
    )
  }

  return (
    <ModalShell
      title="Cookie jar"
      onClose={close}
      className="mdl-w-xl mdl-tall"
      bodyClassName="mdl-body-flush"
      headExtra={
        <button
          className="btn btn-ghost btn-sm"
          onClick={refresh}
          title="Reload the jar"
          aria-label="Reload the jar"
        >
          <Icon name="refresh" size={12} /> Reload
        </button>
      }
      foot={
        confirmingClear ? (
          <>
            {/* The button that opened this is gone, so the question has to be
                announced and focus has to land on the harmless answer. */}
            <span className="mdl-foot-note" role="status">
              Delete all {total} cookies? Sites will sign you out.
            </span>
            <button className="btn" ref={keepRef} onClick={() => setConfirmingClear(false)}>
              Keep them
            </button>
            <button className="btn btn-danger" onClick={clearAll}>
              Delete all
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-danger mdl-foot-lead"
              disabled={!total}
              onClick={() => setConfirmingClear(true)}
            >
              <Icon name="trash" size={12} /> Clear all cookies
            </button>
            <button className="btn btn-primary" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      <div className="mdl-ck-bar">
        <div className="mdl-search">
          <Icon name="search" size={12} />
          <input
            className="mdl-search-input"
            type="search"
            value={query}
            placeholder="Filter by name, value, domain or path"
            aria-label="Filter cookies"
            spellCheck={false}
            data-autofocus=""
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="plate mdl-ck-count">
          {query ? `${shown} of ${total}` : `${total} cookies`}
        </span>
      </div>

      {cookies === null ? (
        <div className="empty-state">
          <span className="spinner" /> Reading the jar…
        </div>
      ) : total === 0 ? (
        <div className="empty-state">
          <p className="plate">Jar is empty</p>
          <p>Responses that set cookies will land here, provided storing is on.</p>
        </div>
      ) : shown === 0 ? (
        <div className="empty-state">
          <p className="plate">No matches</p>
          <p>Nothing in the jar matches “{query}”.</p>
        </div>
      ) : (
        <div className="mdl-ck-scroll">
          <table className="table-lite mdl-ck-table">
            <thead>
              <tr>
                {COOKIE_COLUMNS.map((column) => (
                  <th
                    key={column.key}
                    aria-sort={
                      sort.key === column.key
                        ? sort.dir === 1
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
                  >
                    <button
                      className="mdl-sort"
                      onClick={() =>
                        setSort((current) =>
                          current.key === column.key
                            ? { key: column.key, dir: current.dir === 1 ? -1 : 1 }
                            : { key: column.key, dir: 1 },
                        )
                      }
                    >
                      {column.label}
                      {sort.key === column.key && (
                        <Icon name={sort.dir === 1 ? 'sort-asc' : 'sort-desc'} size={11} />
                      )}
                    </button>
                  </th>
                ))}
                <th>Flags</th>
                <th className="mdl-ck-actions-head">
                  <span className="mdl-sr">Actions</span>
                </th>
              </tr>
            </thead>

            {groups.map((group) => (
              <tbody key={group.domain}>
                <tr className="mdl-ck-group">
                  <th colSpan={7} scope="colgroup">
                    <span className="mono">{group.domain}</span>
                    <span className="plate mdl-ck-group-count">{group.rows.length}</span>
                  </th>
                </tr>
                {group.rows.map((cookie) => (
                  <tr key={cookieKey(cookie)}>
                    <td>{cookie.name}</td>
                    <td className="mdl-ck-value" title={cookie.value}>
                      {truncateMiddle(cookie.value, 44)}
                    </td>
                    <td>{cookie.domain}</td>
                    <td>{cookie.path}</td>
                    <td className={cookie.expires ? undefined : 'mdl-faint'}>
                      {expiryText(cookie)}
                    </td>
                    <td>
                      <span className="mdl-ck-flags">
                        {cookie.secure && <span className="chip">Secure</span>}
                        {cookie.httpOnly && <span className="chip">HttpOnly</span>}
                        {cookie.sameSite && <span className="chip">SameSite {cookie.sameSite}</span>}
                        {cookie.hostOnly && <span className="chip">Host only</span>}
                      </span>
                    </td>
                    <td className="mdl-ck-actions">
                      <button
                        className="btn-icon btn-xs is-danger"
                        title="Delete cookie"
                        aria-label={`Delete cookie ${cookie.name} for ${cookie.domain}`}
                        onClick={() => remove(cookie)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 3. curl import                                                      */
/* ------------------------------------------------------------------ */

const CURL_PLACEHOLDER = `curl -X POST 'https://api.example.com/v1/orders' \
  -H 'Authorization: Bearer {{token}}' \
  -H 'Content-Type: application/json' \
  -d '{"sku":"DS-1","qty":2}'`

/**
 * The parser hands back `unknown`. Anything with a method is accepted and then
 * folded onto a fresh request, so a partial payload still yields a complete
 * ApiRequest rather than a half-built object the rest of the app would trip on.
 */
function normalizeParsed(value: unknown): ApiRequest | null {
  if (typeof value !== 'object' || value === null || !('method' in value)) return null
  const raw = value as Partial<ApiRequest>
  if (typeof raw.method !== 'string') return null
  const base = newRequest()
  return {
    ...base,
    ...raw,
    id: base.id,
    kind: 'request',
    protocol: 'http',
    body: { ...base.body, ...raw.body },
    auth: { ...base.auth, ...raw.auth },
  }
}

function bodyBytes(body: Body): number {
  switch (body.mode) {
    case 'none':
    case 'binary':
      return 0
    case 'form-urlencoded':
      return byteLength(
        body.form
          .filter((row) => row.enabled)
          .map((row) => `${row.key}=${row.value}`)
          .join('&'),
      )
    case 'multipart':
      return body.multipart
        .filter((field) => field.enabled)
        .reduce((sum, field) => sum + byteLength(field.key) + byteLength(field.value), 0)
    case 'graphql':
      return byteLength(body.graphql.query) + byteLength(body.graphql.variables)
    default:
      return byteLength(body.text)
  }
}

function CurlImportDialog({ tabId }: { tabId: string | null }): JSX.Element {
  const close = useStore((s) => s.closeModal)
  const patchRequest = useStore((s) => s.patchRequest)
  const openScratch = useStore((s) => s.openScratch)

  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ApiRequest | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const source = text.trim()
    if (!source) {
      seq.current++
      setParsed(null)
      setWarnings([])
      setError(null)
      setParsing(false)
      return
    }
    setParsing(true)
    const mine = ++seq.current
    const timer = setTimeout(() => {
      void window.api.curl.parse(source).then(
        (result) => {
          if (mine !== seq.current) return
          setParsing(false)
          setWarnings(result.warnings ?? [])
          const request = normalizeParsed(result.request)
          if (!request) {
            setParsed(null)
            setError('That does not look like a curl command yet.')
            return
          }
          setParsed(request)
          setError(null)
        },
        (err: unknown) => {
          if (mine !== seq.current) return
          setParsing(false)
          setParsed(null)
          // Warnings belong to the parse that produced them, not to this one.
          setWarnings([])
          setError(errorText(err))
        },
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [text])

  /** Crossing into the textarea fires dragleave on the wrapper it sits in. */
  const onDragLeave = (event: React.DragEvent) => {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    setDragging(false)
  }

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    if (!/\.(txt|sh|curl)$/i.test(file.name) && !file.type.startsWith('text/')) {
      notify('error', 'Drop a .txt or .sh file')
      return
    }
    void file.text().then(setText, (err: unknown) =>
      notify('error', 'Could not read that file', errorText(err)),
    )
  }

  const replace = () => {
    if (!tabId || !parsed) return
    patchRequest(tabId, {
      method: parsed.method,
      url: parsed.url,
      params: parsed.params,
      pathParams: parsed.pathParams,
      headers: parsed.headers,
      cookies: parsed.cookies,
      body: parsed.body,
      auth: parsed.auth,
    })
    close()
    notify('success', 'Request replaced from curl')
  }

  const openNew = () => {
    if (!parsed) return
    openScratch(parsed)
    close()
  }

  const headerCount = parsed?.headers.filter((row) => row.enabled).length ?? 0
  const paramCount = parsed?.params.filter((row) => row.enabled).length ?? 0
  // Encoding the body is O(body); the textarea re-renders on every keystroke.
  const bytes = useMemo(() => (parsed ? bodyBytes(parsed.body) : 0), [parsed])

  return (
    <ModalShell
      title="Import curl"
      onClose={close}
      className="mdl-w-lg"
      foot={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={!tabId || !parsed}
            title={tabId ? undefined : 'No request is open to replace'}
            onClick={replace}
          >
            Replace this request
          </button>
          <button className="btn btn-primary" disabled={!parsed} onClick={openNew}>
            Open as new request
          </button>
        </>
      }
    >
      <div
        className={`mdl-drop${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <textarea
          className="textarea mdl-curl-input"
          value={text}
          spellCheck={false}
          autoComplete="off"
          data-autofocus=""
          aria-label="curl command"
          placeholder={CURL_PLACEHOLDER}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="mdl-drop-hint">Paste a command, or drop a .txt or .sh file here.</p>
      </div>

      {error && (
        <p className="mdl-inline-error" role="alert">
          <Icon name="alert" size={12} /> {error}
        </p>
      )}

      <section className="mdl-preview" aria-live="polite">
        <h3 className="plate mdl-sec-title">
          Will be created {parsing && <span className="spinner mdl-preview-spinner" />}
        </h3>

        {parsed ? (
          <>
            <div className="mdl-preview-line">
              <span className={`method-badge mdl-method ${methodClass(parsed.method)}`}>
                {parsed.method}
              </span>
              <span className="mono truncate mdl-preview-url" title={parsed.url}>
                {parsed.url || '(no URL)'}
              </span>
            </div>
            <div className="mdl-preview-stats">
              <span className="chip">
                {headerCount} header{headerCount === 1 ? '' : 's'}
              </span>
              <span className="chip">
                {paramCount} param{paramCount === 1 ? '' : 's'}
              </span>
              <span className="chip">
                {parsed.body.mode === 'none' ? 'no body' : `${formatBytes(bytes)} body`}
              </span>
              {parsed.auth.type !== 'inherit' && parsed.auth.type !== 'none' && (
                <span className="chip chip-signal">{parsed.auth.type} auth</span>
              )}
            </div>
          </>
        ) : (
          <p className="mdl-preview-empty">Nothing parsed yet.</p>
        )}

        {warnings.length > 0 && (
          <ul className="mdl-warn-list scroll-y">
            {warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        )}
      </section>
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 4. curl export                                                      */
/* ------------------------------------------------------------------ */

type CurlPlatform = 'sh' | 'powershell' | 'cmd'

const PLATFORMS: ReadonlyArray<{ value: CurlPlatform; label: string }> = [
  { value: 'sh', label: 'sh' },
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'cmd' },
]

const AUTH_WARNING: Partial<Record<string, string>> = {
  bearer: 'the resolved bearer token',
  basic: 'the base64 of your username and password',
  apikey: 'the resolved API key',
}

function CurlExportDialog({ tabId }: { tabId: string }): JSX.Element {
  const close = useStore((s) => s.closeModal)
  const request = useTabRequest(tabId)
  const collection = useTabCollection(tabId)
  const requestId = useStore((s) => s.tabs.find((t) => t.id === tabId)?.requestId ?? null)
  const appDefaults = useStore((s) => s.settings.defaultSettings)
  const editorFontSize = useStore((s) => s.settings.editorFontSize)

  const [platform, setPlatform] = useState<CurlPlatform>(() =>
    /win/i.test(navigator.userAgent) ? 'powershell' : 'sh',
  )
  const [multiline, setMultiline] = useState(true)
  const [longFlags, setLongFlags] = useState(false)
  const [command, setCommand] = useState('')
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const built = useMemo(() => {
    if (!request) return null
    const folders =
      collection && requestId ? folderPath(collection.children, requestId) ?? [] : []
    const ctx = { collection, folders, appDefaults, execId: 'preview' }
    const { wire, issues } = buildWire(request, ctx)
    return { wire, issues, auth: effectiveAuth(request, ctx) }
  }, [request, collection, requestId, appDefaults])

  useEffect(() => {
    const wire = built?.wire
    if (!wire) {
      setCommand('')
      return
    }
    let alive = true
    void window.api.curl.generate(wire, { platform, multiline, longFlags }).then(
      (result) => {
        if (alive) setCommand(result)
      },
      (err: unknown) => {
        if (!alive) return
        setCommand('')
        notify('error', 'Could not build the command', errorText(err))
      },
    )
    return () => {
      alive = false
    }
  }, [built, platform, multiline, longFlags])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const copy = () => {
    if (!command) return
    void navigator.clipboard.writeText(command).then(
      () => {
        setCopied(true)
        if (copyTimer.current) clearTimeout(copyTimer.current)
        copyTimer.current = setTimeout(() => setCopied(false), 1500)
      },
      (err: unknown) => notify('error', 'Could not copy', errorText(err)),
    )
  }

  const secret = built ? AUTH_WARNING[built.auth.type] : undefined

  return (
    <ModalShell
      title="Copy as curl"
      onClose={close}
      className="mdl-w-xl"
      foot={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!command}
            onClick={copy}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} /> {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      }
    >
      {!request ? (
        <div className="empty-state">
          <p className="plate">Nothing to export</p>
          <p>This tab no longer holds a request.</p>
        </div>
      ) : (
        <>
          <div className="mdl-opts">
            <Segmented
              value={platform}
              options={PLATFORMS}
              autofocus
              ariaLabel="Shell"
              onChange={setPlatform}
            />
            <label className="mdl-opt">
              <input
                type="checkbox"
                className="switch"
                checked={multiline}
                onChange={(event) => setMultiline(event.target.checked)}
              />
              <span>Multiline</span>
            </label>
            <label className="mdl-opt">
              <input
                type="checkbox"
                className="switch"
                checked={longFlags}
                onChange={(event) => setLongFlags(event.target.checked)}
              />
              <span>Long flags</span>
            </label>
          </div>

          {secret && (
            <p className="mdl-warn-strip" role="note">
              <Icon name="lock" size={12} />
              <span>
                This command carries {secret} in clear text. Strip it before pasting anywhere you
                would not paste the credential itself.
              </span>
            </p>
          )}

          {built && built.issues.length > 0 && (
            <ul className="mdl-warn-list scroll-y">
              {built.issues.map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
          )}

          <div className="mdl-curl-out">
            <CodeEditor
              value={command}
              language="text"
              readOnly
              wrap
              showLineNumbers={false}
              fontSize={editorFontSize}
              ariaLabel="Generated curl command"
            />
          </div>
        </>
      )}
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 5. Variables                                                        */
/* ------------------------------------------------------------------ */

const SHARED = '__shared__'

/** Notes for exactly the tokens DYNAMIC_VARS exposes. */
const DYNAMIC_NOTES: Record<string, string> = {
  $uuid: 'Version 4 UUID, fresh on every send',
  $guid: 'Alias of $uuid',
  $timestamp: 'Unix time in whole seconds',
  $isoTimestamp: 'Current time, ISO 8601',
  $randomInt: 'Integer between 0 and 1000',
  '$randomInt:min:max': 'Integer inside a range you pick',
  '$randomHex:n': 'n hex characters, 8 by default',
  '$randomString:n': 'n alphanumeric characters, 16 by default',
  $randomEmail: 'Plausible email address',
  $randomFirstName: 'First name',
  $randomLastName: 'Surname',
  $randomCompany: 'Company name',
  $randomUrl: 'https URL with a path',
  $randomIp: 'IPv4 address',
}

/** Argument-taking tokens need concrete arguments to show a real value. */
const DYNAMIC_SAMPLE: Record<string, string> = {
  '$randomInt:min:max': '$randomInt:10:99',
  '$randomHex:n': '$randomHex:12',
  '$randomString:n': '$randomString:8',
}

const COLLECTION_TABS: ReadonlyArray<{ id: CollectionTab; label: string; icon: IconName }> = [
  { id: 'variables', label: 'Variables', icon: 'variable' },
  { id: 'auth', label: 'Auth', icon: 'key' },
  { id: 'headers', label: 'Headers', icon: 'list' },
]

/**
 * A collection sits at the top of the auth chain, so `inherit` there resolves
 * to nothing at all. The editor shows it as "None" rather than offering a
 * parent that does not exist; the stored value is left alone until edited.
 */
function CollectionAuthPane({
  collection,
  scope,
  patch,
}: {
  collection: Collection
  scope: Map<string, VarScope>
  patch: (id: string, patch: Partial<Collection>) => void
}): JSX.Element {
  const auth: Auth =
    collection.auth.type === 'inherit' ? { ...collection.auth, type: 'none' } : collection.auth

  return (
    <div className="mdl-collpane scroll-y">
      <p className="mdl-collpane-lead">
        Every request that leaves its own Authorization on <strong>Inherit</strong> falls back to
        this, unless a folder in between sets its own.
      </p>
      <AuthEditor
        auth={auth}
        onAuth={(next) => patch(collection.id, { auth: next })}
        scope={scope}
        resolved={auth}
        subject="this collection"
        types={COLLECTION_AUTH_TYPES}
      />
    </div>
  )
}

const COLLECTION_AUTH_TYPES: ReadonlyArray<{ type: AuthType; label: string }> = [
  { type: 'none', label: 'None' },
  { type: 'bearer', label: 'Bearer' },
  { type: 'basic', label: 'Basic' },
  { type: 'apikey', label: 'API key' },
]

function CollectionHeadersPane({
  collection,
  scope,
  patch,
}: {
  collection: Collection
  scope: Map<string, VarScope>
  patch: (id: string, patch: Partial<Collection>) => void
}): JSX.Element {
  return (
    <div className="mdl-collpane scroll-y">
      <p className="mdl-collpane-lead">
        Sent with every request in this collection. A request that sets the same header name wins.
      </p>
      <div className="mdl-vars-table">
        <KVTable
          rows={collection.headers}
          scope={scope}
          keyPlaceholder="Header"
          valuePlaceholder="Value"
          emptyHint="No collection headers — name one in the empty row above to add the first."
          onChange={(headers) => patch(collection.id, { headers })}
        />
      </div>
    </div>
  )
}

function CollectionDialog({
  collectionId,
  initialTab,
}: {
  collectionId: string
  initialTab?: CollectionTab
}): JSX.Element {
  const [tab, setTab] = useState<CollectionTab>(initialTab ?? 'variables')
  const collection = useCollection(collectionId)
  const patchCollection = useStore((s) => s.patchCollection)
  const close = useStore((s) => s.closeModal)
  const setSharedVariables = useStore((s) => s.setSharedVariables)
  const setSetValues = useStore((s) => s.setSetValues)
  const addVariableSet = useStore((s) => s.addVariableSet)
  const renameVariableSet = useStore((s) => s.renameVariableSet)
  const deleteVariableSet = useStore((s) => s.deleteVariableSet)
  const setActiveSet = useStore((s) => s.setActiveSet)

  const [selected, setSelected] = useState<string>(() => collection?.activeSetId ?? SHARED)
  const [adding, setAdding] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [showDynamic, setShowDynamic] = useState(false)
  const [seed, setSeed] = useState(0)
  const sharedRef = useRef<HTMLButtonElement>(null)

  const scope = useMemo(() => buildScope(collection), [collection])

  const dynamic = useMemo(
    () =>
      DYNAMIC_VARS.map((name) => ({
        name,
        note: DYNAMIC_NOTES[name] ?? '',
        example: resolve(`{{${DYNAMIC_SAMPLE[name] ?? name}}}`, EMPTY_SCOPE),
      })),
    // seed is the re-roll button; the values are deliberately regenerated.
    [seed],
  )

  const sets = collection?.sets ?? []
  const set = sets.find((entry) => entry.id === selected) ?? null
  const showingShared = selected === SHARED || !set

  const addSet = (name: string) => {
    setAdding(false)
    const trimmed = name.trim()
    if (!trimmed) return
    addVariableSet(collectionId, trimmed)
    const created = useStore
      .getState()
      .collections.find((entry) => entry.id === collectionId)
      ?.sets.at(-1)
    if (created) setSelected(created.id)
  }

  const duplicateSet = (source: VariableSet) => {
    addVariableSet(collectionId, `${source.name} copy`)
    // The store appends, so the copy is the last set; give its rows new ids.
    const created = useStore
      .getState()
      .collections.find((entry) => entry.id === collectionId)
      ?.sets.at(-1)
    if (!created) return
    setSetValues(
      collectionId,
      created.id,
      source.values.map((row) => ({ ...row, id: uid() })),
    )
    setSelected(created.id)
  }

  const removeSet = (id: string) => {
    setPendingDelete(null)
    deleteVariableSet(collectionId, id)
    if (selected === id) setSelected(SHARED)
    // Both the row and the confirmation that held focus are about to vanish.
    sharedRef.current?.focus()
  }

  if (!collection) {
    return (
      <ModalShell
        title="Collection"
        onClose={close}
        className="mdl-w-lg"
        foot={
          <button className="btn btn-primary" onClick={close}>
            Close
          </button>
        }
      >
        <div className="empty-state">
          <p className="plate">Collection not found</p>
          <p>It was probably deleted while this dialog was open.</p>
        </div>
      </ModalShell>
    )
  }

  const rows = showingShared ? collection.variables : set ? set.values : []
  const doomed = pendingDelete ? sets.find((entry) => entry.id === pendingDelete) ?? null : null

  return (
    <ModalShell
      title={collection.name}
      onClose={close}
      className="mdl-w-xl mdl-tall"
      bodyClassName="mdl-body-flush"
      headExtra={
        <div className="mdl-tabs" role="tablist" aria-label="Collection settings">
          {COLLECTION_TABS.map((entry) => (
            <button
              key={entry.id}
              role="tab"
              aria-selected={tab === entry.id}
              className={`mdl-tab${tab === entry.id ? ' is-on' : ''}`}
              onClick={() => setTab(entry.id)}
            >
              <Icon name={entry.icon} size={12} />
              {entry.label}
            </button>
          ))}
        </div>
      }
      foot={
        <>
          <label className={`mdl-foot-field mdl-foot-lead${tab === 'variables' ? '' : ' is-hidden'}`}>
            <span className="plate">Active set</span>
            <select
              className="select mdl-foot-select"
              value={collection.activeSetId ?? ''}
              onChange={(event) => setActiveSet(collectionId, event.target.value || null)}
            >
              {sets.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {tab === 'auth' && <CollectionAuthPane collection={collection} scope={scope} patch={patchCollection} />}

      {tab === 'headers' && (
        <CollectionHeadersPane collection={collection} scope={scope} patch={patchCollection} />
      )}

      <div className="mdl-vars" hidden={tab !== 'variables'}>
        <div className="mdl-vars-list">
          <div className="mdl-vars-list-head">
            <span className="plate">Sets</span>
            <button
              className="btn-icon btn-xs"
              onClick={() => setAdding(true)}
              title="Add a set"
              aria-label="Add a set"
            >
              <Icon name="plus" size={12} />
            </button>
          </div>

          <ul className="mdl-vars-items scroll-y">
            <li>
              <div className={`mdl-vars-item${showingShared ? ' is-selected' : ''}`}>
                <button
                  ref={sharedRef}
                  className="mdl-vars-pick"
                  aria-current={showingShared ? 'true' : undefined}
                  data-autofocus={showingShared ? '' : undefined}
                  onClick={() => setSelected(SHARED)}
                >
                  <Icon name="pin" size={12} />
                  <span className="truncate">Shared</span>
                  <span className="mono mdl-vars-count">{collection.variables.length}</span>
                </button>
              </div>
            </li>

            {sets.map((entry) => {
              const isSelected = !showingShared && set?.id === entry.id
              const isActive = collection.activeSetId === entry.id
              return (
                <li key={entry.id}>
                  {renamingId === entry.id ? (
                    <div className="mdl-vars-item is-editing">
                      <InlineName
                        initial={entry.name}
                        ariaLabel="Set name"
                        onCommit={(name) => {
                          setRenamingId(null)
                          const trimmed = name.trim()
                          if (trimmed && trimmed !== entry.name) {
                            renameVariableSet(collectionId, entry.id, trimmed)
                          }
                        }}
                        onCancel={() => setRenamingId(null)}
                      />
                    </div>
                  ) : (
                    <div className={`mdl-vars-item${isSelected ? ' is-selected' : ''}`}>
                      <button
                        className="mdl-vars-pick"
                        aria-current={isSelected ? 'true' : undefined}
                        data-autofocus={isSelected ? '' : undefined}
                        onClick={() => setSelected(entry.id)}
                      >
                        <Icon name="variable" size={12} />
                        <span className="truncate">{entry.name}</span>
                        {isActive && <span className="chip chip-signal">Active</span>}
                        <span className="mono mdl-vars-count">{entry.values.length}</span>
                      </button>
                      <div className="mdl-vars-actions">
                        <button
                          className="btn-icon btn-xs"
                          title="Rename"
                          aria-label={`Rename ${entry.name}`}
                          onClick={() => setRenamingId(entry.id)}
                        >
                          <Icon name="edit" size={11} />
                        </button>
                        <button
                          className="btn-icon btn-xs"
                          title="Duplicate"
                          aria-label={`Duplicate ${entry.name}`}
                          onClick={() => duplicateSet(entry)}
                        >
                          <Icon name="copy" size={11} />
                        </button>
                        <button
                          className="btn-icon btn-xs is-danger"
                          title="Delete"
                          aria-label={`Delete ${entry.name}`}
                          onClick={() => setPendingDelete(entry.id)}
                        >
                          <Icon name="trash" size={11} />
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}

            {adding && (
              <li>
                <div className="mdl-vars-item is-editing">
                  <InlineName
                    initial="New set"
                    ariaLabel="New set name"
                    onCommit={addSet}
                    onCancel={() => setAdding(false)}
                  />
                </div>
              </li>
            )}
          </ul>

          {doomed && (
            <div
              className="mdl-vars-confirm"
              role="group"
              aria-label={`Confirm deleting ${doomed.name}`}
            >
              <p>
                Delete “{doomed.name}” and its {doomed.values.length} value
                {doomed.values.length === 1 ? '' : 's'}?
              </p>
              {sets.length === 1 && (
                <p className="mdl-vars-confirm-warn">
                  It is the last set — the collection will be left with shared values only.
                </p>
              )}
              <div className="mdl-vars-confirm-actions">
                <button className="btn btn-sm" autoFocus onClick={() => setPendingDelete(null)}>
                  Keep
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => removeSet(doomed.id)}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mdl-vars-pane">
          <div className="mdl-vars-pane-head">
            <h3 className="plate">{showingShared ? 'Shared values' : set?.name}</h3>
            <p className="mdl-vars-precedence">
              {showingShared
                ? 'Shared values are always in scope, but a key of the same name in the active set wins.'
                : 'Values in the active set win over shared values of the same name.'}
            </p>
          </div>

          <div className="mdl-vars-table">
            <KVTable
              rows={rows}
              scope={scope}
              allowSecret
              keyPlaceholder="Variable"
              valuePlaceholder="Value"
              emptyHint="No variables yet — name one in the empty row above to add the first."
              onChange={(next) => {
                if (showingShared) setSharedVariables(collectionId, next)
                else if (set) setSetValues(collectionId, set.id, next)
              }}
            />
          </div>

          <div className="mdl-dyn">
            <div className="mdl-dyn-head">
              <button
                className="mdl-dyn-toggle"
                aria-expanded={showDynamic}
                onClick={() => setShowDynamic((open) => !open)}
              >
                <Icon name={showDynamic ? 'chevron-down' : 'chevron-right'} size={12} />
                <span className="plate">Always available</span>
                <span className="mdl-dyn-count mono">{DYNAMIC_VARS.length}</span>
              </button>
              {showDynamic && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setSeed((value) => value + 1)}
                  title="Generate fresh examples"
                >
                  <Icon name="refresh" size={11} /> Re-roll
                </button>
              )}
            </div>

            {showDynamic && (
              <ul className="mdl-dyn-list scroll-y">
                {dynamic.map((item) => (
                  <li key={item.name}>
                    <button
                      className="mdl-dyn-token mono"
                      title="Copy this token"
                      onClick={() => copyToClipboard(`{{${item.name}}}`, 'Token copied')}
                    >
                      {`{{${item.name}}}`}
                    </button>
                    <span className="mdl-dyn-note">{item.note}</span>
                    <span className="mono mdl-dyn-example truncate" title={item.example}>
                      {item.example}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 6. Import report                                                    */
/* ------------------------------------------------------------------ */

const KIND_LABEL: Record<ImportKind, string> = {
  native: 'Deadsimple',
  openapi: 'OpenAPI',
  postman: 'Postman',
}

function ImportReportDialog({ outcomes }: { outcomes: ImportOutcome[] }): JSX.Element {
  const close = useStore((s) => s.closeModal)
  const setExpanded = useStore((s) => s.setExpanded)
  const setSidebarTab = useStore((s) => s.setSidebarTab)
  const select = useStore((s) => s.select)

  const openInSidebar = () => {
    setSidebarTab('collections')
    setExpanded(
      outcomes.map((outcome) => outcome.collection.id),
      true,
    )
    const first = outcomes[0]?.collection.id
    if (first) select(first)
    close()
  }

  const many = outcomes.length > 1

  return (
    <ModalShell
      title={many ? `Imported ${outcomes.length} collections` : 'Import complete'}
      onClose={close}
      className="mdl-w-lg"
      foot={
        <>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button
            className="btn btn-primary"
            data-autofocus=""
            disabled={!outcomes.length}
            onClick={openInSidebar}
          >
            {many ? 'Open collections' : 'Open collection'}
          </button>
        </>
      }
    >
      {outcomes.map((outcome) => (
        <article className="mdl-imp" key={outcome.collection.id}>
          <header className="mdl-imp-head">
            <h3 className="mdl-imp-name truncate">{outcome.collection.name}</h3>
            <span className="chip">{KIND_LABEL[outcome.kind]}</span>
          </header>

          <dl className="mdl-imp-stats">
            <div>
              <dt className="plate">Folders</dt>
              <dd className="mono">{outcome.stats.folders}</dd>
            </div>
            <div>
              <dt className="plate">Requests</dt>
              <dd className="mono">{outcome.stats.requests}</dd>
            </div>
            <div>
              <dt className="plate">Variables</dt>
              <dd className="mono">{outcome.stats.variables}</dd>
            </div>
          </dl>

          {outcome.sourcePath && (
            <p className="mono mdl-path truncate" title={outcome.sourcePath}>
              {outcome.sourcePath}
            </p>
          )}

          {outcome.warnings.length ? (
            <div className="mdl-warn-block">
              <div className="mdl-warn-head">
                <span className="plate">
                  {outcome.warnings.length} warning{outcome.warnings.length === 1 ? '' : 's'}
                </span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    copyToClipboard(outcome.warnings.join('\n'), 'Warnings copied')
                  }
                >
                  <Icon name="copy" size={11} /> Copy all
                </button>
              </div>
              <ul className="mdl-warn-list scroll-y">
                {outcome.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mdl-imp-clean">
              <Icon name="check" size={12} /> Imported cleanly
            </p>
          )}
        </article>
      ))}
    </ModalShell>
  )
}

/* ------------------------------------------------------------------ */
/* 7. Confirm                                                          */
/* ------------------------------------------------------------------ */

function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
}): JSX.Element {
  const close = useStore((s) => s.closeModal)

  const run = useCallback(() => {
    props.onConfirm()
    // The action may have opened a dialog of its own; only close if it did not.
    const current = useStore.getState().modal
    if (current?.kind === 'confirm') useStore.getState().closeModal()
  }, [props])

  return (
    <ModalShell
      title={props.title}
      onClose={close}
      className="mdl-w-sm"
      onKeyDown={(event) => {
        // Enter confirms from anywhere except a button, which handles its own.
        if (event.key !== 'Enter') return
        if (event.target instanceof HTMLElement && event.target.tagName === 'BUTTON') return
        event.preventDefault()
        run()
      }}
      foot={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-danger" data-autofocus="" onClick={run}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p className="mdl-confirm">{props.message}</p>
    </ModalShell>
  )
}
