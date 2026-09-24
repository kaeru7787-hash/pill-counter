import type { Confidence, Detection } from "../types";
export function spatialAgreement(a: Detection[], b: Detection[]) {
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  const used = new Set<number>();
  let matches = 0;
  for (const d of a) {
    let best = -1,
      dist = Infinity;
    b.forEach((e, i) => {
      const r =
        Math.hypot(d.center.x - e.center.x, d.center.y - e.center.y) /
        Math.sqrt(Math.min(d.area, e.area));
      if (!used.has(i) && r < 0.65 && r < dist) {
        best = i;
        dist = r;
      }
    });
    if (best >= 0) {
      used.add(best);
      matches++;
    }
  }
  return matches / Math.max(a.length, b.length);
}
export function confidence(
  counts: { A: number; B: number; C: number; AI?: number },
  agreement: number,
  issues: string[],
  aiAgreement?: number,
): Confidence {
  const values = Object.values(counts),
    spread = Math.max(...values) - Math.min(...values),
    reasons = [...issues];
  if (!counts.B) reasons.push("錠剤候補を検出できませんでした");
  if (spread > 1) reasons.push(`解析方法の個数が不一致（差 ${spread}）`);
  if (agreement < 0.9) reasons.push("解析条件によって検出位置が変化");
  if (aiAgreement !== undefined && aiAgreement < 0.9)
    reasons.push("AIと画像処理の検出位置が不一致");
  if (reasons.length)
    return { level: "review", reasons: [...new Set(reasons)] };
  if (spread === 1)
    return {
      level: "medium",
      reasons: [
        "解析方法間で1個の差があります。すべての番号を確認してください",
      ],
    };
  if (counts.AI === undefined)
    return {
      level: "medium",
      reasons: [
        "画像処理の結果は安定。AIによる独立照合は未実施",
        "信頼度は一致度の目安です。実写精度は未検証です",
      ],
    };
  if (spread === 0)
    return {
      level: "high",
      reasons: [
        "画像処理3条件とAIの個数・位置が一致",
        "一致度の評価であり、正解確率ではありません",
      ],
    };
  return {
    level: "medium",
    reasons: ["解析方法間で1個の差があります。番号を確認してください"],
  };
}
export function chooseDetections(
  a: Detection[],
  b: Detection[],
  c: Detection[],
) {
  // Select an actual supported detection set, never an arithmetic count.
  if (
    a.length === c.length &&
    b.length !== c.length &&
    spatialAgreement(b, c) >= 0.9
  )
    return c;
  return b;
}
