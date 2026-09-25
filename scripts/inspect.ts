import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { analyze } from "../src/vision/pipeline";
const file = process.argv[2] || "tests/images/18-real-tray.jpg";
const max = Number(process.argv[3] || 1280);
const { data, info } = await sharp(file)
  .rotate()
  .resize({ width: max, height: max, fit: "inside", withoutEnlargement: true })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const result = await analyze(
  { width: info.width, height: info.height, data: new Uint8ClampedArray(data) },
  {
    scene: process.env.SCENE === "bag" ? "bag" : "tray",
    autoROI: process.env.AUTO_ROI === "1",
    debug: true,
  },
);
mkdirSync("tests/reports/debug", { recursive: true });
const { debug, ...rest } = result;
writeFileSync(
  "tests/reports/debug/inspection.json",
  JSON.stringify(rest, null, 2),
);
for (const [name, img] of Object.entries(debug))
  await sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png()
    .toFile("tests/reports/debug/" + name.replaceAll(" ", "-") + ".png");
const svg = `<svg width="${info.width}" height="${info.height}">${result.detections.map((d, i) => `<polygon points="${d.contour.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#00ffff" stroke-width="1.5"/><circle cx="${d.center.x}" cy="${d.center.y}" r="7" fill="#123"/><text x="${d.center.x}" y="${d.center.y + 3}" text-anchor="middle" fill="white" font-size="9">${i + 1}</text>`).join("")}</svg>`;
await sharp(data, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .composite([{ input: Buffer.from(svg) }])
  .png()
  .toFile("tests/reports/debug/overlay.png");
console.log(
  JSON.stringify(
    {
      size: [info.width, info.height],
      count: result.detections.length,
      counts: result.counts,
      roi: result.roi,
      elapsed: result.elapsed,
      diagnostics: result.diagnostics,
      confidence: result.confidence,
    },
    null,
    2,
  ),
);
