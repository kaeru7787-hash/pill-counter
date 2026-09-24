export function metrics(rows: { truth: number; predicted: number }[]) {
  if (!rows.length) throw new Error("評価画像がありません");
  const valid = rows.filter((r) => r.truth > 0);
  return {
    images: rows.length,
    exactCountAccuracy:
      rows.filter((r) => r.truth === r.predicted).length / rows.length,
    meanAbsoluteError:
      rows.reduce((s, r) => s + Math.abs(r.predicted - r.truth), 0) /
      rows.length,
    meanAbsolutePercentageError: valid.length
      ? valid.reduce(
          (s, r) => s + Math.abs(r.predicted - r.truth) / r.truth,
          0,
        ) / valid.length
      : null,
    withinOneAccuracy:
      rows.filter((r) => Math.abs(r.predicted - r.truth) <= 1).length /
      rows.length,
    mapeExcludedZeroTruth: rows.length - valid.length,
  };
}
