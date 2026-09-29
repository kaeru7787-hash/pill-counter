export type Point = { x: number; y: number };
export type ROI = { x: number; y: number; width: number; height: number };
export type ObjectMeasurement = {
  major: number;
  minor: number;
  angle: number; // radians, major axis in image coordinates
  area: number;
  method: "contour" | "pixels" | "box";
  contour: Point[]; // measured outline; never replaces the original detection
};
export type ReferenceEllipse = {
  major: number;
  minor: number;
  area: number;
  sampleCount: number;
  retainedCount: number;
  trimmedEachEnd: number;
  mean: { major: number; minor: number };
  median: { major: number; minor: number };
  usedMedian: { major: boolean; minor: boolean };
};
export type EllipseAssessment = {
  status: "normal" | "review" | "exclusion-candidate" | "excluded";
  majorRatio?: number;
  minorRatio?: number;
  areaRatio?: number;
  match?: { iou: number; coverage: number; containment: number };
  reasons: string[];
};
export type Detection = {
  id: string;
  center: Point;
  contour: Point[];
  area: number;
  box: ROI;
  source: "cv" | "ai" | "manual";
  flags: string[];
  group?: string;
  score?: number;
  measurement?: ObjectMeasurement;
  markerAngle?: number; // optional image-edge estimate for the reference marker
  markerAngleSupport?: number;
  ellipseAssessment?: EllipseAssessment;
  shape?: {
    circularity: number;
    solidity: number;
    aspect: number;
    perimeter: number;
  };
};
export type Parameters = {
  threshold?: number;
  blockSize?: number;
  blur?: number;
  morphology?: number;
  minArea?: number;
  maxArea?: number;
  minCircularity?: number;
  minSolidity?: number;
  minimumDistance?: number;
  diameter?: number;
  houghMin?: number;
  houghMax?: number;
  houghSensitivity?: number;
};
export type Settings = {
  target?: "pill" | "bottle";
  scene: "tray" | "desk" | "bag";
  autoROI: boolean;
  debug: boolean;
  useAI?: boolean;
  roi?: ROI;
  parameters?: Parameters;
};
export type Raster = { width: number; height: number; data: Uint8ClampedArray };
export type DebugImage = {
  origin?: Point;
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
  model?: { target: "pill" | "bottle"; url: string; sha256?: string };
  algorithm?: string;
  estimatedDiameter?: number;
  candidates?: Detection[];
  rejectedCandidates?: Detection[];
  ellipseReview?: {
    reference?: ReferenceEllipse;
    optical: Detection[];
    rejected: Detection[];
  };
};
export type WorkerRequest = {
  id: number;
  image: Raster;
  settings: Settings;
  baseURL: string;
};
export type WorkerResponse = { id: number; result?: Analysis; error?: string };
