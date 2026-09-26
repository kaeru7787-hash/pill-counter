import "./style.css";
import { parameterHTML, readParameters } from "./components/Parameters";
import { ImageViewer, type Mode } from "./components/ImageViewer";
import { loadImage } from "./image";
import { saveRecord, exportRecords, clearRecords } from "./storage";
import type {
  Analysis,
  Detection,
  Raster,
  Settings,
  WorkerResponse,
} from "./types";

let aiEnabled = true;
try {
  aiEnabled = localStorage.getItem("pill-ai-enabled") !== "false";
} catch {
  /* Storage may be unavailable. */
}
const developerMode = new URLSearchParams(location.search).get("debug") === "1";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<header><div class="brand"><span class="brand-icon">▰</span><div>錠数ノート<small>PILL COUNTER</small></div></div><span class="local">端末内で解析</span></header>
<main><section class="intro"><div><p class="eyebrow">写真から数える · 目で確かめる</p><h1>錠剤の数を、ひとつずつ。</h1><p>検出した場所を確認し、数え漏れや誤検出を修正できます。</p></div><span class="version">試験版 0.7</span></section>
<section class="upload-panel"><label class="field">数える対象<select id="target"><option value="pill">錠剤</option><option value="bottle">点眼ボトル（試験）</option></select></label><p id="target-guide" class="guide">錠剤はAI併用で解析します。OFFで画像処理のみと比較できます。</p><div class="input-buttons"><label class="button primary" for="camera">撮影<input id="camera" type="file" accept="image/*" capture="environment"></label><label class="button secondary" for="file">写真を選択<input id="file" type="file" accept="image/*"></label></div><p class="guide">真上から撮影してください。影を避け、可能なら錠剤を少し離してください。</p><label class="check"><input id="ai-enabled" type="checkbox" ${aiEnabled ? "checked" : ""}>AI併用</label><p class="privacy">写真は端末内だけで解析します。AI初回は配布元から約5MBのモデルを取得します。</p></section>
<div id="status" class="status" role="status" aria-live="polite">写真を選ぶと解析を開始します。</div><button id="cancel" class="text-button" hidden>解析を中止</button>
<div class="workspace"><section class="viewer-panel"><div class="panel-heading"><h2>検出画像</h2><span id="image-meta">未選択</span></div>
<div id="empty" class="empty"><div class="frame-mark">＋</div><h3>錠剤の写真を読み込む</h3><p>番号と輪郭を重ねて<br>1錠ずつ確認できます。</p><button id="demo" class="text-button">合成サンプルで試す →</button></div>
<div id="canvas-wrap" hidden><canvas id="image-canvas" aria-label="錠剤の検出画像。下の操作モードで追加・削除・範囲指定できます"></canvas></div>
<div class="toolbar" aria-label="画像の操作"><button data-mode="select" aria-pressed="true">選択</button><button data-mode="add" aria-pressed="false">＋ 追加</button><button data-mode="delete" aria-pressed="false">− 削除</button><button data-mode="roi" aria-pressed="false">範囲指定</button><button data-mode="batch" aria-pressed="false">範囲削除</button><button id="undo" disabled>元に戻す</button><button id="redo" disabled>やり直す</button><button id="reset-detections" disabled>補正を全リセット</button></div>
<p id="mode-hint" class="hint">番号をタップすると選択できます。拡大は下のスライダーで調整できます。</p>
<div class="viewer-actions"><label>拡大 <input id="zoom" type="range" min="1" max="3" step=".25" value="1"></label><button id="delete-selected" disabled>選択を削除</button><button id="reset-roi" disabled>範囲を解除</button></div>
<details id="detection-list"><summary>検出一覧（画像を使わず選択・削除）</summary><div id="list"></div></details>
</section>
<aside><section class="result-panel"><p class="eyebrow" id="count-label">自動検出</p><div class="count"><span id="count">—</span><span class="unit">錠</span></div><div class="confidence-row"><span>信頼度</span><strong id="confidence" class="badge neutral">未解析</strong></div><p id="auto-count" class="muted">検出数は番号の数と一致します。</p><p id="ai-status" class="muted">AIをOFFにすると画像処理のみの結果と比較できます。</p><ul id="reasons"></ul><div id="votes" class="votes" ${developerMode ? "" : "hidden"}></div><label class="confirm"><input id="confirmed" type="checkbox" disabled>すべての番号と数え漏れを目視確認した</label><p class="disclaimer">計数の補助ツールです。写真を使って開発・検証中です。調剤の最終確認に自動計数だけを使わないでください。</p></section>
<section class="settings-panel" ${developerMode ? "" : "hidden"}><h2>解析設定</h2><label class="field">撮影環境<select id="scene"><option value="tray">黒い計数トレー</option><option value="desk">机・その他の背景</option><option value="bag">透明な分包袋</option></select></label><label class="check"><input id="auto-roi" type="checkbox" checked>黒いトレーの範囲を自動推定</label><label class="check"><input id="debug" type="checkbox">解析表示</label><div id="debug-controls" hidden><label class="field">表示する画像<select id="layer"><option>Original</option><option>Foreground mask</option><option>ROI</option><option>Grayscale</option><option>Threshold</option><option>Morphology</option><option>Markers</option><option>Distance transform</option><option>Watershed</option><option>Contours</option><option selected>Final detections</option></select></label><p id="diagnostics" class="muted"></p></div>${parameterHTML}<label class="field">解析解像度<select id="resolution"><option value="2048">高精度・長辺2048px（標準）</option><option value="3072">長辺3072px</option><option value="10000">元解像度（上限600万画素）</option></select></label><button id="analyze" class="button secondary full" disabled>この設定で再解析</button></section></aside></div>
<section class="data-panel" ${developerMode ? "" : "hidden"}><div><h2>検証データ</h2><p>元画像・自動検出・訂正後の結果を、このブラウザ内に保存します。</p><small>元画像には袋の印字も含まれます。書き出す前に内容を確認してください。</small></div><div class="data-actions"><button id="save" disabled>この結果を端末に保存</button><button id="export">検証データを書き出す</button><button id="clear" class="text-button">保存データを削除</button></div></section>
<footer>錠数ノート v0.7.0 <span>画像は端末内に。判断は確認できる形に。</span><span id="offline">オフライン準備中</span></footer></main>`;
const $ = <T extends HTMLElement = HTMLElement>(s: string) =>
  document.querySelector<T>(s)!;
const viewer = new ImageViewer($<HTMLCanvasElement>("#image-canvas"));
let image: Raster | undefined,
  original: File | undefined,
  result: Analysis | undefined,
  worker: Worker | undefined;
let revision = 0,
  busy = false,
  history: Detection[][] = [],
  future: Detection[][] = [],
  confirmed = false,
  originalWidth = 0,
  originalHeight = 0,
  recordID = crypto.randomUUID();
let timer: ReturnType<typeof setTimeout> | undefined;
const settings = (): Settings => ({
  target: $<HTMLSelectElement>("#target").value as Settings["target"],
  useAI: $<HTMLInputElement>("#ai-enabled").checked,
  scene: $<HTMLSelectElement>("#scene").value as Settings["scene"],
  autoROI: $<HTMLInputElement>("#auto-roi").checked,
  debug: $<HTMLInputElement>("#debug").checked,
  roi: viewer.roi,
  parameters: readParameters(),
});
let analyzedSettings: Settings | undefined;
function status(message: string, error = false) {
  $("#status").textContent = message;
  $("#status").classList.toggle("error", error);
}
function setBusy(value: boolean) {
  busy = value;
  $<HTMLInputElement>("#ai-enabled").disabled =
    value || $<HTMLSelectElement>("#target").value === "bottle";
  $<HTMLSelectElement>("#target").disabled = value;
  $("#cancel").hidden = !value;
  for (const id of ["analyze", "reset-roi"])
    $<HTMLButtonElement>(`#${id}`).disabled = value || !image;
  $<HTMLButtonElement>("#save").disabled = value || !result;
  $<HTMLButtonElement>("#undo").disabled = value || !history.length;
  $<HTMLButtonElement>("#delete-selected").disabled = value || !viewer.selected;
  $<HTMLInputElement>("#confirmed").disabled = value || !result;
  document
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((b) => (b.disabled = value || !result));
  $("#canvas-wrap").classList.toggle("busy", value);
}
function changed() {
  confirmed = false;
  $<HTMLInputElement>("#confirmed").checked = false;
  viewer.selected = undefined;
  render();
}
function checkpoint() {
  future = [];
  history.push(structuredClone(viewer.detections));
  if (history.length > 40) history.shift();
}
function render() {
  viewer.draw();
  $<HTMLButtonElement>("#undo").disabled = !history.length || busy;
  $<HTMLButtonElement>("#delete-selected").disabled = !viewer.selected || busy;
  if (!result) return;
  $<HTMLButtonElement>("#redo").disabled = !future.length || busy;
  $<HTMLButtonElement>("#reset-detections").disabled = busy;
  const unit = analyzedSettings?.target === "bottle" ? "本" : "錠";
  $(".unit").textContent = unit;
  const edited =
    JSON.stringify(viewer.detections) !== JSON.stringify(result.detections);
  $("#count").textContent = String(viewer.detections.length);
  $("#count-label").textContent = confirmed
    ? "目視確認済みの個数"
    : edited
      ? "手動修正後・未確認"
      : result.confidence.level === "review"
        ? "参考検出数・未確定"
        : "自動検出・未確定";
  $("#auto-count").textContent =
    `自動 ${result.detections.length}${unit} → 現在 ${viewer.detections.length}${unit}（追加 +${viewer.detections.filter((d) => d.source === "manual").length} / 削除 ${result.detections.filter((d) => !viewer.detections.some((e) => e.id === d.id)).length}）・${(result.elapsed / 1000).toFixed(1)}秒`;
  $("#confidence").textContent = {
    high: "高",
    medium: "中",
    review: "低・要確認",
  }[result.confidence.level];
  $("#confidence").className = `badge ${result.confidence.level}`;
  $("#reasons").replaceChildren(
    ...result.confidence.reasons.map((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      return li;
    }),
  );
  $("#votes").textContent =
    `A ${result.counts.A} / B ${result.counts.B} / C ${result.counts.C}${result.counts.AI === undefined ? "" : ` / AI ${result.counts.AI}`}`;
  $("#diagnostics").textContent = [
    result.algorithm || "Lab + 距離変換/Watershed",
    ...result.diagnostics,
  ].join(" · ");
  $("#ai-status").textContent =
    `${result.algorithm || "画像処理"} / ${result.aiStatus || "AI未導入"}`;
  $("#list").replaceChildren(
    ...viewer.detections.map((d, i) => {
      const b = document.createElement("button");
      b.textContent = `${i + 1}${d.source === "manual" ? "（追加）" : ""}`;
      b.setAttribute("aria-pressed", String(d.id === viewer.selected));
      b.onclick = () => {
        viewer.selected = d.id;
        render();
      };
      return b;
    }),
  );
}
function remove(id: string) {
  if (busy) return;
  checkpoint();
  viewer.detections = viewer.detections.filter((d) => d.id !== id);
  changed();
  status("検出を削除しました。「元に戻す」で取り消せます。");
}
viewer.onSelect = () => render();
viewer.onDelete = remove;
viewer.onAdd = (p) => {
  if (busy || !result) return;
  const r = result.roi;
  if (p.x < r.x || p.y < r.y || p.x > r.x + r.width || p.y > r.y + r.height) {
    status("解析範囲の内側をタップしてください。");
    return;
  }
  checkpoint();
  const areas = viewer.detections.map((d) => d.area).sort((a, b) => a - b),
    radius =
      Math.sqrt(
        (areas[Math.floor(areas.length / 2)] ||
          image!.width * image!.height * 0.001) / Math.PI,
      ) * 0.7;
  const contour = Array.from({ length: 24 }, (_, i) => ({
    x: p.x + radius * Math.cos((i * Math.PI) / 12),
    y: p.y + radius * Math.sin((i * Math.PI) / 12),
  }));
  viewer.detections.push({
    id: crypto.randomUUID(),
    center: p,
    contour,
    area: Math.PI * radius * radius,
    box: {
      x: p.x - radius,
      y: p.y - radius,
      width: radius * 2,
      height: radius * 2,
    },
    source: "manual",
    flags: ["人が追加した位置。輪郭は推定ではありません"],
  });
  changed();
  status(
    `1${analyzedSettings?.target === "bottle" ? "本" : "錠"}追加しました。青い輪郭は手動の位置マーカーです。`,
  );
};
viewer.onBatch = (r) => {
  if (busy || !result) return;
  checkpoint();
  viewer.detections = viewer.detections.filter(
    (d) =>
      d.center.x < r.x ||
      d.center.y < r.y ||
      d.center.x > r.x + r.width ||
      d.center.y > r.y + r.height,
  );
  changed();
};
viewer.onROI = () => {
  void run();
};
async function run() {
  if (!image) return;
  if (
    history.length &&
    !window.confirm(
      "再解析すると、この画像の手動修正がリセットされます。続けますか？",
    )
  ) {
    viewer.roi = analyzedSettings?.roi;
    viewer.draw();
    return;
  }
  let runSettings: Settings;
  try {
    runSettings = structuredClone(settings());
  } catch (e) {
    status(String(e), true);
    return;
  }
  worker?.terminate();
  clearTimeout(timer);
  const id = ++revision;
  setBusy(true);
  status(
    runSettings.target === "bottle"
      ? "点眼ボトルのキャップを解析しています…"
      : runSettings.useAI
        ? "画像処理とAIで解析しています…（初回はモデルを取得）"
        : "画像を解析しています…",
  );

  worker = new Worker(new URL("./workers/visionWorker.ts", import.meta.url), {
    type: "module",
  });
  const fail = (message: string) => {
    if (id !== revision) return;
    worker?.terminate();
    clearTimeout(timer);
    if (result && analyzedSettings) {
      $<HTMLSelectElement>("#target").value = analyzedSettings.target || "pill";
      syncTargetUI();
    }
    setBusy(false);
    status(message, true);
  };
  timer = setTimeout(
    () =>
      fail(
        "解析が時間内に完了しませんでした。範囲を小さくするか、画像を撮り直してください。",
      ),
    120000,
  );
  worker.onerror = (e) => fail(`解析できませんでした: ${e.message}`);
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (event.data.id !== revision) return;
    clearTimeout(timer);
    if (event.data.error) {
      fail(event.data.error);
      return;
    }
    result = event.data.result!;
    analyzedSettings = runSettings;
    viewer.analysis = result;
    viewer.detections = structuredClone(result.detections);
    history = [];
    future = [];
    worker?.terminate();
    setBusy(false);
    changed();
    status(
      `解析完了（${(result.elapsed / 1000).toFixed(1)}秒）。すべての番号と数え漏れを確認してください。`,
    );
  };
  worker.postMessage({
    id,
    image,
    settings: runSettings,
    baseURL: new URL(import.meta.env.BASE_URL, location.href).href,
  });
  return true;
}
async function open(file: File) {
  worker?.terminate();
  clearTimeout(timer);
  const loadID = ++revision;
  setBusy(true);
  status("写真を読み込んでいます…");
  try {
    const loaded = await loadImage(
      file,
      Number($<HTMLSelectElement>("#resolution").value),
    );
    if (loadID !== revision) return;
    original = file;
    image = loaded.image;
    originalWidth = loaded.originalWidth;
    originalHeight = loaded.originalHeight;
    recordID = crypto.randomUUID();
    result = undefined;
    history = [];
    future = [];
    confirmed = false;
    analyzedSettings = undefined;
    $<HTMLInputElement>("#confirmed").checked = false;
    viewer.original = loaded.canvas;
    viewer.analysis = undefined;
    viewer.roi = undefined;
    viewer.detections = [];
    viewer.selected = undefined;
    viewer.layer = "Final detections";
    $<HTMLSelectElement>("#layer").value = "Final detections";
    $("#empty").hidden = true;
    $("#canvas-wrap").hidden = false;
    $("#image-meta").textContent = `${image.width} × ${image.height}`;
    $("#count").textContent = "—";
    $("#count-label").textContent = "解析中";
    $("#auto-count").textContent = "";
    $("#list").replaceChildren();
    $("#confidence").textContent = "未解析";
    $("#confidence").className = "badge neutral";
    $("#reasons").replaceChildren();
    $("#votes").textContent = "";
    $<HTMLInputElement>("#zoom").value = "1";
    viewer.canvas.style.width = "100%";
    viewer.draw();
    await run();
  } catch (e) {
    if (loadID !== revision) return;
    setBusy(false);
    status(e instanceof Error ? e.message : String(e), true);
  }
}
for (const id of ["camera", "file"])
  $<HTMLInputElement>(`#${id}`).onchange = (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) void open(f);
    input.value = "";
  };
document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(
  (button) =>
    (button.onclick = () => {
      viewer.mode = button.dataset.mode as Mode;
      document
        .querySelectorAll("[data-mode]")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      viewer.layer = "Final detections";
      $<HTMLSelectElement>("#layer").value = viewer.layer;
      viewer.canvas.style.touchAction =
        viewer.mode === "roi" || viewer.mode === "batch"
          ? "none"
          : "pan-x pan-y";
      $("#mode-hint").textContent = {
        batch: "ドラッグした範囲内の検出を一括削除します。",
        select: "番号をタップして選択します。",
        add: "数え漏れの中心をタップして追加します。",
        delete: "誤検出の番号または輪郭内をタップして削除します。",
        roi: "画像上をドラッグして「この範囲だけ数える」矩形を指定します。",
      }[viewer.mode];
      viewer.draw();
    }),
);
$("#analyze").onclick = () => void run();
$("#cancel").onclick = () => {
  revision++;
  worker?.terminate();
  clearTimeout(timer);
  if (result && analyzedSettings) {
    $<HTMLSelectElement>("#target").value = analyzedSettings.target || "pill";
    syncTargetUI();
    viewer.roi = analyzedSettings.roi;
    viewer.draw();
  }
  setBusy(false);
  status("解析を中止しました。表示中の結果は更新されていません。");
};
$("#undo").onclick = () => {
  const prior = history.pop();
  if (prior) {
    future.push(structuredClone(viewer.detections));
    viewer.detections = prior;
    changed();
  }
};
$("#redo").onclick = () => {
  if (busy) return;
  const next = future.pop();
  if (next) {
    history.push(structuredClone(viewer.detections));
    viewer.detections = next;
    changed();
  }
};
$("#reset-detections").onclick = () => {
  if (busy || !result) return;
  checkpoint();
  viewer.detections = structuredClone(result.detections);
  changed();
};
$("#reset-parameters").onclick = () => {
  document
    .querySelectorAll<HTMLInputElement>("[data-parameter]")
    .forEach((el) => (el.value = ""));
  status("調整値を自動に戻しました。再解析してください。");
};
let selectedResolution = "2048";
$("#resolution").onchange = () => {
  const select = $<HTMLSelectElement>("#resolution");
  if (
    history.length &&
    !window.confirm(
      "解像度を変更すると手動修正がリセットされます。続けますか？",
    )
  ) {
    select.value = selectedResolution;
    return;
  }
  selectedResolution = select.value;
  if (original) void open(original);
};
$("#delete-selected").onclick = () => {
  if (viewer.selected) remove(viewer.selected);
};
$("#reset-roi").onclick = () => {
  viewer.roi = undefined;
  $<HTMLInputElement>("#auto-roi").checked = false;
  void run();
};
$<HTMLInputElement>("#confirmed").onchange = (e) => {
  confirmed = (e.target as HTMLInputElement).checked;
  render();
};
$<HTMLInputElement>("#zoom").oninput = (e) => {
  viewer.canvas.style.width = `${Number((e.target as HTMLInputElement).value) * 100}%`;
  viewer.draw();
};
$<HTMLInputElement>("#debug").onchange = () => {
  $("#debug-controls").hidden = !$<HTMLInputElement>("#debug").checked;
  if (!$<HTMLInputElement>("#debug").checked) {
    viewer.layer = "Final detections";
    viewer.draw();
  } else if (image) void run();
};
$<HTMLSelectElement>("#layer").onchange = (e) => {
  viewer.layer = (e.target as HTMLSelectElement).value;
  viewer.draw();
};
for (const id of ["scene", "auto-roi"])
  $(`#${id}`).onchange = () => {
    status("設定が変わりました。「この設定で再解析」を押してください。");
  };
$("#save").onclick = async () => {
  if (!result || !original || !analyzedSettings) return;
  const { debug: _, ...analysis } = result;
  try {
    await saveRecord({
      id: recordID,
      createdAt: new Date().toISOString(),
      original,
      filename: original.name,
      originalWidth,
      originalHeight,
      analysis,
      corrected: structuredClone(viewer.detections),
      settings: analyzedSettings,
      confirmed,
      schemaVersion: 1,
    });
    status("元画像と結果を、この端末に保存しました。");
  } catch (e) {
    status(
      `保存できません。空き容量やブラウザ設定を確認してください。${String(e)}`,
      true,
    );
  }
};
$("#export").onclick = async () => {
  try {
    const n = await exportRecords();
    status(`${n}件の検証データを書き出しました。`);
  } catch (e) {
    status(String(e), true);
  }
};
$("#clear").onclick = async () => {
  if (window.confirm("このブラウザに保存した検証データをすべて削除しますか？"))
    try {
      await clearRecords();
      status("保存データを削除しました。");
    } catch (e) {
      status(String(e), true);
    }
};
$("#demo").onclick = async () => {
  try {
    const r = await fetch(
      new URL("sample.png", new URL(import.meta.env.BASE_URL, location.href)),
    );
    if (!r.ok) throw new Error("サンプルを取得できません");
    await open(
      new File([await r.blob()], "synthetic-sample.png", { type: "image/png" }),
    );
  } catch (e) {
    status(String(e), true);
  }
};
setBusy(false);
if ("serviceWorker" in navigator && import.meta.env.PROD)
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .then(async () => {
      await navigator.serviceWorker.ready;
      $("#offline").textContent = "オフライン対応";
    })
    .catch(() => {
      $("#offline").textContent = "オフライン準備未完了";
    });
else $("#offline").textContent = "開発モード";
$<HTMLInputElement>("#ai-enabled").onchange = () => {
  try {
    localStorage.setItem(
      "pill-ai-enabled",
      String($<HTMLInputElement>("#ai-enabled").checked),
    );
  } catch {}
  void run();
};

function syncTargetUI() {
  const bottle = $<HTMLSelectElement>("#target").value === "bottle";
  $("#target-guide").textContent = bottle
    ? "色付きキャップ1個を1本として数えます。キャップが見える向きで撮影してください。錠剤用AIは使用しません。"
    : "錠剤はAI併用で解析します。OFFで画像処理のみと比較できます。";
  $("#empty h3").textContent = bottle
    ? "点眼ボトルの写真を読み込む"
    : "錠剤の写真を読み込む";
  $(".unit").textContent = bottle ? "本" : "錠";
  $("#demo").hidden = bottle;
  setBusy(false);
}
$<HTMLSelectElement>("#target").onchange = async () => {
  syncTargetUI();
  viewer.roi = undefined;
  if (image) {
    const started = await run();
    if (
      !started &&
      result &&
      analyzedSettings &&
      analyzedSettings.target !== settings().target
    ) {
      $<HTMLSelectElement>("#target").value = analyzedSettings.target || "pill";
      syncTargetUI();
    }
  }
};
