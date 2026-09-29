# 画像制作記録

第1章とマスコットはOpenAI ImageGenで既存ガイドを参照して制作。第2・3章は既存ガイドを継続利用しています。人物は顔のない緑のピクトグラムで、実在人物の肖像ではありません。

## 第1章の更新

Edit this completed Japanese comic, preserve layout, all art, all other Japanese text, white opaque background and dimensions. Only update three places: (1) panel1 mint note replace with 「点眼はボトル全体が写るように。」 (2) panel3 explanation replace ON line with 「ON：画像処理＋対象専用AIで照合」; OFF line remains 「OFF：画像処理だけで解析」; remove obsolete bottom line about no pill AI for bottles and replace with 「錠剤と点眼、それぞれ専用AIで補助します。」 Add one compact short line beneath it 「点眼AIは少数写真で学習した試作です。」 using existing whitespace, do not overcrowd. (3) footer change version v0.9.0 to v0.10.0. Keep green contour and navy AI rectangle legend intact. Green rounded faceless pictogram character, white chest cross, navy outlines unchanged.

## アプリ用マスコット

Create one app mascot illustration matching the green faceless pictogram people in the reference instructional comic. Reference is STYLE only, do not reproduce the comic. Single friendly solid emerald green round-headed pictogram person, blank face, thick rounded limbs, subtle dark navy outline, white plus sign on chest, holding a dark navy tablet with one simple white pill icon while raising the other hand in greeting. Bust/upper body, simple bold silhouette legible at 80px. Centered square image, clean opaque WHITE background, no words, no letters, no speech bubbles, no shadows, no extra panels. Crisp flat public-information pictogram style with small mint accent.



## v0.11.0
01-count.png and 03-save.png edited with the built-in image generator. Section 3 now describes always-on target-specific AI; section 11 describes automatic on-device correction learning and deletion of training images. Other sections are preserved. Both outputs visually inspected.

## v0.15.0
03-save.png edited with built-in ImageGen. Panel 11 now describes saving the corrected result and checking each new photo independently; automatic learning claims were removed. Footer updated to v0.15.0. Output visually inspected.

### v0.15.0 直接ピンチ編集
02-edit.png was edited with built-in ImageGen and visually inspected. Prompt: preserve page 2/3, green medical pictogram mascot and navy/mint palette; replace range controls and separate zoom view with four panels: basic select/add/delete; pinch and pan only in select mode; undo/redo/reset; edit while keeping zoom and position, zoom slider and fit image. Footer: 確認できたら、保存へ and v0.15.0. Remove all learning references.

## v0.16.0 漫画のUI追従

3ページとも既存画像を編集対象としてbuilt-in ImageGenで更新し、出力を目視確認。第1章は基準楕円と水色実線・青実線・橙破線の意味、要確認も個数に含む説明へ変更。第2章は旧ボタン名を「拡大・縮小」へ統一し、そのモードでのみピンチ操作できる説明を維持。第3章は破線と全体の確認、端末に応じた保存操作を説明。全ページの版表記はv0.16.0。マスコット・配色・章構成は保持し、認識や操作のコードは変更していない。

