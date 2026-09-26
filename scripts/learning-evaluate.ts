/** Offline, operator-reviewed re-training of exported feedback. Never uploads or deploys. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { train, FEATURE_COUNT, type LearningRecord } from "../src/learning";
const path = process.env.LEARNING_INPUT,
  output = process.env.LEARNING_OUTPUT || "work/learning-evaluation";
if (!path)
  throw new Error(
    "Set LEARNING_INPUT to a reviewed pill-learning JSON file. No data is sent anywhere.",
  );
const raw = readFileSync(path);
if (raw.length > 120 * 1024 * 1024)
  throw new Error("File exceeds the 120 MB limit");
const data = JSON.parse(raw.toString("utf8"));
if (
  data.schemaVersion !== 1 ||
  data.featureVersion !== 1 ||
  !Array.isArray(data.records) ||
  data.records.length > 40
)
  throw new Error("Unsupported learning export");
for (const r of data.records) {
  if (
    !r.confirmed ||
    !["pill", "bottle"].includes(r.target) ||
    typeof r.imageHash !== "string" ||
    typeof r.group !== "string" ||
    !r.group.trim() ||
    !Array.isArray(r.examples) ||
    r.examples.length > 10000 ||
    r.examples.some(
      (e: { x: number[]; y: number }) =>
        ![0, 1].includes(e.y) ||
        !Array.isArray(e.x) ||
        e.x.length !== FEATURE_COUNT ||
        e.x.some((v) => !Number.isFinite(v) || v < 0 || v > 1),
    )
  )
    throw new Error("Invalid examples or photograph grouping");
}
const records = data.records as LearningRecord[];
mkdirSync(output, { recursive: true });
for (const target of ["pill", "bottle"] as const) {
  const result = train(records, target);
  // A null model overwrites any older candidate when a later evaluation fails.
  writeFileSync(
    `${output}/${target}.json`,
    JSON.stringify(
      {
        ...result,
        intendedUse:
          "operator-reviewed suggestions only; not an ONNX detector or automatic count update",
      },
      null,
      2,
    ),
  );
  console.log(target, JSON.stringify(result.report));
}
