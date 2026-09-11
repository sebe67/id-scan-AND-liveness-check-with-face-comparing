import { toCanvas, type ImageInput } from "./ocr/imageUtils";
import { runIdOcr, mergeIdOcrResults, type RunIdOcrOptions } from "./ocr/index";
import type { PhIdOcrResult } from "./ocr/types";
import { startCamera, stopCamera, runLivenessCheck, detectFace } from "./liveness/index";
import type { RunLivenessCheckOptions, FaceFrame } from "./liveness/index";
import type { LivenessResult } from "./liveness/challenges/challengeRunner";
import { compareIdPhotoToLiveCapture, loadFaceMatchModels, type FaceMatchOutcome } from "./faceMatch/faceMatcher";

export interface VerifyIdentityOptions {
  /** Forwarded to runIdOcr for both the front and (if given) back image. */
  ocr?: RunIdOcrOptions;
  /** Forwarded to runLivenessCheck - challengeCount, flipHeadTurnDirection, onEvent, onFrame, etc. */
  liveness?: RunLivenessCheckOptions;
  faceMatch?: { matchThreshold?: number };
  /**
   * Fired once, right after the liveness sequence ends, while this function waits
   * (briefly) for the user to look centered and neutral again before grabbing the frame
   * used for face matching - see waitForCaptureReadyFace below. There's no equivalent
   * event from liveness.onEvent, since this happens after the challenge sequence itself
   * is done.
   */
  onFaceCaptureStatus?: (message: string) => void;
}

export interface FaceCaptureReadiness {
  /** False only if the wait timed out - the caller still gets whatever the last frame looked like, below. */
  ready: boolean;
  yawDeg: number;
  pitchDeg: number;
  /** max(mouthSmileLeft, mouthSmileRight) - how much of a smile was on the captured frame. */
  smileScore: number;
  /** jawOpen - how open the mouth was on the captured frame. */
  jawOpenScore: number;
}

export interface VerifyIdentityResult {
  idOcr: PhIdOcrResult;
  liveness: LivenessResult;
  /** What the frame used for face matching actually looked like when it was grabbed - see waitForCaptureReadyFace. */
  faceCapture: FaceCaptureReadiness;
  faceMatch: FaceMatchOutcome;
}

// If the liveness sequence happens to end on a TURN_LEFT/TURN_RIGHT challenge, the frame
// grabbed right after it finishes can be a profile view, which face-api can't produce a
// good descriptor from - confirmed via real testing to cause a false "didn't match".
// A real test also caught the same problem from a big smile still lingering right after
// a SMILE challenge: the recognition net isn't fully expression-invariant, and a strong,
// asymmetric expression (smiling hard vs. a neutral ID photo) measurably pushes the two
// descriptors apart. MOUTH_OPEN can distort the same way for the same reason. So this
// waits for pose AND expression to both look neutral, not just pose.
const FACE_CAPTURE_CENTER_THRESHOLD_DEG = 15;
// These sit below each challenge's own "triggered" threshold (see smile.ts/mouthOpen.ts:
// SMILE fires above 0.45, MOUTH_OPEN above 0.35) with a small margin, rather than being
// the exact inverse - the same hysteresis-gap idea blink.ts already uses for its own
// close/open thresholds, so a score sitting right at the boundary doesn't flicker.
const FACE_CAPTURE_SMILE_NEUTRAL_THRESHOLD = 0.3;
const FACE_CAPTURE_JAW_OPEN_NEUTRAL_THRESHOLD = 0.2;
const FACE_CAPTURE_WAIT_TIMEOUT_MS = 4000;
const FACE_CAPTURE_POLL_INTERVAL_MS = 80; // matches liveness's own default detection interval
// Once a frame first looks centered and neutral, wait this long and re-check before
// actually capturing - a single good-looking frame can be a fluke (mid-transition
// between expressions, motion blur), and this costs very little given the wait is
// already happening.
const FACE_CAPTURE_SETTLE_MS = 400;

function isCaptureReady(frame: FaceFrame): boolean {
  const smile = Math.max(frame.blendshapes.mouthSmileLeft ?? 0, frame.blendshapes.mouthSmileRight ?? 0);
  const jawOpen = frame.blendshapes.jawOpen ?? 0;
  return (
    frame.faceDetected &&
    Math.abs(frame.yawDeg) < FACE_CAPTURE_CENTER_THRESHOLD_DEG &&
    Math.abs(frame.pitchDeg) < FACE_CAPTURE_CENTER_THRESHOLD_DEG &&
    smile < FACE_CAPTURE_SMILE_NEUTRAL_THRESHOLD &&
    jawOpen < FACE_CAPTURE_JAW_OPEN_NEUTRAL_THRESHOLD
  );
}

function toFaceCaptureReadiness(ready: boolean, frame: FaceFrame | undefined): FaceCaptureReadiness {
  return {
    ready,
    yawDeg: frame?.yawDeg ?? 0,
    pitchDeg: frame?.pitchDeg ?? 0,
    smileScore: Math.max(frame?.blendshapes.mouthSmileLeft ?? 0, frame?.blendshapes.mouthSmileRight ?? 0),
    jawOpenScore: frame?.blendshapes.jawOpen ?? 0,
  };
}

/**
 * Polls the live video (reusing liveness's own MediaPipe-based yaw/pitch/blendshape
 * detection - no new model, no extra download) until the user looks centered AND
 * neutral (not smiling, mouth closed), or the timeout elapses. Once a frame first looks
 * ready, waits FACE_CAPTURE_SETTLE_MS and re-checks before accepting it, to avoid
 * capturing a fluke single frame mid-transition. Always resolves - on timeout, `ready`
 * is false and the caller gets whatever the last frame looked like, so the flow never
 * hard-blocks on this.
 */
async function waitForCaptureReadyFace(
  video: HTMLVideoElement,
  onStatus?: (message: string) => void
): Promise<FaceCaptureReadiness> {
  onStatus?.("Look straight at the camera with a neutral expression...");
  const deadline = performance.now() + FACE_CAPTURE_WAIT_TIMEOUT_MS;
  let last: FaceFrame | undefined;

  while (performance.now() < deadline) {
    const frame = await detectFace(video, performance.now());
    last = frame;

    if (isCaptureReady(frame)) {
      await new Promise((resolve) => setTimeout(resolve, FACE_CAPTURE_SETTLE_MS));
      const settledFrame = await detectFace(video, performance.now());
      last = settledFrame;
      if (isCaptureReady(settledFrame)) {
        return toFaceCaptureReadiness(true, settledFrame);
      }
      // fell out of centered/neutral again during the settle wait - keep polling below.
    }

    await new Promise((resolve) => setTimeout(resolve, FACE_CAPTURE_POLL_INTERVAL_MS));
  }
  return toFaceCaptureReadiness(false, last);
}

/**
 * The combined flow: OCR the ID (front, optionally back), run the liveness challenge
 * sequence against the live camera, and compare a face descriptor from the ID photo
 * against one from the live feed - all in one browser session, all in memory. Nothing
 * about either face (image or descriptor) needs to leave the device; only the returned
 * VerifyIdentityResult - OCR fields, a pass/fail liveness result, and a match
 * distance/boolean - is meant to go to your server, per this team's on-device design
 * principle (see the id-ocr-web and liveness-check-web handoff docs).
 *
 * `video` must already have a live camera stream started, OR be an empty <video> element
 * - this function calls startCamera/stopCamera around the liveness check itself, the same
 * way checkLiveness() does. After the liveness sequence finishes (pass or fail), it briefly
 * waits for the user to look centered and neutral (not turned, not smiling, mouth closed)
 * before grabbing the frame for face matching (see waitForCaptureReadyFace) - the
 * sequence's last challenge can be a head turn or an expression one, and face-api can't
 * produce a good descriptor from a profile view or mid-grin.
 *
 * Liveness passing/failing and the face match succeeding/failing are independent signals
 * - this function doesn't decide what "verified" means for your app. Check both fields of
 * the result and combine them however your actual policy requires (e.g. require both to
 * pass, or treat a face-match failure as a softer signal than a liveness failure).
 */
export async function verifyIdentity(
  idFrontImage: ImageInput,
  video: HTMLVideoElement,
  options: VerifyIdentityOptions = {},
  idBackImage?: ImageInput
): Promise<VerifyIdentityResult> {
  // Kick off face-api's model download/init now, in parallel with the OCR and liveness
  // steps below, instead of only starting it once we actually need it (which would add
  // model load time - a few seconds on a cold cache - onto the very end of the flow,
  // right when the user is waiting for a final result). By the time we get to
  // compareIdPhotoToLiveCapture, this is usually already done; debug.modelLoadMs in the
  // result shows how much it actually helped on a given run.
  const faceModelsReady = loadFaceMatchModels();

  const frontCanvas = await toCanvas(idFrontImage);
  const ocrResults = [await runIdOcr(frontCanvas, "FRONT", options.ocr)];
  if (idBackImage) {
    const backCanvas = await toCanvas(idBackImage);
    ocrResults.push(await runIdOcr(backCanvas, "BACK", options.ocr));
  }
  const idOcr = mergeIdOcrResults(ocrResults);

  await startCamera(video);
  const { result } = runLivenessCheck(video, options.liveness);
  const liveness = await result;

  const faceCapture = await waitForCaptureReadyFace(video, options.onFaceCaptureStatus);

  await faceModelsReady;
  // video is still live here - grab the face match before stopping the camera.
  const faceMatch = await compareIdPhotoToLiveCapture(frontCanvas, video, options.faceMatch);

  stopCamera(video);

  return { idOcr, liveness, faceCapture, faceMatch };
}

export { configureOrtWasmPaths, defaultModelConfig } from "./ocr/index";
export { ID_TEMPLATES } from "./ocr/idTemplates";
export type { CommonFields, DocumentProvenanceEntry, IdType, OcrField, PhIdOcrResult, VariantFields } from "./ocr/types";
export { LIBRARY_VERSION as OCR_LIBRARY_VERSION } from "./ocr/version";

export { checkLiveness, startCamera, stopCamera, runLivenessCheck } from "./liveness/index";
export type { CheckLivenessOptions, RunLivenessCheckOptions, LivenessCheckHandle } from "./liveness/index";
export type { ChallengeResult, LivenessResult, RunnerEvent } from "./liveness/challenges/challengeRunner";

export { loadFaceMatchModels, getFaceDescriptor, compareIdPhotoToLiveCapture } from "./faceMatch/faceMatcher";
export type { FaceBox, FaceBoxDebug, FaceDescriptorResult, FaceMatchDebugInfo, FaceMatchResult, FaceMatchOutcome } from "./faceMatch/faceMatcher";
