import type { CollectionRecord } from "./api";

export interface CollectionOption {
  collection: CollectionRecord;
  label: string;
}

export interface CollectionTreeNode {
  collection: CollectionRecord;
  children: CollectionTreeNode[];
}

export function collectionPath(
  collection: CollectionRecord,
  collections: CollectionRecord[],
): string {
  const byId = new Map(collections.map((item) => [item.id, item]));
  const names = [collection.name];
  const visited = new Set([collection.id]);
  let parentId = collection.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }

  return names.join(" / ");
}

export function collectionOptions(
  collections: CollectionRecord[],
  excludedId?: string,
): CollectionOption[] {
  const excluded = excludedId ? new Set([excludedId, ...collectionDescendantIds(excludedId, collections)]) : null;

  return collections
    .filter((collection) => !excluded?.has(collection.id))
    .map((collection) => ({
      collection,
      label: collectionPath(collection, collections),
    }))
    .sort((left, right) =>
      left.label.localeCompare(right.label, "ja") || left.collection.id.localeCompare(right.collection.id),
    );
}

export function collectionDescendantIds(
  collectionId: string,
  collections: CollectionRecord[],
): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const collection of collections) {
    if (!collection.parentId) continue;
    const children = childrenByParent.get(collection.parentId) ?? [];
    children.push(collection.id);
    childrenByParent.set(collection.parentId, children);
  }

  const descendants: string[] = [];
  const visited = new Set([collectionId]);
  const pending = [...(childrenByParent.get(collectionId) ?? [])];
  while (pending.length) {
    const childId = pending.shift();
    if (!childId || visited.has(childId)) continue;
    visited.add(childId);
    descendants.push(childId);
    pending.push(...(childrenByParent.get(childId) ?? []));
  }
  return descendants;
}

export function collectionAncestorIds(
  collectionId: string,
  collections: CollectionRecord[],
): string[] {
  const byId = new Map(collections.map((item) => [item.id, item]));
  const ancestors: string[] = [];
  const visited = new Set([collectionId]);
  let parentId = byId.get(collectionId)?.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    ancestors.push(parentId);
    parentId = byId.get(parentId)?.parentId;
  }

  return ancestors;
}

export function collectionTree(collections: CollectionRecord[]): CollectionTreeNode[] {
  const nodes = new Map<string, CollectionTreeNode>(
    collections.map((collection): [string, CollectionTreeNode] => [
      collection.id,
      { collection, children: [] },
    ]),
  );
  const roots: CollectionTreeNode[] = [];

  for (const node of nodes.values()) {
    const parent = node.collection.parentId ? nodes.get(node.collection.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const sortNodes = (items: CollectionTreeNode[]) => {
    items.sort(
      (left, right) =>
        left.collection.name.localeCompare(right.collection.name, "ja") ||
        left.collection.id.localeCompare(right.collection.id),
    );
    items.forEach((item) => sortNodes(item.children));
  };
  sortNodes(roots);
  return roots;
}
