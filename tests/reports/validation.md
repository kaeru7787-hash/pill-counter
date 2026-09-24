# 検証記録

2026-09-24、Node.js 24 / Windowsで実行。

|検証|結果|
|---|---|
|TypeScript型検査・本番ビルド|成功|
|処理テスト|12件成功|
|合成画像評価|17/17完全一致、MAE 0、MAPE 0、±1精度 100%|
|ブラウザ操作|Chromium 4件・iPhone 13相当WebKit 4件、計8件成功|
|画像サイズ|320pxと1280pxの同じ合成画像で個数一致|
|JPEG EXIF|orientation=6で480×640に補正、個数24を維持|
|ONNX|テスト専用の定数出力モデルでWASM実行とCV照合を両ブラウザで確認|
|PWA|配信サーバーを停止し、両ブラウザで再読み込み・新しい写真の解析に成功|
|サブパス|`/pill-counter/` で画像・Worker・モデル・WASM・SWを読み込み|
|画像の外部送信|UIテスト中、外部HTTPリクエストなし|

ONNXテスト用モデルは実写を認識するモデルではなく、推論の接続を検証するためだけのモデルです。`public/models`には配置していません。

WebKitの`context.setOffline(true)`には、service workerによるナビゲーションも失敗する[既知のエミュレーション問題](https://github.com/microsoft/playwright/issues/42775)があります。本テストではスキップせず、実際にローカル配信サーバーを停止して検証しました。

実機iPhoneのカメラ、HEIC、ホーム画面追加、端末ごとのメモリ、実写の正解付き画像、GitHub上でのActions実行・公開は未検証です。合成セットは開発に使用しているため、未知画像に対する精度を意味しません。

再実行手順はREADMEを参照してください。UIの確認画像は`ui-chromium.png`と`ui-webkit-mobile.png`です。
