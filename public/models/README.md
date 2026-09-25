# 試験用AIモデル

v0.5は利用者の試験用にAIと従来CVを併用します。写真を外部送信せず、端末内のONNX Runtime Web WASMで解析します。

重みは本リポジトリに再配布せず、初回に配布元から取得します。`config.json` に固定リビジョンとSHA-256を指定し、検証したモデルをブラウザ内にキャッシュします。AIが利用できない場合は理由を表示してCVのみで動作します。

- 配布元：[piky/yolo11](https://huggingface.co/piky/yolo11)
- 作者表記：Wijai Thongsom、YOLO11 Pill Detection Model、2026
- ファイル：yolo11n.onnx、5,356,820 bytes
- リビジョン：9ec04d28c48d342906ccaee863a08a6a6394dbc1
- SHA-256：8b28ce48c1b5e16a3d3878cf541783070b413701c62e7e0b879659cdd7496228
- 実モデル内クラス：capsule / damaged-pill / foreign-matter / tablet。foreign-matterは計数から除外。

配布元のモデルカードはMIT表記、重み内メタデータはAGPL-3.0表記で、相違が未解決です。本アプリがモデルの権利や配布条件を保証するものではありません。出典・条件は配布元と[Ultralyticsのライセンス情報](https://www.ultralytics.com/license)を確認してください。

強い反射の36錠写真は35錠で、1錠の見逃しが残ります。AI併用中は常に要確認とし、検出数を確定値にしません。完全に隠れた錠剤は数えられません。

独自モデルを使う場合は設定を差し替えてください。`modelURL`を省略すると同じディレクトリの`pill-counter.onnx`を読みます。外部モデルにはHTTPSとSHA-256が必須です。出力形式などはルートREADMEを参照してください。
