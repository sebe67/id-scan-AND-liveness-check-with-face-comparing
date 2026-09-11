import { blinkDetector } from "./blink";
import { createTurnLeftDetector, createTurnRightDetector } from "./headTurn";
import { mouthOpenDetector } from "./mouthOpen";
import { smileDetector } from "./smile";
import type { ChallengeDetector } from "./types";

// nodUp/nodDownDetector aren't in the default pool - pitch tends to be noisier than yaw
// with a webcam at typical laptop angles. Available in nod.ts if you want to add them in.

/**
 * @param count How many challenges to include.
 * @param flipHeadTurnDirection Passed straight through to the two head-turn detectors -
 *   see headTurn.ts. Doesn't affect blink/smile/mouth-open at all, those have no
 *   left/right ambiguity to get backwards.
 */
export function pickChallengeSequence(count = 3, flipHeadTurnDirection = false): ChallengeDetector[] {
  const pool: ChallengeDetector[] = [
    blinkDetector,
    createTurnLeftDetector(flipHeadTurnDirection),
    createTurnRightDetector(flipHeadTurnDirection),
    smileDetector,
    mouthOpenDetector,
  ];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}
