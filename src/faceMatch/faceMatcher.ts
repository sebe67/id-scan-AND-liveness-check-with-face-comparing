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
 * Loads the three models this needs: a face detector, a landmark model (for alignment
 * before recognition), and the recognition model that produces the 128-d descriptor.
 * Call once at app startup, before getFaceDescriptor. Safe to call more than once - only
 * loads once, subsequent calls reuse the same promise.
 */
export function loadFaceMatchModels(modelBaseUrl: string = DEFAULT_MODEL_BASE_URL): Promise<void> {
  modelsLoadedPromise ??= (async () => {
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelBaseUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelBaseUrl);
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelBaseUrl);
  })();
  return modelsLoadedPromise;
}

export interface FaceDescriptorResult {
  /** 128-d face embedding from face-api's recognition net. Treat as opaque - only meaningful via euclideanDistance against another descriptor from this same model. */
  descriptor: Float32Array;
  /** The face detector's own confidence for the box this descriptor was computed from. */
  detectionScore: number;
}

/**
 * Detects the single largest/most confident face in an image, video frame, or canvas and
 * returns its descriptor. Works the same whether the input is a live <video> frame or a
 * static image (e.g. the whole ID card image) - face-api locates the face itself, no
 * pre-cropped region needed. Returns undefined if no face was found.
 */
export async function getFaceDescriptor(
  input: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement
): Promise<FaceDescriptorResult | undefined> {
  await loadFaceMatchModels();
  const detection = await faceapi
    .detectSingleFace(input, new faceapi.TinyFaceDetectorOptions())
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return undefined;
  return { descriptor: detection.descriptor, detectionScore: detection.detection.score };
}

export interface FaceMatchResult {
  matched: boolean;
  /** Euclidean distance between the two descriptors - lower means more similar. */
  distance: number;
  idPhotoDetectionScore: number;
  liveCaptureDetectionScore: number;
}

export type FaceMatchOutcome =
  | FaceMatchResult
  | { matched: false; reason: "NO_FACE_IN_ID_PHOTO" | "NO_FACE_IN_LIVE_CAPTURE" };

/**
 * The main entry point: give it the ID photo (or the whole ID card image - the face
 * detector finds the face itself) and a live camera frame, get back whether they're the
 * same person. Both descriptor extractions and the comparison happen in-browser; nothing
 * about either face - not the images, not the descriptors - needs to leave the device
 * unless the caller explicitly sends the FaceMatchResult itself somewhere.
 */
export async function compareIdPhotoToLiveCapture(
  idPhotoImage: HTMLImageElement | HTMLCanvasElement,
  liveFrame: HTMLVideoElement | HTMLCanvasElement,
  options: { matchThreshold?: number } = {}
): Promise<FaceMatchOutcome> {
  const threshold = options.matchThreshold ?? DEFAULT_MATCH_THRESHOLD;

  const [idFace, liveFace] = await Promise.all([getFaceDescriptor(idPhotoImage), getFaceDescriptor(liveFrame)]);

  if (!idFace) return { matched: false, reason: "NO_FACE_IN_ID_PHOTO" };
  if (!liveFace) return { matched: false, reason: "NO_FACE_IN_LIVE_CAPTURE" };

  const distance = faceapi.euclideanDistance(idFace.descriptor, liveFace.descriptor);
  return {
    matched: distance < threshold,
    distance,
    idPhotoDetectionScore: idFace.detectionScore,
    liveCaptureDetectionScore: liveFace.detectionScore,
  };
}
