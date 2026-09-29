import type {
  Detection,
  EllipseAssessment,
  ObjectMeasurement,
  Point,
  Raster,
  ReferenceEllipse,
} from "../types";

// All post-processing thresholds live here. Axes are full diameters in pixels.
export const ELLIPSE_CONFIG = Object.freeze({
  TRIM_FRACTION: 0.2,
  MEAN_MEDIAN_DIVERGENCE: 0.1,
  MIN_MAJOR_AXIS_RATIO: 0.3,
  MIN_MINOR_AXIS_RATIO: 0.3,
  MIN_AREA_RATIO: 0.22,
  REVIEW_AXIS_MIN: 0.6,
  REVIEW_AXIS_MAX: 1.65,
  REVIEW_AREA_MAX: 1.8,
  REVIEW_IOU: 0.5,
  EXCLUSION_CANDIDATE_IOU: 0.25,
  DUPLICATE_DISTANCE_RATIO: 0.4,
  DUPLICATE_IOU: 0.55,
  MATCH_GRID: 28,
  AI_GRID: 32,
  AI_MIN_CONTRAST: 18,
  AI_MIN_COVERAGE: 0.18,
  AI_MAX_COVERAGE: 0.9,
  AI_COMPONENT_SHARE: 0.6,
  ORIENTATION_STEP_DEGREES: 5,
  ORIENTATION_SAMPLES: 32,
  ORIENTATION_MIN_SUPPORT: 8,
  ORIENTATION_MIN_MARGIN: 2,
  ORIENTATION_MIN_ASPECT: 1.25,
  ORIENTATION_INNER_RADIUS: 0.8,
  ORIENTATION_OUTER_RADIUS: 1.12,
  RESTORE_MIN_REFERENCE_COUNT: 5,
  RESTORE_MIN_IOU: 0.6,
  RESTORE_MIN_AREA_RATIO: 0.65,
  RESTORE_MAX_AREA_RATIO: 1.45,
  RESTORE_MAX_AXIS_RATIO: 1.5,
});
const median = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b),
    i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function hull(points: Point[]) {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [],
    upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  for (const p of sorted.reverse()) {
    while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
function measureContour(
  contour: Point[],
  area: number,
  method: ObjectMeasurement["method"],
): ObjectMeasurement | undefined {
  const h = hull(contour);
  if (h.length < 3) return;
  let squared = 0,
    angle = 0;
  for (let i = 0; i < h.length; i++)
    for (let j = i + 1; j < h.length; j++) {
      const dx = h[j].x - h[i].x,
        dy = h[j].y - h[i].y,
        s = dx * dx + dy * dy;
      if (s > squared) {
        squared = s;
        angle = Math.atan2(dy, dx);
      }
    }
  angle = (angle + Math.PI) % Math.PI;
  const normal = h.map((p) => -p.x * Math.sin(angle) + p.y * Math.cos(angle));
  const major = Math.sqrt(squared),
    minor = Math.max(...normal) - Math.min(...normal);
  if (!(major > 0 && minor > 0 && Number.isFinite(area) && area > 0)) return;
  return { major, minor, angle, area, method, contour };
}

/** AI output is an axis-aligned box, not a measured outline. Estimate only when
 * a contrasting, central connected foreground is present; otherwise keep a
 * clearly labelled box fallback (angle 0, no invented overlap score). */
function measureAI(d: Detection, image: Raster): ObjectMeasurement | undefined {
  const n = ELLIPSE_CONFIG.AI_GRID,
    values: number[] = [],
    histogram = new Array<number>(256).fill(0);
  const { box } = d;
  if (
    box.width < 2 ||
    box.height < 2 ||
    box.x < 0 ||
    box.y < 0 ||
    box.x + box.width >= image.width ||
    box.y + box.height >= image.height
  )
    return;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const px = Math.floor(box.x + ((x + 0.5) * box.width) / n),
        py = Math.floor(box.y + ((y + 0.5) * box.height) / n),
        i = (py * image.width + px) * 4;
      const v = Math.round(
        0.299 * image.data[i] +
          0.587 * image.data[i + 1] +
          0.114 * image.data[i + 2],
      );
      values.push(v);
      histogram[v]++;
    }
  const total = values.reduce((a, b) => a + b, 0);
  let count = 0,
    sum = 0,
    best = 0,
    threshold = 0;
  for (let t = 0; t < 255; t++) {
    count += histogram[t];
    sum += t * histogram[t];
    if (!count || count === n * n) continue;
    const delta = sum / count - (total - sum) / (n * n - count),
      score = count * (n * n - count) * delta * delta;
    if (score > best) {
      best = score;
      threshold = t;
    }
  }
  const middle: number[] = [],
    edge: number[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      if (Math.abs(x - n / 2) < n / 8 && Math.abs(y - n / 2) < n / 8)
        middle.push(values[y * n + x]);
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1)
        edge.push(values[y * n + x]);
    }
  const contrast = median(middle) - median(edge);
  if (Math.abs(contrast) < ELLIPSE_CONFIG.AI_MIN_CONTRAST) return;
  const mask = values.map((v) =>
      contrast > 0 ? v > threshold : v <= threshold,
    ),
    seen = new Set<number>();
  const seed = Math.floor(n / 2) * n + Math.floor(n / 2);
  if (!mask[seed]) return;
  const queue = [seed];
  seen.add(seed);
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k],
      x = i % n,
      y = Math.floor(i / n);
    for (const [xx, yy] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      const j = yy * n + xx;
      if (xx >= 0 && xx < n && yy >= 0 && yy < n && mask[j] && !seen.has(j)) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  const coverage = queue.length / (n * n),
    foreground = mask.filter(Boolean).length;
  if (
    coverage < ELLIPSE_CONFIG.AI_MIN_COVERAGE ||
    coverage > ELLIPSE_CONFIG.AI_MAX_COVERAGE ||
    queue.length / foreground < ELLIPSE_CONFIG.AI_COMPONENT_SHARE
  )
    return;
  const boundary: Point[] = [];
  for (const i of queue) {
    const x = i % n,
      y = Math.floor(i / n);
    if (
      x === 0 ||
      y === 0 ||
      x === n - 1 ||
      y === n - 1 ||
      !seen.has(i - 1) ||
      !seen.has(i + 1) ||
      !seen.has(i - n) ||
      !seen.has(i + n)
    )
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ])
        boundary.push({
          x: box.x + ((x + dx) * box.width) / n,
          y: box.y + ((y + dy) * box.height) / n,
        });
  }
  // A convex envelope provides an orientation, not proof that the object is a
  // tablet. Its foreground area remains the component area, including holes.
  return measureContour(
    hull(boundary),
    coverage * box.width * box.height,
    "pixels",
  );
}
export function measureDetectedObjects<T extends Detection>(
  objects: T[],
  image?: Raster,
): T[] {
  return objects.map((d) => {
    if (d.measurement) return d;
    let measurement =
      d.source === "ai"
        ? image && measureAI(d, image)
        : measureContour(d.contour, d.area, "contour");
    if (!measurement)
      measurement = {
        major: Math.max(d.box.width, d.box.height),
        minor: Math.min(d.box.width, d.box.height),
        angle: 0,
        area: d.area,
        method: "box",
        contour: [],
      };
    return { ...d, measurement };
  });
}

/** Sort paired axes by their product (size), trim both tails once; do not
 * independently trim axes and accidentally combine different tablet groups. */
export function calculateReferenceEllipse(
  objects: Detection[],
): ReferenceEllipse | undefined {
  const measured = measureDetectedObjects(objects)
    .filter((d) => d.source === "cv" && d.measurement!.method === "contour")
    .map((d) => d.measurement!)
    .filter(
      (m) => m.major > 0 && m.minor > 0 && Number.isFinite(m.major * m.minor),
    )
    .sort((a, b) => a.major * a.minor - b.major * b.minor);
  if (!measured.length) return;
  const cut = Math.floor(measured.length * ELLIPSE_CONFIG.TRIM_FRACTION),
    central = measured.slice(cut, measured.length - cut);
  const mean = {
    major: central.reduce((s, m) => s + m.major, 0) / central.length,
    minor: central.reduce((s, m) => s + m.minor, 0) / central.length,
  };
  const med = {
    major: median(central.map((m) => m.major)),
    minor: median(central.map((m) => m.minor)),
  };
  const usedMedian = {
    major:
      Math.abs(mean.major - med.major) / med.major >=
      ELLIPSE_CONFIG.MEAN_MEDIAN_DIVERGENCE,
    minor:
      Math.abs(mean.minor - med.minor) / med.minor >=
      ELLIPSE_CONFIG.MEAN_MEDIAN_DIVERGENCE,
  };
  let major = usedMedian.major ? med.major : mean.major,
    minor = usedMedian.minor ? med.minor : mean.minor;
  // Per-axis fallback must not invert the long and short axes in a skewed
  // distribution. In that case retain the paired median geometry.
  if (minor > major) {
    major = med.major;
    minor = med.minor;
    usedMedian.major = usedMedian.minor = true;
  }
  return {
    major,
    minor,
    area: (Math.PI * major * minor) / 4,
    sampleCount: measured.length,
    retainedCount: central.length,
    trimmedEachEnd: cut,
    mean,
    median: med,
    usedMedian,
  };
}
export function insideEllipse(
  p: Point,
  center: Point,
  major: number,
  minor: number,
  angle: number,
) {
  const dx = p.x - center.x,
    dy = p.y - center.y,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return (
    ((dx * c + dy * s) / (major / 2)) ** 2 +
      ((-dx * s + dy * c) / (minor / 2)) ** 2 <=
    1
  );
}

/** A tight AI box can contain connected neighbours. Rotate the reference over
 * the existing centre and compare inside/outside boundary contrast to recover
 * its display angle. This NEVER replaces the measured size or area used by
 * the exclusion gates, and never invents an IoU from the fitted template. */
export function estimateAIEllipseOrientation(
  objects: Detection[],
  reference: ReferenceEllipse | undefined,
  image: Raster,
): Detection[] {
  if (
    !reference ||
    reference.major / reference.minor < ELLIPSE_CONFIG.ORIENTATION_MIN_ASPECT
  )
    return objects;
  const gray = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height)
      return undefined;
    const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
    return (
      0.299 * image.data[i] +
      0.587 * image.data[i + 1] +
      0.114 * image.data[i + 2]
    );
  };
  return objects.map((d) => {
    if (d.source !== "ai" || !d.measurement) return d;
    const scores: { angle: number; score: number }[] = [];
    for (
      let deg = 0;
      deg < 180;
      deg += ELLIPSE_CONFIG.ORIENTATION_STEP_DEGREES
    ) {
      const angle = (deg * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle),
        differences: number[] = [];
      for (let i = 0; i < ELLIPSE_CONFIG.ORIENTATION_SAMPLES; i++) {
        const t = (i * Math.PI * 2) / ELLIPSE_CONFIG.ORIENTATION_SAMPLES;
        const x = (reference.major / 2) * Math.cos(t),
          y = (reference.minor / 2) * Math.sin(t),
          dx = x * c - y * s,
          dy = x * s + y * c;
        const inner = gray(
          d.center.x + dx * ELLIPSE_CONFIG.ORIENTATION_INNER_RADIUS,
          d.center.y + dy * ELLIPSE_CONFIG.ORIENTATION_INNER_RADIUS,
        );
        const outer = gray(
          d.center.x + dx * ELLIPSE_CONFIG.ORIENTATION_OUTER_RADIUS,
          d.center.y + dy * ELLIPSE_CONFIG.ORIENTATION_OUTER_RADIUS,
        );
        if (inner !== undefined && outer !== undefined)
          differences.push(inner - outer);
      }
      // Absolute signed mean handles light and dark tablets; alternating print
      // edges cancel instead of contributing many independent positive votes.
      const score =
        differences.length === ELLIPSE_CONFIG.ORIENTATION_SAMPLES
          ? Math.abs(
              differences.reduce((a, b) => a + b, 0) / differences.length,
            )
          : 0;
      scores.push({ angle, score });
    }
    scores.sort((a, b) => b.score - a.score);
    const best = scores[0],
      perpendicular = scores.reduce((a, b) =>
        Math.abs(Math.cos(a.angle - best.angle)) <
        Math.abs(Math.cos(b.angle - best.angle))
          ? a
          : b,
      );
    if (
      best.score < ELLIPSE_CONFIG.ORIENTATION_MIN_SUPPORT ||
      best.score - perpendicular.score < ELLIPSE_CONFIG.ORIENTATION_MIN_MARGIN
    )
      return d;
    return { ...d, markerAngle: best.angle, markerAngleSupport: best.score };
  });
}
function insidePolygon(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function sampledMatch(
  bounds: { left: number; right: number; top: number; bottom: number },
  a: (p: Point) => boolean,
  b: (p: Point) => boolean,
) {
  let aa = 0,
    bb = 0,
    both = 0;
  const n = ELLIPSE_CONFIG.MATCH_GRID;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const p = {
          x: bounds.left + ((x + 0.5) * (bounds.right - bounds.left)) / n,
          y: bounds.top + ((y + 0.5) * (bounds.bottom - bounds.top)) / n,
        },
        av = a(p),
        bv = b(p);
      if (av) aa++;
      if (bv) bb++;
      if (av && bv) both++;
    }
  return {
    iou: both / Math.max(1, aa + bb - both),
    coverage: both / Math.max(1, bb),
    containment: both / Math.max(1, aa),
  };
}
export function calculateEllipseMatchScore(
  d: Detection,
  reference: ReferenceEllipse,
) {
  const m = d.measurement;
  if (!m || m.method === "box" || m.contour.length < 3) return;
  const r = reference.major / 2,
    xs = m.contour.map((p) => p.x),
    ys = m.contour.map((p) => p.y);
  return sampledMatch(
    {
      left: Math.min(d.center.x - r, ...xs),
      right: Math.max(d.center.x + r, ...xs),
      top: Math.min(d.center.y - r, ...ys),
      bottom: Math.max(d.center.y + r, ...ys),
    },
    (p) => insidePolygon(p, m.contour),
    (p) =>
      insideEllipse(
        p,
        d.center,
        reference.major,
        reference.minor,
        d.markerAngle ?? m.angle,
      ),
  );
}
export function filterByReferenceSize<T extends Detection>(
  objects: T[],
  reference?: ReferenceEllipse,
) {
  const kept: T[] = [],
    rejected: T[] = [];
  for (const d of objects) {
    const m = d.measurement!,
      reasons: string[] = [];
    const a: EllipseAssessment = { status: "normal", reasons };
    if (!reference || !m || !(m.major > 0 && m.minor > 0)) {
      a.status = "review";
      reasons.push("基準楕円または形状計測が不足");
    } else {
      a.majorRatio = m.major / reference.major;
      a.minorRatio = m.minor / reference.minor;
      a.areaRatio = m.area / reference.area;
      if (a.majorRatio < ELLIPSE_CONFIG.MIN_MAJOR_AXIS_RATIO)
        reasons.push(
          `長径が基準の${ELLIPSE_CONFIG.MIN_MAJOR_AXIS_RATIO * 100}%未満`,
        );
      if (a.minorRatio < ELLIPSE_CONFIG.MIN_MINOR_AXIS_RATIO)
        reasons.push(
          `短径が基準の${ELLIPSE_CONFIG.MIN_MINOR_AXIS_RATIO * 100}%未満`,
        );
      if (a.areaRatio < ELLIPSE_CONFIG.MIN_AREA_RATIO)
        reasons.push(`面積が基準の${ELLIPSE_CONFIG.MIN_AREA_RATIO * 100}%未満`);
      if (reasons.length && d.source !== "manual") a.status = "excluded";
      else {
        a.match = calculateEllipseMatchScore(d, reference);
        if (m.method === "box")
          reasons.push("AIの輪郭は未確定（外接枠でサイズ判定）");
        if (
          a.majorRatio < ELLIPSE_CONFIG.REVIEW_AXIS_MIN ||
          a.minorRatio < ELLIPSE_CONFIG.REVIEW_AXIS_MIN ||
          a.majorRatio > ELLIPSE_CONFIG.REVIEW_AXIS_MAX ||
          a.minorRatio > ELLIPSE_CONFIG.REVIEW_AXIS_MAX ||
          a.areaRatio > ELLIPSE_CONFIG.REVIEW_AREA_MAX
        )
          reasons.push("基準サイズからのずれ");
        if (a.match && a.match.iou < ELLIPSE_CONFIG.REVIEW_IOU)
          reasons.push("基準楕円との一致度が低い");
        if (
          d.flags.some((f) =>
            /接触|不規則|反射|境界|復元|要確認|split|merged/i.test(f),
          )
        )
          reasons.push("元の検出で形状に注意あり");
        a.status =
          a.match && a.match.iou < ELLIPSE_CONFIG.EXCLUSION_CANDIDATE_IOU
            ? "exclusion-candidate"
            : reasons.length
              ? "review"
              : "normal";
      }
    }
    const item = { ...d, ellipseAssessment: a };
    (a.status === "excluded" ? rejected : kept).push(item);
  }
  return { kept, rejected };
}
export function ellipseOverlap(
  a: Detection,
  b: Detection,
  reference: ReferenceEllipse,
) {
  const r = reference.major / 2;
  return sampledMatch(
    {
      left: Math.min(a.center.x, b.center.x) - r,
      right: Math.max(a.center.x, b.center.x) + r,
      top: Math.min(a.center.y, b.center.y) - r,
      bottom: Math.max(a.center.y, b.center.y) + r,
    },
    (p) =>
      insideEllipse(
        p,
        a.center,
        reference.major,
        reference.minor,
        a.markerAngle ?? a.measurement?.angle ?? 0,
      ),
    (p) =>
      insideEllipse(
        p,
        b.center,
        reference.major,
        reference.minor,
        b.markerAngle ?? b.measurement?.angle ?? 0,
      ),
  ).iou;
}
/** This supplements the existing fusion; it does not replace AI support checks.
 * Distance alone must never merge side-by-side long tablets. */
export function mergeOpticalAndAIDetections(
  objects: Detection[],
  reference?: ReferenceEllipse,
) {
  if (!reference) return { detections: objects, rejected: [] as Detection[] };
  const optical = objects.filter((d) => d.source === "cv"),
    rejected: Detection[] = [];
  const detections = objects.filter((d) => {
    if (d.source !== "ai") return true;
    const same = optical.find(
      (c) =>
        Math.hypot(c.center.x - d.center.x, c.center.y - d.center.y) <
          reference.major * ELLIPSE_CONFIG.DUPLICATE_DISTANCE_RATIO &&
        ellipseOverlap(c, d, reference) >= ELLIPSE_CONFIG.DUPLICATE_IOU,
    );
    if (!same) return true;
    rejected.push({
      ...d,
      ellipseAssessment: {
        ...d.ellipseAssessment,
        status: "excluded",
        reasons: [
          ...(d.ellipseAssessment?.reasons || []),
          `基準楕円が光学検出 ${same.id} と重複`,
        ],
      },
    });
    return false;
  });
  return { detections, rejected };
}

/** Existing fusion can discard a contact contour in anticipation of an AI
 * replacement that never survives its own checks. Re-evaluate just that
 * reason, never background/size vetoes. Preserve a one-pill optical region as
 * reviewable only if no final object explains its measured foreground. */
export function restoreUnreplacedOpticalCandidates(
  objects: Detection[],
  rejected: Detection[],
  reference?: ReferenceEllipse,
) {
  const restored: Detection[] = [],
    detections = [...objects];
  if (
    reference &&
    reference.sampleCount >= ELLIPSE_CONFIG.RESTORE_MIN_REFERENCE_COUNT
  ) {
    for (const d of rejected) {
      if (
        d.source !== "cv" ||
        d.flags.at(-1) !== "接触輪郭をAIの個体候補に置換"
      )
        continue;
      const m = d.measurement,
        match = calculateEllipseMatchScore(d, reference);
      if (
        !m ||
        !match ||
        match.iou < ELLIPSE_CONFIG.RESTORE_MIN_IOU ||
        m.area / reference.area < ELLIPSE_CONFIG.RESTORE_MIN_AREA_RATIO ||
        m.area / reference.area > ELLIPSE_CONFIG.RESTORE_MAX_AREA_RATIO ||
        m.major / reference.major > ELLIPSE_CONFIG.RESTORE_MAX_AXIS_RATIO ||
        m.minor / reference.minor > ELLIPSE_CONFIG.RESTORE_MAX_AXIS_RATIO
      )
        continue;
      const explained = detections.some(
        (e) =>
          insidePolygon(e.center, m.contour) ||
          (e.source === "cv" && insidePolygon(d.center, e.contour)) ||
          ellipseOverlap(d, e, reference) >= ELLIPSE_CONFIG.DUPLICATE_IOU,
      );
      if (explained) continue;
      const item = {
        ...d,
        flags: [
          ...d.flags.slice(0, -1),
          "AI置換が成立しなかった光学候補を復元・要確認",
        ],
      };
      restored.push(item);
      detections.push(item);
    }
  }
  return {
    detections,
    restored,
    rejected: rejected.filter(
      (d) => !restored.some((e) => e.id === d.id && e.source === d.source),
    ),
  };
}
