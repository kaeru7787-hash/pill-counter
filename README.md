# 錠数ノート — ブラウザ内錠剤カウンター

スマートフォンの写真から錠剤候補を抽出し、**輪郭と通し番号で計数根拠を確認・訂正**する静的Webアプリです。TypeScript / Vite / OpenCV.js / ONNX Runtime Webを使用し、GitHub Pagesに配置できます。外部API・画像アップロード・APIキー・アクセス解析は使用しません。

**検証版です。実写の正解付きデータ、学習済みAIモデル、iPhone実機での検証は未提供・未実施です。合成画像の成績を調剤現場の精度として扱わないでください。自動結果は必ず番号と数え漏れを確認してください。** 隠れた錠剤・完全重複・透明袋の強い反射などは写真だけでは判定できません。

## 起動

Node.js 24、pnpm 11を使用します。

```sh
corepack enable
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

本番相当の動作（PWAを含む）：

```sh
pnpm build
pnpm preview
```

`file://` からHTMLを直接開かず、HTTPサーバー経由でアクセスしてください。依存関係とWASMはビルド成果物に含まれ、CDNから実行時に取得しません。初回に約11MBのOpenCV.jsを取得します。任意のONNXモデルとORT WASMは利用時に取得します。

## 使い方

1. 「撮影」で背面カメラを起動、または「写真を選択」で既存画像を選びます。
2. 撮影環境を選択します。透明袋では必ず「透明な分包袋」を選んで再解析してください。
3. 検出された全候補に輪郭と番号が付きます。参考検出数は表示中の番号の数です。
4. 「追加」で検出漏れの中心をタップ。「削除」で誤検出をタップ。「元に戻す」で修正を取り消します。青い手動マーカーは位置の記録で、推定輪郭ではありません。
5. 「範囲指定」で矩形をドラッグすると、その範囲を再解析します。複数トレー・複数袋を個別に指定できます。範囲をまたぐ候補は要確認になります。
6. 全番号・未検出箇所を確認し、目視確認チェックを入れます。自動の信頼度は書き換えず、目視確認済みの個数を別の状態として表示します。
7. 必要なら「この結果を端末に保存」。再保存は同じ画像の記録を更新します。

再解析は手動修正をリセットします。修正済みなら画面内で確認します。拡大スライダー、画像内のスクロール、検出一覧からの選択も利用できます。

写真はブラウザ標準デコーダーのEXIF orientation補正後、長辺最大1280pxに縮小します。元ファイルは変更せず保存します。HEICの対応はブラウザに依存し、開けない場合はJPEG/PNGが必要です。小さすぎる錠剤は撮影範囲を狭めて撮り直してください。

## 画像認識アルゴリズム

`src/vision` はDOMに依存せず、アプリとNode評価で同じ処理を実行します。アプリでは専用Workerを使用し、再解析・キャンセル時に終了します。

1. **前処理**：中性色の背景に限定した穏やかなホワイトバランス、Gaussianノイズ除去。色差を壊す強い自動補正は避けます。
2. **背景推定**：周辺サンプルのLab色クラスタから優勢な背景を推定。Lと色差を組み合わせた距離画像にOtsu閾値を適用。弱い色差には適応閾値の局所コントラストも要求します。固定輝度閾値だけでは数えません。
3. **Morphology**：close/openでノイズを抑え、候補ごとのDistance Transform最大値から相対的な厚さを推定。厚さに応じたopenで袋の細い線を除去します。白飛び部分を一律除外すると白錠も失うため、広い白飛びは要確認の理由にします。
4. **輪郭・形状**：CCOMP階層を使い、囲み枠の内側にある錠剤も取得。穴を引いた面積、solidity、円形度、回転矩形の長短軸比、境界接触を調べます。ノイズの面積は画像内の候補面積分布に対する相対値で判断します。
5. **接触分離**：L2 Distance Transformの局所ピークを抑制・統合し、種領域を作ります。距離の尾根がつながるカプセルを重複カウントしないようにし、3錠の合流点にできる偽ピークも抑制。OpenCVのmarker-based Watershedで分割します。OpenCV watershedは画素間の勾配を使うため、距離をそのまま高さとして誤用せず、距離由来の種と二値境界を使用します。
6. **面積異常**：中央値の約2倍以上で形状も不自然な領域はピーク間隔を変えて再解析。結果が変われば要確認にし、面積を割り算して錠数を捏造しません。
7. **3条件照合**：A＝形状を評価した輪郭数、B＝Watershed結果、C＝異なる色差閾値・ピーク間隔での分割数。表示輪郭は原則Bです。AとCの個数が一致してBだけが異なり、B/Cの位置が安定している場合はCの実際の検出集合を選びます。個数を平均せず、BとCは位置も一対一照合します。

CLAHE、楕円フィッティング、YOLOのinstance segmentationは初版では使用していません。非円形対応は輪郭、長短軸比、距離の尾根で実装しています。印字と錠剤の意味的識別は未学習の古典CVだけでは保証できません。

### 信頼度

信頼度は**検出の一致度と警告理由**です。統計的な正解確率ではありません。

|状態|表示|
|---|---|
|CV3条件とAIの個数・位置が一致し、品質警告なし|高|
|CVのみで安定、または解析間の差が1個以内で品質警告なし|中|
|差が2個以上、位置不一致、接触・形状異常、白飛び、境界接触、袋、自動ROI未確認、AI失敗など|要確認|

0候補でも「0錠確定」にはしません。触れ合った錠剤を正しく分離できたケースも、保守的に要確認になる場合があります。CVの3条件には相関があり、一致しても全条件で同じ誤りが起き得ます。AIがない状態では「高」にしません。

### 自動トレー範囲とROI

自動推定は大きな暗い連結領域からトレー内部の矩形を推定する簡易方式です。矩形の黄色い点線を必ず確認してください。トレーと机が同じ暗色、透明トレー、背景物が多い画像には不向きです。初期値はOFFで、手動ROIを優先します。

### デバッグ

「解析表示」をONにして再解析すると、Original / Foreground mask / Threshold / Distance transform / Watershed / Contours / Final detectionsを選べます。ROIの解析画像は元画像と同じ座標に配置します。

## 精度評価・改善

```sh
pnpm test          # 信頼度、位置照合、YOLO decoder、CV、ROIなどのテスト
pnpm evaluate      # 全画像の個数と誤差、4指標、改善前後を出力
pnpm exec playwright install chromium webkit
pnpm build
pnpm test:browser  # Chromium / モバイルWebKit、手動修正・保存・ROI・オフライン
```

`tests/images/` の画像と `tests/ground-truth.json` を管理します。

```json
{"001.png":90,"002.png":191,"003.png":34}
```

評価器はPNG/JPEG/WebPを受け付け、EXIF補正・長辺1280px以下への縮小を行います。Node側のデコードはSharpを利用するため、ブラウザと補間・色管理に僅かな違いが出る可能性があります。`tests/metadata.json` に `kind: "real"`、`scene: "tray" | "desk" | "bag"` と、必要なら誤りの分類を指定できます。実写と合成の指標はJSONの`byKind`にも分離します。正解未登録の画像があれば評価を失敗させます。`pnpm fixtures` は合成画像と正解JSONを再生成する開発用コマンドなので、実写を追加したあとに無造作に実行しないでください。

出力は `tests/reports/latest.json` と `latest.md` です。

- Exact Count Accuracy：完全一致した画像数 / 全画像数（最優先）
- MAE：絶対個数誤差の平均
- MAPE：正解が1以上の画像について絶対誤差 / 正解を平均。正解0枚は除外数を明記
- ±1 Count Accuracy：絶対誤差1以内の画像の割合

「要確認」画像を評価から除外しません。初期の合成画像17枚では、改善前の完全一致6/17、MAE 8.294から、改善後17/17、MAE 0になりました。**これは開発に使った合成画像の回帰成績で、未知の実写での精度ではありません。** 別途、撮影端末・照明・剤形・袋の有無が異なる実写の未使用評価セットが必要です。

`baseline.json` は初期の結果、`accepted.json` は改善後に確認した回帰基準を保持します。評価時に画像ごとの誤差悪化も比較し、acceptedから悪化・画像削除すると失敗します。基準を更新する場合は、差分と輪郭を確認してください。正解個数だけではFalse PositiveとFalse Negativeの相殺を見抜けないため、原因調査には位置アノテーションと輪郭表示を併用してください。合成画像には中心座標を付属しています。現在のエラー分類はメタデータのシナリオを元にした想定分類で、自動的な原因断定ではありません。

改善履歴と残る課題は `tests/reports/improvements.md` を参照してください。

## ローカル保存・学習用書き出し

IndexedDB `pill-counter-local` に、元画像のバイナリ、ファイル名、画像サイズ、解析バージョン、解析ROI・設定、自動検出、手動訂正後の輪郭・位置、目視確認状態を保存します。File/Blobの保存に関するブラウザ差を避けるため、画像はArrayBufferとして保存して読み出し時に復元します。自動保存・自動送信はしません。

「検証データを書き出す」を押すと、元画像をdata URLとして含むJSONをダウンロードします。座標は**EXIF補正後・縮小後の解析画像の画素座標**です。`analysis.width/height` と `originalWidth/originalHeight` を使って変換してください。元ファイルにはEXIFが残るため、学習データ作成側でも同じ向きに揃える必要があります。`group` フィールドを将来の色・剤形グループに利用できます。

ブラウザのデータ消去・ストレージ回収で保存内容が失われる場合があります。端末外に保管する必要がある記録は明示的に書き出してください。書き出しには元画像の袋の印字も含まれます。

## AIモデル追加

初期状態でモデルは付属しません。錠剤向けに学習・実測評価したモデルを次に配置します。

```text
public/models/pill-counter.onnx
public/models/config.json
```

設定例：

```json
{"format":"yolov8-detect","inputSize":640,"classes":1,"scoreThreshold":0.5,"iouThreshold":0.45}
```

現在のアダプターの契約：

- 入力：float32 `[1,3,S,S]`、RGB、0〜1正規化、ROIをアスペクト比維持でletterbox、パディング値114。
- 出力：YOLOv8型のraw検出 `[1,4+classes,N]`、`cx,cy,w,h` は入力サイズ上の画素座標、以降はクラス確率。objectness列なし。
- NMSを行い、letterboxを元座標に戻して、CVとの個数・位置を照合。
- 単一クラスのpill検出を推奨。マルチクラスも総数として扱います。
- WASM、1スレッド。GitHub Pagesのcross-origin isolationは不要です。
- モデルがなくてもCVは動作。取得・ロード・形式エラーは要確認にします。

任意のYOLO ONNXを置くだけで互換になるわけではありません。NMS済み出力・YOLOv5/v10系・segmentationのprototype出力は別アダプターが必要です。`src/ai/onnxDetector.ts` の結果を共通 `Detection[]` に変換すれば追加できます。instance segmentationではモデルのmaskを輪郭に変換する処理を実装してください。モデルの学習・モデルファイルのライセンス・実写による精度校正は含まれません。

## GitHub Pages公開

このディレクトリをリポジトリのルートにします。GitHub上のリポジトリ作成・接続先設定は別途必要です。

1. GitHubにリポジトリを作成し、このプロジェクトを`main`へpush。
2. Settings → Pages → Build and deployment → Sourceを**GitHub Actions**に設定。
3. `.github/workflows/pages.yml` がテスト→精度評価→ビルド→ブラウザテスト→Pages deployを実行。
4. Actionsの`github-pages`環境に表示される公開URLを使用。

Viteの`base`は`./`です。プロジェクトPagesのサブパスとユーザーPagesのルートの両方で、Worker・モデル・アイコン・manifest・service workerが相対解決されます。サブパス `/pill-counter/` でもブラウザテストします。固定ベースが必要ならビルド時に`BASE_PATH=/repository-name/`を指定できます。

公開リポジトリには患者情報・薬袋の印字を含む実写や書き出しデータをコミットしないでください。付属画像はすべて合成です。

## PWA / iPhone

HTTPSのGitHub PagesをSafariで開き、共有メニューから「ホーム画面に追加」できます。manifest、PNGアイコン、service workerを同梱しています。初回のキャッシュ完了後、アプリ本体・CV・サンプルはオフラインで使用できます。AIモデルとORT WASMはオンラインで一度読み込んだ後にキャッシュされます。

更新したservice workerは既存ページが閉じられた後に有効になるため、古い画面をすべて閉じて再度開いてください。開発サーバーではservice workerを登録しません。

ターゲットは現行Safariです。WebKitのiPhone相当エミュレーションは実機そのものではありません。実機でカメラ起動・EXIF各方向・HEIC・大きな写真のメモリ使用・ホーム画面起動・オフライン・長時間使用を確認する必要があります。

## 構成

```text
src/
  main.ts                 # 軽量DOM UI、状態管理
  components/ImageViewer.ts
  image.ts                # 画像デコード・縮小
  storage.ts              # IndexedDB・JSON書き出し
  vision/                 # 前処理、マスク、輪郭、分離、照合、指標
  ai/onnxDetector.ts      # 任意のONNX検出器
  workers/visionWorker.ts
  types/index.ts
public/models/            # 任意モデル
scripts/                  # アセット、評価、合成画像、SW生成
tests/images/             # 合成回帰画像
tests/ground-truth.json
tests/reports/            # 精度・改善記録
.github/workflows/pages.yml
```

主な参考仕様：[OpenCV Watershed](https://docs.opencv.org/4.12.0/d7/d1c/tutorial_js_watershed.html)、[ONNX Runtime Web配布](https://onnxruntime.ai/docs/tutorials/web/deploy.html)、[GitHub Pagesワークフロー](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。
