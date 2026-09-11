import type { ChallengeDetector, FaceFrame } from "./types";

// Same tuning note as headTurn.ts - confirm sign/threshold against the debug overlay's
// live pitchDeg reading before trusting it.
const PITCH_THRESHOLD_DEG = 15;

interface NodState {
  satisfiedOnce: boolean;
}

function makeNodDetector(direction: "UP" | "DOWN"): ChallengeDetector<NodState> {
  const sign = direction === "DOWN" ? -1 : 1;
  return {
    type: direction === "DOWN" ? "NOD_DOWN" : "NOD_UP",
    instruction: `Nod your head ${direction === "DOWN" ? "down" : "up"}`,
    timeoutMs: 6000,
    createState: () => ({ satisfiedOnce: false }),
    update(frame: FaceFrame, state: NodState) {
      if (sign * frame.pitchDeg > PITCH_THRESHOLD_DEG) {
        return { state: { satisfiedOnce: true }, satisfied: true };
      }
      return { state, satisfied: false };
    },
  };
}

export const nodDownDetector = makeNodDetector("DOWN");
export const nodUpDetector = makeNodDetector("UP");
