# id-scan-and-liveness-check-with-face-comparing

Client-side (browser) identity verification: OCR an ID card, run an active liveness
check against the camera, and compare a face descriptor from the ID photo against one
from the live camera feed — all on-device, in one browser session. Combines
[id-ocr-web](../../paddlevstesseractOCR) and
[liveness-check-web](../../liveness-check-web) (unmodified, copied in as `src/ocr/` and
`src/liveness/`) plus a new `src/faceMatch/` step.

**Why one module and not two separate ones talking over a server:** the whole point of
comparing a live face to an ID photo is to verify identity — and a face descriptor (or
the raw images it's computed from) is exactly the kind of sensitive personal data neither
of the two original projects ever sent off-device. Keeping both steps in the same
browser session, in memory, means the descriptors never need to be transmitted or stored
anywhere in between. Only the final result — OCR fields, a liveness pass/fail, and a
face-match distance/boolean — is meant to reach your server.

## Status

First real-device run: OCR and the camera/liveness flow both came up fine. Three real,
specific bugs have been found and fixed since, each via actual testing rather than
guessing:

1. The face-match step reported no match — root-caused via the debug face-crop preview
   (see "Debugging a match result" below): the original detector (TinyFaceDetector,
   chosen for speed) mistook a driver's license's circular security seal for a face and
   compared *that* against the live capture, never looking at the actual printed photo
   at all. Switched to SsdMobilenetv1 (face-api's more accurate detector - see "How face
   matching works") since this only ever runs once per image, not in a real-time loop,
   so there was no real reason to prefer the faster/sloppier one.
2. Separately noticed: since the liveness challenge sequence is randomized and can end on
   a head turn, the live frame grabbed right after it finishes could catch the user
   mid-turn - a profile view face-api can't get a good descriptor from.
3. Confirmed via real testing: a big smile right at the end also failed the match, even
   with the head perfectly centered - the recognition net isn't fully
   expression-invariant. `verifyIdentity` now waits briefly for the user to look both
   centered AND neutral (not smiling, mouth closed) before capturing - see "Why wait for
   a centered, neutral face" below.

**Not yet re-tested against a real ID/face pair with all fixes in place** - each fix is
reasoned from a real, specific failure, not a guess, but none have been confirmed
together against an actual run yet. Typechecks cleanly (`npm run build`) and is built
from two already-verified pieces (id-ocr-web tested against real ID photos;
liveness-check-web tested against a real camera). See Known Limitations below.

## Quick start

```ts
import { configureOrtWasmPaths, verifyIdentity } from "id-scan-and-liveness-check-with-face-comparing";

configureOrtWasmPaths("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/"); // self-host in production

const frontIdImage = /* a File, Blob, HTMLImageElement, HTMLCanvasElement, or ImageBitmap */;
const video = document.querySelector("video")!; // an empty <video> element in your UI

const result = await verifyIdentity(frontIdImage, video, {
  liveness: { flipHeadTurnDirection: false }, // see liveness-check-web's handoff doc - Section 6
});

console.log(result.idOcr);       // OCR fields, same shape as id-ocr-web's PhIdOcrResult
console.log(result.liveness);    // { passed, challenges: [...] }
console.log(result.faceCapture); // { ready, yawDeg, pitchDeg, smileScore, jawOpenScore } - was the live frame centered and neutral?
console.log(result.faceMatch);   // { matched, distance, debug } | { matched: false, reason: "NO_FACE_IN_...", debug }
```

`verifyIdentity` starts the camera, runs the liveness challenges, briefly waits for the
user to be facing the camera again (see "Why wait for a frontal face" below), compares a
descriptor from that frame against one from the ID image, then stops the camera. One
call, one combined result. Pass a back-image as the 4th argument if you have one — it's
OCR'd too and merged into `idOcr` the same way id-ocr-web's `mergeIdOcrResults` already
worked.

`liveness.passed` and `faceMatch.matched` are independent — this library doesn't decide
what counts as "verified" for your app. Combine them however your actual policy needs
(e.g. require both, or treat a face-match miss more leniently than a failed liveness
check).

## Try it locally

```sh
npm install
npm run example
```

Pick an ID front image, click "Start", allow camera access, follow the challenge
prompts. Needs real network access (OCR models, MediaPipe WASM, face-api models are all
loaded from their respective CDNs — see Section on hosting below).

## Repository map

```
src/
  ocr/          id-ocr-web's source, copied in unmodified. See that project's own
                handoff doc for how this half works - fieldExtraction.ts, idTemplates.ts,
                the bug-pattern lessons, etc. all still apply exactly as documented there.
  liveness/     liveness-check-web's source, copied in unmodified. Same note - its
                handoff doc (especially the head-turn-direction section) still applies.
  faceMatch/
    faceMatcher.ts   The new part. loadFaceMatchModels(), getFaceDescriptor(), and
                      compareIdPhotoToLiveCapture() - see "How face matching works" below.
  index.ts       verifyIdentity() - the combined entry point wiring the three pieces
                 together, plus re-exports of everything from all three parts.
example/        Combined demo: file pickers for the ID image(s) + the liveness camera UI.
```

## How face matching works

Uses [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) — a maintained
fork of the original (unmaintained since ~2020) `face-api.js`, running on TensorFlow.js.
Chosen over training/sourcing our own face-embedding ONNX model (the way id-ocr-web's own
models are hosted) because it's a turnkey, well-proven library for exactly this task —
face detection, alignment, and a 128-dimension face descriptor in one package — and this
was the fastest path to a real implementation rather than spending time sourcing and
verifying a raw model file the way id-ocr-web's own README describes having to do for its
OCR models.

**The trade-off worth knowing:** this adds TensorFlow.js as a third ML runtime in the
page, alongside onnxruntime-web (OCR) and MediaPipe's own WASM runtime (liveness
gestures). Three separate WASM-based ML stacks loading on one page is real extra weight
(roughly 12MB of model files beyond what the other two already load - see the detector
note below for why this is bigger than it first looks) and more surface area for
something to go wrong across browsers. If bundle size or load time becomes a real
problem, the alternative considered was an ONNX face-embedding model (e.g. MobileFaceNet)
run through onnxruntime-web instead — reusing the same runtime id-ocr-web already depends
on rather than adding a new one — at the cost of having to source, verify, and host that
model ourselves the way id-ocr-web's team already learned is real, non-trivial work (see
that project's Section 7 on models & hosting).

**The flow, concretely:**
1. `getFaceDescriptor(image)` runs a face detector on whatever it's given (a live
   `<video>` frame or a static image), then a landmark model (for alignment), then the
   recognition net, producing a 128-d descriptor. No pre-cropped face region is needed —
   it finds the face itself, whether that's a live camera frame or the whole ID card image
   (the photo on the card is just wherever the detector finds a face in it).
2. `compareIdPhotoToLiveCapture(idImage, liveFrame)` gets a descriptor from each and
   returns the Euclidean distance between them, plus `matched: distance < threshold`.
3. **Threshold**: defaults to 0.6, which is face-api's own published rule of thumb
   (tuned against the LFW benchmark) — not yet validated against real Philippine ID
   photos, which tend to be lower-resolution, more compressed, and sometimes years older
   than the live capture they'd be compared against. Expect this needs its own tuning
   pass against real ID/face pairs, the same way liveness-check-web's gesture thresholds
   needed a real-camera tuning pass before they were trustworthy.

**Detector choice: SsdMobilenetv1, not TinyFaceDetector.** face-api ships two detectors:
`TinyFaceDetector` (fast, smaller download, less accurate) and `SsdMobilenetv1` (slower,
~5.4MB, more accurate). This started on TinyFaceDetector, and a real test caught it
false-positiving on a driver's license's circular security seal — it detected that as "a
face" with enough confidence that the actual printed photo was never even considered.
Switched to SsdMobilenetv1, since detection here only ever runs once per image rather
than in a real-time loop (unlike liveness's per-frame gesture detection, which does need
to be fast) — there's no real cost to using the more accurate detector for a one-shot
call, only a bigger one-time download.

## Why wait for a centered, neutral face

The liveness challenge sequence is randomized (`src/liveness/challenges/sequence.ts`) and
can end on any of its challenges. Two real, separate bugs came from this:

- Ending on TURN_LEFT/TURN_RIGHT: grabbing the live frame the instant the sequence
  finishes can catch the user mid-turn — a profile view doesn't give face-api's
  recognition net anything close to what it needs. Confirmed via real testing to produce
  a confident-looking but wrong "didn't match".
- Ending on SMILE (or lingering from MOUTH_OPEN): also confirmed via real testing - a big
  smile alone, with the head perfectly centered, was enough to fail the match. The
  recognition net isn't fully expression-invariant, and a strong, asymmetric expression
  measurably pushes the two descriptors apart, especially against a neutral-expression ID
  photo (most ID photos require a neutral expression by policy).

`verifyIdentity` now waits (up to 4 seconds, polling every ~80ms) for the user to look
both centered (yaw/pitch within 15° of straight-on) AND neutral (no real smile, mouth
closed) before grabbing the frame - reusing `liveness/faceTracking.ts`'s own
MediaPipe-based angle and blendshape detection (the same signals `headTurn.ts`,
`smile.ts`, and `mouthOpen.ts` already compute for their own challenges), not a new model
or extra download. Once a frame first looks ready, it waits another 400ms and re-checks
before actually using it, in case that first good-looking frame was just a fluke mid
head-turn/expression transition. `onFaceCaptureStatus` fires once, right when the wait
starts, so the UI can show something like "Look straight at the camera with a neutral
expression..." (the demo wires this to the same instruction text the challenges
themselves use).

This always resolves - if the user never reaches a ready state within the timeout, it
proceeds anyway with whatever the last frame was, rather than blocking the flow
indefinitely. `result.faceCapture` reports `ready`, `yawDeg`/`pitchDeg`, and
`smileScore`/`jawOpenScore` for the frame that was actually used, so a future mismatch
can be checked against all of this first before assuming the match itself is wrong. None
of these numbers (15°, the 0.3/0.2 expression thresholds, the 400ms settle, the 4s
timeout) have been tuned against real users yet - they're reasoned defaults, not
validated ones.

## Debugging a match result

Every `FaceMatchOutcome` (matched or not, even a `NO_FACE_IN_...` failure) carries a
`debug` object meant to be pasted somewhere for troubleshooting:

```ts
{
  modelLoadMs, idPhotoDetectMs, liveCaptureDetectMs, totalMs, // timings, see Performance below
  threshold,                          // the distance cutoff actually used
  idPhoto:      { detectionScore, box } | undefined,  // undefined = no face found in the ID photo
  liveCapture:  { detectionScore, box } | undefined,  // undefined = no face found in the live frame
}
```

(`box` and a `sourceCanvas` are also on each side internally - the demo uses
`sourceCanvas` to draw the "Detected faces" crop preview, but strips it before printing
the JSON since a canvas doesn't stringify to anything useful as text.)

`detectionScore` (0-1, the face detector's own confidence) is the first thing to check on
a surprise no-match: a low score on either side means the detector barely found a face at
all, which makes the resulting descriptor unreliable regardless of the distance number.
The demo (`npm run example`) shows this automatically - after a run, "Detected faces"
displays exactly what the detector cropped out of both the ID photo and the live capture,
which is usually the fastest way to see whether it grabbed the actual face, a logo, part
of the background, or nothing sensible. If a real mismatch needs troubleshooting, the
`faceMatchOutput` block's JSON (which includes the full `debug` object) is meant to be
copied straight out of the demo page and shared.

## Performance

**Why a run can take 10+ seconds, especially the first one:** face-api's three models
(detector, landmarks, recognition) total roughly 12MB with the SsdMobilenetv1 detector
(see "How face matching works" for why that one over the smaller TinyFaceDetector),
downloaded fresh on a cold browser cache, and TensorFlow.js (which
face-api runs on) has its own first-inference warm-up cost in the browser (shader
compilation on WebGL, JIT warm-up generally) that's a known, normal TF.js characteristic
- not specific to anything in this code. Both costs are real and mostly unavoidable, but
they only need to happen once per page load.

**What's already done about it:** `verifyIdentity()` now calls `loadFaceMatchModels()`
immediately, before OCR or the liveness sequence even start, instead of only starting the
download once it's actually needed at the very end. Downloading/initializing overlaps
with OCR and the (several-second) liveness challenge sequence instead of adding to the
end of the flow on top of them. `debug.modelLoadMs` in the result shows directly how much
this helped on a given run - it should read near 0ms if the models had already finished
loading by the time the face-match step needed them.

**What wasn't changed, and why:** the natural next lever would be forcing TensorFlow.js
onto its fastest backend (WebGL) explicitly rather than trusting its own auto-selection.
Checked against the actual installed `@vladmandic/face-api` package before writing
anything here - its public API doesn't expose a `tf` handle or backend control function
(a `tf.setBackend(...)` snippet does appear in its type file, but only inside a leftover
documentation comment copied from TensorFlow.js's own source, not as something this
package actually exports). Writing code against that would have been guessing at
something already checked and found not to exist, so it was left alone. In a real
browser, TF.js's own automatic backend selection typically already picks WebGL when it's
available, so this may not even cost anything in practice - `debug.idPhotoDetectMs` /
`debug.liveCaptureDetectMs` (the actual inference time, separate from model loading) is
the number that would show it if the backend chosen were ever the slow CPU one.

**If it's still slow after this**, paste back a `debug` block from a real run (the
"Face Match Result" section in the demo) - the four timing numbers split out exactly
where the time is going (download+init vs. each detection), which is more useful than
guessing further from here.

## Models & hosting

| What | Loaded from | Notes |
|---|---|---|
| PaddleOCR det/rec models | Your own GCS bucket (`src/ocr/config.ts`) | Same as id-ocr-web - see that project's Section 7. |
| onnxruntime-web WASM | jsdelivr in the demo | Self-host in production - id-ocr-web's own lesson. |
| MediaPipe Face Landmarker | Google's CDN/storage (`src/liveness/faceTracking.ts`) | Same as liveness-check-web - no self-hosting needed, this is the normal way to use MediaPipe Tasks. |
| face-api models (detector, landmarks, recognition) | jsdelivr, via the `@vladmandic/face-api` npm package's own model files (`src/faceMatch/faceMatcher.ts`) | Fine for a demo, same caveat as onnxruntime-web's WASM above - self-host for production rather than depending on jsdelivr staying up. |

## Known limitations / open questions

- **Face-match accuracy still needs a clean real-world confirmation.** Two real bugs have
  already been found and fixed via actual testing (wrong detector picking up the ID
  card's logo instead of the photo; the live frame sometimes caught mid-head-turn or
  mid-smile), but no run has yet gone through with all fixes in place. See Status above
  and "Debugging a match result" for how to investigate a given run instead of guessing.
- **The face-match threshold (0.6) and the capture-readiness wait's angle/expression/
  timing numbers are all generic starting points, not tuned for this use case.** See "How
  face matching works" and "Why wait for a centered, neutral face" above.
- **No anti-spoofing**, inherited from liveness-check-web - a photo or video replay could
  pass the liveness step, and a good enough photo could also pass the face-match step
  against the same ID. Fine for a low-risk use case, not a real fraud control as-is.
- **Bundle size**: three ML runtimes on one page (Section "How face matching works").
  Worth measuring real load time on a target device before shipping.
- **head-turn direction issue from liveness-check-web still applies unchanged** - read
  that project's handoff doc, Section 6, before touching anything under `src/liveness/`.
- **`src/ocr/registration.ts` (copied in unmodified) is NOT wired up to the combined
  result and is not re-exported from `src/index.ts` on purpose.** Its `registerId()` only
  submits `{ id_data: PhIdOcrResult }` - it knows nothing about `liveness` or `faceMatch`.
  Sending a `VerifyIdentityResult` to a real server needs either a new envelope shape
  that includes all three, or a decision that liveness/faceMatch get submitted
  separately. Don't call `registerId()` directly on part of a `VerifyIdentityResult`
  without deciding this first - it would silently submit only the OCR third of it.
