import * as ort from "onnxruntime-web";
import { canvasRegionToNormalizedTensor } from "./imageUtils";

export interface RecCharset {
  /** Index 0 is the reserved CTC blank; the rest mirrors the loaded dictionary file plus a trailing space. */
  chars: string[];
}

/** PaddleOCR's CTCLabelDecode charset: ['blank', ...dict lines, ' ']. */
export function buildCharset(keysFileText: string): RecCharset {
  const lines = keysFileText.split(/\r?\n/).filter((l) => l.length > 0);
  return { chars: ["", ...lines, " "] };
}

export interface RecognizedText {
  text: string;
  confidence: number;
}

const REC_HEIGHT = 48;
const MAX_REC_WIDTH = 800;

function softmaxProb(data: Float32Array, offset: number, C: number, maxVal: number): number {
  let expSum = 0;
  for (let c = 0; c < C; c++) expSum += Math.exp(data[offset + c] - maxVal);
  return 1 / expSum;
}

/**
 * Runs the deployed PaddleOCR recognition model on one already-cropped/straightened
 * text-line image and greedy-CTC-decodes the output against the PaddleOCR character
 * dictionary.
 */
export async function recognizeLine(
  session: ort.InferenceSession,
  lineCanvas: HTMLCanvasElement,
  charset: RecCharset
): Promise<RecognizedText> {
  const aspect = lineCanvas.width / Math.max(1, lineCanvas.height);
  const targetWidth = Math.min(MAX_REC_WIDTH, Math.max(REC_HEIGHT, Math.round(REC_HEIGHT * aspect)));
  const tensor = canvasRegionToNormalizedTensor(lineCanvas, targetWidth, REC_HEIGHT, undefined, undefined, "-1-1");

  const inputName = session.inputNames[0];
  const input = new ort.Tensor("float32", tensor.data, [1, 3, REC_HEIGHT, targetWidth]);
  const outputs = await session.run({ [inputName]: input });
  const logits = outputs[session.outputNames[0]];
  const dims = logits.dims; // [1, T, C]
  const T = dims[1];
  const C = dims[2];

  if (C !== charset.chars.length) {
    console.warn(
      `id-ocr-web: rec model outputs ${C} classes but the loaded charset has ${charset.chars.length} entries ` +
        "(blank + dictionary file + space). Decoded text will be misaligned — confirm the dictionary file " +
        "loaded via OcrModelConfig.keysUrl matches the deployed rec_model.onnx's actual training dictionary " +
        "(inspect the model's output layer width directly if unsure; don't assume from a filename or README claim)."
    );
  }

  const data = logits.data as Float32Array;
  let prevIdx = -1;
  const chars: string[] = [];
  let confSum = 0;
  let confCount = 0;

  for (let t = 0; t < T; t++) {
    const offset = t * C;
    let maxVal = -Infinity;
    let maxIdx = 0;
    let rowSum = 0;
    for (let c = 0; c < C; c++) {
      const v = data[offset + c];
      rowSum += v;
      if (v > maxVal) {
        maxVal = v;
        maxIdx = c;
      }
    }

    // Some PaddleOCR rec exports already apply softmax internally (confirmed for the
    // currently deployed rec_model.onnx: its output tensor is literally named
    // softmax_11.tmp_0), in which case each timestep's row already sums to ~1 and
    // maxVal *is* the confidence. Re-softmaxing already-[0,1]-bounded values flattens
    // them toward uniform and produces meaningless near-zero confidences (caught by
    // running this against the real model - see node-e2e-test.mjs). Only compute our
    // own softmax when the row doesn't already look normalized, so this keeps working
    // correctly if a future model swap exports raw logits instead.
    const prob = Math.abs(rowSum - 1) < 0.01 ? maxVal : softmaxProb(data, offset, C, maxVal);

    // Standard CTC greedy decode: drop blanks (index 0), collapse consecutive repeats.
    if (maxIdx !== 0 && maxIdx !== prevIdx) {
      chars.push(charset.chars[maxIdx] ?? "");
      confSum += prob;
      confCount += 1;
    }
    prevIdx = maxIdx;
  }

  return {
    text: chars.join(""),
    confidence: confCount > 0 ? confSum / confCount : 0,
  };
}
