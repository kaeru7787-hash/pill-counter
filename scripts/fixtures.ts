import { PNG } from "pngjs";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
type Pill = {
  x: number;
  y: number;
  rx: number;
  ry: number;
  color?: number[];
  angle?: number;
  capsule?: boolean;
  score?: boolean;
};
type Case = {
  name: string;
  pills: Pill[];
  bg?: number[];
  artifact?: "bag" | "rim" | "specks" | "shadow";
  category: string;
  scene?: string;
  blur?: boolean;
};
const grid = (rows: number, cols: number, rx = 20, ry = 20): Pill[] =>
  Array.from({ length: rows * cols }, (_, i) => ({
    x: 50 + (i % cols) * (540 / cols),
    y: 50 + Math.floor(i / cols) * (380 / rows),
    rx,
    ry,
  }));
const cases: Case[] = [
  { name: "01-white-separated", pills: grid(4, 6), category: "Clean" },
  {
    name: "02-yellow-oval",
    pills: grid(3, 5, 28, 16).map((p) => ({
      ...p,
      color: [231, 204, 63],
      angle: 0.25,
    })),
    category: "Clean",
  },
  {
    name: "03-capsules",
    pills: grid(3, 4, 35, 15).map((p, i) => ({
      ...p,
      capsule: true,
      color: i % 2 ? [160, 80, 120] : [65, 156, 199],
      angle: i % 2 ? 0.4 : -0.3,
    })),
    category: "Split pill",
  },
  {
    name: "04-touching-pairs",
    pills: [
      { x: 130, y: 120, rx: 25, ry: 25 },
      { x: 176, y: 120, rx: 25, ry: 25 },
      { x: 330, y: 280, rx: 25, ry: 25 },
      { x: 375, y: 280, rx: 25, ry: 25 },
    ],
    category: "Merged pills",
  },
  {
    name: "05-touching-three",
    pills: [
      { x: 180, y: 190, rx: 29, ry: 29 },
      { x: 232, y: 190, rx: 29, ry: 29 },
      { x: 207, y: 234, rx: 29, ry: 29 },
    ],
    category: "Merged pills",
  },
  {
    name: "06-mixed-sizes",
    pills: grid(3, 5).map((p, i) => ({
      ...p,
      rx: i % 3 === 0 ? 12 : i % 3 === 1 ? 20 : 29,
      ry: i % 3 === 0 ? 12 : i % 3 === 1 ? 16 : 24,
      color: i % 2 ? [228, 201, 83] : [225, 228, 221],
    })),
    category: "False Negative",
  },
  {
    name: "07-scored-tablets",
    pills: grid(3, 5, 25, 25).map((p) => ({ ...p, score: true })),
    category: "Split pill",
  },
  {
    name: "08-tray-rim",
    pills: grid(3, 5),
    artifact: "rim",
    category: "Background",
  },
  {
    name: "09-bag-artifacts",
    pills: grid(3, 5),
    artifact: "bag",
    category: "Bag artifact",
    scene: "bag",
  },
  {
    name: "10-desk-color",
    pills: grid(3, 5).map((p) => ({ ...p, color: [201, 152, 48] })),
    bg: [182, 166, 143],
    category: "Background",
    scene: "desk",
  },
  {
    name: "11-specks",
    pills: grid(3, 5),
    artifact: "specks",
    category: "False Positive",
  },
  {
    name: "12-shadow",
    pills: grid(3, 5),
    artifact: "shadow",
    category: "Background",
  },
  { name: "13-empty", pills: [], category: "Empty" },
  {
    name: "14-dense-90",
    pills: Array.from({ length: 90 }, (_, i) => ({
      x: 40 + (i % 10) * 58,
      y: 32 + Math.floor(i / 10) * 51,
      rx: 19,
      ry: 19,
    })),
    category: "Clean",
  },
  {
    name: "15-edge-cut",
    pills: [
      { x: 3, y: 120, rx: 24, ry: 24 },
      { x: 160, y: 200, rx: 24, ry: 24 },
    ],
    category: "False Negative",
  },
  {
    name: "16-low-contrast",
    pills: grid(3, 5).map((p) => ({ ...p, color: [50, 52, 53] })),
    category: "False Negative",
  },
  {
    name: "17-white-reflection",
    pills: grid(3, 5).map((p) => ({ ...p, color: [255, 255, 255] })),
    artifact: "bag",
    category: "Reflection",
    scene: "bag",
  },
];
mkdirSync("tests/images", { recursive: true });
const ground: Record<string, number> = {},
  metadata: Record<string, unknown> = {};
for (const c of cases) {
  const w = 640,
    h = 480,
    png = new PNG({ width: w, height: h });
  let seed = 7123;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed % 5) - 2;
      let color = (c.bg || [27, 31, 34]).map(
        (v) => v + noise + (c.artifact === "shadow" ? (22 * x) / w : 0),
      );
      if (
        c.artifact === "rim" &&
        (x < 15 || x > w - 16 || y < 15 || y > h - 16)
      )
        color = [135, 141, 144];
      for (const pill of c.pills) {
        const a = pill.angle || 0,
          dx = (x - pill.x) * Math.cos(a) + (y - pill.y) * Math.sin(a),
          dy = -(x - pill.x) * Math.sin(a) + (y - pill.y) * Math.cos(a);
        const inside = pill.capsule
          ? Math.hypot(Math.max(0, Math.abs(dx) - (pill.rx - pill.ry)), dy) <
            pill.ry
          : (dx * dx) / (pill.rx * pill.rx) + (dy * dy) / (pill.ry * pill.ry) <
            1;
        if (inside) {
          color = (pill.color || [225, 229, 226]).map(
            (v) =>
              v +
              noise +
              (pill.color?.[0] === 255 ? 0 : 5 * (1 - dy / pill.ry)),
          );
          if (pill.capsule && dx < 0)
            color = color.map((v) => Math.min(248, v + 60));
          if (pill.score && Math.abs(dx) < 1.2)
            color = color.map((v) => v - 80);
        }
      }
      if (
        c.artifact === "bag" &&
        (Math.abs(y - (0.36 * x + 32)) < 2 ||
          Math.abs(y - (0.18 * x + 380)) < 3 ||
          x === 25)
      )
        color = [252, 252, 252];
      if (
        c.artifact === "bag" &&
        y > 430 &&
        y < 444 &&
        x > 180 &&
        x < 390 &&
        x % 16 < 4
      )
        color = [5, 5, 5];
      if (c.artifact === "specks" && (x * 17 + y * 13) % 1229 < 2)
        color = [212, 212, 212];
      const p = (y * w + x) * 4;
      for (let k = 0; k < 3; k++)
        png.data[p + k] = Math.max(0, Math.min(255, color[k]));
      png.data[p + 3] = 255;
    }
  const file = `${c.name}.png`;
  writeFileSync(`tests/images/${file}`, PNG.sync.write(png));
  ground[file] = c.pills.length;
  metadata[file] = {
    kind: "synthetic",
    category: c.category,
    scene: c.scene || "tray",
    instances: c.pills.map((p) => ({ x: p.x, y: p.y })),
  };
}
writeFileSync(
  "tests/ground-truth.json",
  JSON.stringify(ground, null, 2) + "\n",
);
writeFileSync("tests/metadata.json", JSON.stringify(metadata, null, 2) + "\n");
copyFileSync("tests/images/01-white-separated.png", "public/sample.png");
console.log(
  `Generated ${cases.length} synthetic fixtures. No real-photo accuracy claim.`,
);
