import { test } from "node:test";
import assert from "node:assert/strict";
import type { Detection, Raster } from "../src/types";
import {
  estimateAIEllipseOrientation,
  calculateReferenceEllipse,
  measureDetectedObjects,
  filterByReferenceSize,
  calculateEllipseMatchScore,
  mergeOpticalAndAIDetections,
  restoreUnreplacedOpticalCandidates,
  insideEllipse,
  ELLIPSE_CONFIG,
} from "../src/vision/referenceEllipse";
import {
  normalizedMarker,
  drawNormalizedMarkers,
} from "../src/components/normalizedMarkers";
function pill(
  x = 100,
  y = 100,
  major = 60,
  minor = 30,
  angle = 0,
  source: Detection["source"] = "cv",
): Detection {
  const contour = Array.from({ length: 64 }, (_, i) => {
    const t = (i * Math.PI) / 32;
    return {
      x:
        x +
        (major / 2) * Math.cos(t) * Math.cos(angle) -
        (minor / 2) * Math.sin(t) * Math.sin(angle),
      y:
        y +
        (major / 2) * Math.cos(t) * Math.sin(angle) +
        (minor / 2) * Math.sin(t) * Math.cos(angle),
    };
  });
  const xs = contour.map((p) => p.x),
    ys = contour.map((p) => p.y);
  return {
    id: `${source}-${x}-${y}`,
    center: { x, y },
    area: (Math.PI * major * minor) / 4,
    box: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    contour,
    source,
    flags: [],
  };
}
const close = (actual: number, expected: number, tol = 0.02) =>
  assert.ok(Math.abs(actual - expected) < tol, `${actual} vs ${expected}`);

test("unfulfilled AI replacement restores only an unexplained one-pill region for review", () => {
  const ref = calculateReferenceEllipse(
    Array.from({ length: 5 }, () => pill()),
  )!;
  const candidate = measureDetectedObjects([pill()])[0];
  candidate.flags = ["接触輪郭をAIの個体候補に置換"];
  const result = restoreUnreplacedOpticalCandidates([], [candidate], ref);
  assert.equal(result.restored.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(
    filterByReferenceSize(result.detections, ref).kept[0].ellipseAssessment
      ?.status,
    "review",
  );
  const replacement = measureDetectedObjects([
    pill(102, 100, 60, 30, 0, "ai"),
  ])[0];
  assert.equal(
    restoreUnreplacedOpticalCandidates([replacement], [candidate], ref).restored
      .length,
    0,
  );
  // A nearby pill on a parallel row is not a replacement.
  const neighbor = measureDetectedObjects([pill(100, 135)])[0];
  assert.equal(
    restoreUnreplacedOpticalCandidates([neighbor], [candidate], ref).restored
      .length,
    1,
  );
  const background = { ...candidate, flags: ["背景支持が不足"] };
  assert.equal(
    restoreUnreplacedOpticalCandidates([], [background], ref).restored.length,
    0,
  );
  const merged = measureDetectedObjects([pill(100, 100, 120, 60)])[0];
  merged.flags = candidate.flags;
  assert.equal(
    restoreUnreplacedOpticalCandidates([], [merged], ref).restored.length,
    0,
  );
  assert.equal(
    restoreUnreplacedOpticalCandidates([], [candidate], {
      ...ref,
      sampleCount: 1,
    }).restored.length,
    0,
  );
  assert.equal(
    restoreUnreplacedOpticalCandidates([], [candidate]).restored.length,
    0,
  );
});
test("rotated round and long contours retain original data and recover Feret axes", () => {
  for (const angle of [0, 0.3, Math.PI / 2, 2.5]) {
    const d = pill(100, 100, 80, 24, angle),
      before = JSON.stringify(d),
      m = measureDetectedObjects([d])[0].measurement!;
    close(m.major, 80);
    close(m.minor, 24);
    close(m.angle, angle);
    assert.equal(JSON.stringify(d), before);
    assert.equal(m.method, "contour");
  }
  const m = measureDetectedObjects([pill(100, 100, 40, 40)])[0].measurement!;
  close(m.major, 40);
  close(m.minor, 40);
});
test("paired central 60% rejects both tails and records mean / median choice", () => {
  const objects = [3, 5, 30, 30, 30, 30, 30, 30, 120, 150].map((v, i) =>
    pill(i * 100, 100, v * 2, v),
  );
  const ref = calculateReferenceEllipse(objects)!;
  assert.equal(ref.trimmedEachEnd, 2);
  assert.equal(ref.retainedCount, 6);
  close(ref.major, 60);
  close(ref.minor, 30);
  assert.equal(ref.usedMedian.major, false);
  const skew = calculateReferenceEllipse(
    [1, 1, 1, 5, 10].map((v) => pill(100, 100, v * 20, v * 10)),
  )!;
  assert.equal(skew.usedMedian.major, true);
  assert.equal(skew.usedMedian.minor, true);
  close(skew.major, 20);
});
test("no optical candidates and very small sets have explicit fallbacks without NaN", () => {
  assert.equal(calculateReferenceEllipse([]), undefined);
  assert.equal(
    calculateReferenceEllipse([pill(1, 1, 20, 10, 0, "ai")]),
    undefined,
  );
  for (const n of [1, 2, 3, 4]) {
    const ref = calculateReferenceEllipse(
      Array.from({ length: n }, () => pill()),
    )!;
    assert.equal(ref.retainedCount, n);
    assert.ok(Number.isFinite(ref.area));
  }
  const ai = measureDetectedObjects([pill(100, 100, 60, 30, 0, "ai")]);
  const result = filterByReferenceSize(ai);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].ellipseAssessment!.status, "review");
});
test("three small-size gates apply to both sources; low IoU alone never removes a pill", () => {
  const ref = calculateReferenceEllipse([pill()])!;
  for (const source of ["cv", "ai"] as const) {
    const inputs = measureDetectedObjects([
      pill(100, 100, 10, 5, 0, source),
      pill(100, 100, 60, 6, 0, source),
    ]);
    const r = filterByReferenceSize(inputs, ref);
    assert.equal(r.rejected.length, 2);
    assert.ok(r.rejected.every((d) => d.ellipseAssessment!.reasons.length));
  }
  const regular = measureDetectedObjects([pill()])[0];
  assert.ok(calculateEllipseMatchScore(regular, ref)!.iou > 0.95);
  const large = measureDetectedObjects([pill(100, 100, 180, 90)])[0];
  const r = filterByReferenceSize([large], ref);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].ellipseAssessment!.status, "exclusion-candidate");
  // Partial but plausible overlap remains reviewable rather than disappearing.
  assert.equal(
    filterByReferenceSize(measureDetectedObjects([pill(100, 100, 42, 22)]), ref)
      .kept.length,
    1,
  );
});
test("size thresholds are strict below tests, not inclusive at the boundary", () => {
  const ref = calculateReferenceEllipse([pill()])!;
  const d = measureDetectedObjects([pill()])[0];
  d.measurement = {
    ...d.measurement!,
    major: ref.major * ELLIPSE_CONFIG.MIN_MAJOR_AXIS_RATIO,
    minor: ref.minor * ELLIPSE_CONFIG.MIN_MINOR_AXIS_RATIO,
    area: ref.area * ELLIPSE_CONFIG.MIN_AREA_RATIO,
  };
  assert.equal(filterByReferenceSize([d], ref).kept.length, 1);
});
test("distance plus rotated overlap removes CV/AI doubles but keeps side-by-side long pills", () => {
  const optical = measureDetectedObjects([pill(100, 100, 100, 20)]),
    ref = calculateReferenceEllipse(optical)!;
  const duplicate = {
    ...optical[0],
    id: "ai-double",
    source: "ai" as const,
    center: { x: 103, y: 100 },
  };
  const neighbor = {
    ...optical[0],
    id: "ai-neighbor",
    source: "ai" as const,
    center: { x: 100, y: 123 },
  };
  const r = mergeOpticalAndAIDetections([...optical, duplicate, neighbor], ref);
  assert.equal(r.detections.length, 2);
  assert.equal(r.rejected[0].id, "ai-double");
  assert.ok(r.detections.includes(neighbor));
});
test("AI direction is measured from contrasting pixels; flat or unavailable pixels remain unknown", () => {
  const truePill = pill(100, 100, 72, 28, 0.7),
    b = { x: 55, y: 55, width: 90, height: 90 };
  const ai = {
    ...truePill,
    source: "ai" as const,
    contour: [],
    box: b,
    area: b.width * b.height,
  };
  const image: Raster = {
    width: 200,
    height: 200,
    data: new Uint8ClampedArray(200 * 200 * 4),
  };
  for (let y = 0; y < 200; y++)
    for (let x = 0; x < 200; x++) {
      const v = insideEllipse({ x, y }, truePill.center, 72, 28, 0.7)
        ? 235
        : 40;
      image.data.set([v, v, v, 255], (y * 200 + x) * 4);
    }
  const m = measureDetectedObjects([ai], image)[0].measurement!;
  assert.equal(m.method, "pixels");
  close(m.angle, 0.7, 0.08);
  close(m.major, 72, 6);
  close(m.minor, 28, 6);
  image.data.fill(128);
  const flat = measureDetectedObjects([ai], image)[0].measurement!;
  assert.equal(flat.method, "box");
  assert.equal(flat.angle, 0);
});
test("final markers share one size, use an ellipse only, and keep suspicious candidates dashed", () => {
  const ds = measureDetectedObjects([pill(), pill(180, 100, 40, 25, 0.7)]),
    ref = calculateReferenceEllipse([ds[0]])!;
  const reviewed = filterByReferenceSize(ds, ref).kept;
  for (const d of reviewed) {
    close(normalizedMarker(d, ref).major, ref.major);
    close(normalizedMarker(d, ref).minor, ref.minor);
  }
  const calls: any[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_, key) =>
        (...args: any[]) =>
          calls.push([key, ...args]),
      set: () => true,
    },
  ) as CanvasRenderingContext2D;
  const flagged = {
    ...reviewed[0],
    ellipseAssessment: { status: "review" as const, reasons: ["反射"] },
  };
  drawNormalizedMarkers(ctx, flagged, ref, false, 640);
  assert.equal(calls.filter((c) => c[0] === "ellipse").length, 1);
  assert.equal(
    calls.some((c) => c[0] === "lineTo"),
    false,
  );
  assert.ok(calls.find((c) => c[0] === "setLineDash")[1].length);
});

test("reference boundary recovers the direction in a connected pair without rewriting size evidence", () => {
  const angle = 0.7,
    major = 72,
    minor = 28;
  const ref = calculateReferenceEllipse([pill(100, 100, major, minor, angle)])!;
  const shape = pill(100, 100, major, minor, angle, "ai");
  const neighbor = {
    x: 100 - Math.sin(angle) * minor,
    y: 100 + Math.cos(angle) * minor,
  };
  for (const dark of [false, true]) {
    const image: Raster = {
      width: 220,
      height: 220,
      data: new Uint8ClampedArray(220 * 220 * 4),
    };
    for (let y = 0; y < 220; y++)
      for (let x = 0; x < 220; x++) {
        const inside =
          insideEllipse({ x, y }, shape.center, major, minor, angle) ||
          insideEllipse({ x, y }, neighbor, major, minor, angle);
        const v = inside !== dark ? 235 : 40;
        image.data.set([v, v, v, 255], (y * 220 + x) * 4);
      }
    const d = measureDetectedObjects([shape])[0],
      original = JSON.stringify(d.measurement);
    const result = estimateAIEllipseOrientation([d], ref, image)[0];
    assert.ok(result.markerAngle !== undefined);
    close(result.markerAngle!, angle, 0.18);
    assert.equal(JSON.stringify(result.measurement), original);
    image.data.fill(128);
    assert.equal(
      estimateAIEllipseOrientation([d], ref, image)[0].markerAngle,
      undefined,
    );
  }
});
