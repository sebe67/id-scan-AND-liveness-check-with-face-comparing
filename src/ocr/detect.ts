import * as ort from "onnxruntime-web";
import { canvasRegionToNormalizedTensor, computeDetResizeDims } from "./imageUtils";
import {
  Point,
  convexHull,
  findConnectedComponents,
  minAreaRect,
  orderQuadPoints,
  unclipRect,
} from "./geometry";

export interface DetectedLine {
  corners: [Point, Point, Point, Point]; // [topLeft, topRight, bottomRight, bottomLeft], original image coords
  score: number;
}

export interface DetectOptions {
  limitSideLen?: number;
  probThreshold?: number;
  boxThreshold?: number;
  unclipRatio?: number;
  minSidePx?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  limitSideLen: 960,
  probThreshold: 0.3,
  boxThreshold: 0.6,
  unclipRatio: 1.5,
  minSidePx: 3,
};

/**
 * Runs the deployed DB-based PaddleOCR detection model and post-processes its
 * probability map into text-line boxes, mirroring PaddleOCR's DBPostProcess: binarize
 * -> connected components -> minAreaRect -> score/size filter -> unclip -> rescale to
 * source image. (This DB-postprocessing shape is shared across PaddleOCR det model
 * versions - unlike the rec model, det model version can't be confirmed just from its
 * output shape, so no version claim is made here; see README Status for what has and
 * hasn't been verified.)
 */
export async function detectTextLines(
  session: ort.InferenceSession,
  canvas: HTMLCanvasElement,
  options: DetectOptions = {}
): Promise<DetectedLine[]> {
  const opts = { ...DEFAULTS, ...options };
  const { width: resizeW, height: resizeH } = computeDetResizeDims(canvas.width, canvas.height, opts.limitSideLen);
  const tensor = canvasRegionToNormalizedTensor(canvas, resizeW, resizeH, undefined, undefined, "0-1");

  const inputName = session.inputNames[0];
  const input = new ort.Tensor("float32", tensor.data, [1, 3, resizeH, resizeW]);
  const outputs = await session.run({ [inputName]: input });
  const probMap = outputs[session.outputNames[0]];
  const probData = probMap.data as Float32Array;
  const dims = probMap.dims;
  const probH = dims[dims.length - 2];
  const probW = dims[dims.length - 1];

  const binary = new Uint8Array(probW * probH);
  for (let i = 0; i < binary.length; i++) {
    binary[i] = probData[i] > opts.probThreshold ? 1 : 0;
  }

  const components = findConnectedComponents(binary, probW, probH);
  const scaleX = canvas.width / resizeW;
  const scaleY = canvas.height / resizeH;

  const lines: DetectedLine[] = [];
  for (const comp of components) {
    const hull = convexHull(comp);
    if (hull.length < 3) continue;

    const rect = minAreaRect(hull);
    if (Math.min(rect.width, rect.height) < opts.minSidePx) continue;

    let sum = 0;
    for (const p of comp) sum += probData[p.y * probW + p.x];
    const score = sum / comp.length;
    if (score < opts.boxThreshold) continue;

    const unclipped = unclipRect(rect, opts.unclipRatio);
    const scaledCorners = unclipped.corners.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
    lines.push({ corners: orderQuadPoints(scaledCorners), score });
  }

  // Reading order: top-to-bottom rows, left-to-right within a row.
  lines.sort((a, b) => {
    const ay = (a.corners[0].y + a.corners[1].y) / 2;
    const by = (b.corners[0].y + b.corners[1].y) / 2;
    if (Math.abs(ay - by) > 10) return ay - by;
    return a.corners[0].x - b.corners[0].x;
  });

  return lines;
}
