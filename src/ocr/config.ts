export interface OcrModelConfig {
  detModelUrl: string;
  recModelUrl: string;
  keysUrl: string;
}

/**
 * Public HTTPS URL for the GCS bucket holding the model assets. The three objects
 * must have public read access (`gsutil iam ch allUsers:objectViewer gs://idscan_ocr`,
 * or a public bucket ACL) — this code runs in the browser and cannot hold a
 * service-account credential. cls_model.onnx is intentionally not referenced:
 * orientation classification is skipped since input images already arrive
 * edge-straightened/upright.
 *
 * v1.1/ holds a genuine PP-OCRv5 mobile rec model (confirmed via onnx.load() on the
 * downloaded file: output layer is 18,385-wide, matching ppocrv5_dict.txt's 18,383
 * entries + blank + space) paired with ppocrv5_dict.txt — unlike v1.0/, which turned
 * out to be a PP-OCRv3/v4-generation model despite its naming. Verified end-to-end
 * against these exact files via `npm run check:live-models` before switching this
 * default over.
 */
export const DEFAULT_MODEL_BASE_URL = "https://storage.googleapis.com/idscan_ocr/v1.1/";

export function defaultModelConfig(baseUrl: string = DEFAULT_MODEL_BASE_URL): OcrModelConfig {
  return {
    detModelUrl: `${baseUrl}det_model.onnx`,
    recModelUrl: `${baseUrl}rec_model.onnx`,
    keysUrl: `${baseUrl}ppocrv5_dict.txt`,
  };
}
