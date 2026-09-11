import { configureOrtWasmPaths, verifyIdentity, OCR_LIBRARY_VERSION } from "../src/index";
import type { RunnerEvent, FaceBoxDebug } from "../src/index";

document.querySelector<HTMLElement>("#version")!.textContent = `v${OCR_LIBRARY_VERSION}`;

// onnxruntime-web's wasm binaries, served from a CDN for this example so it runs with
// zero extra setup. In your real app, host these yourself instead, same as id-ocr-web's
// own demo - see that project's README setup steps. MediaPipe's WASM (for liveness) and
// face-api's models (for face matching) already default to CDN URLs of their own inside
// src/liveness/faceTracking.ts and src/faceMatch/faceMatcher.ts.
configureOrtWasmPaths("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/");

const frontInput = document.querySelector<HTMLInputElement>("#front")!;
const backInput = document.querySelector<HTMLInputElement>("#back")!;
const video = document.querySelector<HTMLVideoElement>("#video")!;
const instructionEl = document.querySelector<HTMLDivElement>("#instruction")!;
const progressEl = document.querySelector<HTMLDivElement>("#progress")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
const flipToggle = document.querySelector<HTMLInputElement>("#flipToggle")!;
const idFaceCropEl = document.querySelector<HTMLCanvasElement>("#idFaceCrop")!;
const liveFaceCropEl = document.querySelector<HTMLCanvasElement>("#liveFaceCrop")!;
const timingEl = document.querySelector<HTMLDivElement>("#timing")!;
const ocrOutput = document.querySelector<HTMLPreElement>("#ocrOutput")!;
const livenessOutput = document.querySelector<HTMLPreElement>("#livenessOutput")!;
const faceMatchOutput = document.querySelector<HTMLPreElement>("#faceMatchOutput")!;

const CHALLENGE_COUNT = 3;
let completedCount = 0;

function renderProgress(total: number, completed: number): void {
  progressEl.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const span = document.createElement("span");
    span.textContent = String(i + 1);
    if (i < completed) span.classList.add("done");
    progressEl.appendChild(span);
  }
}

function handleEvent(event: RunnerEvent): void {
  switch (event.kind) {
    case "challengeStart":
      instructionEl.textContent = event.instruction;
      break;
    case "challengeComplete":
      completedCount++;
      renderProgress(CHALLENGE_COUNT, completedCount);
      break;
    case "challengeTimeout":
      instructionEl.textContent = `Didn't catch that, try again — ${instructionEl.textContent}`;
      break;
    case "sequenceComplete":
      instructionEl.textContent = "Liveness passed. Comparing faces...";
      renderProgress(CHALLENGE_COUNT, CHALLENGE_COUNT);
      break;
    case "sequenceFailed":
      instructionEl.textContent = "Liveness failed. Comparing faces anyway...";
      break;
  }
}

/** Crops `box` out of a FaceBoxDebug's sourceCanvas and draws it into a small preview canvas. */
function renderFaceCrop(target: HTMLCanvasElement, faceDebug: FaceBoxDebug | undefined): void {
  if (!faceDebug) {
    target.width = 0;
    target.height = 0;
    return;
  }
  const { box, sourceCanvas } = faceDebug;
  target.width = box.width;
  target.height = box.height;
  const ctx = target.getContext("2d")!;
  ctx.drawImage(sourceCanvas, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
}

// sourceCanvas isn't meaningfully JSON-serializable (it's a DOM element, stringifies to
// noise) - it's shown as an actual image via renderFaceCrop above instead, so it's
// stripped out of the pasteable debug text here.
function stripCanvases(key: string, value: unknown): unknown {
  return key === "sourceCanvas" ? undefined : value;
}

startButton.addEventListener("click", async () => {
  const frontFile = frontInput.files?.[0];
  const backFile = backInput.files?.[0];
  if (!frontFile) {
    ocrOutput.textContent = "Pick an ID front image first.";
    return;
  }

  startButton.disabled = true;
  ocrOutput.textContent = "";
  livenessOutput.textContent = "";
  faceMatchOutput.textContent = "";
  timingEl.textContent = "";
  renderFaceCrop(idFaceCropEl, undefined);
  renderFaceCrop(liveFaceCropEl, undefined);
  completedCount = 0;
  renderProgress(CHALLENGE_COUNT, 0);
  instructionEl.textContent = "Running OCR on the ID...";

  try {
    const result = await verifyIdentity(
      frontFile,
      video,
      {
        liveness: { challengeCount: CHALLENGE_COUNT, onEvent: handleEvent, flipHeadTurnDirection: flipToggle.checked },
        onFaceCaptureStatus: (message) => {
          instructionEl.textContent = message;
        },
      },
      backFile
    );

    instructionEl.textContent = result.faceMatch.matched ? "Done — face matched." : "Done — face did not match.";

    ocrOutput.textContent = JSON.stringify(result.idOcr, null, 2);
    livenessOutput.textContent = JSON.stringify(result.liveness, null, 2);
    faceMatchOutput.textContent = JSON.stringify(result.faceMatch, stripCanvases, 2);

    const { debug } = result.faceMatch;
    const { faceCapture } = result;
    timingEl.textContent =
      `model load: ${debug.modelLoadMs.toFixed(0)}ms | ` +
      `ID photo detect: ${debug.idPhotoDetectMs.toFixed(0)}ms | ` +
      `live capture detect: ${debug.liveCaptureDetectMs.toFixed(0)}ms | ` +
      `total: ${debug.totalMs.toFixed(0)}ms\n` +
      `live capture readiness: ${faceCapture.ready ? "centered + neutral" : "NOT ready (timed out waiting)"} ` +
      `(yaw ${faceCapture.yawDeg.toFixed(0)}°, pitch ${faceCapture.pitchDeg.toFixed(0)}°, ` +
      `smile ${faceCapture.smileScore.toFixed(2)}, jaw open ${faceCapture.jawOpenScore.toFixed(2)})`;
    renderFaceCrop(idFaceCropEl, debug.idPhoto);
    renderFaceCrop(liveFaceCropEl, debug.liveCapture);
  } catch (err) {
    instructionEl.textContent = "Error.";
    ocrOutput.textContent = `Error: ${(err as Error).message}`;
    console.error(err);
  } finally {
    startButton.disabled = false;
  }
});
