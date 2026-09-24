import type { ApiRequest, Folder, TreeNode } from '../../shared/types'

/**
 * Immutable tree operations. Each returns a new array in which only the nodes
 * on the path to the change are recreated, so editing one request in a
 * thousand-request collection does not clone the whole tree on every keystroke.
 */

export type DropPosition = 'before' | 'after' | 'inside'

export function updateNode(
  nodes: TreeNode[],
  id: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  let changed = false
  const next = nodes.map((node) => {
    if (node.id === id) {
      changed = true
      return updater(node)
    }
    if (node.kind === 'folder') {
      const children = updateNode(node.children, id, updater)
      if (children !== node.children) {
        changed = true
        return { ...node, children }
      }
    }
    return node
  })
  return changed ? next : nodes
}

export function updateRequest(
  nodes: TreeNode[],
  id: string,
  updater: (req: ApiRequest) => ApiRequest,
): TreeNode[] {
  return updateNode(nodes, id, (node) => (node.kind === 'request' ? updater(node) : node))
}

export function findRequest(nodes: TreeNode[], id: string): ApiRequest | null {
  for (const node of nodes) {
    if (node.kind === 'request') {
      if (node.id === id) return node
    } else {
      const hit = findRequest(node.children, id)
      if (hit) return hit
    }
  }
  return null
}

export function findAny(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.kind === 'folder') {
      const hit = findAny(node.children, id)
      if (hit) return hit
    }
  }
  return null
}

/** Ancestor folders of `id`, ordered root-first. Empty when not found or at root. */
export function folderPath(nodes: TreeNode[], id: string, trail: Folder[] = []): Folder[] | null {
  for (const node of nodes) {
    if (node.id === id) return trail
    if (node.kind === 'folder') {
      const hit = folderPath(node.children, id, [...trail, node])
      if (hit) return hit
    }
  }
  return null
}

export function removeNode(
  nodes: TreeNode[],
  id: string,
): { nodes: TreeNode[]; removed: TreeNode | null } {
  let removed: TreeNode | null = null

  const walk = (list: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    let changed = false
    for (const node of list) {
      if (node.id === id) {
        removed = node
        changed = true
        continue
      }
      if (node.kind === 'folder') {
        const children = walk(node.children)
        if (children !== node.children) {
          changed = true
          out.push({ ...node, children })
          continue
        }
      }
      out.push(node)
    }
    return changed ? out : list
  }

  return { nodes: walk(nodes), removed }
}

/** Appends into a folder, or to the root when parentId is null. */
export function insertNode(
  nodes: TreeNode[],
  parentId: string | null,
  node: TreeNode,
  index = -1,
): TreeNode[] {
  if (parentId === null) {
    const out = nodes.slice()
    out.splice(index < 0 ? out.length : index, 0, node)
    return out
  }
  return updateNode(nodes, parentId, (parent) => {
    if (parent.kind !== 'folder') return parent
    const children = parent.children.slice()
    children.splice(index < 0 ? children.length : index, 0, node)
    return { ...parent, children }
  })
}

/** True when `ancestorId` contains `nodeId` at any depth. Guards drag-into-self. */
export function isDescendant(nodes: TreeNode[], ancestorId: string, nodeId: string): boolean {
  const ancestor = findAny(nodes, ancestorId)
  if (!ancestor || ancestor.kind !== 'folder') return false
  return findAny(ancestor.children, nodeId) !== null
}

/**
 * Reparents/reorders in one step. Dropping a folder into itself or one of its
 * own descendants is a no-op rather than an error, because a drag can easily
 * land there by accident.
 */
export function moveNode(
  nodes: TreeNode[],
  dragId: string,
  targetId: string | null,
  position: DropPosition,
): TreeNode[] {
  if (dragId === targetId) return nodes
  if (targetId && isDescendant(nodes, dragId, targetId)) return nodes

  const { nodes: without, removed } = removeNode(nodes, dragId)
  if (!removed) return nodes

  if (targetId === null) return insertNode(without, null, removed)

  if (position === 'inside') {
    const target = findAny(without, targetId)
    if (!target) return nodes
    if (target.kind !== 'folder') return insertSibling(without, targetId, removed, 'after')
    return insertNode(without, targetId, removed)
  }

  return insertSibling(without, targetId, removed, position)
}

function insertSibling(
  nodes: TreeNode[],
  siblingId: string,
  node: TreeNode,
  position: 'before' | 'after',
): TreeNode[] {
  const walk = (list: TreeNode[]): TreeNode[] | null => {
    const idx = list.findIndex((n) => n.id === siblingId)
    if (idx >= 0) {
      const out = list.slice()
      out.splice(position === 'before' ? idx : idx + 1, 0, node)
      return out
    }
    let changed = false
    const out = list.map((n) => {
      if (n.kind !== 'folder') return n
      const children = walk(n.children)
      if (children) {
        changed = true
        return { ...n, children }
      }
      return n
    })
    return changed ? out : null
  }
  return walk(nodes) ?? nodes
}

/** Flattened view for the sidebar's virtualised list. */
export interface FlatRow {
  node: TreeNode
  depth: number
  parentId: string | null
  /** Ancestor folder ids, root-first. */
  path: string[]
}

export function flatten(
  nodes: TreeNode[],
  expanded: Record<string, boolean>,
  depth = 0,
  parentId: string | null = null,
  path: string[] = [],
): FlatRow[] {
  const out: FlatRow[] = []
  for (const node of nodes) {
    out.push({ node, depth, parentId, path })
    if (node.kind === 'folder' && expanded[node.id]) {
      out.push(...flatten(node.children, expanded, depth + 1, node.id, [...path, node.id]))
    }
  }
  return out
}

/** Every folder id in the tree, for expand-all / collapse-all. */
export function allFolderIds(nodes: TreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'folder') {
      acc.push(node.id)
      allFolderIds(node.children, acc)
    }
  }
  return acc
}

export interface SearchHit {
  node: TreeNode
  /** Ancestor folder ids that must be expanded to reveal this node. */
  path: string[]
}

/** Case-insensitive match on name, method and URL. */
export function searchTree(nodes: TreeNode[], query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []

  const walk = (list: TreeNode[], path: string[]) => {
    for (const node of list) {
      const haystack =
        node.kind === 'request'
          ? `${node.method} ${node.name} ${node.url}`.toLowerCase()
          : node.name.toLowerCase()
      if (haystack.includes(q)) hits.push({ node, path })
      if (node.kind === 'folder') walk(node.children, [...path, node.id])
    }
  }

  walk(nodes, [])
  return hits
}
