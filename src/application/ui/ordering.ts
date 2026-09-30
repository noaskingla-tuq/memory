export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface KeyedRow {
  readonly updatedAt: string;
  readonly id: string;
}

// why: every listing sorts (updated_at DESC, id ASC), the same order SQLite produces per namespace, so a merge of namespace pages stays a valid keyset order
export function newestFirst(left: KeyedRow, right: KeyedRow): number {
  return compareText(right.updatedAt, left.updatedAt) || compareText(left.id, right.id);
}
