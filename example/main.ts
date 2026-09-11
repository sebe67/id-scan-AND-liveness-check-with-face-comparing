import { configureOrtWasmPaths, verifyIdentity, OCR_LIBRARY_VERSION } from "../src/index";
import type { RunnerEvent } from "../src/index";

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
const output = document.querySelector<HTMLPreElement>("#output")!;

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

startButton.addEventListener("click", async () => {
  const frontFile = frontInput.files?.[0];
  const backFile = backInput.files?.[0];
  if (!frontFile) {
    output.textContent = "Pick an ID front image first.";
    return;
  }

  startButton.disabled = true;
  output.textContent = "";
  completedCount = 0;
  renderProgress(CHALLENGE_COUNT, 0);
  instructionEl.textContent = "Running OCR on the ID...";

  try {
    const result = await verifyIdentity(
      frontFile,
      video,
      {
        liveness: { challengeCount: CHALLENGE_COUNT, onEvent: handleEvent, flipHeadTurnDirection: flipToggle.checked },
      },
      backFile
    );
    instructionEl.textContent = result.faceMatch.matched ? "Done — face matched." : "Done — face did not match.";
    output.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    instructionEl.textContent = "Error.";
    output.textContent = `Error: ${(err as Error).message}`;
    console.error(err);
  } finally {
    startButton.disabled = false;
  }
});
