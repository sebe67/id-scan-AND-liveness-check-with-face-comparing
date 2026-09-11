export type IdType =
  | "PHILSYS"
  | "UMID"
  | "DRIVERS_LICENSE"
  | "PASSPORT"
  | "PRC"
  | "POSTAL"
  | "VOTERS"
  | "SSS"
  | "TIN"
  | "PHILHEALTH"
  | "SENIOR_CITIZEN"
  | "PWD";

export type DocumentSide = "FRONT" | "BACK";

export interface OcrField {
  value: string;
  confidence: number;
  source_side?: DocumentSide;
  /** [xMin, yMin, xMax, yMax] in the source image's pixel coordinates. */
  bounding_box?: [number, number, number, number];
}

/**
 * Fields as a single OCR pass over one side of a document may produce them — a name
 * genuinely might not be found yet at this point (e.g. it's only printed on the other
 * side, or the read failed), so every field here is optional. This is the type used by
 * `runIdOcr()`'s per-side result; it is deliberately looser than `RequiredCommonFields`
 * below, which is what the final, schema-conformant payload actually guarantees.
 */
export interface CommonFields {
  last_name?: OcrField;
  first_name?: OcrField;
  middle_name?: OcrField;
  name_extension?: OcrField;
  date_of_birth?: OcrField;
  sex?: OcrField;
  address?: OcrField;
  blood_type?: OcrField;
}

/**
 * schema/ph-id-schema.json (and /api/v1/register) require first_name, last_name, and
 * date_of_birth on common_fields. `mergeIdOcrResults()` enforces that: after merging
 * every side's results, any of these three still missing gets an explicit
 * `{ value: "", confidence: 0 }` placeholder rather than being left absent — so the
 * final payload always has the shape the server expects, and a 422 for one of these
 * three would mean the server rejected an empty/low-confidence value, not a missing
 * field. (Confirm that's actually how the server wants "could not read this" signaled —
 * see the open question in the README.)
 */
export interface RequiredCommonFields extends CommonFields {
  first_name: OcrField;
  last_name: OcrField;
  date_of_birth: OcrField;
}

export interface VariantFields {
  id_number?: OcrField;
  issue_date?: OcrField;
  expiry_date?: OcrField;
  place_of_birth?: OcrField;
  civil_status?: OcrField;
  nationality?: OcrField;
  weight?: OcrField;
  height?: OcrField;
  emergency_contact?: OcrField;
  license_restrictions?: OcrField;
  prc_profession?: OcrField;
  pwd_disability_type?: OcrField;
}

export interface DocumentProvenanceEntry {
  side: DocumentSide;
  image_hash: string;
  raw_ocr_text: string;
  engine_version: string;
}

/**
 * Mirrors ../schema/ph-id-schema.json field-for-field. `mergeIdOcrResults()` returns a
 * plain object of this shape — JSON.stringify() it directly to get the schema's payload.
 */
export interface PhIdOcrResult {
  id_type?: IdType;
  common_fields: RequiredCommonFields;
  variant_fields?: VariantFields;
  document_provenance?: DocumentProvenanceEntry[];
}

/** One recognized text line, in original-image pixel coordinates. */
export interface RecognizedTextLine {
  text: string;
  confidence: number;
  boundingBox: [number, number, number, number];
}
