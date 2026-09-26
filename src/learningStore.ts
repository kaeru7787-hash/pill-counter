import type { LearningRecord } from "./learning";

export async function learningDB() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("pill-counter-learning", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("records", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("学習データを開けません"));
    r.onblocked = () => reject(new Error("別のタブを閉じて再試行してください"));
  });
}
export async function readLearning(): Promise<LearningRecord[]> {
  const db = await learningDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("records"),
        r = tx.objectStore("records").getAll();
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("学習データを読み出せません"));
    });
  } finally {
    db.close();
  }
}
export async function writeLearning(record: LearningRecord | string) {
  const db = await learningDB();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"),
        store = tx.objectStore("records");
      if (typeof record === "string") store.delete(record);
      else store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("端末の保存容量・設定を確認してください"));
    });
  } finally {
    db.close();
  }
}
export async function imageHash(canvas: HTMLCanvasElement) {
  const bytes = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function pngBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => {
      if (!b) reject(new Error("学習画像を作成できません"));
      else b.arrayBuffer().then(resolve, reject);
    }, "image/png"),
  );
}
export async function learningExport(records: LearningRecord[]) {
  if (!records.length) throw new Error("保存済みの学習データがありません");
  const data = records.map(({ image, ...r }) => {
    let binary = "";
    for (const byte of new Uint8Array(image))
      binary += String.fromCharCode(byte);
    return { ...r, imagePNG: btoa(binary) };
  });
  return new Blob(
    [
      JSON.stringify({
        schemaVersion: 1,
        featureVersion: 1,
        purpose:
          "human-reviewed point labels; boxes are sampling windows, not object boundaries",
        coordinateSpace:
          "oriented analysis canvas pixels; outside ROI and masks are unknown",
        records: data,
      }),
    ],
    { type: "application/json" },
  );
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
