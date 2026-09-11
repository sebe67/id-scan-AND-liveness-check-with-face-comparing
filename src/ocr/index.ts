import * as ort from "onnxruntime-web";
import { defaultModelConfig, OcrModelConfig } from "./config";
import { detectTextLines } from "./detect";
import { detectIdType, extractFields } from "./fieldExtraction";
import { toCanvas, hashCanvas, ImageInput } from "./imageUtils";
import { fetchModelBytes, fetchTextAsset } from "./modelCache";
import { parseTd3Mrz } from "./mrz";
import { cropQuadToCanvas } from "./perspective";
import { buildCharset, RecCharset, recognizeLine } from "./recognize";
import type {
  CommonFields,
  DocumentProvenanceEntry,
  DocumentSide,
  IdType,
  PhIdOcrResult,
  RecognizedTextLine,
  RequiredCommonFields,
  VariantFields,
} from "./types";
import { LIBRARY_VERSION } from "./version";

const ENGINE_VERSION = `id-ocr-web@${LIBRARY_VERSION} (ppocrv5-mobile/onnxruntime-web)`;
const REC_LINE_HEIGHT = 48;

/** Point onnxruntime-web at wherever you host its .wasm binaries (npm package's dist/, or a CDN). Call once at app startup. */
export function configureOrtWasmPaths(pathOrUrl: string): void {
  ort.env.wasm.wasmPaths = pathOrUrl;
}

let detSessionPromise: Promise<ort.InferenceSession> | undefined;
let recSessionPromise: Promise<ort.InferenceSession> | undefined;
let charsetPromise: Promise<RecCharset> | undefined;

/** Lazily loads (and memoizes) the det/rec sessions and charset for the life of the page. */
function getSessions(config: OcrModelConfig) {
  detSessionPromise ??= fetchModelBytes(config.detModelUrl).then((buf) =>
    ort.InferenceSession.create(buf, { executionProviders: ["wasm"] })
  );
  recSessionPromise ??= fetchModelBytes(config.recModelUrl).then((buf) =>
    ort.InferenceSession.create(buf, { executionProviders: ["wasm"] })
  );
  charsetPromise ??= fetchTextAsset(config.keysUrl).then(buildCharset);
  return { det: detSessionPromise, rec: recSessionPromise, charset: charsetPromise };
}

export interface RunIdOcrOptions {
  modelConfig?: OcrModelConfig;
  /** Skip auto-detection and force a specific id_type (useful if the caller already knows it, e.g. from a capture flow). */
  idType?: IdType;
}

export interface RunIdOcrResult {
  idType?: IdType;
  common_fields: CommonFields;
  variant_fields: VariantFields;
  provenance: DocumentProvenanceEntry;
  lines: RecognizedTextLine[];
}

/**
 * Runs the full on-device pipeline for one side of an ID (detect text lines -> crop &
 * recognize each -> classify id_type -> extract fields) on an already edge-straightened
 * image. The image never leaves the device: everything here is local inference via
 * onnxruntime-web (WASM), and the only network calls are the initial (cached) model
 * downloads from your public GCS bucket.
 */
export async function runIdOcr(
  image: ImageInput,
  side: DocumentSide,
  options: RunIdOcrOptions = {}
): Promise<RunIdOcrResult> {
  const config = options.modelConfig ?? defaultModelConfig();
  const { det, rec, charset } = getSessions(config);
  const [detSession, recSession, recCharset] = await Promise.all([det, rec, charset]);

  const canvas = await toCanvas(image);
  const imageHash = await hashCanvas(canvas);
  const detectedLines = await detectTextLines(detSession, canvas);

  const lines: RecognizedTextLine[] = [];
  for (const line of detectedLines) {
    const xs = line.corners.map((p) => p.x);
    const ys = line.corners.map((p) => p.y);
    const boundingBox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    const rectHeight = Math.max(1, Math.hypot(line.corners[3].x - line.corners[0].x, line.corners[3].y - line.corners[0].y));
    const rectWidth = Math.max(1, Math.hypot(line.corners[1].x - line.corners[0].x, line.corners[1].y - line.corners[0].y));
    const outWidth = Math.max(REC_LINE_HEIGHT, Math.round(REC_LINE_HEIGHT * (rectWidth / rectHeight)));

    const lineCanvas = cropQuadToCanvas(canvas, line.corners, outWidth, REC_LINE_HEIGHT);
    const recognized = await recognizeLine(recSession, lineCanvas, recCharset);
    if (!recognized.text) continue;
    lines.push({ text: recognized.text, confidence: recognized.confidence, boundingBox });
  }

  const idType = options.idType ?? detectIdType(lines);
  const { common_fields, variant_fields } = extractFields(lines, idType, side, { width: canvas.width, height: canvas.height });
  const rawOcrText = lines.map((l) => l.text).join("\n");

  if (idType === "PASSPORT") {
    applyMrzFallback(common_fields, variant_fields, rawOcrText, side);
  }

  const provenance: DocumentProvenanceEntry = {
    side,
    image_hash: imageHash,
    raw_ocr_text: rawOcrText,
    engine_version: ENGINE_VERSION,
  };

  return { idType, common_fields, variant_fields, provenance, lines };
}

/** Fills in fields from the passport's MRZ where label-matching didn't already find them; MRZ is checksum-backed, so it's the more trustworthy source when both agree to check. */
function applyMrzFallback(common: CommonFields, variant: VariantFields, rawOcrText: string, side: DocumentSide): void {
  const mrz = parseTd3Mrz(rawOcrText);
  if (!mrz) return;

  common.last_name ??= { value: mrz.surname, confidence: mrz.documentNumberValid ? 0.95 : 0.7, source_side: side };
  common.first_name ??= { value: mrz.givenNames, confidence: mrz.documentNumberValid ? 0.95 : 0.7, source_side: side };
  common.date_of_birth ??= { value: mrz.dateOfBirth, confidence: mrz.dateOfBirthValid ? 0.98 : 0.7, source_side: side };
  common.sex ??= { value: mrz.sex, confidence: 0.9, source_side: side };

  variant.id_number ??= { value: mrz.documentNumber, confidence: mrz.documentNumberValid ? 0.98 : 0.7, source_side: side };
  variant.expiry_date ??= { value: mrz.expiryDate, confidence: mrz.expiryDateValid ? 0.98 : 0.7, source_side: side };
  variant.nationality ??= { value: mrz.nationality, confidence: 0.9, source_side: side };
}

const REQUIRED_COMMON_FIELDS: (keyof CommonFields)[] = ["first_name", "last_name", "date_of_birth"];

/**
 * Combines one or two `runIdOcr` results (front/back) into the final ph-id-schema
 * object. Where both sides produced a value for the same field, keeps the
 * higher-confidence one. Required common_fields the schema demands but OCR never
 * found are filled with an empty, zero-confidence placeholder rather than omitted.
 */
export function mergeIdOcrResults(results: RunIdOcrResult[]): PhIdOcrResult {
  const commonFields: CommonFields = {};
  const variantFields: VariantFields = {};
  const provenance: DocumentProvenanceEntry[] = [];
  let idType: IdType | undefined;

  for (const r of results) {
    if (r.idType && !idType) idType = r.idType;

    for (const [key, field] of Object.entries(r.common_fields) as [keyof CommonFields, CommonFields[keyof CommonFields]][]) {
      if (!field) continue;
      const existing = commonFields[key];
      if (!existing || field.confidence > existing.confidence) commonFields[key] = field;
    }
    for (const [key, field] of Object.entries(r.variant_fields) as [keyof VariantFields, VariantFields[keyof VariantFields]][]) {
      if (!field) continue;
      const existing = variantFields[key];
      if (!existing || field.confidence > existing.confidence) variantFields[key] = field;
    }
    provenance.push(r.provenance);
  }

  for (const field of REQUIRED_COMMON_FIELDS) {
    commonFields[field] ??= { value: "", confidence: 0 };
  }

  return {
    id_type: idType,
    // Safe cast: the loop above unconditionally sets first_name, last_name, and
    // date_of_birth, so commonFields now satisfies RequiredCommonFields even though
    // TS can't see that guarantee across the loop boundary.
    common_fields: commonFields as RequiredCommonFields,
    variant_fields: variantFields,
    document_provenance: provenance,
  };
}

export { defaultModelConfig } from "./config";
export { registerId, RegistrationError, DEFAULT_REGISTRATION_ENDPOINT } from "./registration";
export type { RegistrationEnvelope, RegistrationSuccessResponse } from "./registration";
export type {
  CommonFields,
  DocumentProvenanceEntry,
  DocumentSide,
  IdType,
  OcrField,
  PhIdOcrResult,
  RecognizedTextLine,
  RequiredCommonFields,
  VariantFields,
} from "./types";
export { ID_TEMPLATES } from "./idTemplates";
export type { IdTemplate, TemplateRegion } from "./idTemplates";
export type { ImageSize } from "./fieldExtraction";
export { LIBRARY_VERSION } from "./version";
