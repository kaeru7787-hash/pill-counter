export type Point = { x: number; y: number };
export type ROI = { x: number; y: number; width: number; height: number };
export type Detection = {
  id: string;
  center: Point;
  contour: Point[];
  area: number;
  box: ROI;
  source: "cv" | "ai" | "manual";
  flags: string[];
  group?: string;
};
export type Settings = {
  scene: "tray" | "desk" | "bag";
  autoROI: boolean;
  debug: boolean;
  roi?: ROI;
};
export type Raster = { width: number; height: number; data: Uint8ClampedArray };
export type DebugImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};
export type Confidence = {
  level: "high" | "medium" | "review";
  reasons: string[];
};
export type Analysis = {
  version: string;
  width: number;
  height: number;
  roi: ROI;
  detections: Detection[];
  counts: { A: number; B: number; C: number; AI?: number };
  confidence: Confidence;
  debug: Record<string, DebugImage>;
  diagnostics: string[];
  elapsed: number;
  aiStatus?: string;
};
export type WorkerRequest = {
  id: number;
  image: Raster;
  settings: Settings;
  baseURL: string;
};
export type WorkerResponse = { id: number; result?: Analysis; error?: string };
