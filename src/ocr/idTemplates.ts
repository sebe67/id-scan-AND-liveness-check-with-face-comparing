import type { DocumentSide, IdType } from "./types";

/**
 * Reference dimensions the regions below were captured against (a real DRIVERS_LICENSE
 * FRONT specimen scan, confirmed 600x410px). Regions are stored normalized (0-1 fractions
 * of image width/height), not as raw pixel boxes, so they scale to a straightened card
 * image of any resolution - as long as it's cropped to roughly the same aspect ratio as a
 * real PH driver's license, which the upstream edge-straightening step already guarantees.
 */
const REFERENCE_WIDTH = 600;
const REFERENCE_HEIGHT = 410;

function normalizeBox(box: [number, number, number, number]): [number, number, number, number] {
  return [box[0] / REFERENCE_WIDTH, box[1] / REFERENCE_HEIGHT, box[2] / REFERENCE_WIDTH, box[3] / REFERENCE_HEIGHT];
}

export interface TemplateRegion {
  /** [xMin, yMin, xMax, yMax] as fractions (0-1) of the straightened image's width/height. */
  box: [number, number, number, number];
}

export type IdTemplate = Partial<Record<string, TemplateRegion>>;

/**
 * Known-good field value positions for a specific id_type + side layout, keyed by field
 * name. This is a positional prior that complements (and for the fields it covers,
 * outranks) the label-proximity heuristic in fieldExtraction.ts: printed government ID
 * layouts are the same form for every holder, so a value's position on the card is
 * consistent across cards of the same type even when the label text itself is misread,
 * garbled, or merged with a neighboring label by OCR (exactly what prompted this - see
 * the DRIVERS_LICENSE bug report the coordinates below are taken from).
 *
 * Deliberately sparse: only fields with a *confirmed-correct* real bounding box (verified
 * against an actual bug report, not guessed) are included. Fabricating a plausible-looking
 * region for a field we don't have real data for would just trade one kind of silently
 * wrong position for another. Fields not listed here - weight, height, expiry_date,
 * address, and the name fields on DRIVERS_LICENSE FRONT - fall back to the label-proximity
 * heuristic, same as any id_type/side with no template at all.
 */
export const ID_TEMPLATES: Partial<Record<IdType, Partial<Record<DocumentSide, IdTemplate>>>> = {
  DRIVERS_LICENSE: {
    FRONT: {
      nationality: { box: normalizeBox([216.43304559977318, 178.92689649045485, 251.6272553598082, 200.79520030087542]) },
      sex: { box: normalizeBox([297.05068779904303, 181.35735358391608, 317.7519437799043, 198.0897618006993]) },
      date_of_birth: { box: normalizeBox([338.7050860323887, 181.5641179733728, 418.2028087044534, 197.88299741124263]) },
      id_number: { box: normalizeBox([217.20068892750746, 267.1866495827286, 324.57562686196616, 283.7508504172714]) },
      blood_type: { box: normalizeBox([241.69736842105263, 299.5365384615385, 266.52631578947364, 315.46346153846156]) },
      license_restrictions: { box: normalizeBox([311.84210526315786, 331.1538461538462, 361.1842105263158, 348.8942307692308]) },
    },
  },
};
