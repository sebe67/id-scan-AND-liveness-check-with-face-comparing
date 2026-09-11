import type { ChallengeDetector, FaceFrame } from "./types";

const SMILE_THRESHOLD = 0.45;

interface SmileState {
  satisfiedOnce: boolean;
}

export const smileDetector: ChallengeDetector<SmileState> = {
  type: "SMILE",
  instruction: "Smile",
  timeoutMs: 6000,
  createState: () => ({ satisfiedOnce: false }),
  update(frame: FaceFrame, state: SmileState) {
    const left = frame.blendshapes.mouthSmileLeft ?? 0;
    const right = frame.blendshapes.mouthSmileRight ?? 0;
    if (Math.min(left, right) > SMILE_THRESHOLD) {
      return { state: { satisfiedOnce: true }, satisfied: true };
    }
    return { state, satisfied: false };
  },
};
