/**
 * Shared domain model. Imported by both the Electron main process and the renderer.
 * Nothing in here may import Node or DOM APIs.
 */

export const APP_SCHEMA_VERSION = 1

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** An enable-able key/value row. Used for params, headers, cookies, form fields, variables. */
export interface KV {
  id: string
  enabled: boolean
  key: string
  value: string
  /** Free-text note shown in the row's third column. */
  description?: string
  /** Marks a value that should be masked in the UI (variable sets only). */
  secret?: boolean
}

export const HTTP_METHODS = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'QUERY',
] as const
export type KnownMethod = (typeof HTTP_METHODS)[number]
/** Any token is legal per RFC 9110; the list above is only for the picker. */
export type Method = KnownMethod | (string & {})

/* ------------------------------------------------------------------ */
/* Request body                                                        */
/* ------------------------------------------------------------------ */

export type BodyMode =
  | 'none'
  | 'json'
  | 'text'
  | 'xml'
  | 'html'
  | 'javascript'
  | 'form-urlencoded'
  | 'multipart'
  | 'binary'
  | 'graphql'

export interface MultipartField {
  id: string
  enabled: boolean
  key: string
  kind: 'text' | 'file'
  /** Text value when kind==='text'. */
  value: string
  /** Absolute path when kind==='file'. */
  filePath?: string
  /** Overrides the filename sent in Content-Disposition. */
  fileName?: string
  /** Overrides the part's Content-Type. */
  contentType?: string
}

export interface GraphQLBody {
  query: string
  variables: string
  operationName?: string
}

export interface Body {
  mode: BodyMode
  /** Backing store for json / text / xml / html / javascript. */
  text: string
  form: KV[]
  multipart: MultipartField[]
  binaryPath: string
  graphql: GraphQLBody
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export type AuthType = 'inherit' | 'none' | 'bearer' | 'basic' | 'apikey'

export interface Auth {
  type: AuthType
  bearer: { token: string; scheme: string }
  basic: { username: string; password: string }
  apikey: { key: string; value: string; in: 'header' | 'query' }
}

/* ------------------------------------------------------------------ */
/* Per-request transport settings                                      */
/* ------------------------------------------------------------------ */

export interface RequestSettings {
  followRedirects: boolean
  maxRedirects: number
  /** 0 disables the timeout. */
  timeoutMs: number
  /** false === accept self-signed / invalid certificates. */
  verifyTls: boolean
  /** URL-encode the path and query before sending. */
  encodeUrl: boolean
  /** Send matching cookies from the local jar. */
  sendCookies: boolean
  /** Persist Set-Cookie responses into the local jar. */
  storeCookies: boolean
  /** Send Accept-Encoding and transparently decompress the response. */
  decompress: boolean
  /** Emit chunks to the UI as they arrive (SSE, chunked, long polls). */
  streamResponse: boolean
  /** e.g. http://127.0.0.1:8080 - empty string means no proxy. */
  proxy: string
}

export const DEFAULT_SETTINGS: RequestSettings = {
  followRedirects: true,
  maxRedirects: 10,
  timeoutMs: 60_000,
  verifyTls: true,
  encodeUrl: true,
  sendCookies: true,
  storeCookies: true,
  decompress: true,
  streamResponse: true,
  proxy: '',
}

/* ------------------------------------------------------------------ */
/* Tree                                                                */
/* ------------------------------------------------------------------ */

/** Reserved so gRPC / GraphQL-native transports can slot in later. */
export type Protocol = 'http'

export interface ApiRequest {
  kind: 'request'
  id: string
  protocol: Protocol
  name: string
  method: Method
  url: string
  params: KV[]
  pathParams: KV[]
  headers: KV[]
  cookies: KV[]
  body: Body
  auth: Auth
  settings: Partial<RequestSettings>
  docs: string
}

export interface Folder {
  kind: 'folder'
  id: string
  name: string
  children: TreeNode[]
  /** Folder-level defaults, merged into every descendant request. */
  auth: Auth
  headers: KV[]
  docs: string
}

export type TreeNode = Folder | ApiRequest

export interface VariableSet {
  id: string
  name: string
  values: KV[]
}

export interface Collection {
  schemaVersion: number
  id: string
  name: string
  children: TreeNode[]
  /** Always-active variables, shared by every set. */
  variables: KV[]
  sets: VariableSet[]
  activeSetId: string | null
  auth: Auth
  headers: KV[]
  settings: Partial<RequestSettings>
  docs: string
  createdAt: number
  updatedAt: number
}

/** Metadata row used by the sidebar without loading a whole collection. */
export interface CollectionSummary {
  id: string
  name: string
  updatedAt: number
  requestCount: number
}

/* ------------------------------------------------------------------ */
/* Wire format - a fully resolved request, ready to execute            */
/* ------------------------------------------------------------------ */

export type WireBody =
  | { kind: 'none' }
  | { kind: 'text'; text: string }
  | { kind: 'multipart'; parts: WirePart[] }
  | { kind: 'file'; path: string }

export interface WirePart {
  name: string
  kind: 'text' | 'file'
  value: string
  filePath?: string
  fileName?: string
  contentType?: string
}

export interface WireRequest {
  /** Correlates streaming events and cancellation with this execution. */
  execId: string
  method: string
  url: string
  /** Ordered, duplicates allowed, casing preserved exactly as typed. */
  headers: Array<[string, string]>
  body: WireBody
  settings: RequestSettings
}

/* ------------------------------------------------------------------ */
/* Wire response                                                       */
/* ------------------------------------------------------------------ */

export interface Timing {
  /** Wall-clock ms spent in each phase. Absent phases did not occur. */
  dns?: number
  tcp?: number
  tls?: number
  /** Time from request sent to first response byte. */
  wait?: number
  download?: number
  total: number
  startedAt: number
}

export interface ResponseCookie {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: string
  maxAge?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: string
}

export interface RedirectHop {
  status: number
  url: string
  location: string
}

export interface TlsInfo {
  protocol: string
  cipher: string
  issuer: string
  subject: string
  validFrom: string
  validTo: string
  authorized: boolean
  authorizationError?: string
}

export interface WireResponseOk {
  ok: true
  execId: string
  status: number
  statusText: string
  httpVersion: string
  headers: Array<[string, string]>
  /** Decoded body bytes. Truncated when the payload exceeds the inline cap. */
  body: Uint8Array
  truncated: boolean
  /** Absolute path to the full body when it was too large to inline. */
  overflowPath?: string
  size: {
    /** Bytes on the wire, before decompression. */
    transfer: number
    /** Bytes after decompression. */
    decoded: number
    headers: number
  }
  timing: Timing
  redirects: RedirectHop[]
  cookies: ResponseCookie[]
  remoteAddress?: string
  remotePort?: number
  tls?: TlsInfo
  /** Echo of what actually went on the wire, after auth + cookies + defaults. */
  sent: { method: string; url: string; headers: Array<[string, string]> }
}

export interface WireResponseErr {
  ok: false
  execId: string
  error: string
  code?: string
  timing: Timing
  /** True when the user pressed Cancel rather than the request failing. */
  canceled?: boolean
}

export type WireResponse = WireResponseOk | WireResponseErr

/** Streamed while a response is still arriving (SSE, chunked). */
export interface StreamEvent {
  execId: string
  phase: 'headers' | 'chunk' | 'end'
  status?: number
  statusText?: string
  headers?: Array<[string, string]>
  chunk?: Uint8Array
  receivedBytes?: number
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export interface HistoryEntry {
  id: string
  at: number
  method: string
  url: string
  name: string
  collectionId?: string
  requestId?: string
  status?: number
  statusText?: string
  ok: boolean
  error?: string
  durationMs: number
  responseSize: number
  timing?: Timing
  /** Enough to fully restore and re-fire the call. */
  snapshot: WireRequest
}

/* ------------------------------------------------------------------ */
/* Cookie jar                                                          */
/* ------------------------------------------------------------------ */

export interface JarCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  hostOnly: boolean
  createdAt: number
}

/* ------------------------------------------------------------------ */
/* App settings                                                        */
/* ------------------------------------------------------------------ */

export interface AppSettings {
  theme: 'dark' | 'light'
  /** Renderer font scale multiplier. */
  uiScale: number
  editorFontSize: number
  wrapLines: boolean
  historyLimit: number
  /** Bodies larger than this are spilled to disk instead of sent over IPC. */
  inlineBodyCapBytes: number
  defaultSettings: RequestSettings
  sidebarWidth: number
  responseWidth: number
  /** Collapses the sidebar to a rail that reveals it on hover. */
  sidebarCollapsed: boolean
  confirmDelete: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'light',
  uiScale: 1,
  editorFontSize: 12.5,
  wrapLines: true,
  historyLimit: 500,
  inlineBodyCapBytes: 24 * 1024 * 1024,
  defaultSettings: DEFAULT_SETTINGS,
  sidebarWidth: 268,
  responseWidth: 620,
  sidebarCollapsed: false,
  confirmDelete: true,
}

/* ------------------------------------------------------------------ */
/* Import results                                                      */
/* ------------------------------------------------------------------ */

export interface ImportResult {
  collection: Collection
  warnings: string[]
  stats: { folders: number; requests: number; variables: number }
}
