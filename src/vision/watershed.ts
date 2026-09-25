import type { CV } from "./opencv";
import { contours } from "./shapeFilter";
import type { Detection } from "../types";
export function splitWatershed(
  cv: CV,
  mask: InstanceType<CV["Mat"]>,
  offset: { x: number; y: number },
  sensitivity = 1,
  typicalRadius?: number,
  hints: { x: number; y: number }[] = [],
) {
  const distance = new cv.Mat(),
    cc = new cv.Mat(),
    stats = new cv.Mat(),
    centroids = new cv.Mat();
  cv.distanceTransform(mask, distance, cv.DIST_L2, 5);
  const n = cv.connectedComponentsWithStats(mask, cc, stats, centroids, 8),
    w = mask.cols,
    h = mask.rows;
  const markers = cv.Mat.zeros(h, w, cv.CV_32SC1),
    maxima = new Float32Array(n),
    seeds: { x: number; y: number; d: number; c: number }[] = [];
  const labels = cc.data32S,
    dist = distance.data32F,
    marked = markers.data32S,
    maskPixels = mask.data;
  for (let p = 0; p < w * h; p++) {
    const c = labels[p];
    if (!c) marked[p] = 1;
    else maxima[c] = Math.max(maxima[c], dist[p]);
  }
  const candidates: typeof seeds = [];
  for (const hint of hints) {
    const x = Math.round(hint.x),
      y = Math.round(hint.y),
      p = y * w + x,
      c = labels[p];
    if (c && dist[p] > (typicalRadius || 1) * 0.45)
      seeds.push({ x, y, c, d: Math.min(dist[p], typicalRadius || dist[p]) });
  }
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x,
        c = labels[p],
        d = dist[p];
      if (
        !c ||
        d < maxima[c] * 0.38 ||
        (typicalRadius && d < typicalRadius * 0.48)
      )
        continue;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (dist[p + dy * w + dx] > d + 0.01) {
            peak = false;
            break;
          }
      if (peak) candidates.push({ x, y, d, c });
    }
  candidates.sort((a, b) => b.d - a.d);
  const candidateLimit = candidates.length > 5000;
  if (candidateLimit) candidates.length = 5000;
  for (const s of candidates) {
    if (typicalRadius) {
      if (
        seeds.some(
          (t) =>
            t.c === s.c &&
            Math.hypot(s.x - t.x, s.y - t.y) <
              Math.min(typicalRadius, Math.max(s.d, t.d)) * 1.5 * sensitivity,
        )
      )
        continue;
      // Merge a flat capsule ridge only when its entire component is convex.
      const ridge = seeds.some((t) => {
        if (t.c !== s.c) return false;
        const st = stats.data32S.subarray(s.c * 5, s.c * 5 + 5);
        if (st[4] > Math.PI * typicalRadius * typicalRadius * 2.3) return false;
        const steps = Math.ceil(Math.hypot(s.x - t.x, s.y - t.y));
        let low = Infinity;
        for (let j = 0; j <= steps; j++) {
          const f = j / Math.max(steps, 1);
          low = Math.min(
            low,
            dist[
              Math.round(t.y + (s.y - t.y) * f) * w +
                Math.round(t.x + (s.x - t.x) * f)
            ],
          );
        }
        return low > Math.min(s.d, t.d) * 0.96;
      });
      if (!ridge) seeds.push(s);
      if (seeds.length >= 1500) break;
      continue;
    }
    // A junction of three touching pills can create a slightly higher central peak.
    // Prefer three independently supported lobes to that central junction.
    const lobes: typeof seeds = [];
    for (const t of candidates) {
      if (
        t === s ||
        t.c !== s.c ||
        t.d < s.d * 0.92 ||
        Math.hypot(t.x - s.x, t.y - s.y) > s.d * 1.65
      )
        continue;
      if (
        lobes.every(
          (u) => Math.hypot(t.x - u.x, t.y - u.y) > Math.max(t.d, u.d) * 1.65,
        )
      )
        lobes.push(t);
      if (lobes.length === 3) break;
    }
    if (lobes.length === 3) continue;
    if (
      seeds.some(
        (t) =>
          t.c === s.c &&
          Math.hypot(s.x - t.x, s.y - t.y) <
            Math.max(s.d, t.d) * 1.65 * sensitivity,
      )
    )
      continue;
    // A capsule's flat distance ridge should remain one seed if the saddle stays high.
    const ridge = seeds.some((t) => {
      if (t.c !== s.c) return false;
      const steps = Math.ceil(Math.hypot(s.x - t.x, s.y - t.y));
      let minimum = Infinity;
      for (let j = 0; j <= steps; j++) {
        const a = j / Math.max(steps, 1);
        minimum = Math.min(
          minimum,
          dist[
            Math.round(t.y + (s.y - t.y) * a) * w +
              Math.round(t.x + (s.x - t.x) * a)
          ],
        );
      }
      return minimum > Math.min(s.d, t.d) * 0.9;
    });
    if (!ridge) seeds.push(s);
    if (seeds.length >= 1500) break;
  }
  seeds.forEach((s, i) => {
    const radius = Math.max(1, s.d * 0.4);
    for (
      let y = Math.max(1, Math.floor(s.y - radius));
      y <= Math.min(h - 2, s.y + radius);
      y++
    )
      for (
        let x = Math.max(1, Math.floor(s.x - radius));
        x <= Math.min(w - 2, s.x + radius);
        x++
      )
        if (Math.hypot(x - s.x, y - s.y) <= radius && labels[y * w + x] === s.c)
          marked[y * w + x] = i + 2;
  });
  const terrain = cv.Mat.zeros(h, w, cv.CV_8UC3);
  // OpenCV watershed prioritizes color gradients, not scalar elevations.
  // A binary terrain retains object edges; distance-derived cores control its basins.
  const terrainPixels = terrain.data;
  const terrainMask = mask.data;
  for (let p = 0; p < w * h; p++) {
    const v = terrainMask[p];
    terrainPixels[p * 3] =
      terrainPixels[p * 3 + 1] =
      terrainPixels[p * 3 + 2] =
        v;
  }
  const seedsImage = markers.clone();
  cv.watershed(terrain, markers);
  const result: Detection[] = [],
    region = cv.Mat.zeros(h, w, cv.CV_8UC1);
  // Limit each extraction to its original component's rectangle.
  for (let i = 0; i < seeds.length; i++) {
    // OpenCV allocations may grow WASM memory and detach previously cached views.
    const regionPixels = region.data,
      watershedLabels = markers.data32S,
      maskPixels = mask.data;
    const s = seeds[i],
      st = stats.data32S.subarray(s.c * 5, s.c * 5 + 5);
    regionPixels.fill(0);
    for (let y = st[1]; y < st[1] + st[3]; y++)
      for (let x = st[0]; x < st[0] + st[2]; x++) {
        const p = y * w + x;
        if (
          maskPixels[p] &&
          watershedLabels[p] === i + 2 &&
          (!typicalRadius ||
            Math.hypot(x - s.x, y - s.y) <= Math.max(typicalRadius, s.d) * 1.3)
        )
          regionPixels[p] = 255;
      }
    result.push(...contours(cv, region, `w${i}`, offset));
  }
  region.delete();
  terrain.delete();
  cc.delete();
  stats.delete();
  centroids.delete();
  return {
    detections: result,
    distance,
    markers,
    seedsImage,
    seedCount: seeds.length,
    seedLimit: seeds.length >= 1500 || candidateLimit,
  };
}
