# Eyedrop bottle prototype 2026-09-27

Dedicated one-class (`eyedrop_bottle`) YOLO11n model. Locally fine-tuned from Ultralytics `yolo11n.pt`, 35 epochs, frozen first 10 layers, AdamW lr0=0.002, seed=42, CPU float32. Ultralytics 8.4.163, torch 2.14.0+cpu, torchvision 0.29.0+cpu, ONNX 1.23.0. Input: RGB float32 [1,3,640,640], letterboxed with 114/255; output [1,5,8400]. ONNX opset17, no built-in NMS.

- `eyedrop-bottle.onnx`: browser inference weights, SHA256 `e44003020d6ac9ba31f75b069ee6b520b7d9afebe788c1c20726cb17f5b89a8a`.
- `eyedrop-bottle.pt`: corresponding trainable PyTorch weights. Load only trusted checkpoints.
- `bottle-config.json`: confidence0.45, NMS IoU0.55; whole image + four overlapping views.
- Training sources: red53, green46, blue41; 140 objects across **3 source photographs**, five views per source (15 crops). Square52 source was excluded from training and used for developmental evaluation/model selection.
- Labels: assistant-reviewed provisional visible-body boxes; no user-confirmed per-object ground truth. Lying bottles occur in one training photograph only. Photos are private and not redistributed.
- Known limitation: one missed lying bottle in the blue training photograph. No independent lying-bottle evaluation. Counts in V010.md are hybrid CV+AI, not standalone AI accuracy.

## Training and evaluation

Install pinned training dependencies from `scripts/bottle-training-requirements.txt`. Provide your own consented photographs and reviewed annotations. The development preparation script expects the four source names in `work/originals/` and CV seed detections in `work/v08/`. These private inputs are not bundled; the scripts do not download them. Inspect and correct all generated boxes before using new data.

```
node scripts/prepare-bottle-training.mjs
python scripts/train-bottle-ai.py --epochs 35 --freeze 10 --name prototype
node scripts/run.mjs tests/bottle-ai.test.ts --test
node scripts/evaluate-bottle-ai.mjs prototype
```

The adopted weights were trained with the default five-view preparation, before the optional `--lying-crops` experiment. The additional60-epoch candidate was rejected. Further training can start with `--weights public/models/eyedrop-bottle.pt`; it does not guarantee improvement. The app does not train this detector automatically.

## License and source

Ultralytics YOLO11 pretrained weights and this derived model are AGPL-3.0. Source and training scripts are included in the public repository, with the license in the root `LICENSE`. This release's application code is distributed under AGPL-3.0; third-party dependencies retain their own notices/licenses. Generated comic/art assets are supplied with the application; no rights over the user's private photographs are granted.

Upstream: [Ultralytics YOLO11](https://github.com/ultralytics/ultralytics), [license information](https://www.ultralytics.com/license), [AGPL terms](https://www.ultralytics.com/legal/agpl-3-0-software-license). Existing third-party pill-model provenance is documented separately in README.md in this directory.
