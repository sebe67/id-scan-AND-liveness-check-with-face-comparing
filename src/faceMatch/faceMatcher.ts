import * as faceapi from "@vladmandic/face-api";

// jsdelivr serves the model files bundled in the npm package itself - fine for a demo,
// same caveat as this project's other CDN-loaded assets (MediaPipe's WASM, in
// liveness/faceTracking.ts): a real deployment should self-host these rather than depend
// on a third-party CDN staying up. Pinned to match package.json's version - don't bump
// one without the other.
const DEFAULT_MODEL_BASE_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";

// 0.6 Euclidean distance is face-api's own published rule of thumb for "same person",
// tuned against the LFW benchmark - a starting point, not validated yet against real ID
// photos (which are often lower-res, older, and more compressed than a live camera
// frame). Expect this to need tuning once tested against real ID/face pairs, the same
// way liveness/challenges/*.ts's gesture thresholds needed a real-camera tuning pass.
const DEFAULT_MATCH_THRESHOLD = 0.6;

let modelsLoadedPromise: Promise<void> | undefined;

/**
 * Loads the three models this needs: a face detector (SsdMobilenetv1 - see the doc
 * comment on getFaceDescriptor for why this one specifically, not the faster
 * TinyFaceDetector), a landmark model (for alignment before recognition), and the
 * recognition model that produces the 128-d descriptor. Safe to call more than once, and
 * safe to call without awaiting immediately - only loads once, every call (including
 * internal ones from getFaceDescriptor) reuses the same promise. Calling this early (e.g.
 * as soon as your app starts, or at the start of verifyIdentity - see src/index.ts) lets
 * the download/init overlap with whatever else is happening (OCR, the liveness challenge
 * sequence) instead of adding to the end of the flow - see the README's Performance
 * section.
 */
export function loadFaceMatchModels(modelBaseUrl: string = DEFAULT_MODEL_BASE_URL): Promise<void> {
  modelsLoadedPromise ??= (async () => {
    await faceapi.nets.ssdMobilenetv1.loadFromUri(modelBaseUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelBaseUrl);
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelBaseUrl);
  })();
  return modelsLoadedPromise;
}

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceDescriptorResult {
  /** 128-d face embedding from face-api's recognition net. Treat as opaque - only meaningful via euclideanDistance against another descriptor from this same model. */
  descriptor: Float32Array;
  /** The face detector's own confidence for the box this descriptor was computed from. */
  detectionScore: number;
  /** Where on sourceCanvas the detector found the face - in sourceCanvas's own pixel coordinates. */
  box: FaceBox;
  /**
   * A stable snapshot of exactly what was fed to the detector, as a canvas - for an
   * HTMLCanvasElement input this is that same canvas; for a <video> or <img>, it's a
   * freshly drawn copy. Kept around so a caller can crop `box` out of it later for
   * display, even after a live camera stream has since stopped (a <video> element's
   * current frame isn't retrievable after the stream stops, but a canvas snapshot is).
   */
  sourceCanvas: HTMLCanvasElement;
}

function captureToCanvas(input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement): HTMLCanvasElement {
  if (input instanceof HTMLCanvasElement) return input;
  const width = input instanceof HTMLVideoElement ? input.videoWidth : input.naturalWidth;
  const height = input instanceof HTMLVideoElement ? input.videoHeight : input.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(input, 0, 0, width, height);
  return canvas;
}

/**
 * Detects the single most confident face in an image, video frame, or canvas and returns
 * its descriptor. Works the same whether the input is a live <video> frame or a static
 * image (e.g. the whole ID card image) - face-api locates the face itself, no pre-cropped
 * region needed. Returns undefined if no face was found.
 *
 * Uses SsdMobilenetv1 rather than face-api's faster TinyFaceDetector - confirmed via a
 * real test that TinyFaceDetector false-positives on ID card graphics (a driver's
 * license's circular security seal got detected and scored as "a face" over the actual
 * printed photo). SsdMobilenetv1 is the more accurate of face-api's two detectors, at the
 * cost of a bigger model download (see README's Performance section). Worth it here since
 * this only ever runs once per image (not a real-time loop the way liveness's gesture
 * detection is), so there's no speed reason to prefer the less accurate detector.
 */
export async function getFaceDescriptor(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
): Promise<FaceDescriptorResult | undefined> {
  await loadFaceMatchModels();
  const sourceCanvas = captureToCanvas(input);
  const detection = await faceapi
    .detectSingleFace(sourceCanvas, new faceapi.SsdMobilenetv1Options())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return undefined;
  const { x, y, width, height } = detection.detection.box;
  return { descriptor: detection.descriptor, detectionScore: detection.detection.score, box: { x, y, width, height }, sourceCanvas };
}

export interface FaceBoxDebug {
  detectionScore: number;
  box: FaceBox;
  sourceCanvas: HTMLCanvasElement;
}

export interface FaceMatchDebugInfo {
  /** How long loadFaceMatchModels() took to resolve - near 0 if it was already pre-warmed (see loadFaceMatchModels' doc comment). */
  modelLoadMs: number;
  idPhotoDetectMs: number;
  liveCaptureDetectMs: number;
  totalMs: number;
  threshold: number;
  /** Undefined if no face was found in the ID photo. */
  idPhoto?: FaceBoxDebug;
  /** Undefined if no face was found in the live capture. */
  liveCapture?: FaceBoxDebug;
}

export interface FaceMatchResult {
  matched: boolean;
  /** Euclidean distance between the two descriptors - lower means more similar. */
  distance: number;
  debug: FaceMatchDebugInfo;
}

export type FaceMatchOutcome =
  | FaceMatchResult
  | { matched: false; reason: "NO_FACE_IN_ID_PHOTO" | "NO_FACE_IN_LIVE_CAPTURE"; debug: FaceMatchDebugInfo };

/**
 * The main entry point: give it the ID photo (or the whole ID card image - the face
 * detector finds the face itself) and a live camera frame, get back whether they're the
 * same person, plus a `debug` block (timings, detection scores/boxes) meant to be
 * JSON-stringified and shared when something needs diagnosing - see the demo's "Face
 * Match Result" output. Both descriptor extractions and the comparison happen
 * in-browser; nothing about either face - not the images, not the descriptors - needs to
 * leave the device unless the caller explicitly sends the result itself somewhere.
 *
 * Runs the two detections sequentially (not in parallel) specifically so debug.
 * idPhotoDetectMs and debug.liveCaptureDetectMs are each accurate on their own, rather
 * than overlapping and both looking artificially fast/slow together.
 */
export async function compareIdPhotoToLiveCapture(
  idPhotoImage: HTMLImageElement | HTMLCanvasElement,
  liveFrame: HTMLVideoElement | HTMLCanvasElement,
  options: { matchThreshold?: number } = {}
): Promise<FaceMatchOutcome> {
  const threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;
  const totalStart = performance.now();

  const modelLoadStart = performance.now();
  await loadFaceMatchModels();
  const modelLoadMs = performance.now() - modelLoadStart;

  const idStart = performance.now();
  const idFace = await getFaceDescriptor(idPhotoImage);
  const idPhotoDetectMs = performance.now() - idStart;

  const liveStart = performance.now();
  const liveFace = await getFaceDescriptor(liveFrame);
  const liveCaptureDetectMs = performance.now() - liveStart;

  const debug: FaceMatchDebugInfo = {
    modelLoadMs,
    idPhotoDetectMs,
    liveCaptureDetectMs,
    totalMs: performance.now() - totalStart,
    threshold,
    idPhoto: idFace ? { detectionScore: idFace.detectionScore, box: idFace.box, sourceCanvas: idFace.sourceCanvas } : undefined,
    liveCapture: liveFace ? { detectionScore: liveFace.detectionScore, box: liveFace.box, sourceCanvas: liveFace.sourceCanvas } : undefined,
  };

  if (!idFace) return { matched: false, reason: "NO_FACE_IN_ID_PHOTO", debug };
  if (!liveFace) return { matched: false, reason: "NO_FACE_IN_LIVE_CAPTURE", debug };

  const distance = faceapi.euclideanDistance(idFace.descriptor, liveFace.descriptor);
  return { matched: distance < threshold, distance, debug };
}
