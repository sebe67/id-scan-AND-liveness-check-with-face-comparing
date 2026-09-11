import type { ChallengeDetector, FaceFrame } from "./types";

const JAW_OPEN_THRESHOLD = 0.35;

interface MouthOpenState {
  satisfiedOnce: boolean;
}

export const mouthOpenDetector: ChallengeDetector<MouthOpenState> = {
  type: "MOUTH_OPEN",
  instruction: "Open your mouth",
  timeoutMs: 6000,
  createState: () => ({ satisfiedOnce: false }),
  update(frame: FaceFrame, state: MouthOpenState) {
    if ((frame.blendshapes.jawOpen ?? 0) > JAW_OPEN_THRESHOLD) {
      return { state: { satisfiedOnce: true }, satisfied: true };
    }
    return { state, satisfied: false };
  },
};
