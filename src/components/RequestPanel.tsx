import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react'

import type { FileMeta } from '../../shared/api'
import { kv as makeKV, multipartField } from '../../shared/factory'
import {
  HTTP_METHODS,
  type ApiRequest,
  type Auth,
  type AuthType,
  type Body,
  type BodyMode,
  type Collection,
  type Folder,
  type KV,
  type MultipartField,
  type RequestSettings,
} from '../../shared/types'
import { formatBytes, methodClass, minifyJson, prettyJson } from '../lib/format'
import { buildScope, resolve, type VarScope } from '../lib/variables'
import {
  buildWire,
  effectiveAuth,
  effectiveSettings,
  effectiveUrl,
  type BuildContext,
} from '../lib/wire'
import { useStore, useTabCollection, useTabRequest, type ReqTabKey } from '../state/store'
import { allFolderIds, flatten, folderPath } from '../state/tree'
import { CodeEditor } from './ui/CodeEditor'
import { ContextMenu, type MenuItem } from './ui/ContextMenu'
import { Caret, Icon } from './ui/Icon'
import { KVTable } from './ui/KVTable'
import { VarInput } from './ui/VarInput'
import './RequestPanel.css'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const REQ_TABS: ReadonlyArray<{ key: ReqTabKey; label: string }> = [
  { key: 'params', label: 'Params' },
  { key: 'body', label: 'Body' },
  { key: 'headers', label: 'Headers' },
  { key: 'auth', label: 'Auth' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'settings', label: 'Settings' },
  { key: 'docs', label: 'Docs' },
]

const BODY_MODES: ReadonlyArray<{ mode: BodyMode; label: string }> = [
  { mode: 'none', label: 'None' },
  { mode: 'json', label: 'JSON' },
  { mode: 'text', label: 'Text' },
  { mode: 'xml', label: 'XML' },
  { mode: 'html', label: 'HTML' },
  { mode: 'javascript', label: 'JS' },
  { mode: 'form-urlencoded', label: 'Form' },
  { mode: 'multipart', label: 'Multipart' },
  { mode: 'binary', label: 'Binary' },
  { mode: 'graphql', label: 'GraphQL' },
]

const AUTH_TYPES: ReadonlyArray<{ type: AuthType; label: string }> = [
  { type: 'inherit', label: 'Inherit' },
  { type: 'none', label: 'None' },
  { type: 'bearer', label: 'Bearer' },
  { type: 'basic', label: 'Basic' },
  { type: 'apikey', label: 'API key' },
]

/** Mirrors CONTENT_TYPES in lib/wire.ts, so the Headers tab can predict it. */
const BODY_CONTENT_TYPE: Partial<Record<BodyMode, string>> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  html: 'text/html',
  javascript: 'application/javascript',
  graphql: 'application/json',
  'form-urlencoded': 'application/x-www-form-urlencoded',
}

const EDITOR_MODES = new Set<BodyMode>(['json', 'text', 'xml', 'html', 'javascript'])

const HEADER_SUGGESTIONS: readonly string[] = [
  'Accept',
  'Accept-Charset',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Disposition',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'Date',
  'ETag',
  'Expect',
  'Forwarded',
  'From',
  'Host',
  'If-Match',
  'If-Modified-Since',
  'If-None-Match',
  'If-Unmodified-Since',
  'Idempotency-Key',
  'Origin',
  'Pragma',
  'Prefer',
  'Range',
  'Referer',
  'TE',
  'User-Agent',
  'X-Api-Key',
  'X-Correlation-Id',
  'X-Csrf-Token',
  'X-Forwarded-For',
  'X-Request-Id',
  'X-Requested-With',
]

/** Sentinel option value; no RFC 9110 token may contain a brace. */
const CUSTOM_METHOD = '{custom}'

/** An empty URL makes every downstream issue meaningless noise. */
const EMPTY_URL_ISSUE = 'Request URL is empty'

const NO_FOLDERS: Folder[] = []

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Same templating lib/wire.ts substitutes, so what is listed is what is used. */
const COLON_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_-]*)/g
const BRACE_PARAM_RE = /(?<!\{)\{([^{}/?#\s]+)\}(?!\})/g

interface PathToken {
  name: string
  token: string
}

function detectPathParams(url: string): PathToken[] {
  const hash = url.indexOf('#')
  const beforeHash = hash < 0 ? url : url.slice(0, hash)
  const query = beforeHash.indexOf('?')
  const base = query < 0 ? beforeHash : beforeHash.slice(0, query)

  const out: PathToken[] = []
  const seen = new Set<string>()
  const add = (raw: string, token: string): void => {
    const name = raw.trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push({ name, token })
  }
  for (const match of base.matchAll(COLON_PARAM_RE)) add(match[1], match[0])
  for (const match of base.matchAll(BRACE_PARAM_RE)) add(match[1], match[0])
  return out
}

/** Index of the query `?`, ignoring one inside a {{token}}. -1 when there is none. */
function findQueryStart(url: string): number {
  let depth = 0
  for (let i = 0; i < url.length; i++) {
    if (url[i] === '{' && url[i + 1] === '{') {
      depth++
      i++
      continue
    }
    if (url[i] === '}' && url[i + 1] === '}') {
      if (depth > 0) depth--
      i++
      continue
    }
    if (depth > 0) continue
    if (url[i] === '#') return -1
    if (url[i] === '?') return i
  }
  return -1
}

function safeDecode(input: string): string {
  // A query string is form-encoded, so a literal `+` means a space. Decoding it
  // as one keeps the round trip honest: buildWire re-encodes the space as %20,
  // which every server reads back as the character the user actually typed.
  const normalised = input.includes('+') ? input.replace(/\+/g, '%20') : input
  if (!normalised.includes('%')) return normalised
  try {
    return decodeURIComponent(normalised)
  } catch {
    return input
  }
}

/**
 * Splits a typed query string off the URL into param rows.
 *
 * Percent escapes are decoded so the table shows the characters the user meant;
 * buildWire re-encodes them on the way out, and the resolved line under the bar
 * shows exactly what that produced.
 */
function splitUrlQuery(url: string): { url: string; rows: KV[] } | null {
  const start = findQueryStart(url)
  if (start < 0) return null

  const hash = url.indexOf('#', start)
  const query = hash < 0 ? url.slice(start + 1) : url.slice(start + 1, hash)
  const rest = hash < 0 ? '' : url.slice(hash)

  const rows: KV[] = []
  for (const segment of query.split('&')) {
    if (!segment) continue
    const eq = segment.indexOf('=')
    const key = eq < 0 ? segment : segment.slice(0, eq)
    if (!key) continue
    rows.push(makeKV(safeDecode(key), eq < 0 ? '' : safeDecode(segment.slice(eq + 1))))
  }
  return { url: url.slice(0, start) + rest, rows }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** btoa rejects anything outside Latin-1, so go through UTF-8 bytes first. */
function base64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** A fixed run of dots: a mask that leaked the credential length would be no mask. */
const MASK = '••••••••••••••••••••'

function enabledCount(rows: KV[]): number {
  return rows.filter((row) => row.enabled && row.key.trim()).length
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function RequestPanel({ tabId }: { tabId: string }): JSX.Element {
  const request = useTabRequest(tabId)
  const collection = useTabCollection(tabId)
  const requestId = useStore((s) => s.tabs.find((t) => t.id === tabId)?.requestId ?? null)
  const reqTab = useStore((s) => s.tabs.find((t) => t.id === tabId)?.reqTab ?? 'params')
  const sending = useStore((s) => s.tabs.find((t) => t.id === tabId)?.exec.status === 'sending')
  const appDefaults = useStore((s) => s.settings.defaultSettings)
  const editorFontSize = useStore((s) => s.settings.editorFontSize)

  const [wrap, setWrap] = useState(() => useStore.getState().settings.wrapLines)

  const scope = useMemo(() => buildScope(collection), [collection])

  const folders = useMemo(() => {
    if (!collection || !requestId) return NO_FOLDERS
    return folderPath(collection.children, requestId) ?? NO_FOLDERS
  }, [collection, requestId])

  const ctx = useMemo<BuildContext>(
    () => ({ collection, folders, appDefaults, execId: 'preview' }),
    [collection, folders, appDefaults],
  )

  const patch = useCallback(
    (next: Partial<ApiRequest>) => useStore.getState().patchRequest(tabId, next),
    [tabId],
  )

  const resolvedUrl = useMemo(
    () => (request ? effectiveUrl(request, scope) : ''),
    [request, scope],
  )

  const issues = useMemo(() => {
    if (!request) return []
    return buildWire(request, ctx).issues.filter((issue) => issue !== EMPTY_URL_ISSUE)
  }, [request, ctx])

  const pathTokens = useMemo(
    () => (request ? detectPathParams(resolve(request.url, scope)) : []),
    [request, scope],
  )

  /* Templated segments own the path-variable rows: a new :segment appears with
     an empty value, one that vanished is dropped, and edits survive both. */
  const tokenKey = pathTokens.map((token) => token.name).join('\u0000')
  useEffect(() => {
    const names = tokenKey ? tokenKey.split('\u0000') : []
    const store = useStore.getState()
    const current = store.getRequest(tabId)
    if (!current) return
    const existing = current.pathParams
    const next = names.map(
      (name) => existing.find((row) => row.key.trim() === name) ?? makeKV(name, ''),
    )
    const unchanged =
      next.length === existing.length && next.every((row, index) => row === existing[index])
    if (unchanged) return
    store.patchRequest(tabId, { pathParams: next })
  }, [tokenKey, tabId])

  if (!request) {
    return (
      <div className="rqpanel">
        <div className="empty-state rq-gone">
          <p className="plate plate-lg">This request is gone</p>
          <p>It was deleted or its collection was removed. Close the tab to tidy up.</p>
          <div className="empty-actions">
            <button className="btn" onClick={() => useStore.getState().closeTab(tabId)}>
              <Icon name="close" size={12} /> Close tab
            </button>
          </div>
        </div>
      </div>
    )
  }

  const counts: Partial<Record<ReqTabKey, number>> = {
    params: enabledCount(request.params) + enabledCount(request.pathParams),
    headers: enabledCount(request.headers),
    cookies: enabledCount(request.cookies),
    settings: Object.keys(request.settings).length,
  }
  const marks: Partial<Record<ReqTabKey, boolean>> = {
    body: request.body.mode !== 'none',
    auth: request.auth.type !== 'inherit' && request.auth.type !== 'none',
    docs: request.docs.trim().length > 0,
  }

  return (
    <div className="rqpanel">
      <UrlBar
        tabId={tabId}
        request={request}
        scope={scope}
        patch={patch}
        sending={sending}
        resolvedUrl={resolvedUrl}
        isScratch={requestId === null}
      />

      {issues.length > 0 && (
        <div className="rq-issues" role="status">
          <Icon name="alert" size={12} className="rq-issues-icon" />
          <ul className="rq-issues-list">
            {issues.map((issue, index) => (
              // Two fields can raise the same sentence, so the index disambiguates.
              <li key={`${index}-${issue}`}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="tabs rq-tabs" role="tablist" aria-label="Request sections">
        {REQ_TABS.map((entry) => (
          <button
            key={entry.key}
            role="tab"
            id={`rq-tab-${tabId}-${entry.key}`}
            aria-selected={reqTab === entry.key}
            aria-controls={`rq-panel-${tabId}`}
            className="tab"
            onClick={() => useStore.getState().setReqTab(tabId, entry.key)}
          >
            {entry.label}
            {counts[entry.key] ? <span className="rq-count mono">{counts[entry.key]}</span> : null}
            {marks[entry.key] && (
              <>
                <span className="rq-dot" aria-hidden="true" />
                <span className="rq-sr"> (set)</span>
              </>
            )}
          </button>
        ))}
      </div>

      <div
        className="rq-pane"
        role="tabpanel"
        id={`rq-panel-${tabId}`}
        aria-labelledby={`rq-tab-${tabId}-${reqTab}`}
      >
        {reqTab === 'params' && (
          <ParamsTab request={request} scope={scope} patch={patch} tokens={pathTokens} />
        )}
        {reqTab === 'body' && (
          <BodyTab
            request={request}
            scope={scope}
            patch={patch}
            wrap={wrap}
            onToggleWrap={() => setWrap((v) => !v)}
            fontSize={editorFontSize}
          />
        )}
        {reqTab === 'headers' && (
          <HeadersTab
            request={request}
            scope={scope}
            patch={patch}
            ctx={ctx}
            collection={collection}
            folders={folders}
            resolvedUrl={resolvedUrl}
          />
        )}
        {reqTab === 'auth' && (
          <AuthTab
            request={request}
            scope={scope}
            patch={patch}
            ctx={ctx}
            collection={collection}
            folders={folders}
          />
        )}
        {reqTab === 'cookies' && <CookiesTab request={request} scope={scope} patch={patch} />}
        {reqTab === 'settings' && <SettingsTab request={request} patch={patch} ctx={ctx} />}
        {reqTab === 'docs' && <DocsTab request={request} patch={patch} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* URL bar                                                             */
/* ------------------------------------------------------------------ */

interface UrlBarProps {
  tabId: string
  request: ApiRequest
  scope: Map<string, VarScope>
  patch: (next: Partial<ApiRequest>) => void
  sending: boolean
  resolvedUrl: string
  isScratch: boolean
}

function UrlBar({
  tabId,
  request,
  scope,
  patch,
  sending,
  resolvedUrl,
  isScratch,
}: UrlBarProps): JSX.Element {
  const known = (HTTP_METHODS as readonly string[]).includes(request.method)
  const [freeMethod, setFreeMethod] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const methodRef = useRef<HTMLInputElement>(null)

  const custom = freeMethod || !known

  useEffect(() => {
    if (freeMethod) methodRef.current?.focus()
  }, [freeMethod])

  /** A pasted or typed query string belongs in the params table, not the bar. */
  const absorbQuery = useCallback(() => {
    const store = useStore.getState()
    const current = store.getRequest(tabId)
    if (!current) return
    const split = splitUrlQuery(current.url)
    if (!split) return
    store.patchRequest(tabId, {
      url: split.url,
      params: [...current.params, ...split.rows],
    })
  }, [tabId])

  const send = useCallback(() => {
    absorbQuery()
    void useStore.getState().send(tabId)
  }, [absorbQuery, tabId])

  const menuItems = useMemo((): MenuItem[] => {
    const store = useStore.getState()
    const items: MenuItem[] = [
      {
        label: 'Copy as curl',
        icon: 'terminal',
        onSelect: () => store.openModal({ kind: 'curl-export', tabId }),
      },
      {
        label: 'Paste curl…',
        icon: 'download',
        shortcut: 'Ctrl+Shift+V',
        onSelect: () => store.openModal({ kind: 'curl-import', tabId }),
      },
    ]
    if (isScratch) {
      items.push({ label: '', separator: true })
      items.push({ label: 'Save as…', icon: 'save', onSelect: () => setSaveOpen(true) })
    }
    return items
  }, [tabId, isScratch])

  return (
    <div className="rq-bar-wrap">
      <div className="rq-bar">
        {custom ? (
          <div className="rq-method-free">
            <input
              ref={methodRef}
              className={`input rq-method-input ${methodClass(request.method)}`}
              value={request.method}
              spellCheck={false}
              autoComplete="off"
              aria-label="HTTP method"
              placeholder="METHOD"
              onChange={(e) => patch({ method: e.target.value.toUpperCase() })}
            />
            <button
              className="btn-icon btn-xs rq-method-back"
              title="Pick a standard method"
              aria-label="Pick a standard method"
              onClick={() => {
                setFreeMethod(false)
                if (!(HTTP_METHODS as readonly string[]).includes(request.method)) {
                  patch({ method: 'GET' })
                }
              }}
            >
              <Icon name="list" size={12} />
            </button>
          </div>
        ) : (
          <select
            className={`select rq-method ${methodClass(request.method)}`}
            value={request.method}
            aria-label="HTTP method"
            onChange={(e) => {
              if (e.target.value === CUSTOM_METHOD) setFreeMethod(true)
              else patch({ method: e.target.value })
            }}
          >
            {HTTP_METHODS.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
            <option value={CUSTOM_METHOD}>Custom…</option>
          </select>
        )}

        <VarInput
          className="rq-url"
          value={request.url}
          onChange={(url) => patch({ url })}
          scope={scope}
          monospace
          dataFocus="url"
          ariaLabel="Request URL"
          placeholder="https://api.example.com/v1/resource  ·  {{baseUrl}}/users/{{id}}"
          onBlur={absorbQuery}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // Ctrl/Cmd+Enter belongs to the global shortcut, which sends or stops.
            // Handling it here too would fire twice: send, then cancel.
            if (e.ctrlKey || e.metaKey || e.altKey) return
            e.preventDefault()
            send()
          }}
        />

        {sending ? (
          <button
            className="btn btn-danger rq-send"
            title="Stop the request  (Ctrl+Enter)"
            onClick={() => void useStore.getState().cancel(tabId)}
          >
            <Icon name="stop" size={12} /> Stop
          </button>
        ) : (
          <button className="btn btn-primary rq-send" title="Send  (Ctrl+Enter)" onClick={send}>
            <Icon name="send" size={13} /> Send
          </button>
        )}

        <button
          ref={moreRef}
          className="btn-icon rq-more"
          title="More request actions"
          aria-label="More request actions"
          aria-haspopup="menu"
          onClick={() => {
            const rect = moreRef.current?.getBoundingClientRect()
            if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 })
          }}
        >
          <Icon name="dots" />
        </button>
      </div>

      <div className="rq-resolved">
        <span className="plate rq-resolved-label">Sends</span>
        {resolvedUrl ? (
          <span className="mono rq-resolved-url" title={resolvedUrl}>
            {resolvedUrl}
          </span>
        ) : (
          <span className="mono rq-resolved-empty">nothing yet — enter a URL</span>
        )}
      </div>

      {saveOpen && <SaveAsForm tabId={tabId} onClose={() => setSaveOpen(false)} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Save a scratch request                                              */
/* ------------------------------------------------------------------ */

function SaveAsForm({ tabId, onClose }: { tabId: string; onClose: () => void }): JSX.Element {
  const collections = useStore((s) => s.collections)
  const [name, setName] = useState(() => useStore.getState().getRequest(tabId)?.name ?? '')
  const [collectionId, setCollectionId] = useState(() => collections[0]?.id ?? '')
  const [folderId, setFolderId] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => nameRef.current?.focus(), [])

  const folderOptions = useMemo(() => {
    const target: Collection | undefined = collections.find((c) => c.id === collectionId)
    if (!target) return []
    const open: Record<string, boolean> = {}
    for (const id of allFolderIds(target.children)) open[id] = true
    return flatten(target.children, open).flatMap((row) =>
      row.node.kind === 'folder'
        ? [{ id: row.node.id, label: '  '.repeat(row.depth) + row.node.name }]
        : [],
    )
  }, [collections, collectionId])

  const canSave = name.trim().length > 0 && collectionId.length > 0

  const save = (): void => {
    if (!canSave) return
    useStore.getState().saveScratchAs(tabId, collectionId, folderId || null, name.trim())
    onClose()
  }

  return (
    <div className="rq-saveas" role="group" aria-label="Save this request">
      <span className="plate rq-saveas-label">Save as</span>

      <input
        ref={nameRef}
        className="input rq-saveas-name"
        value={name}
        placeholder="Request name"
        aria-label="Request name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            save()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />

      <select
        className="select rq-saveas-select"
        value={collectionId}
        aria-label="Collection"
        onChange={(e) => {
          setCollectionId(e.target.value)
          setFolderId('')
        }}
      >
        {collections.length === 0 && <option value="">No collection yet</option>}
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>

      <select
        className="select rq-saveas-select"
        value={folderId}
        aria-label="Folder"
        onChange={(e) => setFolderId(e.target.value)}
      >
        <option value="">Top level</option>
        {folderOptions.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>

      <button className="btn btn-primary btn-sm" disabled={!canSave} onClick={save}>
        <Icon name="save" size={11} /> Save
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onClose}>
        Cancel
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Params                                                              */
/* ------------------------------------------------------------------ */

interface TabProps {
  request: ApiRequest
  scope: Map<string, VarScope>
  patch: (next: Partial<ApiRequest>) => void
}

function ParamsTab({
  request,
  scope,
  patch,
  tokens,
}: TabProps & { tokens: PathToken[] }): JSX.Element {
  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Query parameters</h3>
          <p className="rq-section-note">
            A query string typed into the URL bar moves here.
          </p>
        </header>
        <KVTable
          rows={request.params}
          onChange={(params) => patch({ params })}
          scope={scope}
          keyPlaceholder="Parameter"
          emptyHint="No query parameters."
        />
      </section>

      {tokens.length > 0 && (
        <section className="rq-section">
          <header className="rq-section-head">
            <h3 className="plate">Path variables</h3>
            <div className="rq-tokens">
              {tokens.map((token) => (
                <span key={token.name} className="chip chip-var mono">
                  {token.token}
                </span>
              ))}
            </div>
            <p className="rq-section-note">
              Detected in the path. Rows follow the URL: rename a segment and the row follows it.
            </p>
          </header>
          <KVTable
            rows={request.pathParams}
            onChange={(pathParams) => patch({ pathParams })}
            scope={scope}
            keyPlaceholder="Segment"
            emptyHint="No path variables."
          />
        </section>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

interface BodyTabProps extends TabProps {
  wrap: boolean
  onToggleWrap: () => void
  fontSize: number
}

function BodyTab({
  request,
  scope,
  patch,
  wrap,
  onToggleWrap,
  fontSize,
}: BodyTabProps): JSX.Element {
  const body = request.body
  const mode = body.mode

  const patchBody = useCallback(
    (next: Partial<Body>) => patch({ body: { ...request.body, ...next } }),
    [patch, request.body],
  )

  return (
    <div className="rq-body">
      <div
        className="rq-modes"
        role="radiogroup"
        aria-label="Body format"
      >
        {BODY_MODES.map((entry) => (
          <button
            key={entry.mode}
            role="radio"
            aria-checked={mode === entry.mode}
            className={`rq-mode${mode === entry.mode ? ' is-on' : ''}`}
            onClick={() => patchBody({ mode: entry.mode })}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {mode === 'none' && (
        <div className="empty-state rq-fill">
          <p className="plate plate-lg">No body</p>
          <p>This request sends no body. Pick a format above to add one.</p>
        </div>
      )}

      {EDITOR_MODES.has(mode) && (
        <TextBody
          mode={mode}
          text={body.text}
          onChange={(text) => patchBody({ text })}
          wrap={wrap}
          onToggleWrap={onToggleWrap}
          fontSize={fontSize}
        />
      )}

      {mode === 'form-urlencoded' && (
        <div className="rq-scroll">
          <section className="rq-section">
            <header className="rq-section-head">
              <h3 className="plate">Form fields</h3>
              <p className="rq-section-note">
                Sent as application/x-www-form-urlencoded, percent-encoded for you.
              </p>
            </header>
            <KVTable
              rows={body.form}
              onChange={(form) => patchBody({ form })}
              scope={scope}
              keyPlaceholder="Field"
              emptyHint="No form fields."
            />
          </section>
        </div>
      )}

      {mode === 'multipart' && (
        <MultipartTable
          fields={body.multipart}
          scope={scope}
          onChange={(multipart) => patchBody({ multipart })}
        />
      )}

      {mode === 'binary' && (
        <BinaryPicker
          path={body.binaryPath}
          onChange={(binaryPath) => patchBody({ binaryPath })}
        />
      )}

      {mode === 'graphql' && (
        <GraphQLBodyEditor
          value={body.graphql}
          onChange={(graphql) => patchBody({ graphql })}
          wrap={wrap}
          onToggleWrap={onToggleWrap}
          fontSize={fontSize}
        />
      )}
    </div>
  )
}

function jsonError(text: string): string | null {
  if (!text.trim()) return null
  try {
    JSON.parse(text)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function TextBody({
  mode,
  text,
  onChange,
  wrap,
  onToggleWrap,
  fontSize,
}: {
  mode: BodyMode
  text: string
  onChange: (text: string) => void
  wrap: boolean
  onToggleWrap: () => void
  fontSize: number
}): JSX.Element {
  const isJson = mode === 'json'
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text])
  const error = useMemo(() => (isJson ? jsonError(text) : null), [isJson, text])
  const language = mode === 'text' ? 'text' : (mode as 'json' | 'xml' | 'html' | 'javascript')

  return (
    <div className="rq-editor-wrap">
      <div className="rq-toolbar">
        {isJson && (
          <>
            <button
              className="btn btn-sm"
              disabled={!text.trim()}
              onClick={() => onChange(prettyJson(text))}
            >
              Beautify
            </button>
            <button
              className="btn btn-sm"
              disabled={!text.trim()}
              onClick={() => onChange(minifyJson(text))}
            >
              Minify
            </button>
          </>
        )}
        <button
          className="btn btn-sm"
          aria-pressed={wrap}
          onClick={onToggleWrap}
          title="Wrap long lines"
        >
          <Icon name="wrap" size={11} /> Wrap
        </button>
        <span className="rq-spacer" />
        <span className="rq-bytes mono">{formatBytes(bytes)}</span>
      </div>

      {error && (
        <p className="rq-parse-error mono" role="status">
          <Icon name="alert" size={11} /> {error}
        </p>
      )}

      <div className="rq-editor">
        <CodeEditor
          value={text}
          onChange={onChange}
          language={language}
          wrap={wrap}
          fontSize={fontSize}
          highlightVariables
          ariaLabel="Request body"
          placeholder={isJson ? '{\n  "key": "{{value}}"\n}' : 'Request body'}
        />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Multipart                                                           */
/* ------------------------------------------------------------------ */

/** Stats every referenced path, so a file deleted behind our back is visible. */
function useFileMetas(paths: readonly string[]): Record<string, FileMeta> {
  // NUL joins them: a path may legally contain anything else, spaces included.
  const key = paths.join('\u0000')
  const [metas, setMetas] = useState<Record<string, FileMeta>>({})

  useEffect(() => {
    const list = key ? key.split('\u0000') : []
    if (!list.length) {
      setMetas((prev) => (Object.keys(prev).length ? {} : prev))
      return
    }
    let alive = true
    void Promise.all(
      list.map((path) =>
        window.api.files
          .stat(path)
          .catch((): FileMeta => ({ path, name: baseName(path), size: 0, exists: false })),
      ),
    ).then((result) => {
      if (alive) setMetas(Object.fromEntries(result.map((meta) => [meta.path, meta])))
    })
    return () => {
      alive = false
    }
  }, [key])

  return metas
}

function MultipartTable({
  fields,
  scope,
  onChange,
}: {
  fields: MultipartField[]
  scope: Map<string, VarScope>
  onChange: (fields: MultipartField[]) => void
}): JSX.Element {
  const paths = useMemo(
    () =>
      fields.flatMap((field) =>
        field.kind === 'file' && field.filePath ? [field.filePath] : [],
      ),
    [fields],
  )
  const metas = useFileMetas(paths)

  /* Typing into the draft row promotes it to a real row, which means the input
     under the caret is replaced. Without handing focus to the new row's name
     field the next keystroke would land back in the draft and spawn a second
     row, so "avatar" would become six one-letter parts. */
  const nameRefs = useRef(new Map<string, HTMLInputElement>())
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    const id = focusNext.current
    if (!id) return
    focusNext.current = null
    const input = nameRefs.current.get(id)
    if (!input) return
    input.focus()
    const end = input.value.length
    input.setSelectionRange(end, end)
  })

  const append = (field: MultipartField): void => {
    focusNext.current = field.id
    onChange([...fields, field])
  }

  const update = (index: number, next: Partial<MultipartField>): void => {
    const copy = fields.slice()
    copy[index] = { ...copy[index], ...next }
    onChange(copy)
  }

  const pick = (index: number): void => {
    void window.api.files
      .pick({ title: 'Choose file' })
      .then((picked) => {
        if (!picked?.length) return
        update(index, { filePath: picked[0] })
      })
      .catch((err: unknown) => {
        useStore.getState().toast('error', 'Could not open the file picker', String(err))
      })
  }

  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Multipart fields</h3>
          <p className="rq-section-note">
            Sent as multipart/form-data. The boundary and each part header are generated for you.
          </p>
        </header>

        <div className="rq-mp">
          <div className="rq-mp-head">
            <span className="rq-mp-cell" />
            <span className="rq-mp-cell plate">Field</span>
            <span className="rq-mp-cell plate">Kind</span>
            <span className="rq-mp-cell plate">Value</span>
            <span className="rq-mp-cell plate">Content-Type</span>
            <span className="rq-mp-cell" />
          </div>

          {fields.map((field, index) => {
            const meta = field.filePath ? metas[field.filePath] : undefined
            const missing = field.kind === 'file' && !!field.filePath && meta?.exists === false
            return (
              <div
                className={`rq-mp-row${field.enabled ? '' : ' is-off'}${missing ? ' is-missing' : ''}`}
                key={field.id}
              >
                <span className="rq-mp-cell rq-mp-toggle">
                  <input
                    type="checkbox"
                    className="checkbox"
                    checked={field.enabled}
                    aria-label={`Include ${field.key || 'part'}`}
                    onChange={(e) => update(index, { enabled: e.target.checked })}
                  />
                </span>

                <span className="rq-mp-cell">
                  <input
                    ref={(el) => {
                      if (el) nameRefs.current.set(field.id, el)
                      else nameRefs.current.delete(field.id)
                    }}
                    className="kv-input"
                    value={field.key}
                    placeholder="Field"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Field name"
                    onChange={(e) => update(index, { key: e.target.value })}
                  />
                </span>

                <span className="rq-mp-cell rq-mp-kind">
                  <button
                    className={`rq-seg${field.kind === 'text' ? ' is-on' : ''}`}
                    aria-pressed={field.kind === 'text'}
                    aria-label={`Send ${field.key || 'this part'} as text`}
                    onClick={() => update(index, { kind: 'text' })}
                  >
                    Text
                  </button>
                  <button
                    className={`rq-seg${field.kind === 'file' ? ' is-on' : ''}`}
                    aria-pressed={field.kind === 'file'}
                    aria-label={`Send ${field.key || 'this part'} as a file`}
                    onClick={() => update(index, { kind: 'file' })}
                  >
                    File
                  </button>
                </span>

                <span className="rq-mp-cell">
                  {field.kind === 'text' ? (
                    <VarInput
                      value={field.value}
                      onChange={(value) => update(index, { value })}
                      scope={scope}
                      placeholder="Value"
                      ariaLabel="Field value"
                    />
                  ) : (
                    <span className="rq-file">
                      <button
                        className="btn btn-sm"
                        onClick={() => pick(index)}
                        aria-label={`Choose a file for ${field.key || 'this part'}`}
                      >
                        <Icon name="upload" size={11} /> {field.filePath ? 'Change' : 'Choose'}
                      </button>
                      {field.filePath ? (
                        <span className="rq-file-meta mono truncate" title={field.filePath}>
                          {meta?.name ?? baseName(field.filePath)}
                          {meta?.exists ? ` · ${formatBytes(meta.size)}` : ''}
                          {missing ? ' · missing' : ''}
                        </span>
                      ) : (
                        <span className="rq-file-meta rq-file-empty">no file</span>
                      )}
                    </span>
                  )}
                </span>

                <span className="rq-mp-cell">
                  <input
                    className="kv-input is-quiet"
                    value={field.contentType ?? ''}
                    placeholder="auto"
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Part content type"
                    onChange={(e) => update(index, { contentType: e.target.value })}
                  />
                </span>

                <span className="rq-mp-cell rq-mp-actions">
                  <button
                    className="btn-icon btn-xs is-danger"
                    title="Remove part"
                    aria-label={`Remove ${field.key || 'part'}`}
                    onClick={() => onChange(fields.filter((_, i) => i !== index))}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </span>
              </div>
            )
          })}

          <div className="rq-mp-row is-draft">
            <span className="rq-mp-cell rq-mp-toggle">
              <input
                type="checkbox"
                className="checkbox"
                checked
                readOnly
                tabIndex={-1}
                aria-hidden="true"
              />
            </span>
            <span className="rq-mp-cell">
              <input
                className="kv-input"
                value=""
                placeholder="Field"
                spellCheck={false}
                autoComplete="off"
                aria-label="New multipart field"
                onChange={(e) => append(multipartField(e.target.value))}
              />
            </span>
            <span className="rq-mp-cell rq-mp-kind">
              <button
                className="rq-seg"
                aria-label="Add a text part"
                onClick={() => append(multipartField(''))}
              >
                Text
              </button>
              <button
                className="rq-seg"
                aria-label="Add a file part"
                onClick={() => append(multipartField('', 'file'))}
              >
                File
              </button>
            </span>
            <span className="rq-mp-cell" />
            <span className="rq-mp-cell" />
            <span className="rq-mp-cell" />
          </div>
        </div>

        {fields.some((f) => f.enabled && f.kind === 'file' && f.filePath && metas[f.filePath]?.exists === false) && (
          <p className="rq-warn">
            <Icon name="alert" size={11} /> One or more selected files no longer exist on disk.
          </p>
        )}
      </section>
    </div>
  )
}

function BinaryPicker({
  path,
  onChange,
}: {
  path: string
  onChange: (path: string) => void
}): JSX.Element {
  const paths = useMemo(() => (path ? [path] : []), [path])
  const metas = useFileMetas(paths)
  const meta = path ? metas[path] : undefined

  const pick = (): void => {
    void window.api.files
      .pick({ title: 'Choose file' })
      .then((picked) => {
        if (picked?.length) onChange(picked[0])
      })
      .catch((err: unknown) => {
        useStore.getState().toast('error', 'Could not open the file picker', String(err))
      })
  }

  if (!path) {
    return (
      <div className="empty-state rq-fill">
        <p className="plate plate-lg">No file selected</p>
        <p>The file is streamed as the raw request body, byte for byte.</p>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={pick}>
            <Icon name="upload" size={12} /> Choose a file
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Binary body</h3>
        </header>

        <dl className={`rq-filecard${meta?.exists === false ? ' is-missing' : ''}`}>
          <dt className="plate">Name</dt>
          <dd className="mono">{meta?.name ?? baseName(path)}</dd>
          <dt className="plate">Size</dt>
          <dd className="mono">
            {meta ? (meta.exists ? formatBytes(meta.size) : 'file is missing') : 'reading…'}
          </dd>
          <dt className="plate">Path</dt>
          <dd className="mono rq-filecard-path">{path}</dd>
        </dl>

        <div className="rq-actions">
          <button className="btn btn-sm" onClick={pick}>
            <Icon name="upload" size={11} /> Change
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => onChange('')}>
            <Icon name="close" size={11} /> Clear
          </button>
        </div>
      </section>
    </div>
  )
}

function GraphQLBodyEditor({
  value,
  onChange,
  wrap,
  onToggleWrap,
  fontSize,
}: {
  value: Body['graphql']
  onChange: (next: Body['graphql']) => void
  wrap: boolean
  onToggleWrap: () => void
  fontSize: number
}): JSX.Element {
  const error = useMemo(() => jsonError(value.variables), [value.variables])

  return (
    <div className="rq-gql">
      <div className="rq-toolbar">
        <label className="rq-gql-op">
          <span className="plate">Operation</span>
          <input
            className="input rq-gql-op-input"
            value={value.operationName ?? ''}
            placeholder="optional, when the document holds several"
            spellCheck={false}
            autoComplete="off"
            aria-label="GraphQL operation name"
            onChange={(e) => onChange({ ...value, operationName: e.target.value })}
          />
        </label>
        <span className="rq-spacer" />
        <button
          className="btn btn-sm"
          aria-pressed={wrap}
          onClick={onToggleWrap}
          title="Wrap long lines"
        >
          <Icon name="wrap" size={11} /> Wrap
        </button>
      </div>

      <div className="rq-gql-pane">
        <p className="plate rq-gql-label">Query</p>
        <div className="rq-editor">
          <CodeEditor
            value={value.query}
            onChange={(query) => onChange({ ...value, query })}
            language="graphql"
            wrap={wrap}
            fontSize={fontSize}
            highlightVariables
            ariaLabel="GraphQL query"
            placeholder={'query Users($first: Int) {\n  users(first: $first) { id }\n}'}
          />
        </div>
      </div>

      <div className="rq-gql-pane rq-gql-vars">
        <p className="plate rq-gql-label">
          Variables
          {error && (
            <span className="rq-parse-error mono">
              <Icon name="alert" size={11} /> {error}
            </span>
          )}
        </p>
        <div className="rq-editor">
          <CodeEditor
            value={value.variables}
            onChange={(variables) => onChange({ ...value, variables })}
            language="json"
            wrap={wrap}
            fontSize={fontSize}
            highlightVariables
            ariaLabel="GraphQL variables"
            placeholder={'{ "first": 10 }'}
          />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

interface InheritedHeader {
  name: string
  value: string
  source: string
  /** The transport fills this in; there is no value to show yet. */
  computed?: boolean
}

function HeadersTab({
  request,
  scope,
  patch,
  ctx,
  collection,
  folders,
  resolvedUrl,
}: TabProps & {
  ctx: BuildContext
  collection: Collection | null
  folders: Folder[]
  resolvedUrl: string
}): JSX.Element {
  const [open, setOpen] = useState(false)

  const inherited = useMemo((): InheritedHeader[] => {
    const out: InheritedHeader[] = []

    if (collection) {
      for (const row of collection.headers) {
        if (!row.enabled || !row.key.trim()) continue
        out.push({
          name: row.key.trim(),
          value: resolve(row.value, scope),
          source: `Collection · ${collection.name}`,
        })
      }
    }
    for (const folder of folders) {
      for (const row of folder.headers) {
        if (!row.enabled || !row.key.trim()) continue
        out.push({
          name: row.key.trim(),
          value: resolve(row.value, scope),
          source: `Folder · ${folder.name}`,
        })
      }
    }

    const auth = effectiveAuth(request, ctx)
    const generated = authHeader(auth, scope)
    if (generated && generated.in === 'header') {
      out.push({
        name: generated.name,
        value: MASK,
        source: request.auth.type === 'inherit' ? 'Auth · inherited' : 'Auth tab',
      })
    }

    const settings = effectiveSettings(request, ctx)
    const mode = request.body.mode
    const contentType = BODY_CONTENT_TYPE[mode]
    if (contentType) out.push({ name: 'Content-Type', value: contentType, source: 'Body format' })
    else if (mode === 'multipart') {
      out.push({
        name: 'Content-Type',
        value: 'multipart/form-data; boundary=…',
        source: 'Body format',
        computed: true,
      })
    }

    const host = hostOf(resolvedUrl)
    out.push({ name: 'Host', value: host || 'from the URL', source: 'Transport', computed: !host })
    if (mode !== 'none') {
      out.push({ name: 'Content-Length', value: 'byte length of the body', source: 'Transport', computed: true })
    }
    if (settings.decompress) {
      out.push({ name: 'Accept-Encoding', value: 'gzip, deflate, br', source: 'Transport' })
    }
    out.push({ name: 'User-Agent', value: 'the app identifier', source: 'Transport', computed: true })
    if (settings.sendCookies) {
      out.push({
        name: 'Cookie',
        value: 'matching cookies from the shared jar',
        source: 'Transport',
        computed: true,
      })
    }
    return out
  }, [collection, folders, request, ctx, scope, resolvedUrl])

  const ownNames = useMemo(
    () =>
      new Set(
        request.headers
          .filter((row) => row.enabled && row.key.trim())
          .map((row) => row.key.trim().toLowerCase()),
      ),
    [request.headers],
  )

  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Request headers</h3>
          <p className="rq-section-note">
            Written last, so a row here replaces anything inherited with the same name.
          </p>
        </header>
        <KVTable
          rows={request.headers}
          onChange={(headers) => patch({ headers })}
          scope={scope}
          keyPlaceholder="Header"
          keySuggestions={HEADER_SUGGESTIONS}
          emptyHint="No headers of its own."
        />
      </section>

      <section className="rq-section">
        <button
          className="rq-disclosure"
          aria-expanded={open}
          aria-controls="rq-inherited-headers"
          onClick={() => setOpen((v) => !v)}
        >
          <Caret open={open} />
          <span className="plate">Inherited and automatic headers</span>
          <span className="rq-count mono">{inherited.length}</span>
        </button>

        {open && (
          <table className="table-lite rq-inherited" id="rq-inherited-headers">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {inherited.map((entry, index) => {
                const overridden = ownNames.has(entry.name.toLowerCase())
                return (
                  <tr
                    key={`${entry.name}-${entry.source}-${index}`}
                    className={overridden ? 'is-overridden' : undefined}
                  >
                    <td className="mono">{entry.name}</td>
                    <td className={`mono${entry.computed ? ' rq-computed' : ''}`}>{entry.value}</td>
                    <td className="rq-source">
                      {entry.source}
                      {overridden && <span className="rq-replaced"> · replaced above</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

interface GeneratedAuth {
  name: string
  value: string
  in: 'header' | 'query'
}

/** Mirrors the auth branch of buildWire so the preview cannot drift from it. */
function authHeader(auth: Auth, scope: Map<string, VarScope>): GeneratedAuth | null {
  switch (auth.type) {
    case 'bearer': {
      const scheme = resolve(auth.bearer.scheme, scope).trim() || 'Bearer'
      const token = resolve(auth.bearer.token, scope).trim()
      if (!token) return null
      const prefixed = token.toLowerCase().startsWith(scheme.toLowerCase() + ' ')
      return { name: 'Authorization', value: prefixed ? token : `${scheme} ${token}`, in: 'header' }
    }
    case 'basic': {
      const username = resolve(auth.basic.username, scope)
      const password = resolve(auth.basic.password, scope)
      if (!username && !password) return null
      return {
        name: 'Authorization',
        value: 'Basic ' + base64Utf8(`${username}:${password}`),
        in: 'header',
      }
    }
    case 'apikey': {
      const key = resolve(auth.apikey.key, scope).trim()
      if (!key) return null
      return { name: key, value: resolve(auth.apikey.value, scope), in: auth.apikey.in }
    }
    default:
      return null
  }
}

function inheritSource(folders: Folder[], collection: Collection | null): string {
  for (let i = folders.length - 1; i >= 0; i--) {
    if (folders[i].auth.type !== 'inherit') return `folder "${folders[i].name}"`
  }
  if (collection && collection.auth.type !== 'inherit') return `collection "${collection.name}"`
  return 'nothing above it'
}

function AuthTab({
  request,
  scope,
  patch,
  ctx,
  collection,
  folders,
}: TabProps & {
  ctx: BuildContext
  collection: Collection | null
  folders: Folder[]
}): JSX.Element {
  const resolved = useMemo(() => effectiveAuth(request, ctx), [request, ctx])
  return (
    <AuthEditor
      auth={request.auth}
      onAuth={(auth) => patch({ auth })}
      scope={scope}
      resolved={resolved}
      subject="this request"
      note={
        <p className="rq-note">
          Taking authorization from {inheritSource(folders, collection)}
          {resolved.type === 'none' ? ' — nothing is sent.' : `, which uses ${resolved.type}.`}
          {collection && (
            <button
              className="rq-note-link"
              onClick={() =>
                useStore
                  .getState()
                  .openModal({ kind: 'collection', collectionId: collection.id, tab: 'auth' })
              }
            >
              Edit collection auth
            </button>
          )}
        </p>
      }
    />
  )
}

/**
 * The authorization form on its own, so a request and a whole collection can
 * share it. The owner supplies what `inherit` resolves to, since only it knows
 * what sits above: folders for a request, the app defaults for a collection.
 */
export function AuthEditor({
  auth,
  onAuth,
  scope,
  resolved,
  note,
  subject,
  types = AUTH_TYPES,
}: {
  auth: Auth
  onAuth: (next: Auth) => void
  scope: Map<string, VarScope>
  resolved: Auth
  note?: JSX.Element | null
  /** Named in the "nothing is sent" copy, e.g. "this request". */
  subject: string
  types?: ReadonlyArray<{ type: AuthType; label: string }>
}): JSX.Element {
  const [reveal, setReveal] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const generated = useMemo(() => authHeader(resolved, scope), [resolved, scope])

  const setAuth = (next: Partial<Auth>): void => onAuth({ ...auth, ...next })

  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Authorization</h3>
        </header>

        <div className="rq-segs" role="radiogroup" aria-label="Authorization type">
          {types.map((entry) => (
            <button
              key={entry.type}
              role="radio"
              aria-checked={auth.type === entry.type}
              className={`rq-seg${auth.type === entry.type ? ' is-on' : ''}`}
              onClick={() => setAuth({ type: entry.type })}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {auth.type === 'inherit' && note}

        {auth.type === 'none' && (
          <p className="rq-note">No Authorization header is added, whatever the folders say.</p>
        )}

        {auth.type === 'bearer' && (
          <div className="rq-fields">
            <Field label="Scheme" hint="Bearer, Token, DPoP — whatever the API expects.">
              <input
                className="input"
                value={auth.bearer.scheme}
                placeholder="Bearer"
                spellCheck={false}
                autoComplete="off"
                aria-label="Authorization scheme"
                onChange={(e) =>
                  setAuth({ bearer: { ...auth.bearer, scheme: e.target.value } })
                }
              />
            </Field>
            <Field label="Token">
              <VarInput
                value={auth.bearer.token}
                onChange={(token) => setAuth({ bearer: { ...auth.bearer, token } })}
                scope={scope}
                placeholder="{{accessToken}}"
                ariaLabel="Bearer token"
                className="rq-varfield"
              />
            </Field>
          </div>
        )}

        {auth.type === 'basic' && (
          <div className="rq-fields">
            <Field label="Username">
              <VarInput
                value={auth.basic.username}
                onChange={(username) => setAuth({ basic: { ...auth.basic, username } })}
                scope={scope}
                placeholder="{{user}}"
                ariaLabel="Username"
                className="rq-varfield"
              />
            </Field>
            <Field label="Password">
              <div className="rq-reveal">
                {showPassword ? (
                  <VarInput
                    value={auth.basic.password}
                    onChange={(password) => setAuth({ basic: { ...auth.basic, password } })}
                    scope={scope}
                    placeholder="{{password}}"
                    ariaLabel="Password"
                    className="rq-varfield"
                  />
                ) : (
                  <input
                    className="input"
                    type="password"
                    value={auth.basic.password}
                    autoComplete="off"
                    aria-label="Password"
                    onChange={(e) =>
                      setAuth({ basic: { ...auth.basic, password: e.target.value } })
                    }
                  />
                )}
                <button
                  className="btn-icon btn-xs"
                  aria-pressed={showPassword}
                  title={showPassword ? 'Hide the password' : 'Show the password'}
                  aria-label={showPassword ? 'Hide the password' : 'Show the password'}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <Icon name={showPassword ? 'eye-off' : 'eye'} size={12} />
                </button>
              </div>
            </Field>
          </div>
        )}

        {auth.type === 'apikey' && (
          <div className="rq-fields">
            <Field label="Key name">
              <input
                className="input"
                value={auth.apikey.key}
                placeholder="X-Api-Key"
                spellCheck={false}
                autoComplete="off"
                aria-label="API key name"
                onChange={(e) => setAuth({ apikey: { ...auth.apikey, key: e.target.value } })}
              />
            </Field>
            <Field label="Value">
              <VarInput
                value={auth.apikey.value}
                onChange={(value) => setAuth({ apikey: { ...auth.apikey, value } })}
                scope={scope}
                placeholder="{{apiKey}}"
                ariaLabel="API key value"
                className="rq-varfield"
              />
            </Field>
            <Field label="Send in">
              <div className="rq-radios" role="radiogroup" aria-label="Where to send the API key">
                {(['header', 'query'] as const).map((where) => (
                  <label className="rq-radio" key={where}>
                    <input
                      type="radio"
                      name="apikey-in"
                      checked={auth.apikey.in === where}
                      onChange={() => setAuth({ apikey: { ...auth.apikey, in: where } })}
                    />
                    <span>{where === 'header' ? 'Header' : 'Query string'}</span>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}
      </section>

      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">What goes on the wire</h3>
        </header>
        {generated ? (
          <div className="rq-generated">
            <span className="mono rq-generated-name">{generated.name}</span>
            <span className="mono rq-generated-value">{reveal ? generated.value : MASK}</span>
            <span className="badge">{generated.in === 'query' ? 'query' : 'header'}</span>
            <button
              className="btn-icon btn-xs"
              aria-pressed={reveal}
              title={reveal ? 'Hide the value' : 'Reveal the value'}
              aria-label={reveal ? 'Hide the generated value' : 'Reveal the generated value'}
              onClick={() => setReveal((v) => !v)}
            >
              <Icon name={reveal ? 'eye-off' : 'eye'} size={12} />
            </button>
          </div>
        ) : (
          <p className="rq-note">Nothing is added: {subject} sends no credentials.</p>
        )}
      </section>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="rq-field">
      <span className="plate rq-field-label">{label}</span>
      <div className="rq-field-control">{children}</div>
      {hint && <span className="rq-field-hint">{hint}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Cookies                                                             */
/* ------------------------------------------------------------------ */

function CookiesTab({ request, scope, patch }: TabProps): JSX.Element {
  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Request cookies</h3>
          <p className="rq-section-note">
            Merged into one Cookie header, after anything the shared jar contributes.
          </p>
        </header>
        <KVTable
          rows={request.cookies}
          onChange={(cookies) => patch({ cookies })}
          scope={scope}
          keyPlaceholder="Cookie"
          showDescription={false}
          emptyHint="No cookies pinned to this request."
        />
        <div className="rq-actions">
          <button
            className="btn btn-sm"
            onClick={() => useStore.getState().openModal({ kind: 'cookies' })}
          >
            <Icon name="cookie" size={11} /> Open the cookie jar
          </button>
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function SettingsTab({
  request,
  patch,
  ctx,
}: {
  request: ApiRequest
  patch: (next: Partial<ApiRequest>) => void
  ctx: BuildContext
}): JSX.Element {
  const resolved = useMemo(() => effectiveSettings(request, ctx), [request, ctx])
  // What the app and collection alone would have produced, for the "Inherit (…)" label.
  const inherited = useMemo(
    () => effectiveSettings({ ...request, settings: {} }, ctx),
    [request, ctx],
  )

  const has = (key: keyof RequestSettings): boolean => key in request.settings

  function set<K extends keyof RequestSettings>(key: K, value: RequestSettings[K]): void {
    const next: Partial<RequestSettings> = { ...request.settings }
    Object.assign(next, { [key]: value })
    patch({ settings: next })
  }

  const reset = (key: keyof RequestSettings): void => {
    const next: Partial<RequestSettings> = { ...request.settings }
    delete next[key]
    patch({ settings: next })
  }

  const onOff = (value: boolean): string => (value ? 'on' : 'off')

  return (
    <div className="rq-scroll">
      <section className="rq-section">
        <header className="rq-section-head">
          <h3 className="plate">Transport overrides</h3>
          <p className="rq-section-note">
            Every field falls through to the collection, then to the app defaults, until you set it
            here.
          </p>
        </header>

        <div className="rq-settings">
          <SettingRow
            label="Follow redirects"
            overridden={has('followRedirects')}
            inherited={onOff(inherited.followRedirects)}
            onReset={() => reset('followRedirects')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.followRedirects}
              aria-label="Follow redirects"
              onChange={(e) => set('followRedirects', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Maximum redirects"
            overridden={has('maxRedirects')}
            inherited={String(inherited.maxRedirects)}
            onReset={() => reset('maxRedirects')}
          >
            <input
              type="number"
              className="input rq-num"
              min={0}
              max={100}
              value={resolved.maxRedirects}
              aria-label="Maximum redirects"
              onChange={(e) => set('maxRedirects', clampInt(e.target.value, 0, 100))}
            />
          </SettingRow>

          <SettingRow
            label="Timeout"
            hint="Milliseconds. 0 waits forever."
            overridden={has('timeoutMs')}
            inherited={`${inherited.timeoutMs} ms`}
            onReset={() => reset('timeoutMs')}
          >
            <input
              type="number"
              className="input rq-num"
              min={0}
              step={500}
              value={resolved.timeoutMs}
              aria-label="Timeout in milliseconds"
              onChange={(e) => set('timeoutMs', clampInt(e.target.value, 0, 3_600_000))}
            />
          </SettingRow>

          <SettingRow
            label="Verify TLS certificate"
            hint={resolved.verifyTls ? undefined : 'Invalid and self-signed certificates are accepted.'}
            tone={resolved.verifyTls ? undefined : 'warn'}
            overridden={has('verifyTls')}
            inherited={onOff(inherited.verifyTls)}
            onReset={() => reset('verifyTls')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.verifyTls}
              aria-label="Verify TLS certificate"
              onChange={(e) => set('verifyTls', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Encode the URL"
            overridden={has('encodeUrl')}
            inherited={onOff(inherited.encodeUrl)}
            onReset={() => reset('encodeUrl')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.encodeUrl}
              aria-label="Encode the URL"
              onChange={(e) => set('encodeUrl', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Send jar cookies"
            overridden={has('sendCookies')}
            inherited={onOff(inherited.sendCookies)}
            onReset={() => reset('sendCookies')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.sendCookies}
              aria-label="Send jar cookies"
              onChange={(e) => set('sendCookies', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Store Set-Cookie"
            overridden={has('storeCookies')}
            inherited={onOff(inherited.storeCookies)}
            onReset={() => reset('storeCookies')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.storeCookies}
              aria-label="Store Set-Cookie responses"
              onChange={(e) => set('storeCookies', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Decompress"
            overridden={has('decompress')}
            inherited={onOff(inherited.decompress)}
            onReset={() => reset('decompress')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.decompress}
              aria-label="Decompress the response"
              onChange={(e) => set('decompress', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Stream the response"
            hint="Shows chunks as they arrive: SSE, chunked, long polls."
            overridden={has('streamResponse')}
            inherited={onOff(inherited.streamResponse)}
            onReset={() => reset('streamResponse')}
          >
            <input
              type="checkbox"
              className="switch"
              checked={resolved.streamResponse}
              aria-label="Stream the response"
              onChange={(e) => set('streamResponse', e.target.checked)}
            />
          </SettingRow>

          <SettingRow
            label="Proxy"
            overridden={has('proxy')}
            inherited={inherited.proxy || 'none'}
            onReset={() => reset('proxy')}
          >
            <input
              className="input rq-proxy"
              value={resolved.proxy}
              placeholder="http://127.0.0.1:8080"
              spellCheck={false}
              autoComplete="off"
              aria-label="Proxy"
              onChange={(e) => set('proxy', e.target.value)}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

function clampInt(raw: string, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}

function SettingRow({
  label,
  hint,
  tone,
  overridden,
  inherited,
  onReset,
  children,
}: {
  label: string
  hint?: string
  tone?: 'warn'
  overridden: boolean
  inherited: string
  onReset: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className={`rq-set-row${overridden ? ' is-override' : ''}${tone === 'warn' ? ' is-warn' : ''}`}
    >
      <div className="rq-set-label">
        <span className="rq-set-name">{label}</span>
        {hint && <span className="rq-set-hint">{hint}</span>}
      </div>
      <div className="rq-set-control">{children}</div>
      <div className="rq-set-state">
        {overridden ? (
          <button
            className="btn btn-ghost btn-sm"
            onClick={onReset}
            title={`Reset to the inherited value (${inherited})`}
            aria-label={`Reset ${label} to the inherited value`}
          >
            <Icon name="refresh" size={11} /> Inherited
          </button>
        ) : (
          <span className="rq-set-inherit plate">Inherit ({inherited})</span>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Docs                                                                */
/* ------------------------------------------------------------------ */

function DocsTab({
  request,
  patch,
}: {
  request: ApiRequest
  patch: (next: Partial<ApiRequest>) => void
}): JSX.Element {
  return (
    <div className="rq-docs">
      <textarea
        className="textarea rq-docs-area"
        value={request.docs}
        placeholder="Notes about this request"
        aria-label="Request notes"
        onChange={(e) => patch({ docs: e.target.value })}
      />
    </div>
  )
}
