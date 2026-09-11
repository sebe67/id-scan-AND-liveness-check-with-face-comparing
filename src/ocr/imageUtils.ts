export type ImageInput = Blob | HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export async function toCanvas(input: ImageInput): Promise<HTMLCanvasElement> {
  const source: HTMLImageElement | HTMLCanvasElement | ImageBitmap =
    input instanceof Blob ? await createImageBitmap(input) : input;

  const width = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const height = source instanceof HTMLImageElement ? source.naturalHeight : source.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(source as CanvasImageSource, 0, 0);
  return canvas;
}

/** SHA-256 of the canvas's PNG bytes, for document_provenance.image_hash. */
export async function hashCanvas(canvas: HTMLCanvasElement): Promise<string> {
  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob failed"))), "image/png")
  );
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

export interface NormalizedTensor {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Resizes a canvas region to targetWidth x targetHeight and returns a normalized
 * NCHW (channel-first, RGB) Float32Array ready to feed into onnxruntime-web.
 *
 * scaleTo "0-1" applies ImageNet mean/std normalization (used by the detection model).
 * scaleTo "-1-1" applies PaddleOCR's recognition-model normalization: (px/255 - 0.5) / 0.5.
 */
export function canvasRegionToNormalizedTensor(
  canvas: HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
  mean: number[] = IMAGENET_MEAN,
  std: number[] = IMAGENET_STD,
  scaleTo: "0-1" | "-1-1" = "0-1"
): NormalizedTensor {
  const resized = document.createElement("canvas");
  resized.width = targetWidth;
  resized.height = targetHeight;
  const ctx = resized.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  const { data } = ctx.getImageData(0, 0, targetWidth, targetHeight);

  const chw = new Float32Array(3 * targetWidth * targetHeight);
  const plane = targetWidth * targetHeight;
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const px = (y * targetWidth + x) * 4;
      const idx = y * targetWidth + x;
      for (let c = 0; c < 3; c++) {
        const raw = data[px + c] / 255;
        const v = scaleTo === "0-1" ? (raw - mean[c]) / std[c] : (raw - 0.5) / 0.5;
        chw[c * plane + idx] = v;
      }
    }
  }
  return { data: chw, width: targetWidth, height: targetHeight };
}

/**
 * PaddleOCR's DetResizeForTest: scale so the longer side is <= limitSideLen (never
 * upscale beyond the original size otherwise), then round both dimensions to the
 * nearest multiple of 32 (the detection backbone's stride), minimum 32.
 */
export function computeDetResizeDims(
  width: number,
  height: number,
  limitSideLen = 960
): { width: number; height: number } {
  const maxSide = Math.max(width, height);
  const ratio = maxSide > limitSideLen ? limitSideLen / maxSide : 1;

  const resizeH = Math.max(32, Math.round((height * ratio) / 32) * 32);
  const resizeW = Math.max(32, Math.round((width * ratio) / 32) * 32);
  return { width: resizeW, height: resizeH };
}
