import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contains,
  duplicateOf,
  singleObjectContours,
} from "../src/ai/objectIdentity";
import { additionGuard } from "../src/ai/additionGuard";
import { pixelReference, pixelRejection } from "../src/ai/pixelEvidence";
import type { Detection, Raster } from "../src/types";
function body(x: number, y: number, rx = 30, ry = 30, angle = 0): Detection {
  const contour = Array.from({ length: 64 }, (_, i) => {
    const t = (i * Math.PI) / 32;
    return {
      x:
        x +
        Math.cos(angle) * rx * Math.cos(t) -
        Math.sin(angle) * ry * Math.sin(t),
      y:
        y +
        Math.sin(angle) * rx * Math.cos(t) +
        Math.cos(angle) * ry * Math.sin(t),
    };
  });
  const xs = contour.map((p) => p.x),
    ys = contour.map((p) => p.y);
  return {
    id: `${x}-${y}`,
    center: { x, y },
    contour,
    box: {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    },
    area: Math.PI * rx * ry,
    source: "cv",
    flags: [],
    shape: {
      solidity: 0.99,
      circularity: rx === ry ? 0.96 : 0.65,
      aspect: rx / ry,
      perimeter: 200,
    },
  };
}
function candidate(x: number, y: number, size: number): Detection {
  return {
    id: "ai",
    center: { x, y },
    box: { x: x - size / 2, y: y - size / 2, width: size, height: size },
    area: size * size,
    source: "ai",
    flags: [],
    contour: [],
  };
}
const refs = () => Array.from({ length: 8 }, (_, i) => body(50 + i * 75, 70));
function raster(objects: Detection[]): Raster {
  const image = {
    width: 720,
    height: 360,
    data: new Uint8ClampedArray(720 * 360 * 4),
  };
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++)
      image.data.set(
        objects.some((d) => contains(d, { x, y }))
          ? [235, 235, 235, 255]
          : [90, 90, 90, 255],
        (y * image.width + x) * 4,
      );
  return image;
}
test("shifted tiny proposals inside a measured tablet cannot be counted again", () => {
  const ds = refs(),
    im = raster(ds),
    guard = additionGuard(im, ds);
  for (const size of [8, 12, 20, 28]) {
    const d = candidate(70, 70, size);
    assert.equal(duplicateOf(d, ds), ds[0]);
    assert.ok(guard(d, ds).length);
  }
});
test("ownership follows a rotated elongated contour rather than a display circle", () => {
  const ds = Array.from({ length: 8 }, (_, i) =>
    body(65 + i * 80, 120, 36, 15, Math.PI / 4),
  );
  assert.equal(duplicateOf(candidate(82, 137, 8), ds), ds[0]);
  assert.equal(duplicateOf(candidate(42, 143, 8), ds), undefined);
});
test("touching separate tablet and isolated missed tablet remain available for AI rescue", () => {
  const ds = refs(),
    touching = body(50, 130),
    isolated = body(400, 250),
    im = raster([...ds, touching, isolated]),
    guard = additionGuard(im, ds);
  for (const d of [touching, isolated])
    assert.deepEqual(guard({ ...d, source: "ai" }, ds), []);
});
test("merged contours cannot claim independent instances of the measured family", () => {
  const ds = refs(),
    merged = body(300, 250, 65, 30),
    both = [...ds, merged];
  assert.equal(singleObjectContours(both).includes(merged), false);
  assert.equal(duplicateOf(candidate(320, 250, 12), both), undefined);
});
test("bright pixels borrowed from existing bodies fail even without a dark centre", () => {
  const ds = refs(),
    im = raster(ds),
    d = candidate(70, 70, 18);
  // Direct pixel test deliberately bypasses the earlier geometry veto.
  assert.ok(
    pixelRejection(im, d, pixelReference(im, ds), ds).includes(
      "新しい1錠分の内部領域がない",
    ),
  );
  assert.deepEqual(pixelRejection(im, ds[0], pixelReference(im, ds), ds), []);
});
