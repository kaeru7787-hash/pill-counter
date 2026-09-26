import type { Detection } from "../types";
import { iou } from "../ai/onnxDetector";

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] || 0;
export type RegionView = { detection: Detection; threshold: number };

/** Repeated closed regions, not circles. Distinct neighboring caps must never
 * suppress each other just because the enclosing circles overlap. */
export function repeatedCapRegions(views: RegionView[]) {
  const groups: RegionView[][] = [];
  for (const view of views) {
    const d = view.detection;
    const group = groups.find((g) => {
      const a = g[0].detection;
      return (
        iou(a.box, d.box) > 0.45 &&
        Math.hypot(a.center.x - d.center.x, a.center.y - d.center.y) <
          Math.sqrt(a.area) * 0.45
      );
    });
    if (group) group.push(view);
    else groups.push([view]);
  }
  const stable = groups
    .filter((g) => new Set(g.map((v) => v.threshold)).size >= 3)
    .map((g) => {
      const ordered = [...g].sort(
        (a, b) => a.detection.area - b.detection.area,
      );
      return {
        ...ordered[Math.floor(ordered.length / 2)].detection,
        flags: ["複数の明るさで独立したキャップ領域を確認"],
        score: Math.min(1, g.length / 6),
      };
    });
  // Learn one repeated shape family from multiple independent objects. This
  // branch is for non-circular caps; a few tilted round caps cannot enable it.
  let bank: Detection[] = [];
  for (const d of stable) {
    const near = stable.filter(
      (q) =>
        q.area > d.area * 0.7 &&
        q.area < d.area * 1.4 &&
        Math.abs(Math.log((q.shape?.aspect || 1) / (d.shape?.aspect || 1))) <
          0.2,
    );
    if (near.length > bank.length) bank = near;
  }
  const aspect = median(bank.map((d) => d.shape?.aspect || 1));
  if (bank.length < 6 || aspect < 1.25 || bank.length < stable.length * 0.6)
    return {
      detections: [] as Detection[],
      stable: stable.length,
      enabled: false,
    };
  const area = median(bank.map((d) => d.area));
  const detections = stable.filter(
    (d) =>
      d.area > area * 0.6 &&
      d.area < area * 1.55 &&
      Math.abs(Math.log((d.shape?.aspect || 1) / aspect)) < 0.3,
  );
  // Compression can make a real perimeter fail one threshold. Recover only
  // when two independent regions agree with a family established by >= 6 caps.
  // Single-threshold blobs and inferred grid positions remain excluded.
  let recovered = 0;
  for (const g of groups.filter(
    (g) => new Set(g.map((v) => v.threshold)).size === 2,
  )) {
    const d = [...g].sort((a, b) => a.detection.area - b.detection.area)[
      Math.floor(g.length / 2)
    ].detection;
    if (
      d.area > area * 0.7 &&
      d.area < area * 1.4 &&
      Math.abs(Math.log((d.shape?.aspect || 1) / aspect)) < 0.2
    ) {
      detections.push({
        ...d,
        flags: ["2段階の輪郭を写真内のキャップ形状と照合"],
        score: 0.65,
      });
      recovered++;
    }
  }
  return { detections, stable: stable.length, enabled: true, recovered };
}
