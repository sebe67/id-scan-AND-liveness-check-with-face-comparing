import type { ChallengeDetector, ChallengeType, FaceFrame } from "./types";

export interface ChallengeResult {
  type: ChallengeType;
  completed: boolean;
  durationMs: number;
}

export interface LivenessResult {
  passed: boolean;
  challenges: ChallengeResult[];
}

export type RunnerEvent =
  | { kind: "challengeStart"; type: ChallengeType; instruction: string }
  | { kind: "challengeComplete"; type: ChallengeType; durationMs: number }
  | { kind: "challengeTimeout"; type: ChallengeType }
  | { kind: "sequenceComplete"; result: LivenessResult }
  | { kind: "sequenceFailed"; result: LivenessResult };

export interface ChallengeRunnerOptions {
  /** How many times a single challenge can time out before the whole sequence fails. */
  maxRetriesPerChallenge?: number;
}

/**
 * Drives a sequence of challenges to completion: starts the first one, feeds it frames via
 * update(), advances on success, retries (up to a limit) or fails the whole sequence on
 * timeout. Doesn't know anything about the camera or MediaPipe - just consumes FaceFrames,
 * so it's the same code whether frames come from a live camera loop or a recorded test clip.
 */
export class ChallengeRunner {
  private index = 0;
  // Each detector's state has its own shape (S), but the runner only ever passes a given
  // detector's state back to that same detector, so treating it as unknown here is safe -
  // see the method-bivariance note in ChallengeDetector.
  private currentState: unknown;
  private challengeStartedAt = 0;
  private results: ChallengeResult[] = [];
  private retriesUsed = 0;
  private done = false;
  private readonly maxRetriesPerChallenge: number;

  constructor(
    private readonly sequence: ChallengeDetector[],
    private readonly onEvent: (event: RunnerEvent) => void,
    options: ChallengeRunnerOptions = {}
  ) {
    this.maxRetriesPerChallenge = options.maxRetriesPerChallenge ?? 2;
  }

  start(nowMs: number): void {
    this.beginChallenge(nowMs);
  }

  /** Feed one frame's worth of face data. Call this from your detection loop once per detected frame. */
  update(frame: FaceFrame, nowMs: number): void {
    if (this.done) return;
    const detector = this.sequence[this.index];
    const elapsed = nowMs - this.challengeStartedAt;

    if (elapsed > detector.timeoutMs) {
      this.onEvent({ kind: "challengeTimeout", type: detector.type });
      this.retriesUsed++;
      if (this.retriesUsed > this.maxRetriesPerChallenge) {
        this.finish(false);
        return;
      }
      this.beginChallenge(nowMs);
      return;
    }

    const { state, satisfied } = detector.update(frame, this.currentState);
    this.currentState = state;

    if (satisfied) {
      this.results.push({ type: detector.type, completed: true, durationMs: elapsed });
      this.onEvent({ kind: "challengeComplete", type: detector.type, durationMs: elapsed });
      this.retriesUsed = 0;
      this.index++;
      if (this.index >= this.sequence.length) {
        this.finish(true);
      } else {
        this.beginChallenge(nowMs);
      }
    }
  }

  private beginChallenge(nowMs: number): void {
    const detector = this.sequence[this.index];
    this.currentState = detector.createState();
    this.challengeStartedAt = nowMs;
    this.onEvent({ kind: "challengeStart", type: detector.type, instruction: detector.instruction });
  }

  private finish(passed: boolean): void {
    this.done = true;
    const result: LivenessResult = { passed, challenges: this.results };
    this.onEvent(passed ? { kind: "sequenceComplete", result } : { kind: "sequenceFailed", result });
  }
}
