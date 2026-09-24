import {
  APP_SCHEMA_VERSION,
  type ApiRequest,
  type Auth,
  type Body,
  type Collection,
  type Folder,
  type KV,
  type MultipartField,
  type TreeNode,
  type VariableSet,
} from './types'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Short, collision-resistant id. Deliberately avoids crypto.randomUUID so the
 * same code runs in the main process, the renderer, and a plain Node script.
 */
export function uid(size = 12): string {
  let out = ''
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
  if (g.crypto?.getRandomValues) {
    const bytes = g.crypto.getRandomValues(new Uint8Array(size))
    for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  } else {
    for (let i = 0; i < size; i++) out += ALPHABET[(Math.random() * ALPHABET.length) | 0]
  }
  return out
}

export function kv(key = '', value = '', enabled = true, description = ''): KV {
  return { id: uid(), enabled, key, value, description }
}

export function emptyAuth(type: Auth['type'] = 'inherit'): Auth {
  return {
    type,
    bearer: { token: '', scheme: 'Bearer' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', in: 'header' },
  }
}

export function emptyBody(): Body {
  return {
    mode: 'none',
    text: '',
    form: [],
    multipart: [],
    binaryPath: '',
    graphql: { query: '', variables: '{}' },
  }
}

export function multipartField(key = '', kind: MultipartField['kind'] = 'text'): MultipartField {
  return { id: uid(), enabled: true, key, kind, value: '' }
}

export function newRequest(patch: Partial<ApiRequest> = {}): ApiRequest {
  return {
    kind: 'request',
    id: uid(),
    protocol: 'http',
    name: 'New request',
    method: 'GET',
    url: '',
    params: [],
    pathParams: [],
    headers: [],
    cookies: [],
    body: emptyBody(),
    auth: emptyAuth('inherit'),
    settings: {},
    docs: '',
    ...patch,
  }
}

export function newFolder(patch: Partial<Folder> = {}): Folder {
  return {
    kind: 'folder',
    id: uid(),
    name: 'New folder',
    children: [],
    auth: emptyAuth('inherit'),
    headers: [],
    docs: '',
    ...patch,
  }
}

export function newVariableSet(name: string, values: KV[] = []): VariableSet {
  return { id: uid(), name, values }
}

export function newCollection(patch: Partial<Collection> = {}): Collection {
  const now = Date.now()
  const base: Collection = {
    schemaVersion: APP_SCHEMA_VERSION,
    id: uid(),
    name: 'New collection',
    children: [],
    variables: [],
    sets: [],
    activeSetId: null,
    auth: emptyAuth('none'),
    headers: [],
    settings: {},
    docs: '',
    createdAt: now,
    updatedAt: now,
    ...patch,
  }
  if (base.sets.length && !base.activeSetId) base.activeSetId = base.sets[0].id
  return base
}

/* ------------------------------------------------------------------ */
/* Tree helpers                                                        */
/* ------------------------------------------------------------------ */

export function countRequests(nodes: TreeNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === 'request') n++
    else n += countRequests(node.children)
  }
  return n
}

export function countFolders(nodes: TreeNode[]): number {
  let n = 0
  for (const node of nodes) {
    if (node.kind === 'folder') n += 1 + countFolders(node.children)
  }
  return n
}

/** Depth-first walk. Return false from `visit` to skip a folder's children. */
export function walk(
  nodes: TreeNode[],
  visit: (node: TreeNode, parents: Folder[]) => boolean | void,
  parents: Folder[] = [],
): void {
  for (const node of nodes) {
    const go = visit(node, parents)
    if (node.kind === 'folder' && go !== false) walk(node.children, visit, [...parents, node])
  }
}

export function findNode(
  nodes: TreeNode[],
  id: string,
): { node: TreeNode; parents: Folder[] } | null {
  let hit: { node: TreeNode; parents: Folder[] } | null = null
  walk(nodes, (node, parents) => {
    if (hit) return false
    if (node.id === id) {
      hit = { node, parents }
      return false
    }
  })
  return hit
}

/** Removes a node in place and returns it. */
export function removeNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.id === id) return nodes.splice(i, 1)[0]
    if (node.kind === 'folder') {
      const found = removeNode(node.children, id)
      if (found) return found
    }
  }
  return null
}

/** Deep clone with every id regenerated, so the copy is independent. */
export function cloneNode<T extends TreeNode>(node: T): T {
  const copy = structuredClone(node) as TreeNode
  const reid = (n: TreeNode) => {
    n.id = uid()
    if (n.kind === 'folder') {
      n.headers = n.headers.map((h) => ({ ...h, id: uid() }))
      n.children.forEach(reid)
    } else {
      n.params = n.params.map((p) => ({ ...p, id: uid() }))
      n.pathParams = n.pathParams.map((p) => ({ ...p, id: uid() }))
      n.headers = n.headers.map((h) => ({ ...h, id: uid() }))
      n.cookies = n.cookies.map((c) => ({ ...c, id: uid() }))
      n.body.form = n.body.form.map((f) => ({ ...f, id: uid() }))
      n.body.multipart = n.body.multipart.map((f) => ({ ...f, id: uid() }))
    }
  }
  reid(copy)
  return copy as T
}
