import type { ChallengeDetector, FaceFrame } from "./types";

// Starting threshold. Sign confirmed empirically against a real camera (2026-09): the
// video is mirrored for display, but yaw is computed from the unmirrored camera frame,
// so naively "LEFT = negative yaw" comes out backwards - the user has to turn their own
// right to satisfy "turn left". Flipped below to match what a user actually expects -
// on the machine this was tested on. This isn't universal: different camera sources
// (external webcams, Continuity Camera/iPhone-as-webcam, virtual camera software) can
// deliver raw frames with a different orientation, which flips this same math the other
// way on a different device. Rather than guess at a single sign that's right for every
// device, `flip` makes it a runtime-configurable per-deployment setting - see
// makeHeadTurnDetector's caller (sequence.ts) and RunLivenessCheckOptions.flipHeadTurnDirection.
const YAW_THRESHOLD_DEG = 20;

interface HeadTurnState {
  satisfiedOnce: boolean;
}

/**
 * @param direction Which physical direction this challenge asks for.
 * @param flip Set true to invert which physical turn satisfies "left" vs "right" - use
 *   this when a device's raw camera orientation differs from the one this was tuned
 *   against. Only affects head-turn detection; every other challenge type is unaffected.
 */
function makeHeadTurnDetector(direction: "LEFT" | "RIGHT", flip: boolean): ChallengeDetector<HeadTurnState> {
  const baseSign = direction === "LEFT" ? 1 : -1;
  const sign = flip ? -baseSign : baseSign;
  return {
    type: direction === "LEFT" ? "TURN_LEFT" : "TURN_RIGHT",
    instruction: `Turn your head ${direction === "LEFT" ? "left" : "right"}`,
    timeoutMs: 6000,
    createState: () => ({ satisfiedOnce: false }),
    update(frame: FaceFrame, state: HeadTurnState) {
      if (sign * frame.yawDeg > YAW_THRESHOLD_DEG) {
        return { state: { satisfiedOnce: true }, satisfied: true };
      }
      return { state, satisfied: false };
    },
  };
}

export function createTurnLeftDetector(flip: boolean): ChallengeDetector<HeadTurnState> {
  return makeHeadTurnDetector("LEFT", flip);
}

export function createTurnRightDetector(flip: boolean): ChallengeDetector<HeadTurnState> {
  return makeHeadTurnDetector("RIGHT", flip);
}
