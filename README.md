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

**Not yet tested against a real camera or real ID/face pairs.** Built by combining two
already-verified pieces (id-ocr-web, tested against real ID photos; liveness-check-web,
tested against a real camera) with a new face-comparison step that hasn't been run for
real yet. Typechecks cleanly (`npm run build`), but the actual match accuracy, the
0.6 distance threshold, and the getUserMedia/camera flow all need real-device testing
before trusting this for anything beyond a demo. See Known Limitations below.

## Quick start

```ts
import { configureOrtWasmPaths, verifyIdentity } from "id-scan-and-liveness-check-with-face-comparing";

configureOrtWasmPaths("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/"); // self-host in production

const frontIdImage = /* a File, Blob, HTMLImageElement, HTMLCanvasElement, or ImageBitmap */;
const video = document.querySelector("video")!; // an empty <video> element in your UI

const result = await verifyIdentity(frontIdImage, video, {
  liveness: { flipHeadTurnDirection: false }, // see liveness-check-web's handoff doc - Section 6
});

console.log(result.idOcr);      // OCR fields, same shape as id-ocr-web's PhIdOcrResult
console.log(result.liveness);   // { passed, challenges: [...] }
console.log(result.faceMatch);  // { matched, distance, idPhotoDetectionScore, liveCaptureDetectionScore } | { matched: false, reason: "NO_FACE_IN_..." }
```

`verifyIdentity` starts the camera, runs the liveness challenges, grabs a face
descriptor from the live feed right after the sequence ends (pass or fail), compares it
against a descriptor from the ID image, then stops the camera. One call, one combined
result. Pass a back-image as the 4th argument if you have one — it's OCR'd too and
merged into `idOcr` the same way id-ocr-web's `mergeIdOcrResults` already worked.

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
(roughly another 5-7MB of model files beyond what the other two already load) and more
surface area for something to go wrong across browsers. If bundle size or load time
becomes a real problem, the alternative considered was an ONNX face-embedding model
(e.g. MobileFaceNet) run through onnxruntime-web instead — reusing the same runtime
id-ocr-web already depends on rather than adding a new one — at the cost of having to
source, verify, and host that model ourselves the way id-ocr-web's team already learned
is real, non-trivial work (see that project's Section 7 on models & hosting).

**The flow, concretely:**
1. `getFaceDescriptor(image)` runs face-api's tiny face detector on whatever it's given
   (a live `<video>` frame or a static image), then a landmark model (for alignment), then
   the recognition net, producing a 128-d descriptor. No pre-cropped face region is
   needed — it finds the face itself, whether that's a live camera frame or the whole ID
   card image (the photo on the card is just wherever the detector finds a face in it).
2. `compareIdPhotoToLiveCapture(idImage, liveFrame)` gets a descriptor from each and
   returns the Euclidean distance between them, plus `matched: distance < threshold`.
3. **Threshold**: defaults to 0.6, which is face-api's own published rule of thumb
   (tuned against the LFW benchmark) — not yet validated against real Philippine ID
   photos, which tend to be lower-resolution, more compressed, and sometimes years older
   than the live capture they'd be compared against. Expect this needs its own tuning
   pass against real ID/face pairs, the same way liveness-check-web's gesture thresholds
   needed a real-camera tuning pass before they were trustworthy.

## Models & hosting

| What | Loaded from | Notes |
|---|---|---|
| PaddleOCR det/rec models | Your own GCS bucket (`src/ocr/config.ts`) | Same as id-ocr-web - see that project's Section 7. |
| onnxruntime-web WASM | jsdelivr in the demo | Self-host in production - id-ocr-web's own lesson. |
| MediaPipe Face Landmarker | Google's CDN/storage (`src/liveness/faceTracking.ts`) | Same as liveness-check-web - no self-hosting needed, this is the normal way to use MediaPipe Tasks. |
| face-api models (detector, landmarks, recognition) | jsdelivr, via the `@vladmandic/face-api` npm package's own model files (`src/faceMatch/faceMatcher.ts`) | Fine for a demo, same caveat as onnxruntime-web's WASM above - self-host for production rather than depending on jsdelivr staying up. |

## Known limitations / open questions

- **Not tested against a real camera or real ID/face pairs yet.** Everything here
  typechecks and is built from two already-working pieces, but the combined flow (and
  especially the face-match threshold) needs real testing before trusting it.
- **The face-match threshold (0.6) is a generic default, not tuned for this use case.**
  See "How face matching works" above.
- **No anti-spoofing**, inherited from liveness-check-web - a photo or video replay could
  pass the liveness step, and a good enough photo could also pass the face-match step
  against the same ID. Fine for a low-risk use case, not a real fraud control as-is.
- **The live face capture happens once, right after the liveness sequence ends** - not
  during a specific "neutral face" moment. If match accuracy turns out too low in
  testing, capturing during a more controlled moment (e.g. a brief "hold still" beat
  added to the challenge sequence) is a reasonable next step.
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
