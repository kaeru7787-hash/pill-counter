import type { Point } from "../types";
/** Maximum cardinality one-to-one matching: duplicated predictions cannot share a truth point. */
export function positionMetrics(
  predicted: Point[],
  truth: Point[],
  tolerance: number,
) {
  const matches = new Array<number>(truth.length).fill(-1);
  const edges = predicted.map((p) =>
    truth
      .map((t, i) => ({ i, d: Math.hypot(p.x - t.x, p.y - t.y) }))
      .filter((t) => t.d <= tolerance)
      .sort((a, b) => a.d - b.d)
      .map((t) => t.i),
  );
  function assign(i: number, visited: Set<number>): boolean {
    for (const j of edges[i]) {
      if (visited.has(j)) continue;
      visited.add(j);
      if (matches[j] < 0 || assign(matches[j], visited)) {
        matches[j] = i;
        return true;
      }
    }
    return false;
  }
  predicted.forEach((_, i) => assign(i, new Set()));
  const tp = matches.filter((i) => i >= 0).length,
    fp = predicted.length - tp,
    fn = truth.length - tp,
    precision = predicted.length ? tp / predicted.length : 0,
    recall = truth.length ? tp / truth.length : 0;
  return {
    tp,
    fp,
    fn,
    precision,
    recall,
    f1:
      precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    matchedPredictions: matches.filter((i) => i >= 0),
    missingTruth: matches.flatMap((v, i) => (v < 0 ? [i] : [])),
  };
}
