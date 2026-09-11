import type { ChallengeDetector, FaceFrame } from "./types";

// Starting thresholds - tune these against what you actually see in the debug overlay
// (example app, "Show debug overlay" checkbox) once you're testing with a real camera.
const CLOSE_THRESHOLD = 0.5;
const OPEN_THRESHOLD = 0.2;

interface BlinkState {
  eyesClosed: boolean;
}

/** A blink = both eyes' blink-blendshape score rising above CLOSE_THRESHOLD, then falling back below OPEN_THRESHOLD. */
export const blinkDetector: ChallengeDetector<BlinkState> = {
  type: "BLINK",
  instruction: "Blink your eyes",
  timeoutMs: 6000,
  createState: () => ({ eyesClosed: false }),
  update(frame: FaceFrame, state: BlinkState) {
    const left = frame.blendshapes.eyeBlinkLeft ?? 0;
    const right = frame.blendshapes.eyeBlinkRight ?? 0;
    const closedScore = Math.min(left, right); // require both eyes, not a wink

    if (!state.eyesClosed && closedScore > CLOSE_THRESHOLD) {
      return { state: { eyesClosed: true }, satisfied: false };
    }
    if (state.eyesClosed && closedScore < OPEN_THRESHOLD) {
      return { state: { eyesClosed: false }, satisfied: true };
    }
    return { state, satisfied: false };
  },
};
