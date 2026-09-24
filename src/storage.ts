import type { Analysis, Detection, Settings } from "./types";
export type RecordData = {
  id: string;
  createdAt: string;
  original: Blob;
  filename: string;
  originalWidth: number;
  originalHeight: number;
  analysis: Omit<Analysis, "debug">;
  corrected: Detection[];
  settings: Settings;
  confirmed: boolean;
  schemaVersion: 1;
};
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("pill-counter-local", 1);
    r.onupgradeneeded = () =>
      r.result.createObjectStore("records", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveRecord(record: RecordData) {
  // Binary buffers avoid platform-specific IndexedDB File/Blob serialization failures.
  const { original, ...metadata } = record,
    imageBytes = await original.arrayBuffer(),
    imageType = original.type;
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      const request = tx
        .objectStore("records")
        .put({ ...metadata, imageBytes, imageType });
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          tx.error || request.error || new Error("保存トランザクション失敗"),
        );
      tx.onabort = () =>
        reject(tx.error || request.error || new Error("保存が中止されました"));
    });
  } finally {
    db.close();
  }
}
export async function readRecords(): Promise<RecordData[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction("records").objectStore("records").getAll();
      r.onsuccess = () =>
        resolve(
          r.result.map((record) => {
            const { imageBytes, imageType, ...metadata } = record;
            return {
              ...metadata,
              original:
                record.original || new Blob([imageBytes], { type: imageType }),
            };
          }),
        );
      r.onerror = () => reject(r.error);
    });
  } finally {
    db.close();
  }
}
export async function clearRecords() {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("records", "readwrite");
      tx.objectStore("records").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export const blobDataURL = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
export async function exportRecords() {
  const records = await readRecords();
  if (!records.length) throw new Error("保存済みの検証データがありません");
  const data = await Promise.all(
    records.map(async (r) => ({
      ...r,
      original: await blobDataURL(r.original),
    })),
  );
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          {
            schemaVersion: 1,
            coordinateSpace:
              "EXIF-oriented resized analysis image; see analysis.width/height",
            records: data,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `pill-validation-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return records.length;
}
