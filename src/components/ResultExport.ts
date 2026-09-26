import type { ImageViewer } from "./ImageViewer";

type SavePicker = (options: {
  suggestedName: string;
  startIn: "pictures";
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{
  createWritable(): Promise<{
    write(blob: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}>;

export function resultFilename(count: number, date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}_${count}.png`;
}

/** Encode before the click so iOS file sharing retains user activation. */
export class ResultExport {
  private generation = 0;
  private prepared?: { blob: Blob; count: number };
  private busy = false;
  private saving = false;
  private key = "";
  private original?: HTMLCanvasElement;
  constructor(
    private viewer: ImageViewer,
    private button: HTMLButtonElement,
    private fallback: HTMLButtonElement,
    private message: HTMLElement,
  ) {
    button.onclick = () => void this.save();
    fallback.onclick = () => {
      if (!this.prepared || this.busy || this.saving) return;
      this.download(this.file());
    };
  }
  setBusy(value: boolean) {
    this.busy = value;
    this.sync();
  }
  private sync() {
    this.button.disabled = this.fallback.disabled =
      this.busy || this.saving || !this.prepared;
  }
  update(unit: "錠" | "本") {
    const key = JSON.stringify([unit, this.viewer.detections]);
    if (this.original === this.viewer.original && this.key === key) return;
    this.original = this.viewer.original;
    this.key = key;
    const generation = ++this.generation;
    this.prepared = undefined;
    this.fallback.hidden = true;
    this.message.textContent = "画像を準備しています…";
    this.sync();
    const canvas = document.createElement("canvas");
    this.viewer.draw(canvas, true);
    const count = this.viewer.detections.length;
    const ctx = canvas.getContext("2d")!;
    const short = Math.min(canvas.width, canvas.height);
    const font = Math.max(16, Math.round(short * 0.045));
    const margin = Math.max(8, Math.round(short * 0.018));
    const padding = Math.round(font * 0.45);
    ctx.font = `bold ${font}px system-ui, sans-serif`;
    const label = `${count} ${unit}`;
    const width = Math.ceil(ctx.measureText(label).width) + padding * 2;
    const height = font + padding * 2;
    const x = canvas.width - margin - width,
      y = canvas.height - margin - height;
    ctx.fillStyle = "#102b3b";
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = Math.max(1, short / 800);
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + width / 2, y + height / 2);
    canvas.toBlob((blob) => {
      canvas.width = canvas.height = 1;
      if (generation !== this.generation) return;
      if (blob) {
        this.prepared = { blob, count };
        this.message.textContent =
          "現在の番号・編集結果と右下の個数をPNG画像に保存します。";
      } else
        this.message.textContent =
          "画像を作成できませんでした。もう一度解析してください。";
      this.sync();
    }, "image/png");
  }
  private file() {
    return new File(
      [this.prepared!.blob],
      resultFilename(this.prepared!.count),
      { type: "image/png" },
    );
  }
  private download(file: File) {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    this.message.textContent = `${file.name} をダウンロードします。保存先はブラウザーの設定に従います。必要に応じて画像フォルダーへ移動してください。`;
  }
  private async save() {
    if (!this.prepared || this.busy || this.saving) return;
    const file = this.file();
    const picker = (window as Window & { showSaveFilePicker?: SavePicker })
      .showSaveFilePicker;
    this.saving = true;
    this.sync();
    try {
      if (picker) {
        const handle = await picker.call(window, {
          suggestedName: file.name,
          startIn: "pictures",
          types: [
            { description: "PNG画像", accept: { "image/png": [".png"] } },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(file);
        await writable.close();
        this.message.textContent = `${file.name} を選択したフォルダーに保存しました。`;
      } else if (navigator.canShare?.({ files: [file] }) && navigator.share) {
        await navigator.share({ files: [file] });
        this.message.textContent =
          "共有画面を閉じました。写真アプリに画像が保存されたことを確認してください。";
      } else this.download(file);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        this.message.textContent =
          "保存を中止しました。編集結果はそのままです。";
      else {
        this.message.textContent =
          "保存画面を開けませんでした。「ファイルとして保存」も利用できます。";
        this.fallback.hidden = false;
      }
    } finally {
      this.saving = false;
      this.sync();
    }
  }
}
