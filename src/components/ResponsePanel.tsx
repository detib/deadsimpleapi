import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'

import type {
  RedirectHop,
  ResponseCookie,
  TlsInfo,
  WireRequest,
  WireResponseOk,
} from '../../shared/types'
import {
  formatBytes,
  formatDuration,
  highlightRanges,
  methodClass,
  statusClass,
  statusText,
} from '../lib/format'
import { findArrayPaths, getPath, type ArrayHit } from '../lib/json'
import { classifyBody, decodeText, suggestFileName, toDataUrl, type BodyKind } from '../lib/text'
import { useStore, type ExecState, type LiveStream, type ResTabKey } from '../state/store'
import { DataTable } from './DataTable'
import { JsonTree } from './JsonTree'
import { CodeEditor } from './ui/CodeEditor'
import { ContextMenu, type MenuItem } from './ui/ContextMenu'
import { Icon } from './ui/Icon'
import { Waveform } from './ui/Waveform'
import './ResponsePanel.css'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const RES_TABS: ReadonlyArray<{ key: ResTabKey; label: string }> = [
  { key: 'body', label: 'Body' },
  { key: 'table', label: 'Table' },
  { key: 'headers', label: 'Headers' },
  { key: 'cookies', label: 'Cookies' },
  { key: 'timing', label: 'Timing' },
  { key: 'sent', label: 'Sent' },
]

type EditorLang = 'json' | 'xml' | 'html' | 'javascript' | 'text'

/** The kinds worth turning into a string at all. */
const TEXTUAL = new Set<BodyKind>([
  'json',
  'xml',
  'html',
  'javascript',
  'css',
  'csv',
  'text',
  'event-stream',
])

const BODY_LANG: Partial<Record<BodyKind, EditorLang>> = {
  json: 'json',
  xml: 'xml',
  html: 'html',
  javascript: 'javascript',
  css: 'text',
  csv: 'text',
  text: 'text',
  'event-stream': 'text',
}

/** Search re-renders the body as spans, so the highlighter stays bounded. */
const FIND_CAP = 400_000
const FIND_MAX_MARKS = 1500
const HEX_CAP = 64 * 1024
const SSE_MAX_CARDS = 500

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function ResponsePanel({ tabId }: { tabId: string }): JSX.Element {
  const exec = useStore((s) => s.tabs.find((t) => t.id === tabId)?.exec ?? null)
  const [wrap, setWrap] = useState(() => useStore.getState().settings.wrapLines)
  const [jsonView, setJsonView] = useState<'tree' | 'raw'>('tree')

  const toggleWrap = useCallback(() => setWrap((v) => !v), [])

  if (!exec) return <div className="respanel" />

  if (exec.status === 'sending') {
    return exec.stream ? (
      <StreamingView
        tabId={tabId}
        stream={exec.stream}
        startedAt={exec.startedAt}
        wrap={wrap}
        onToggleWrap={toggleWrap}
      />
    ) : (
      <SendingView tabId={tabId} startedAt={exec.startedAt} />
    )
  }

  if (exec.status === 'canceled') return <CanceledView tabId={tabId} />
  if (exec.status === 'error') return <ErrorView tabId={tabId} exec={exec} />
  if (!exec.response || !exec.response.ok) return <IdleView />

  return (
    <ResponseView
      tabId={tabId}
      response={exec.response}
      wire={exec.wire}
      issues={exec.issues}
      wrap={wrap}
      onToggleWrap={toggleWrap}
      jsonView={jsonView}
      onJsonView={setJsonView}
    />
  )
}

/* ------------------------------------------------------------------ */
/* Pre-response states                                                 */
/* ------------------------------------------------------------------ */

function IdleView(): JSX.Element {
  return (
    <div className="respanel">
      <div className="empty-state res-fill">
        <p className="plate plate-lg">No response yet</p>
        <p className="empty-hint">
          <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span> sends the request
        </p>
      </div>
    </div>
  )
}

function SendingView({
  tabId,
  startedAt,
}: {
  tabId: string
  startedAt: number | null
}): JSX.Element {
  const elapsed = useElapsed(startedAt)

  return (
    <div className="respanel">
      <div className="res-center">
        <span className="spinner res-spinner-lg" aria-hidden="true" />
        <p className="plate plate-lg">Waiting for response</p>
        <p className="res-elapsed mono">{formatDuration(elapsed)}</p>
        <button
          className="btn"
          onClick={() => void useStore.getState().cancel(tabId)}
          aria-label="Cancel the request"
        >
          <Icon name="stop" size={12} /> Cancel
        </button>
      </div>
    </div>
  )
}

function StreamingView({
  tabId,
  stream,
  startedAt,
  wrap,
  onToggleWrap,
}: {
  tabId: string
  stream: LiveStream
  startedAt: number | null
  wrap: boolean
  onToggleWrap: () => void
}): JSX.Element {
  const elapsed = useElapsed(startedAt)
  const scroller = useRef<HTMLDivElement>(null)
  /** Sticky only while the user is parked at the bottom; scrolling up wins. */
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (!el || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [stream.text])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  const status = stream.status
  const reason = stream.statusText || (status === undefined ? '' : statusText(status))

  return (
    <div className="respanel">
      <div className="res-ribbon">
        {status === undefined ? (
          <span className="plate">Connecting</span>
        ) : (
          <>
            <span className={`res-status mono st-${statusClass(status)}`}>{status}</span>
            <span className="res-reason truncate">{reason}</span>
          </>
        )}

        <span className="chip chip-signal res-live">
          <span className="spinner res-spinner-xs" aria-hidden="true" />
          streaming · {formatBytes(stream.bytes)}
        </span>

        <span className="res-metric mono">
          <span className="res-sr">Elapsed </span>
          {formatDuration(elapsed)}
        </span>

        <span className="res-spacer" />

        <button
          className="btn-icon tooltip"
          data-tip="Wrap lines"
          data-tip-pos="left"
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          onClick={onToggleWrap}
        >
          <Icon name="wrap" />
        </button>
        <button
          className="btn btn-sm"
          onClick={() => void useStore.getState().cancel(tabId)}
          aria-label="Cancel the request"
        >
          <Icon name="stop" size={11} /> Cancel
        </button>
      </div>

      <div
        className="res-body"
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        aria-label="Streaming response body"
      >
        <pre className={`res-pre${wrap ? ' is-wrap' : ''}`}>{stream.text}</pre>
      </div>
    </div>
  )
}

function CanceledView({ tabId }: { tabId: string }): JSX.Element {
  return (
    <div className="respanel">
      <div className="empty-state res-fill">
        <p className="plate plate-lg">Request canceled</p>
        <p>Nothing came back, because you stopped it.</p>
        <div className="empty-actions">
          <button className="btn" onClick={() => void useStore.getState().send(tabId)}>
            <Icon name="refresh" size={12} /> Retry
          </button>
        </div>
      </div>
    </div>
  )
}

const TLS_HINT_RE =
  /tls|ssl|certificate|cert_|self[- ]signed|unable to verify|depth_zero|hostname\/ip/i

function ErrorView({ tabId, exec }: { tabId: string; exec: ExecState }): JSX.Element {
  const failed = exec.response && !exec.response.ok ? exec.response : null
  const message = failed?.error ?? exec.issues[0] ?? 'The request could not be sent.'
  const code = failed?.code
  const tlsRelated = TLS_HINT_RE.test(`${message} ${code ?? ''}`)
  // When the message came from issues[0] it must not be repeated underneath.
  const extraIssues = failed ? exec.issues : exec.issues.slice(1)

  return (
    <div className="respanel">
      <div className="res-fail">
        <p className="res-fail-head plate plate-lg">
          <Icon name="alert" size={13} /> Request failed
        </p>
        <p className="res-fail-msg">{message}</p>
        {code && <p className="res-fail-code mono">{code}</p>}

        {extraIssues.length > 0 && (
          <ul className="res-fail-issues">
            {extraIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}

        {tlsRelated && (
          <div className="res-hint">
            <p>
              This looks like a certificate problem. If you are calling a development server with a
              self-signed certificate, turn <strong>Verify TLS certificate</strong> off in this
              request&apos;s settings.
            </p>
            <button
              className="btn btn-sm"
              onClick={() => useStore.getState().setReqTab(tabId, 'settings')}
            >
              <Icon name="settings" size={11} /> Open the Settings tab
            </button>
          </div>
        )}

        <div className="empty-actions">
          <button className="btn btn-primary" onClick={() => void useStore.getState().send(tabId)}>
            <Icon name="refresh" size={12} /> Retry
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Response view                                                       */
/* ------------------------------------------------------------------ */

interface ResponseViewProps {
  tabId: string
  response: WireResponseOk
  wire: WireRequest | null
  issues: string[]
  wrap: boolean
  onToggleWrap: () => void
  jsonView: 'tree' | 'raw'
  onJsonView: (view: 'tree' | 'raw') => void
}

function ResponseView({
  tabId,
  response,
  wire,
  issues,
  wrap,
  onToggleWrap,
  jsonView,
  onJsonView,
}: ResponseViewProps): JSX.Element {
  const resTab = useStore((s) => s.tabs.find((t) => t.id === tabId)?.resTab ?? 'body')
  const setResTab = useStore((s) => s.setResTab)

  const [showHops, setShowHops] = useState(false)
  /** Both are keyed by execId so a new response never inherits the old one. */
  const [overflow, setOverflow] = useState<{ execId: string; bytes: Uint8Array } | null>(null)
  const [pick, setPick] = useState<{ execId: string; path: string } | null>(null)

  const bytes = overflow && overflow.execId === response.execId ? overflow.bytes : response.body

  const contentType = useMemo(
    () => response.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1],
    [response],
  )

  const kind = useMemo(() => classifyBody(contentType, bytes), [contentType, bytes])

  // The single decode. A 20MB body must never become a string twice.
  const text = useMemo(
    () => (TEXTUAL.has(kind) ? decodeText(bytes, contentType) : ''),
    [kind, bytes, contentType],
  )

  const parsed = useMemo<{ value: unknown; error: string | null }>(() => {
    if (kind !== 'json') return { value: undefined, error: null }
    try {
      return { value: JSON.parse(text) as unknown, error: null }
    } catch (err) {
      return { value: undefined, error: err instanceof Error ? err.message : String(err) }
    }
  }, [kind, text])

  const tables = useMemo<ArrayHit[]>(() => {
    if (kind !== 'json' || parsed.error !== null) return []
    return findArrayPaths(parsed.value).filter((hit) => hit.length > 0)
  }, [kind, parsed])

  const tablePath =
    pick && pick.execId === response.execId && tables.some((t) => t.path === pick.path)
      ? pick.path
      : (tables[0]?.path ?? null)

  const tableRows = useMemo<unknown[]>(() => {
    if (tablePath === null) return []
    const found = getPath(parsed.value, tablePath)
    return Array.isArray(found) ? (found as unknown[]) : []
  }, [parsed, tablePath])

  // A response with no arrays must not strand the user on a dead tab.
  useEffect(() => {
    if (resTab === 'table' && tables.length === 0) setResTab(tabId, 'body')
  }, [resTab, tables.length, setResTab, tabId])

  /* -------------------------------------------------------------- */

  const saveBody = useCallback(() => {
    void window.api.files
      .saveAs(suggestFileName(response.sent.url, contentType), bytes)
      .then((path) => {
        if (path) useStore.getState().toast('success', 'Response saved', path)
      })
      .catch((err: unknown) => {
        useStore.getState().toast('error', 'Could not save the response', String(err))
      })
  }, [response, contentType, bytes])

  const loadOverflow = useCallback(() => {
    const path = response.overflowPath
    if (!path) return
    void window.api.files
      .readOverflow(path)
      .then((full) => {
        if (!full) {
          useStore.getState().toast('error', 'The overflow file is gone', path)
          return
        }
        setOverflow({ execId: response.execId, bytes: full })
        useStore.getState().toast('success', `Loaded the full ${formatBytes(full.length)} body`)
      })
      .catch((err: unknown) => {
        useStore.getState().toast('error', 'Could not read the full body', String(err))
      })
  }, [response])

  const canCopy = TEXTUAL.has(kind)
  const reason = response.statusText || statusText(response.status)
  const canLoadRest = response.truncated && !!response.overflowPath && !overflow

  /* -------------------------------------------------------------- */

  return (
    <div className="respanel">
      <div className="res-ribbon">
        <span className={`res-status mono st-${statusClass(response.status)}`}>
          {response.status}
        </span>
        <span className="res-reason truncate" title={reason}>
          {reason}
        </span>

        <span className="res-metric mono">
          <span className="res-sr">Total time </span>
          {formatDuration(response.timing.total)}
        </span>
        <span className="res-metric mono">
          <span className="res-sr">Decoded size </span>
          {formatBytes(response.size.decoded)}
        </span>

        <Waveform timing={response.timing} size="sm" className="res-wave" />

        {response.redirects.length > 0 && (
          <button
            className="chip res-chip-btn"
            aria-expanded={showHops}
            onClick={() => setShowHops((v) => !v)}
          >
            <Icon name="share" size={10} />
            {response.redirects.length} redirect{response.redirects.length === 1 ? '' : 's'}
          </button>
        )}

        {response.truncated && (
          <span className="chip chip-signal res-trunc">
            <Icon name="alert" size={10} />
            truncated · {formatBytes(bytes.length)} shown
            {canLoadRest && (
              <button className="res-chip-link" onClick={loadOverflow}>
                load all
              </button>
            )}
          </span>
        )}

        {issues.length > 0 && (
          <span className="chip res-issues tooltip" data-tip={issues.join(' · ')}>
            <Icon name="info" size={10} />
            {issues.length}
          </span>
        )}

        <span className="res-spacer" />

        <button
          className="btn-icon tooltip"
          data-tip={canCopy ? 'Copy body' : 'Body is not text'}
          data-tip-pos="left"
          aria-label="Copy the response body"
          disabled={!canCopy}
          onClick={() => copyText(text, 'Response body copied')}
        >
          <Icon name="copy" />
        </button>
        <button
          className="btn-icon tooltip"
          data-tip="Save to file"
          data-tip-pos="left"
          aria-label="Save the response to a file"
          onClick={saveBody}
        >
          <Icon name="save" />
        </button>
        <button
          className="btn-icon tooltip"
          data-tip="Wrap lines"
          data-tip-pos="left"
          aria-label="Wrap long lines"
          aria-pressed={wrap}
          onClick={onToggleWrap}
        >
          <Icon name="wrap" />
        </button>
      </div>

      {showHops && <RedirectHops hops={response.redirects} />}

      <div className="tabs res-tabs" role="tablist" aria-label="Response views">
        {RES_TABS.map((entry) => {
          const disabled = entry.key === 'table' && tables.length === 0
          const count = tabCount(entry.key, response, tables.length, tableRows.length)
          return (
            <button
              key={entry.key}
              role="tab"
              id={`res-tab-${tabId}-${entry.key}`}
              aria-selected={resTab === entry.key}
              aria-controls={`res-panel-${tabId}`}
              className={`tab${disabled ? ' tooltip' : ''}`}
              data-tip={disabled ? 'No array in this response to tabulate' : undefined}
              disabled={disabled}
              onClick={() => setResTab(tabId, entry.key)}
            >
              {entry.label}
              {count ? <span className="res-count mono">{count}</span> : null}
            </button>
          )
        })}
      </div>

      <div
        className="res-pane"
        role="tabpanel"
        id={`res-panel-${tabId}`}
        aria-labelledby={`res-tab-${tabId}-${resTab}`}
      >
        {resTab === 'body' && (
          <BodyTab
            kind={kind}
            text={text}
            bytes={bytes}
            contentType={contentType}
            parsed={parsed}
            wrap={wrap}
            jsonView={jsonView}
            onJsonView={onJsonView}
            onSave={saveBody}
          />
        )}

        {resTab === 'table' && (
          <TableTab
            tables={tables}
            path={tablePath}
            rows={tableRows}
            kind={kind}
            onPick={(path) => setPick({ execId: response.execId, path })}
          />
        )}

        {resTab === 'headers' && <HeadersTab headers={response.headers} />}
        {resTab === 'cookies' && <CookiesTab cookies={response.cookies} />}
        {resTab === 'timing' && <TimingTab response={response} />}
        {resTab === 'sent' && <SentTab tabId={tabId} response={response} wire={wire} />}
      </div>
    </div>
  )
}

function tabCount(
  key: ResTabKey,
  response: WireResponseOk,
  tableCount: number,
  rowCount: number,
): number | undefined {
  if (key === 'table') return tableCount > 0 ? rowCount : undefined
  if (key === 'headers') return response.headers.length
  if (key === 'cookies') return response.cookies.length
  return undefined
}

function RedirectHops({ hops }: { hops: RedirectHop[] }): JSX.Element {
  return (
    <ol className="res-hops">
      {hops.map((hop, index) => (
        <li key={`${hop.url}-${index}`}>
          <span className={`res-hop-status mono st-${statusClass(hop.status)}`}>{hop.status}</span>
          <span className="res-hop-url mono truncate" title={hop.url}>
            {hop.url}
          </span>
          <Icon name="chevron-right" size={11} className="res-hop-arrow" />
          <span className="res-hop-loc mono truncate" title={hop.location}>
            {hop.location}
          </span>
        </li>
      ))}
    </ol>
  )
}

/* ------------------------------------------------------------------ */
/* Body tab                                                            */
/* ------------------------------------------------------------------ */

interface BodyTabProps {
  kind: BodyKind
  text: string
  bytes: Uint8Array
  contentType: string | undefined
  parsed: { value: unknown; error: string | null }
  wrap: boolean
  jsonView: 'tree' | 'raw'
  onJsonView: (view: 'tree' | 'raw') => void
  onSave: () => void
}

function BodyTab({
  kind,
  text,
  bytes,
  contentType,
  parsed,
  wrap,
  jsonView,
  onJsonView,
  onSave,
}: BodyTabProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [hit, setHit] = useState(0)

  const isJsonTree = kind === 'json' && parsed.error === null && jsonView === 'tree'
  const isStream = kind === 'event-stream'
  const searchable = TEXTUAL.has(kind)
  const findable = searchable && !isJsonTree && !isStream

  const findText = useMemo(() => (text.length > FIND_CAP ? text.slice(0, FIND_CAP) : text), [text])
  const ranges = useMemo(
    () => (query && findable ? highlightRanges(findText, query) : []),
    [findText, query, findable],
  )

  const frames = useMemo(() => (isStream ? parseSse(text) : []), [isStream, text])
  const shownFrames = useMemo(() => {
    if (!query) return frames
    const needle = query.toLowerCase()
    return frames.filter(
      (frame) =>
        (frame.event ?? '').toLowerCase().includes(needle) ||
        (frame.id ?? '').toLowerCase().includes(needle) ||
        frame.data.toLowerCase().includes(needle),
    )
  }, [frames, query])

  useEffect(() => setHit(0), [query, findText])

  const step = (delta: number): void => {
    if (!ranges.length) return
    setHit((current) => (current + delta + ranges.length) % ranges.length)
  }

  /* -------------------------------------------------------------- */

  let content: ReactNode
  if (kind === 'empty') {
    content = (
      <div className="empty-state res-fill">
        <p className="plate">No body</p>
        <p>The response carried no body at all.</p>
      </div>
    )
  } else if (kind === 'image') {
    content = <ImageBody bytes={bytes} contentType={contentType} />
  } else if (kind === 'pdf') {
    content = <PdfBody bytes={bytes} contentType={contentType} />
  } else if (kind === 'audio' || kind === 'video') {
    content = <MediaBody kind={kind} bytes={bytes} contentType={contentType} />
  } else if (kind === 'binary') {
    content = <HexBody bytes={bytes} />
  } else if (isStream) {
    content = (
      <div className="res-body">
        {shownFrames.length === 0 ? (
          <div className="empty-state">
            <p>{frames.length ? 'No event matches that search.' : 'No complete event arrived.'}</p>
          </div>
        ) : (
          <>
            <ul className="res-sse">
              {shownFrames.slice(0, SSE_MAX_CARDS).map((frame, index) => (
                <SseCard key={index} frame={frame} index={index} wrap={wrap} />
              ))}
            </ul>
            {shownFrames.length > SSE_MAX_CARDS && (
              <p className="res-note">
                Showing the first {SSE_MAX_CARDS} of {shownFrames.length} events.
              </p>
            )}
          </>
        )}
      </div>
    )
  } else if (isJsonTree) {
    content = (
      <div className="res-body">
        <JsonTree
          value={parsed.value}
          filter={query}
          onPickPath={(path) => copyText(path, 'Path copied')}
          className="res-tree"
        />
      </div>
    )
  } else if (query && findable) {
    content = (
      <FindView
        text={findText}
        ranges={ranges}
        active={hit}
        wrap={wrap}
        capped={text.length > findText.length}
      />
    )
  } else {
    content = (
      <div className="res-editor">
        <CodeEditor
          value={text}
          language={BODY_LANG[kind] ?? 'text'}
          readOnly
          wrap={wrap}
          ariaLabel="Response body"
        />
      </div>
    )
  }

  /* -------------------------------------------------------------- */

  return (
    <>
      <div className="res-toolbar">
        {searchable ? (
          <>
            <span className="res-search">
              <Icon name="search" size={12} className="res-search-icon" />
              <input
                className="res-search-input mono"
                type="search"
                value={query}
                spellCheck={false}
                autoComplete="off"
                placeholder={isJsonTree ? 'Filter keys and values' : 'Search body'}
                aria-label="Search the response body"
                onChange={(event) => setQuery(event.target.value)}
              />
            </span>

            {query && isStream && (
              <span className="res-hits mono">
                {shownFrames.length}/{frames.length} events
              </span>
            )}

            {query && findable && (
              <span className="res-find">
                <span className="res-hits mono">
                  {ranges.length ? `${hit + 1}/${ranges.length}` : '0'}
                </span>
                <button
                  className="btn btn-ghost btn-icon btn-xs"
                  aria-label="Previous match"
                  disabled={!ranges.length}
                  onClick={() => step(-1)}
                >
                  <Icon name="chevron-up" size={11} />
                </button>
                <button
                  className="btn btn-ghost btn-icon btn-xs"
                  aria-label="Next match"
                  disabled={!ranges.length}
                  onClick={() => step(1)}
                >
                  <Icon name="chevron-down" size={11} />
                </button>
              </span>
            )}
          </>
        ) : (
          <span className="plate">{kind === 'binary' ? 'Hex dump' : `${kind} preview`}</span>
        )}

        <span className="res-spacer" />

        {kind === 'json' && parsed.error === null && (
          <div className="res-seg" role="group" aria-label="JSON view">
            <button
              className="res-seg-btn"
              data-active={jsonView === 'tree'}
              aria-pressed={jsonView === 'tree'}
              onClick={() => onJsonView('tree')}
            >
              <Icon name="braces" size={11} /> Tree
            </button>
            <button
              className="res-seg-btn"
              data-active={jsonView === 'raw'}
              aria-pressed={jsonView === 'raw'}
              onClick={() => onJsonView('raw')}
            >
              <Icon name="list" size={11} /> Raw
            </button>
          </div>
        )}

        {(kind === 'binary' || kind === 'image' || kind === 'pdf') && (
          <button className="btn btn-sm" onClick={onSave}>
            <Icon name="save" size={11} /> Save to file
          </button>
        )}

        <span className="chip res-type" title={contentType ?? 'No Content-Type header'}>
          {shortType(contentType) || kind}
        </span>
      </div>

      {parsed.error !== null && (
        <p className="res-parse-error">
          <Icon name="alert" size={11} /> Not valid JSON: {parsed.error}
        </p>
      )}

      {content}
    </>
  )
}

/* ------------------------------------------------------------------ */

function FindView({
  text,
  ranges,
  active,
  wrap,
  capped,
}: {
  text: string
  ranges: Array<[number, number]>
  active: number
  wrap: boolean
  capped: boolean
}): JSX.Element {
  const activeRef = useRef<HTMLElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [active, text, ranges])

  const nodes = useMemo<ReactNode[]>(() => {
    const out: ReactNode[] = []
    const limit = Math.min(ranges.length, FIND_MAX_MARKS)
    let cursor = 0
    for (let i = 0; i < limit; i++) {
      const [start, end] = ranges[i]
      if (start > cursor) out.push(text.slice(cursor, start))
      out.push(
        <mark
          key={i}
          className={`res-hit${i === active ? ' is-active' : ''}`}
          ref={i === active ? activeRef : undefined}
        >
          {text.slice(start, end)}
        </mark>,
      )
      cursor = end
    }
    out.push(text.slice(cursor))
    return out
  }, [text, ranges, active])

  return (
    <div className="res-body">
      <pre className={`res-pre${wrap ? ' is-wrap' : ''}`}>{nodes}</pre>
      {(capped || ranges.length > FIND_MAX_MARKS) && (
        <p className="res-note">
          Highlighting the first {FIND_MAX_MARKS} matches of the first {formatBytes(FIND_CAP)}.
          Narrow the search to reach the rest.
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

interface SseFrame {
  event?: string
  id?: string
  retry?: string
  data: string
}

/** Blank-line separated frames, per the WHATWG event stream grammar. */
function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  const blocks = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n{2,}/)

  for (const block of blocks) {
    if (!block.trim()) continue
    const dataLines: string[] = []
    const frame: SseFrame = { data: '' }
    let meaningful = false

    for (const line of block.split('\n')) {
      // A line starting with ':' is a keep-alive comment.
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      if (field === 'data') {
        dataLines.push(value)
        meaningful = true
      } else if (field === 'event') {
        frame.event = value
        meaningful = true
      } else if (field === 'id') {
        frame.id = value
        meaningful = true
      } else if (field === 'retry') {
        frame.retry = value
        meaningful = true
      }
    }

    if (!meaningful) continue
    frame.data = dataLines.join('\n')
    frames.push(frame)
  }
  return frames
}

function SseCard({
  frame,
  index,
  wrap,
}: {
  frame: SseFrame
  index: number
  wrap: boolean
}): JSX.Element {
  const json = useMemo<{ ok: boolean; value: unknown }>(() => {
    const trimmed = frame.data.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false, value: undefined }
    try {
      return { ok: true, value: JSON.parse(trimmed) as unknown }
    } catch {
      return { ok: false, value: undefined }
    }
  }, [frame.data])

  return (
    <li className="res-sse-card">
      <div className="res-sse-head">
        <span className="res-sse-index mono">{index + 1}</span>
        <span className="res-sse-event plate">{frame.event || 'message'}</span>
        {frame.id !== undefined && <span className="chip">id {frame.id || '(empty)'}</span>}
        {frame.retry !== undefined && <span className="chip">retry {frame.retry} ms</span>}
      </div>
      <div className="res-sse-body">
        {json.ok ? (
          <JsonTree value={json.value} defaultExpandDepth={2} className="res-tree" />
        ) : frame.data ? (
          <pre className={`res-pre is-flush${wrap ? ' is-wrap' : ''}`}>{frame.data}</pre>
        ) : (
          <p className="res-note is-flush">No data field.</p>
        )}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------ */
/* Binary and media bodies                                             */
/* ------------------------------------------------------------------ */

function ImageBody({
  bytes,
  contentType,
}: {
  bytes: Uint8Array
  contentType: string | undefined
}): JSX.Element {
  const url = useMemo(() => toDataUrl(bytes, contentType), [bytes, contentType])
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null)

  return (
    <div className="res-body res-media">
      <img
        className="res-image"
        src={url}
        alt="Response image preview"
        onLoad={(event) =>
          setDim({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
        }
      />
      <p className="res-meta mono">
        {dim ? `${dim.w} × ${dim.h} px · ` : ''}
        {formatBytes(bytes.length)}
        {contentType ? ` · ${shortType(contentType)}` : ''}
      </p>
    </div>
  )
}

function PdfBody({
  bytes,
  contentType,
}: {
  bytes: Uint8Array
  contentType: string | undefined
}): JSX.Element {
  const url = useMemo(() => toDataUrl(bytes, contentType), [bytes, contentType])
  return (
    <div className="res-body res-media is-fill">
      <iframe className="res-frame" src={url} title="PDF response preview" />
      <p className="res-meta mono">{formatBytes(bytes.length)} · application/pdf</p>
    </div>
  )
}

function MediaBody({
  kind,
  bytes,
  contentType,
}: {
  kind: 'audio' | 'video'
  bytes: Uint8Array
  contentType: string | undefined
}): JSX.Element {
  const url = useMemo(() => toDataUrl(bytes, contentType), [bytes, contentType])
  return (
    <div className="res-body res-media">
      {kind === 'audio' ? (
        <audio className="res-av" controls src={url} aria-label="Response audio" />
      ) : (
        <video className="res-av" controls src={url} aria-label="Response video" />
      )}
      <p className="res-meta mono">
        {formatBytes(bytes.length)}
        {contentType ? ` · ${shortType(contentType)}` : ''}
      </p>
    </div>
  )
}

function HexBody({ bytes }: { bytes: Uint8Array }): JSX.Element {
  // Three aligned text nodes beat 4096 rows of elements by an order of
  // magnitude, and a monospace column keeps them in register.
  const dump = useMemo(() => {
    const limit = Math.min(bytes.length, HEX_CAP)
    const offsets: string[] = []
    const hex: string[] = []
    const ascii: string[] = []

    for (let row = 0; row < limit; row += 16) {
      offsets.push(row.toString(16).padStart(8, '0'))
      let hexLine = ''
      let asciiLine = ''
      for (let col = 0; col < 16; col++) {
        const index = row + col
        if (index < limit) {
          const byte = bytes[index]
          hexLine += byte.toString(16).padStart(2, '0')
          asciiLine += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
        } else {
          hexLine += '  '
          asciiLine += ' '
        }
        hexLine += col === 7 ? '  ' : ' '
      }
      hex.push(hexLine)
      ascii.push(asciiLine)
    }

    return {
      offsets: offsets.join('\n'),
      hex: hex.join('\n'),
      ascii: ascii.join('\n'),
      capped: bytes.length > limit,
    }
  }, [bytes])

  return (
    <>
      {dump.capped && (
        <p className="res-note">
          The first 64 KB of {formatBytes(bytes.length)} is shown. Save the response to inspect all
          of it.
        </p>
      )}
      <div className="res-body res-hex">
        <pre className="res-hex-off" aria-hidden="true">
          {dump.offsets}
        </pre>
        <pre className="res-hex-bytes">{dump.hex}</pre>
        <pre className="res-hex-ascii">{dump.ascii}</pre>
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Table tab                                                           */
/* ------------------------------------------------------------------ */

function TableTab({
  tables,
  path,
  rows,
  kind,
  onPick,
}: {
  tables: ArrayHit[]
  path: string | null
  rows: unknown[]
  kind: BodyKind
  onPick: (path: string) => void
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // DataTable's retarget control carries no anchor, so the picker opens at the
  // top-left of the table itself.
  const openPicker = useCallback(() => {
    const rect = host.current?.getBoundingClientRect()
    setMenu({ x: (rect?.left ?? 80) + 12, y: (rect?.top ?? 80) + 28 })
  }, [])

  if (path === null) {
    return (
      <div className="empty-state res-fill">
        <p className="plate">Nothing to tabulate</p>
        <p>
          {kind === 'json'
            ? 'This JSON response holds no array. The table view needs a list.'
            : 'The table view reads JSON. This response is not JSON.'}
        </p>
      </div>
    )
  }

  const items: MenuItem[] = tables.map((hit) => ({
    label: `${hit.path || '(root)'} — ${hit.length} row${hit.length === 1 ? '' : 's'}`,
    icon: hit.path === path ? 'check' : 'table',
    onSelect: () => onPick(hit.path),
  }))

  return (
    <div className="res-tablehost" ref={host}>
      <DataTable
        rows={rows}
        sourcePath={path || '(root)'}
        onChangeSource={openPicker}
        className="res-datatable"
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Headers tab                                                         */
/* ------------------------------------------------------------------ */

function HeadersTab({ headers }: { headers: Array<[string, string]> }): JSX.Element {
  return (
    <>
      <div className="res-toolbar">
        <span className="plate">
          {headers.length} response header{headers.length === 1 ? '' : 's'}
        </span>
        <span className="res-spacer" />
        <button
          className="btn btn-sm"
          onClick={() =>
            copyText(
              headers.map(([name, value]) => `${name}: ${value}`).join('\n'),
              'Headers copied',
            )
          }
        >
          <Icon name="copy" size={11} /> Copy all
        </button>
      </div>

      <div className="res-body">
        {headers.length === 0 ? (
          <div className="empty-state">
            <p>No headers came back.</p>
          </div>
        ) : (
          <table className="table-lite res-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {headers.map(([name, value], index) => (
                <tr key={`${name}-${index}`}>
                  <td className="res-hname">{name}</td>
                  <td className="res-selectable">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Cookies tab                                                         */
/* ------------------------------------------------------------------ */

function CookiesTab({ cookies }: { cookies: ResponseCookie[] }): JSX.Element {
  const openModal = useStore((s) => s.openModal)

  return (
    <>
      <div className="res-toolbar">
        <span className="plate">
          {cookies.length} cookie{cookies.length === 1 ? '' : 's'} set
        </span>
        <span className="res-spacer" />
        <button className="btn btn-sm" onClick={() => openModal({ kind: 'cookies' })}>
          <Icon name="cookie" size={11} /> Cookie jar
        </button>
      </div>

      <div className="res-body">
        {cookies.length === 0 ? (
          <div className="empty-state">
            <p className="plate">No cookies</p>
            <p>This response did not set any.</p>
          </div>
        ) : (
          <table className="table-lite res-table res-cookies">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
                <th scope="col">Domain</th>
                <th scope="col">Path</th>
                <th scope="col">Expires</th>
                <th scope="col">Flags</th>
              </tr>
            </thead>
            <tbody>
              {cookies.map((cookie, index) => (
                <tr key={`${cookie.name}-${index}`}>
                  <td className="res-hname">{cookie.name}</td>
                  <td className="res-selectable res-cookie-value">{cookie.value}</td>
                  <td>{cookie.domain || '—'}</td>
                  <td>{cookie.path || '—'}</td>
                  <td>
                    {cookie.expires ??
                      (cookie.maxAge !== undefined ? `max-age ${cookie.maxAge}` : '—')}
                  </td>
                  <td className="res-flags">
                    {cookie.secure && <span className="chip">Secure</span>}
                    {cookie.httpOnly && <span className="chip">HttpOnly</span>}
                    {cookie.sameSite && <span className="chip">SameSite={cookie.sameSite}</span>}
                    {!cookie.secure && !cookie.httpOnly && !cookie.sameSite && '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Timing tab                                                          */
/* ------------------------------------------------------------------ */

const PHASE_ROWS: ReadonlyArray<{
  key: 'dns' | 'tcp' | 'tls' | 'wait' | 'download'
  label: string
}> = [
  { key: 'dns', label: 'DNS lookup' },
  { key: 'tcp', label: 'TCP connect' },
  { key: 'tls', label: 'TLS handshake' },
  { key: 'wait', label: 'Waiting (TTFB)' },
  { key: 'download', label: 'Download' },
]

function TimingTab({ response }: { response: WireResponseOk }): JSX.Element {
  const { timing } = response

  return (
    <div className="res-body res-timing">
      <Waveform timing={timing} size="lg" legend className="res-wave-lg" />

      <table className="table-lite res-table">
        <thead>
          <tr>
            <th scope="col">Phase</th>
            <th scope="col">Milliseconds</th>
          </tr>
        </thead>
        <tbody>
          {PHASE_ROWS.map((phase) => {
            const value = timing[phase.key]
            return (
              <tr key={phase.key}>
                <td>{phase.label}</td>
                <td className="res-num">{typeof value === 'number' ? value.toFixed(2) : '—'}</td>
              </tr>
            )
          })}
          <tr>
            <td>Total</td>
            <td className="res-num">{timing.total.toFixed(2)}</td>
          </tr>
          <tr>
            <td>Started</td>
            <td className="res-num">
              {new Date(timing.startedAt).toLocaleTimeString(undefined, { hour12: false })}
            </td>
          </tr>
        </tbody>
      </table>

      <table className="table-lite res-table">
        <thead>
          <tr>
            <th scope="col">Connection</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Remote address</td>
            <td className="res-selectable">{response.remoteAddress ?? '—'}</td>
          </tr>
          <tr>
            <td>Remote port</td>
            <td className="res-num">{response.remotePort ?? '—'}</td>
          </tr>
          <tr>
            <td>HTTP version</td>
            <td>{response.httpVersion || '—'}</td>
          </tr>
          <tr>
            <td>Transferred</td>
            <td className="res-num">{formatBytes(response.size.transfer)}</td>
          </tr>
          <tr>
            <td>Decoded</td>
            <td className="res-num">{formatBytes(response.size.decoded)}</td>
          </tr>
          <tr>
            <td>Headers</td>
            <td className="res-num">{formatBytes(response.size.headers)}</td>
          </tr>
        </tbody>
      </table>

      {response.tls && <TlsBlock tls={response.tls} />}
    </div>
  )
}

function TlsBlock({ tls }: { tls: TlsInfo }): JSX.Element {
  return (
    <>
      {!tls.authorized && (
        <p className="res-tls-warn">
          <Icon name="alert" size={11} /> Certificate not trusted
          {tls.authorizationError ? `: ${tls.authorizationError}` : '.'}
        </p>
      )}
      <table className="table-lite res-table">
        <thead>
          <tr>
            <th scope="col">TLS</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Protocol</td>
            <td>{tls.protocol || '—'}</td>
          </tr>
          <tr>
            <td>Cipher</td>
            <td className="res-selectable">{tls.cipher || '—'}</td>
          </tr>
          <tr>
            <td>Issuer</td>
            <td className="res-selectable">{tls.issuer || '—'}</td>
          </tr>
          <tr>
            <td>Subject</td>
            <td className="res-selectable">{tls.subject || '—'}</td>
          </tr>
          <tr>
            <td>Valid from</td>
            <td>{tls.validFrom || '—'}</td>
          </tr>
          <tr>
            <td>Valid to</td>
            <td>{tls.validTo || '—'}</td>
          </tr>
          <tr>
            <td>Authorized</td>
            <td className={tls.authorized ? 'st-success' : 'st-server-error'}>
              {tls.authorized ? 'yes' : 'no'}
            </td>
          </tr>
        </tbody>
      </table>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Sent tab                                                            */
/* ------------------------------------------------------------------ */

function SentTab({
  tabId,
  response,
  wire,
}: {
  tabId: string
  response: WireResponseOk
  wire: WireRequest | null
}): JSX.Element {
  const openModal = useStore((s) => s.openModal)
  const { sent } = response

  const sentType = useMemo(
    () => sent.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1],
    [sent],
  )

  return (
    <>
      <div className="res-toolbar">
        <span className={`res-method method-badge ${methodClass(sent.method)}`}>{sent.method}</span>
        <span className="plate">on the wire</span>
        <span className="res-spacer" />
        <button
          className="btn btn-sm"
          onClick={() => copyText(sent.url, 'URL copied')}
          aria-label="Copy the sent URL"
        >
          <Icon name="link" size={11} /> URL
        </button>
        <button className="btn btn-sm" onClick={() => openModal({ kind: 'curl-export', tabId })}>
          <Icon name="terminal" size={11} /> Copy as curl
        </button>
      </div>

      <div className="res-body res-sent">
        <p className="res-url mono res-selectable">{sent.url}</p>

        <p className="plate res-section">Request headers ({sent.headers.length})</p>
        {sent.headers.length === 0 ? (
          <p className="res-note">No headers were sent.</p>
        ) : (
          <table className="table-lite res-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {sent.headers.map(([name, value], index) => (
                <tr key={`${name}-${index}`}>
                  <td className="res-hname">{name}</td>
                  <td className="res-selectable">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="plate res-section">Request body</p>
        <SentBody wire={wire} contentType={sentType} />
      </div>
    </>
  )
}

function SentBody({
  wire,
  contentType,
}: {
  wire: WireRequest | null
  contentType: string | undefined
}): JSX.Element {
  if (!wire || wire.body.kind === 'none') {
    return <p className="res-note">No request body was sent.</p>
  }

  if (wire.body.kind === 'file') {
    return (
      <p className="res-note">
        Raw file body, streamed from disk:{' '}
        <span className="mono res-selectable">{wire.body.path}</span>
      </p>
    )
  }

  if (wire.body.kind === 'multipart') {
    return (
      <table className="table-lite res-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Kind</th>
            <th scope="col">Content</th>
          </tr>
        </thead>
        <tbody>
          {wire.body.parts.map((part, index) => (
            <tr key={`${part.name}-${index}`}>
              <td className="res-hname">{part.name}</td>
              <td>{part.kind}</td>
              <td className="res-selectable res-part">
                <span className="mono truncate">
                  {part.kind === 'file' ? part.filePath : part.value || '(empty)'}
                </span>
                {part.fileName && <span className="chip">as {part.fileName}</span>}
                {part.contentType && <span className="chip">{part.contentType}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <div className="res-sent-editor">
      <CodeEditor
        value={wire.body.text}
        language={editorLanguage(contentType)}
        readOnly
        wrap
        ariaLabel="Request body as sent"
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Live elapsed clock. The interval dies with the phase that owns it. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (startedAt === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [startedAt])

  return startedAt === null ? 0 : Math.max(0, now - startedAt)
}

function copyText(value: string, success: string): void {
  const { toast } = useStore.getState()
  void navigator.clipboard.writeText(value).then(
    () => toast('success', success),
    (err: unknown) => toast('error', 'Could not copy', String(err)),
  )
}

function shortType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim()
}

function editorLanguage(contentType: string | undefined): EditorLang {
  const type = shortType(contentType).toLowerCase()
  if (type.includes('json')) return 'json'
  if (type.includes('html')) return 'html'
  if (type.includes('xml')) return 'xml'
  if (type.includes('javascript') || type.includes('ecmascript')) return 'javascript'
  return 'text'
}
