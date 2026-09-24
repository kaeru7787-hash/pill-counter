# 精度評価

生成: 2026-09-24T09:40:45.234Z

合成画像による回帰検証です。実写・調剤現場の精度を示しません。

|画像|正解|検出|誤差|絶対誤差率|信頼度|想定原因|
|---|---:|---:|---:|---:|---|---|
|01-white-separated.png|24|24|0|0.00%|medium|None|
|02-yellow-oval.png|15|15|0|0.00%|medium|None|
|03-capsules.png|12|12|0|0.00%|medium|None|
|04-touching-pairs.png|4|4|0|0.00%|review|None|
|05-touching-three.png|3|3|0|0.00%|review|None|
|06-mixed-sizes.png|15|15|0|0.00%|review|None|
|07-scored-tablets.png|15|15|0|0.00%|medium|None|
|08-tray-rim.png|15|15|0|0.00%|medium|None|
|09-bag-artifacts.png|15|15|0|0.00%|review|None|
|10-desk-color.png|15|15|0|0.00%|medium|None|
|11-specks.png|15|15|0|0.00%|medium|None|
|12-shadow.png|15|15|0|0.00%|medium|None|
|13-empty.png|0|0|0|対象外|review|None|
|14-dense-90.png|90|90|0|0.00%|medium|None|
|15-edge-cut.png|2|2|0|0.00%|review|None|
|16-low-contrast.png|15|15|0|0.00%|medium|None|
|17-white-reflection.png|15|15|0|0.00%|review|None|

## 指標

```json
{
  "images": 17,
  "exactCountAccuracy": 1,
  "meanAbsoluteError": 0,
  "meanAbsolutePercentageError": 0,
  "withinOneAccuracy": 1,
  "mapeExcludedZeroTruth": 1
}
```

MAPEは正解0枚を除外。要確認画像も除外せず全件評価します。

## 改善前後

|指標|改善前|現在|
|---|---:|---:|
|exactCountAccuracy|0.35294117647058826|1|
|meanAbsoluteError|8.294117647058824|0|
|withinOneAccuracy|0.4117647058823529|1|

悪化した画像: なし
