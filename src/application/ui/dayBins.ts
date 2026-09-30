// why: times arrive newest first, so "how many are at or after x" is a binary search for the first element below x
export function countAtLeast(timesDesc: Float64Array, x: number): number {
  let low = 0;
  let high = timesDesc.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((timesDesc[middle] ?? Number.NEGATIVE_INFINITY) >= x) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function binCounts(timesDesc: Float64Array, edgesAsc: readonly number[]): number[] {
  const atLeast = edgesAsc.map((edge) => countAtLeast(timesDesc, edge));
  return Array.from({ length: edgesAsc.length - 1 }, (_, index) => (atLeast[index] ?? 0) - (atLeast[index + 1] ?? 0));
}

export function firstAtMost(timesDesc: Float64Array, x: number): number {
  let low = 0;
  let high = timesDesc.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((timesDesc[middle] ?? Number.NEGATIVE_INFINITY) > x) low = middle + 1;
    else high = middle;
  }
  return low;
}
