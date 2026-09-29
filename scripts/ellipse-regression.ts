import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import sharp from "sharp";
import { analyze } from "../src/vision/pipeline";
import {
  measureDetectedObjects,
  calculateReferenceEllipse,
  filterByReferenceSize,
} from "../src/vision/referenceEllipse";
const metadata = JSON.parse(readFileSync("tests/metadata.json", "utf8"));
const ground = JSON.parse(readFileSync("tests/ground-truth.json", "utf8"));
const rows = [];
mkdirSync("work/v016/cv", { recursive: true });
for (const file of Object.keys(ground)) {
  const { data, info } = await sharp(`tests/images/${file}`)
    .rotate()
    .resize({
      width: 2048,
      height: 2048,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const im = {
    width: info.width,
    height: info.height,
    data: new Uint8ClampedArray(data),
  };
  const before = await analyze(im, {
    scene: metadata[file].scene,
    autoROI: true,
    debug: false,
  });
  const measured = measureDetectedObjects(before.detections),
    reference = calculateReferenceEllipse(measured),
    after = filterByReferenceSize(measured, reference);
  const row = {
    file,
    truth: ground[file],
    before: before.detections.length,
    after: after.kept.length,
    review: after.kept.filter((d) => d.ellipseAssessment?.status !== "normal")
      .length,
    removed: after.rejected.map((d) => ({
      id: d.id,
      center: d.center,
      reason: d.ellipseAssessment?.reasons,
    })),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  writeFileSync(
    `work/v016/cv/${file}.json`,
    JSON.stringify({ reference, before: before.detections, after }),
  );
}
writeFileSync("work/v016/cv-regression.json", JSON.stringify(rows, null, 2));
