export type ChallengeType = "BLINK" | "TURN_LEFT" | "TURN_RIGHT" | "SMILE" | "MOUTH_OPEN" | "NOD_UP" | "NOD_DOWN";

/** One frame's worth of face data, already extracted from MediaPipe's raw output. */
export interface FaceFrame {
  faceDetected: boolean;
  /** categoryName -> score (0-1), from MediaPipe's face blendshapes. Empty if faceDetected is false. */
  blendshapes: Record<string, number>;
  /** Head rotation in degrees, relative to facing the camera straight-on. */
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  timestampMs: number;
}

/**
 * A single challenge's detection logic. `S` is that challenge's own private state shape
 * (e.g. blink needs to track "eyes just closed, waiting for them to reopen").
 * ChallengeRunner treats S as opaque - it just creates it once and passes it back each frame.
 */
export interface ChallengeDetector<S = unknown> {
  type: ChallengeType;
  instruction: string;
  /** How long the user has to satisfy this challenge before it's marked timed-out. */
  timeoutMs: number;
  createState(): S;
  /** Called once per detected-face frame while this challenge is active. */
  update(frame: FaceFrame, state: S): { state: S; satisfied: boolean };
}
