import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyze } from "../src/vision/pipeline";
for (const oblong of [false, true])
  test(`optical shape separates printed ${oblong ? "oblong" : "round"} pills from blue basket apertures`, async () => {
    const svg = `<svg width="640" height="480"><rect width="640" height="480" fill="#555"/>${Array.from(
      { length: 12 },
      (_, i) => {
        const x = 100 + (i % 4) * 125,
          y = 70 + Math.floor(i / 4) * 135;
        return `<g transform="translate(${x} ${y}) rotate(${i * 17})"><rect x="${oblong ? -44 : -22}" y="-22" width="${oblong ? 88 : 44}" height="44" rx="22" fill="#eee"/><path d="M -12 -10 v20 M -3 -10 v20 M 6 -10 v20" stroke="#307ab0" stroke-width="3"/></g>`;
      },
    ).join(
      "",
    )}${Array.from({ length: 12 }, (_, i) => `<rect x="605" y="${i * 38 + 5}" width="20" height="26" fill="#789cca"/>`).join("")}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = await analyze(
      {
        data: new Uint8ClampedArray(data),
        width: info.width,
        height: info.height,
      },
      { scene: "tray", autoROI: false, debug: false },
    );
    assert.equal(result.detections.length, 12);
    if (oblong)
      assert.ok(result.diagnostics.some((d) => d.includes("形状 長円")));
  });

import { aiMarkerRadius } from "../src/components/markerSize";
import type { Detection } from "../src/types";
test("AI circle follows nearby optical size, ignores fragments and falls back without optical matches", () => {
  const detection = (
    x: number,
    r: number,
    source: "cv" | "ai" = "cv",
  ): Detection => ({
    id: String(x),
    center: { x, y: 50 },
    box: { x: x - r, y: 50 - r, width: r * 2, height: r * 2 },
    area: Math.PI * r * r,
    contour: [],
    flags: [],
    source,
  });
  const ai = detection(200, 30, "ai"),
    local = [
      detection(240, 20),
      detection(160, 21),
      detection(280, 22),
      detection(180, 2),
      detection(1200, 40),
    ];
  assert.equal(aiMarkerRadius(ai, local), 21);
  assert.equal(aiMarkerRadius(ai, []), 30);
  assert.equal(aiMarkerRadius(ai, [detection(1200, 40)]), 30);
});

import { additionGuard } from "../src/ai/additionGuard";
test("AI and learned additions cannot borrow foreground from blue apertures or a gray gap", () => {
  const image = {
    width: 400,
    height: 300,
    data: new Uint8ClampedArray(400 * 300 * 4),
  };
  for (let i = 0; i < image.data.length; i += 4)
    image.data.set([110, 110, 110, 255], i);
  const refs: Detection[] = Array.from({ length: 8 }, (_, i) => {
    const x = 40 + (i % 4) * 90,
      y = 40 + Math.floor(i / 4) * 80;
    for (let py = y - 14; py <= y + 14; py++)
      for (let px = x - 28; px <= x + 28; px++)
        image.data.set([230, 230, 230, 255], (py * 400 + px) * 4);
    return {
      id: String(i),
      center: { x, y },
      box: { x: x - 30, y: y - 15, width: 60, height: 30 },
      area: 1400,
      source: "cv",
      flags: [],
      contour: [],
      shape: { solidity: 0.98, circularity: 0.6, aspect: 2, perimeter: 160 },
    };
  });
  for (let y = 200; y < 240; y++)
    for (let x = 20; x < 80; x++)
      image.data.set([100, 155, 210, 255], (y * 400 + x) * 4);
  const at = (x: number, y: number): Detection => ({
    ...refs[0],
    source: "ai",
    center: { x, y },
    box: { x: x - 30, y: y - 15, width: 60, height: 30 },
    shape: undefined,
  });
  const guard = additionGuard(image, refs);
  assert.ok(guard(at(50, 220), refs).length);
  assert.ok(guard(at(180, 220), refs).length);
  assert.equal(guard({ ...refs[0], source: "ai" }, refs.slice(1)).length, 0);
});
import { fuse } from "../src/ai/fusion";
import type { AICandidate } from "../src/ai/onnxDetector";

test("fragment replacement uses background guard and preserves originals on rejection", () => {
  const image = {
    width: 500,
    height: 400,
    data: new Uint8ClampedArray(500 * 400 * 4),
  };
  for (let i = 0; i < image.data.length; i += 4)
    image.data.set([90, 90, 90, 255], i);
  const at = (
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    area: number,
    solidity = 0.96,
  ): Detection => ({
    id,
    center: { x, y },
    box: { x: x - w / 2, y: y - h / 2, width: w, height: h },
    area,
    contour: [
      { x: x - w / 2, y: y - h / 2 },
      { x: x + w / 2, y: y - h / 2 },
      { x: x + w / 2, y: y + h / 2 },
      { x: x - w / 2, y: y + h / 2 },
    ],
    source: "cv",
    flags: [],
    shape: { circularity: 0.85, solidity, aspect: 1, perimeter: 120 },
  });
  const refs = Array.from({ length: 8 }, (_, i) =>
    at("r" + i, 50 + (i % 4) * 100, 240 + Math.floor(i / 4) * 90, 34, 34, 900),
  );
  for (const r of refs)
    for (let y = r.center.y - 17; y <= r.center.y + 17; y++)
      for (let x = r.center.x - 17; x <= r.center.x + 17; x++)
        if (Math.hypot(x - r.center.x, y - r.center.y) <= 17)
          image.data.set([235, 235, 235, 255], (y * 500 + x) * 4);
  const fragments = [
    at("fragment", 99, 100, 16, 15, 100, 0.85),
    at("parent", 114, 100, 25, 25, 400, 0.85),
  ];
  const a: AICandidate = {
    ...at("a", 108, 100, 40, 35, 1400),
    source: "ai",
    score: 0.96,
    view: "full",
  };
  const result = fuse(
    [...refs, ...fragments],
    [a],
    [{ ...a, id: "b", view: "tile" }],
    image,
  );
  assert.equal(
    result.detections.some((d) => d.source === "ai"),
    false,
  );
  assert.equal(result.removed.length, 0);
  assert.equal(result.replaced.length, 0);
  assert.ok(fragments.every((d) => result.detections.includes(d)));
  assert.ok(
    result.rejected.some((d) => d.flags.includes("追加抑制:背景または重複")),
  );
});
test("shadowed tablets use nearby optical colour without admitting gray gaps", () => {
  const image = {
    width: 700,
    height: 500,
    data: new Uint8ClampedArray(700 * 500 * 4),
  };
  for (let i = 0; i < image.data.length; i += 4)
    image.data.set([85, 85, 85, 255], i);
  const paint = (x: number, y: number, r: number, value: number) => {
    for (let py = y - r; py <= y + r; py++)
      for (let px = x - r; px <= x + r; px++)
        if (Math.hypot(px - x, py - y) <= r)
          image.data.set([value, value, value, 255], (py * 700 + px) * 4);
  };
  const refs: Detection[] = [];
  for (let i = 0; i < 24; i++) {
    const x = 40 + (i % 8) * 75,
      y = 40 + Math.floor(i / 8) * 150,
      value = i < 16 ? 235 : 190;
    paint(x, y, 16, value);
    refs.push({
      id: String(i),
      source: "cv",
      center: { x, y },
      box: { x: x - 16, y: y - 16, width: 32, height: 32 },
      area: 804,
      contour: [],
      flags: [],
      shape: { solidity: 0.98, circularity: 0.9, aspect: 1, perimeter: 100 },
    });
  }
  const shadow: Detection = {
    id: "shadow",
    source: "ai",
    center: { x: 265, y: 400 },
    box: { x: 249, y: 384, width: 32, height: 32 },
    area: 1024,
    flags: [],
    contour: [],
  };
  paint(265, 400, 16, 170);
  const guard = additionGuard(image, refs);
  assert.equal(guard(shadow, refs).length, 0);
  const gap = {
    ...shadow,
    center: { x: 340, y: 400 },
    box: { ...shadow.box, x: 324 },
  };
  assert.ok(guard(gap, refs).length);
  // With no local optical evidence, an isolated dim blob cannot change the calibration.
  assert.ok(
    additionGuard(image, refs.slice(0, 16))(shadow, refs.slice(0, 16)).length,
  );
});
import { unrotateDetection } from "../src/ai/onnxDetector";
test("rotated AI boxes return to the correct non-square crop and photo coordinates", () => {
  const d: Detection = {
    id: "r",
    source: "ai",
    center: { x: 25, y: 40 },
    box: { x: 10, y: 20, width: 30, height: 40 },
    area: 1200,
    flags: [],
    contour: [
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ],
  };
  const actual = unrotateDetection(d, {
    x: 100,
    y: 200,
    width: 300,
    height: 180,
  });
  assert.deepEqual(actual.center, { x: 140, y: 355 });
  assert.deepEqual(actual.box, { x: 120, y: 340, width: 40, height: 30 });
  assert.deepEqual(actual.contour, [
    { x: 120, y: 370 },
    { x: 120, y: 340 },
    { x: 160, y: 340 },
    { x: 160, y: 370 },
  ]);
  assert.equal(actual.area, 1200);
});
