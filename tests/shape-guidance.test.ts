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
