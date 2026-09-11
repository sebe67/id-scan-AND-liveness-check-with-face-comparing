import { startCamera, stopCamera } from "./camera";
import { ChallengeRunner, type LivenessResult, type RunnerEvent } from "./challenges/challengeRunner";
import { pickChallengeSequence } from "./challenges/sequence";
import type { FaceFrame } from "./challenges/types";
import { detectFace } from "./faceTracking";

export interface RunLivenessCheckOptions {
  /** How many challenges to require. Default 3. */
  challengeCount?: number;
  /** Fires on every state change - challenge start/complete/timeout, sequence pass/fail. */
  onEvent?: (event: RunnerEvent) => void;
  /** Fires on every detected frame, whether or not it advances a challenge - useful for a debug/calibration overlay. */
  onFrame?: (frame: FaceFrame) => void;
  /** Detection throttle. Default 80ms (~12fps) - gesture detection doesn't need more. */
  detectionIntervalMs?: number;
  /**
   * Different camera sources (external webcams, Continuity Camera, virtual camera
   * software) can deliver raw frames with a different orientation, which flips which
   * physical direction satisfies "turn left" vs "turn right" on some devices. Default
   * false matches the device this was originally tuned on; set true to invert it for a
   * device where it's backwards. Only affects the two head-turn challenges - blink,
   * smile, and mouth-open have no left/right ambiguity to get wrong.
   */
  flipHeadTurnDirection?: boolean;
}

export interface LivenessCheckHandle {
  result: Promise<LivenessResult>;
  stop: () => void;
}

/**
 * Runs an active liveness check against a live <video> element already showing the
 * camera feed (see camera.ts's startCamera). Waits for a face to actually be detected
 * before starting the challenge sequence, so the countdown doesn't start while the user
 * is still framing themselves.
 */
export function runLivenessCheck(video: HTMLVideoElement, options: RunLivenessCheckOptions = {}): LivenessCheckHandle {
  const sequence = pickChallengeSequence(options.challengeCount ?? 3, options.flipHeadTurnDirection ?? false);
  const intervalMs = options.detectionIntervalMs ?? 80;

  let stopped = false;
  let started = false;
  let lastDetectAt = 0;
  let rafId = 0;

  let resolveResult!: (result: LivenessResult) => void;
  const result = new Promise<LivenessResult>((resolve) => {
    resolveResult = resolve;
  });

  const runner = new ChallengeRunner(sequence, (event) => {
    options.onEvent?.(event);
    if (event.kind === "sequenceComplete" || event.kind === "sequenceFailed") {
      stopped = true;
      resolveResult(event.result);
    }
  });

  const loop = async (nowMs: number) => {
    if (stopped) return;
    if (nowMs - lastDetectAt >= intervalMs) {
      lastDetectAt = nowMs;
      const frame = await detectFace(video, nowMs);
      options.onFrame?.(frame);
      if (frame.faceDetected) {
        if (!started) {
          started = true;
          runner.start(nowMs);
        }
        runner.update(frame, nowMs);
      }
    }
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);

  return {
    result,
    stop: () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    },
  };
}

export interface CheckLivenessOptions extends RunLivenessCheckOptions {
  /** Stop the camera stream once the check finishes. Default true. */
  stopCameraWhenDone?: boolean;
}

/**
 * The simplest entry point: give it an (unstarted) <video> element, it requests camera
 * access, runs the challenge sequence, and resolves to a plain boolean. Use
 * runLivenessCheck directly instead if you want the per-challenge detail, need to keep
 * the camera running afterward, or want to show a live preview before the check starts.
 */
export async function checkLiveness(video: HTMLVideoElement, options: CheckLivenessOptions = {}): Promise<boolean> {
  await startCamera(video);
  const { result } = runLivenessCheck(video, options);
  const finalResult = await result;
  if (options.stopCameraWhenDone ?? true) {
    stopCamera(video);
  }
  return finalResult.passed;
}

export { startCamera, stopCamera } from "./camera";
export { detectFace } from "./faceTracking";
export { ChallengeRunner } from "./challenges/challengeRunner";
export type { ChallengeResult, LivenessResult, RunnerEvent } from "./challenges/challengeRunner";
export type { ChallengeDetector, ChallengeType, FaceFrame } from "./challenges/types";
