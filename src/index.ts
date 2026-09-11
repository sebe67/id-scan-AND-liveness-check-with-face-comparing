import { toCanvas, type ImageInput } from "./ocr/imageUtils";
import { runIdOcr, mergeIdOcrResults, type RunIdOcrOptions } from "./ocr/index";
import type { PhIdOcrResult } from "./ocr/types";
import { startCamera, stopCamera, runLivenessCheck } from "./liveness/index";
import type { RunLivenessCheckOptions } from "./liveness/index";
import type { LivenessResult } from "./liveness/challenges/challengeRunner";
import { compareIdPhotoToLiveCapture, loadFaceMatchModels, type FaceMatchOutcome } from "./faceMatch/faceMatcher";

export interface VerifyIdentityOptions {
  /** Forwarded to runIdOcr for both the front and (if given) back image. */
  ocr?: RunIdOcrOptions;
  /** Forwarded to runLivenessCheck - challengeCount, flipHeadTurnDirection, onEvent, onFrame, etc. */
  liveness?: RunLivenessCheckOptions;
  faceMatch?: { matchThreshold?: number };
}

export interface VerifyIdentityResult {
  idOcr: PhIdOcrResult;
  liveness: LivenessResult;
  faceMatch: FaceMatchOutcome;
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
 * way checkLiveness() does. The face-match step reads its live frame from `video` right
 * after the liveness sequence finishes (pass or fail) and before the camera stops, so no
 * extra capture step is needed.
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

  await faceModelsReady;
  // video is still live here - grab the face match before stopping the camera.
  const faceMatch = await compareIdPhotoToLiveCapture(frontCanvas, video, options.faceMatch);

  stopCamera(video);

  return { idOcr, liveness, faceMatch };
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
