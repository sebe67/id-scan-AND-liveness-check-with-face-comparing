import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { FaceFrame } from "./challenges/types";

// Pinned to a specific version deliberately - MediaPipe's wasm build and .task model
// format have changed across releases, so don't switch to "@latest" without retesting.
const WASM_BASE_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_ASSET_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | undefined;

async function createLandmarker(): Promise<FaceLandmarker> {
  const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  const commonOptions = {
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: "VIDEO" as const,
    numFaces: 1,
  };
  try {
    return await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_ASSET_URL, delegate: "GPU" },
      ...commonOptions,
    });
  } catch (err) {
    // GPU delegate support varies by browser/hardware - fall back to CPU rather than
    // failing the whole app over it.
    console.warn("FaceLandmarker: GPU delegate failed, falling back to CPU.", err);
    return FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_ASSET_URL, delegate: "CPU" },
      ...commonOptions,
    });
  }
}

function getLandmarker(): Promise<FaceLandmarker> {
  landmarkerPromise ??= createLandmarker();
  return landmarkerPromise;
}

/**
 * Decomposes MediaPipe's column-major 4x4 facial transformation matrix into pitch/yaw/roll
 * (degrees). Uses the same YXZ Euler extraction as three.js's Euler.setFromRotationMatrix
 * (a well-tested, widely-used algorithm - not derived from scratch here), rather than a
 * from-memory formula that's harder to be confident in without a camera to test against.
 *
 * Sign conventions (which direction counts as positive yaw/pitch) haven't been verified
 * against a real camera in this environment - use the example app's debug overlay to
 * confirm "turn left" actually produces the sign headTurn.ts expects before trusting it.
 */
function matrixToEulerDeg(m: Float32Array | number[]): { pitchDeg: number; yawDeg: number; rollDeg: number } {
  // m is column-major: m[col*4 + row]. So row0 = [m[0], m[4], m[8]], row1 = [m[1], m[5], m[9]], etc.
  const m13 = m[8];
  const m23 = m[9];
  const m33 = m[10];
  const m11 = m[0];
  const m21 = m[1];
  const m22 = m[5];
  const m31 = m[2];

  const clampedM23 = Math.min(1, Math.max(-1, m23));
  const pitch = Math.asin(-clampedM23);

  let yaw: number;
  let roll: number;
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33);
    roll = Math.atan2(m21, m22);
  } else {
    // Gimbal lock case.
    yaw = Math.atan2(-m31, m11);
    roll = 0;
  }

  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  return { pitchDeg: toDeg(pitch), yawDeg: toDeg(yaw), rollDeg: toDeg(roll) };
}

const EMPTY_FRAME_BASE = { blendshapes: {}, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

export async function detectFace(video: HTMLVideoElement, timestampMs: number): Promise<FaceFrame> {
  const landmarker = await getLandmarker();
  const result = landmarker.detectForVideo(video, timestampMs);

  if (!result.faceBlendshapes?.length || !result.facialTransformationMatrixes?.length) {
    return { faceDetected: false, ...EMPTY_FRAME_BASE, timestampMs };
  }

  const blendshapes: Record<string, number> = {};
  for (const category of result.faceBlendshapes[0].categories) {
    blendshapes[category.categoryName] = category.score;
  }

  const { pitchDeg, yawDeg, rollDeg } = matrixToEulerDeg(result.facialTransformationMatrixes[0].data);

  return { faceDetected: true, blendshapes, yawDeg, pitchDeg, rollDeg, timestampMs };
}
