import type { Analysis, Detection } from "../types";
import { measureDetectedObjects } from "../vision/referenceEllipse";
export function ellipseDebugObjects(
  analysis: Analysis,
  detections: Detection[],
) {
  const rejected = analysis.rejectedCandidates || [];
  return [
    ...detections,
    ...rejected.filter(
      (d) =>
        !detections.some(
          (a) =>
            a.id === d.id &&
            a.source === d.source &&
            a.center.x === d.center.x &&
            a.center.y === d.center.y,
        ),
    ),
  ];
}
export function renderEllipseDebug(
  container: HTMLElement,
  analysis: Analysis,
  detections: Detection[],
) {
  container.replaceChildren();
  if (!analysis.ellipseReview) return;
  const ref = analysis.ellipseReview.reference,
    summary = document.createElement("p");
  summary.textContent = ref
    ? `基準長径 ${ref.major.toFixed(2)}px / 短径 ${ref.minor.toFixed(2)}px / 面積 ${ref.area.toFixed(1)}px² / ${ref.sampleCount}個から上下各${ref.trimmedEachEnd}個除外、${ref.retainedCount}個使用。長径平均・中央値 ${ref.mean.major.toFixed(2)} / ${ref.median.major.toFixed(2)}（${ref.usedMedian.major ? "中央値" : "平均"}採用）、短径平均・中央値 ${ref.mean.minor.toFixed(2)} / ${ref.median.minor.toFixed(2)}（${ref.usedMedian.minor ? "中央値" : "平均"}採用）`
    : "光学候補から基準楕円を作成できません。サイズ除外を保留しています。";
  const table = document.createElement("table"),
    head = document.createElement("tr");
  for (const label of [
    "番号 / ID",
    "由来",
    "中心 X,Y",
    "長径 / 短径",
    "計測角度° / 表示角度°",
    "面積比",
    "IoU / 被覆率",
    "形状の取得方法",
    "判定 / 除外理由",
  ]) {
    const th = document.createElement("th");
    th.textContent = label;
    head.append(th);
  }
  table.append(head);
  for (const d of measureDetectedObjects(
    ellipseDebugObjects(analysis, detections),
  )) {
    const row = document.createElement("tr"),
      m = d.measurement!,
      a = d.ellipseAssessment,
      index = detections.findIndex(
        (e) =>
          e.id === d.id &&
          e.center.x === d.center.x &&
          e.center.y === d.center.y,
      );
    const isRejected = !detections.some(
      (e) =>
        e.id === d.id && e.center.x === d.center.x && e.center.y === d.center.y,
    );
    const values = [
      index >= 0 ? `${index + 1} / ${d.id}` : d.id,
      d.source,
      `${d.center.x.toFixed(1)}, ${d.center.y.toFixed(1)}`,
      `${m.major.toFixed(1)} / ${m.minor.toFixed(1)}`,
      `${((m.angle * 180) / Math.PI).toFixed(1)} / ${(((d.markerAngle ?? m.angle) * 180) / Math.PI).toFixed(1)}`,
      a?.areaRatio?.toFixed(3) || "—",
      a?.match
        ? `${a.match.iou.toFixed(3)} / ${a.match.coverage.toFixed(3)}`
        : "未計測",
      `${m.method}${d.markerAngleSupport === undefined ? "" : ` / 境界方向支持 ${d.markerAngleSupport.toFixed(1)}`}`,
      `${isRejected ? "除外" : a?.status || "手動追加"}：${[...(a?.reasons || []), ...d.flags].join(" / ")}`,
    ];
    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    }
    table.append(row);
  }
  container.append(summary, table);
}
