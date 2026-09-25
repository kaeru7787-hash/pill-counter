// Reproducible v0.6 experiment: inference never receives count/center labels.
import sharp from "sharp";
import * as ort from "onnxruntime-web/wasm";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { inferViews } from "../.runtime/src/ai/onnxDetector.js";
import { fuse } from "../.runtime/src/ai/fusion.js";
import { positionMetrics } from "../.runtime/src/vision/positionMetrics.js";
const dir = "tests/reports/v06";
mkdirSync(dir, { recursive: true });
ort.env.wasm.numThreads = 1;
const bytes = readFileSync(".runtime/models/pill-yolo11n.onnx"),
  session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
  });
const config = JSON.parse(readFileSync("public/models/config.json"));
if (createHash("sha256").update(bytes).digest("hex") !== config.sha256)
  throw new Error("Evaluation model does not match the pinned model");
const gt = JSON.parse(readFileSync("tests/ground-truth.json"));
const meta = JSON.parse(readFileSync("tests/metadata.json"));
const rows = [];
try {
  for (const file of Object.keys(gt).filter((f) =>
    process.env.CASES
      ? new RegExp(process.env.CASES).test(f)
      : parseInt(f) >= 18,
  )) {
    const r = JSON.parse(
      readFileSync("tests/reports/ensemble/" + file + ".json"),
    );
    const { data, info } = await sharp("tests/images/" + file)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image = {
      width: info.width,
      height: info.height,
      data: new Uint8ClampedArray(data),
    };
    const cache = dir + "/" + file + ".raw.json";
    let raw;
    {
      const start = performance.now();
      raw = await inferViews(
        image,
        { x: 0, y: 0, width: info.width, height: info.height },
        config,
        session,
        ort,
        r.cv,
      );
      raw.elapsed = performance.now() - start;
      raw.imageSha256 = createHash("sha256")
        .update(readFileSync("tests/images/" + file))
        .digest("hex");
      writeFileSync(cache, JSON.stringify(raw));
    }
    const f = fuse(r.cv, raw.detections, raw.tiles, image);
    const ap = "tests/annotations/" + file.replace(/\.[^.]+$/, ".json");
    const a = existsSync(ap)
      ? JSON.parse(readFileSync(ap))
      : {
          width: info.width,
          height: info.height,
          tolerance: 20,
          centers: meta[file].instances.map((p) => [p.x, p.y]),
        };
    const truth = a.centers.map(([x, y]) => ({
      x: (x * info.width) / a.width,
      y: (y * info.height) / a.height,
    }));
    if (truth.length !== gt[file])
      throw new Error(`Annotation count mismatch: ${file}`);
    const scores = positionMetrics(
      f.detections.map((d) => d.center),
      truth,
      (a.tolerance * info.width) / a.width,
    );
    const baseline = fuse(
      r.cv,
      raw.detections,
      raw.tiles.filter((t) => !t.view.startsWith("review")),
      image,
    );
    const row = {
      file,
      truth: gt[file],
      v05: r.ensemble.length,
      cv: r.cv.length,
      withoutRefinement: baseline.detections.length,
      detected: f.detections.length,
      error: f.detections.length - gt[file],
      ...scores,
      regions: raw.regions,
      elapsed: raw.elapsed,
      rejected: f.rejected.length,
    };
    rows.push(row);
    const allowedMisses = file === "24-lighting-bag-oblong.png" ? 1 : 0;
    if (
      scores.fp > 0 ||
      scores.fn > allowedMisses ||
      Math.abs(row.error) > allowedMisses
    )
      process.exitCode = 1;
    writeFileSync(
      dir + "/" + file + ".json",
      JSON.stringify(
        {
          ...row,
          detections: f.detections,
          rejectedCandidates: f.rejected,
          profile: f.profile,
        },
        null,
        2,
      ),
    );
    const match = new Set(scores.matchedPredictions);
    const svg = `<svg width="${info.width}" height="${info.height}">${f.detections.map((d, i) => `<rect x="${d.box.x}" y="${d.box.y}" width="${d.box.width}" height="${d.box.height}" fill="none" stroke="${match.has(i) ? "#00aa66" : "#ff2244"}" stroke-width="3"/><circle cx="${d.center.x}" cy="${d.center.y}" r="14" fill="#123d4c"/><text x="${d.center.x}" y="${d.center.y + 5}" font-size="16" text-anchor="middle" fill="white">${i + 1}</text>`).join("")}${scores.missingTruth.map((i) => `<circle cx="${truth[i].x}" cy="${truth[i].y}" r="25" fill="none" stroke="#2288ff" stroke-width="5"/>`).join("")}</svg>`;
    await sharp(
      await sharp("tests/images/" + file)
        .composite([{ input: Buffer.from(svg) }])
        .png()
        .toBuffer(),
    )
      .resize({ width: 1400, height: 1400, fit: "inside" })
      .png()
      .toFile(dir + "/" + file + ".png");
    console.log(JSON.stringify(row));
  }
} finally {
  await session.release();
  writeFileSync(dir + "/summary.json", JSON.stringify(rows, null, 2));
}
