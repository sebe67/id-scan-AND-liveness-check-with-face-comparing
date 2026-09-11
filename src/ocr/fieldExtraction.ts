import type { CommonFields, DocumentSide, IdType, OcrField, RecognizedTextLine, VariantFields } from "./types";
import {
  COMMON_FIELD_ALIASES,
  ID_TYPE_DETECTION_KEYWORDS,
  VARIANT_FIELDS_BY_ID_TYPE,
  VARIANT_FIELD_ALIASES,
} from "./idTypeAliases";
import { ID_TEMPLATES } from "./idTemplates";

/** Pixel dimensions of the straightened card image `extractFields` was given, needed to scale a template's normalized regions back to real pixel coordinates. */
export interface ImageSize {
  width: number;
  height: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Best-effort id_type guess from keyword hits across all recognized text. Callers can override this. */
export function detectIdType(lines: RecognizedTextLine[]): IdType | undefined {
  const fullText = normalize(lines.map((l) => l.text).join(" "));
  let best: { type: IdType; hits: number } | undefined;
  for (const [type, keywords] of Object.entries(ID_TYPE_DETECTION_KEYWORDS) as [IdType, string[]][]) {
    const hits = keywords.filter((kw) => fullText.includes(kw)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { type, hits };
  }
  return best?.type;
}

// Matches a same-line "remainder" that's just a unit annotation stuck to the label
// (e.g. "Weight(kg)" -> remainder "(kg)", "Height(m)" -> "(m)") rather than an actual
// value. Letters/degree-sign only inside parens, no digits - real values wouldn't match
// this. Without this check that remainder gets accepted as the field's value outright.
const UNIT_ANNOTATION_PATTERN = /^\([a-zA-Z°]{1,6}\)$/;

function levenshtein(a: string, b: string): number {
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// How much of an alias's characters may differ (proportionally, rounded, minimum 1) and
// still count as the same label. Real-world recognition noise on this font/model garbles
// labels character-by-character in ways an exact substring match can't survive - "Sex" ->
// "SRX", "Date of Birth" -> "Date af Birth", "First Name" -> "Fint Nama" - all seen in a
// real bug report. 30% is loose enough to catch that without being so loose it starts
// matching unrelated short values (verified against real field values in this file's
// regression test).
const FUZZY_EDIT_RATIO = 0.3;

// Aliases at or under this length only ever get compared at their own exact length (see
// fuzzyMatchPrefix's comment) - long enough to still cover every short single-word alias
// in idTypeAliases.ts ("sex", "weight", "height", "tin", "pin", "crn", "dob", "id no", ...).
const SHORT_ALIAS_MAX_LENGTH = 6;

// True if `ch` is a genuine word boundary (a non-letter/digit character, or past the end
// of the string) rather than the middle of a longer word. A real bug report had PRC's
// "profession" alias match the first ten characters of "PROFESSIONAL REGULATION
// COMMISSION" (the id_type's own fixed letterhead text, present on every PRC card) -
// "profession" is a genuine prefix of the unrelated, longer English word
// "professional", not a garbled OCR read of an actual profession label.
function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/**
 * Fuzzy prefix match: does `text` start with something close enough to `alias` to call it
 * the same label? Tries exact match first (fast path), then - since a garbled label can
 * come out a different length than the real one (a dropped or inserted character) - the
 * edit distance from `alias` against several nearby prefix lengths of `text`, keeping
 * whichever length scores lowest. Returns the length of `text` that was consumed as the
 * label, so the caller can slice off exactly that much rather than assuming it's
 * `alias.length`.
 */
function fuzzyMatchPrefix(text: string, alias: string): { matched: boolean; matchedLength: number; exact: boolean } {
  if (text.startsWith(alias) && isWordBoundaryChar(text[alias.length])) {
    return { matched: true, matchedLength: alias.length, exact: true };
  }

  const threshold = Math.max(1, Math.round(alias.length * FUZZY_EDIT_RATIO));

  // Check the WHOLE text against the alias first, before searching shorter prefixes: if
  // the entire line is basically just this label (garbled, or with a little trailing
  // punctuation), that's a stronger, less ambiguous signal than a shorter partial-prefix
  // match - even when a shorter prefix scores a marginally lower raw edit distance. A
  // real bug report had "Birthdate:" (10 chars) go unrecognized as date_of_birth's
  // label: comparing against "birth date" (10 chars), the algorithm preferred a 1-edit
  // match at length 9 ("birthdate") over the 2-edit match at the full length 10
  // ("birthdate:"), even though the longer one was still well within tolerance - so the
  // match came back as a partial, non-full-consuming one instead of "this whole line is
  // the label," and got rejected downstream by the exact-only-remainder rule below.
  const fullDist = levenshtein(text, alias);
  if (fullDist <= threshold) return { matched: true, matchedLength: text.length, exact: false };

  // No good whole-line match. Short aliases (a single short word, like "sex") are only
  // ever additionally compared at their own exact length, never a shorter prefix of a
  // longer text. Letting them match a shorter text prefix too is what let "Expiration
  // Date" collide with "sex": its first two characters, "ex", are edit-distance 1 from
  // "sex" purely because both strings being compared are tiny, not because they mean the
  // same thing.
  const isShortAlias = alias.length <= SHORT_ALIAS_MAX_LENGTH;
  if (isShortAlias) {
    if (alias.length > text.length) return { matched: false, matchedLength: 0, exact: false };
    const dist = levenshtein(text.slice(0, alias.length), alias);
    return dist <= threshold && isWordBoundaryChar(text[alias.length])
      ? { matched: true, matchedLength: alias.length, exact: false }
      : { matched: false, matchedLength: 0, exact: false };
  }

  // Longer, usually multi-word aliases get a wider length window, since recovering a
  // real character drop (a missing OCR'd space, e.g. "Fint Nama.Middie Name" for "First
  // Name.Middle Name") needs a text prefix shorter or longer than the alias's own length
  // to line up correctly - and there the length difference is a much smaller fraction of
  // the total, so the coincidental-match risk is proportionally far lower.
  const lo = Math.max(1, alias.length - 2);
  const hi = alias.length + 3;
  let best: { len: number; dist: number } | undefined;
  for (let len = lo; len <= Math.min(hi, text.length); len++) {
    if (!isWordBoundaryChar(text[len])) continue;
    // A window longer than the alias itself is only trustworthy if something other than
    // plain letters/digits separates the alias's own length from where this window ends
    // - otherwise the "extra" characters are just continuing one single longer word (the
    // "profession"/"professional" case above), not slack for a dropped character the way
    // a *shorter* window is.
    if (len > alias.length && !/[^a-z0-9]/i.test(text.slice(alias.length, len))) continue;
    const dist = levenshtein(text.slice(0, len), alias);
    if (!best || dist < best.dist) best = { len, dist };
  }
  if (best && best.dist <= threshold) return { matched: true, matchedLength: best.len, exact: false };
  return { matched: false, matchedLength: 0, exact: false };
}

/**
 * True if `text` is itself, on its own, nothing but a known field's label (i.e. would
 * match some field's aliases with an empty remainder). Used to catch merged-label OCR
 * lines like "Last Name. First Name.Middle Name", where stripping "Last Name" leaves
 * "First Name.Middle Name" - text that isn't a value at all, but another field's label
 * (possibly itself garbled, e.g. "Fint Nama.Middie Name") run together with a third
 * label's leftover text. Without this check that remainder gets accepted as the first
 * field's value outright.
 */
function isKnownLabelText(text: string, allAliasLists: string[][]): boolean {
  const norm = normalize(text);
  if (!norm) return false;
  return allAliasLists.some((aliases) => aliases.some((alias) => fuzzyMatchPrefix(norm, normalize(alias)).matched));
}

/**
 * True if `text` is, on its own, entirely and only some known field's label - nothing
 * left over (unlike isKnownLabelText above, which also counts a label that's merely a
 * *prefix* of a longer line). Used to stop a nearby-line search (findValueNear,
 * resolveGridRows) from accepting a candidate that's obviously not a value at all: a real
 * bug report had "Last Name"'s value resolve to the text "Nationality" - the nearest
 * unused line below it - purely because nothing checked whether that candidate was
 * itself just another field's label.
 */
function isLabelOnlyText(text: string, allAliasLists: string[][]): boolean {
  if (!normalize(text)) return false;
  // Delegates to matchLabel (checked against every known alias at once) rather than a
  // separate, simpler length check, so this benefits from the same trailing-punctuation
  // handling matchLabel already does elsewhere - e.g. "License No." only prefix-matches
  // "license no" for 10 of its 11 characters, but the leftover "." gets stripped and
  // recognized as empty, so it's still correctly a label-only line, not almost one.
  const { matched, remainder } = matchLabel(text, allAliasLists.flat(), allAliasLists);
  return matched && remainder.length === 0;
}

// A value that plainly isn't the right shape for its field is worse than no value at all
// - a bug report had "weight" resolve to an address placeholder line ("UNIT/HOUSE
// NO.BUILDING, STREET NAME,") and "expiry_date" resolve to a single stray character
// ("h"), both just because they were the nearest unused line, with nothing checking
// whether they looked anything like a weight or a date. Intentionally loose (a real OCR
// value can still have noise) - this only screens out candidates that couldn't possibly
// be right, not ones that merely look unusual.
const NUMERIC_VALUE_PATTERN = /^\d+(\.\d+)?\s*[a-zA-Z]{0,3}$/;
// Three accepted shapes: numeric with slash/dash/dot separators ("2022/10/04"); day +
// month-name + year ("11 JULY1998", "16 MAR 1980" - a real TIN ID and a real passport
// both print birthdates this way); or month-name + day + year ("JANUARY01,1990" - a
// real PhilSys ID, month first this time). Spacing around the day/year is inconsistent
// in the OCR output in both orders ("JULY1998" with no space before the year,
// "JANUARY01,1990" with no space before the day and a comma instead of a space before
// the year) - \s* rather than \s+ around the day and year, and an optional comma,
// accounts for that.
const DATE_VALUE_PATTERN =
  /\d{2,4}[/\-.]\d{1,2}[/\-.]\d{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s*\d{4}|[A-Za-z]{3,9}\.?\s*\d{1,2},?\s*\d{4}/;
// "M"/"F" (every real example seen so far), plus the spelled-out English/Filipino words
// in case some layout prints those instead - never a whole place name or anything else
// multi-word. A real bug report had a passport's sex resolve to "MANILA" (its actual
// place-of-birth value, sitting nearby with no separately-detected "F"/"M" character to
// find instead) purely because it was the nearest unused line.
const SEX_VALUE_PATTERN = /^(m|f|male|female|lalaki|babae)$/i;

const FIELD_VALUE_VALIDATORS: Partial<Record<string, (text: string) => boolean>> = {
  sex: (text) => SEX_VALUE_PATTERN.test(text.trim()),
  weight: (text) => NUMERIC_VALUE_PATTERN.test(text.trim()),
  height: (text) => NUMERIC_VALUE_PATTERN.test(text.trim()),
  date_of_birth: (text) => DATE_VALUE_PATTERN.test(text),
  issue_date: (text) => DATE_VALUE_PATTERN.test(text),
  expiry_date: (text) => DATE_VALUE_PATTERN.test(text),
};

/** If `lineText` starts with (or closely resembles the start of) one of `aliases` as a label, returns what's left after stripping it. */
function matchLabel(
  lineText: string,
  aliases: string[],
  allAliasLists: string[][]
): { matched: boolean; remainder: string } {
  const norm = normalize(lineText);
  for (const alias of aliases) {
    const a = normalize(alias);
    const { matched, matchedLength, exact } = fuzzyMatchPrefix(norm, a);
    if (!matched) continue;
    if (matchedLength >= norm.length) return { matched: true, remainder: "" };
    // A fuzzy (non-exact) match that leaves real leftover text isn't trustworthy enough
    // to treat that leftover as a value - a real bug report had "sex" match the first 3
    // characters of "SEBASTIAN VINCENT PABLO" ("seb", edit-distance 1 from "sex") and
    // "id no" match the first 5 of "15 NOV 2022" ("15 NO", edit-distance 2), both
    // producing garbage remainders ("ASTIAN VINCENT PABLO", "V 2022"). Only an exact
    // substring match (e.g. "Sex: F", "Weight(kg)") is reliable enough for that; a fuzzy
    // match is only trusted when it consumes the *whole* line (handled above), where
    // there's no leftover to get wrong.
    if (!exact) continue;
    // Strip a leading separator before checking the remainder - PH passports print
    // bilingual "Filipino/English" labels on one line ("Kasarian/Sex"), and matching
    // the Filipino half ("Kasarian") leaves "/Sex" as the remainder. Without stripping
    // the "/" here, isKnownLabelText below never recognizes "/Sex" as starting with the
    // (English) "sex" alias - it's the exact same field's own label in the other
    // language, not a value - and "/Sex" gets accepted as sex's value outright.
    const remainder = lineText.slice(matchedLength).replace(/^[\s:./|\\-]+/, "").trim();
    if (UNIT_ANNOTATION_PATTERN.test(remainder) || isKnownLabelText(remainder, allAliasLists)) {
      return { matched: true, remainder: "" };
    }
    return { matched: true, remainder };
  }
  return { matched: false, remainder: "" };
}

function boxCenter(box: [number, number, number, number]): Point2 {
  return { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 };
}

interface Point2 {
  x: number;
  y: number;
}

/**
 * Finds the nearest not-yet-used line that plausibly holds a label's value: either to
 * the right on the same row, or roughly left-aligned with the label and immediately
 * above or below it. Most PH ID layouts put the label above the value, but some (e.g. a
 * PWD ID's "NAME"/"TYPE OF DISABILITY" printed under a ruled line, with the actual value
 * sitting above that line and the label below it) do the opposite - real bug report had
 * "TYPE OF DISABILITY" resolve to "SIGNATURE", the nearest line below it, because
 * nothing here ever looked upward for "PSYCHOSOCIAL", its real value directly above.
 */
function findValueNear(
  labelLine: RecognizedTextLine,
  candidates: RecognizedTextLine[],
  usedIndices: Set<number>,
  isAcceptable: (line: RecognizedTextLine) => boolean = () => true
): { line: RecognizedTextLine; index: number } | undefined {
  const labelCenter = boxCenter(labelLine.boundingBox);
  const labelHeight = labelLine.boundingBox[3] - labelLine.boundingBox[1];
  // Same-row-to-the-right and above/below are tracked as two separate "best" contests,
  // not one combined comparison - their distance formulas aren't on the same scale (one
  // is a plain x-gap, the other is a weighted vertical-gap-plus-left-offset), so a
  // same-row match can end up with a numerically *larger* "dist" than a candidate that's
  // actually in the wrong place entirely. A real bug report had a PRC ID's "LAST NAME"
  // value resolve to a stray line of background microprint noise sitting well above the
  // label, purely because that noise line's left edge happened to align almost exactly
  // with the label's - beating out "DELA CRUZ", the correct value sitting right beside
  // it on the same row, on raw distance alone. Same-row-to-the-right is always the more
  // confident shape when it exists at all (every previously-fixed layout that reads
  // "beside" rather than "above/below" relies on it), so it wins outright whenever
  // there's a same-row candidate, regardless of how the numbers compare.
  let bestSameRow: { line: RecognizedTextLine; index: number; dist: number } | undefined;
  let bestVertical: { line: RecognizedTextLine; index: number; dist: number } | undefined;

  candidates.forEach((cand, idx) => {
    if (usedIndices.has(idx) || cand === labelLine || !isAcceptable(cand)) return;
    const c = boxCenter(cand.boundingBox);
    // "Left-aligned with the label" (the above/below cases) means the candidate's own
    // LEFT edge starts where the label's left edge does - compare edge to edge, not the
    // candidate's center to the label's edge. A real bug report had "Address"'s value
    // resolve to "AUTODEAL", a short unrelated line sitting in a totally different
    // column (near the ID photo placeholder) - its narrow box happened to have a center
    // x closer to the label's left edge than the real (wide) address value's center did,
    // even though that value's own left edge lined up with the label almost exactly.
    const leftAlignOffset = Math.abs(cand.boundingBox[0] - labelLine.boundingBox[0]);
    const sameRow = Math.abs(c.y - labelCenter.y) < labelHeight * 0.7;
    const toRight = c.x > labelLine.boundingBox[2] - 2;

    if (sameRow && toRight) {
      const dist = c.x - labelLine.boundingBox[2];
      if (dist < 0) return;
      if (!bestSameRow || dist < bestSameRow.dist) bestSameRow = { line: cand, index: idx, dist };
      return;
    }

    // Whichever of these is positive says which side the candidate is actually on; the
    // other comes out negative and is discarded by taking the max, rather than needing
    // a separate above/below branch.
    const belowGap = c.y - labelLine.boundingBox[3];
    const aboveGap = labelLine.boundingBox[1] - c.y;
    const verticalGap = Math.max(belowGap, aboveGap);
    if (verticalGap < -2 || leftAlignOffset >= labelHeight * 15) return;

    const dist = verticalGap * 3 + leftAlignOffset;
    if (!bestVertical || dist < bestVertical.dist) bestVertical = { line: cand, index: idx, dist };
  });

  return bestSameRow ?? bestVertical;
}

// Fields whose printed value routinely wraps across more than one detected text line -
// a PH address is the clear case ("UNIT/HOUSE NO...STREET NAME," on one line,
// "BARANGAY,CITY/MUNICIPALITY" on the next). Deliberately just this one field for now:
// extending the wrong field onto its neighbor's label/value is a worse failure than
// under-extending a field that only sometimes wraps, so this only applies where
// multi-line values are the norm, not merely possible.
const MULTILINE_FIELDS = new Set(["address"]);
const MULTILINE_MAX_CONTINUATION_LINES = 3;

/**
 * Extends a just-found value line downward with any immediately-following, left-aligned
 * lines that are plausibly its continuation, joining their text with a space and
 * unioning their bounding boxes. Stops at the first line that's used, that isn't
 * reasonably close below and left-aligned with the line before it, or that's itself a
 * known label (the next field's label line, not a continuation of this one) -
 * `isLabelOnlyText` reuses matchLabel's own trailing-punctuation handling, so a label
 * like "License No." close below is still recognized as a label and excluded even
 * though its literal alias match doesn't consume every character.
 */
function extendMultilineValue(
  firstLine: RecognizedTextLine,
  firstIndex: number,
  lines: RecognizedTextLine[],
  used: Set<number>,
  allAliasLists: string[][]
): { text: string; box: [number, number, number, number]; indices: number[] } {
  let text = firstLine.text;
  let box: [number, number, number, number] = [...firstLine.boundingBox];
  const indices = [firstIndex];
  let cursor = firstLine;

  for (let step = 0; step < MULTILINE_MAX_CONTINUATION_LINES; step++) {
    const cursorHeight = cursor.boundingBox[3] - cursor.boundingBox[1];
    let best: { line: RecognizedTextLine; index: number; dist: number } | undefined;

    lines.forEach((cand, idx) => {
      if (used.has(idx) || indices.includes(idx)) return;
      const leftAlignOffset = Math.abs(cand.boundingBox[0] - cursor.boundingBox[0]);
      const top = cand.boundingBox[1];
      const below = top > cursor.boundingBox[3] - 2 && top < cursor.boundingBox[3] + cursorHeight * 2;
      if (!below || leftAlignOffset > cursorHeight * 5) return;
      const dist = (top - cursor.boundingBox[3]) * 3 + leftAlignOffset;
      if (!best || dist < best.dist) best = { line: cand, index: idx, dist };
    });

    // The nearest candidate below is checked for being a label only *after* finding it,
    // not excluded from the search up front - a label line acts as a wall: if it's the
    // closest thing below, stop there, rather than skip past it to whatever's next
    // (which is exactly how an earlier version of this reached past "License No." to
    // grab the id_number value two rows down as a bogus "continuation" of the address).
    if (!best || isLabelOnlyText(best.line.text, allAliasLists)) break;
    text += " " + best.line.text;
    box = [
      Math.min(box[0], best.line.boundingBox[0]),
      Math.min(box[1], best.line.boundingBox[1]),
      Math.max(box[2], best.line.boundingBox[2]),
      Math.max(box[3], best.line.boundingBox[3]),
    ];
    indices.push(best.index);
    cursor = best.line;
  }

  return { text, box, indices };
}

function toOcrField(text: string, confidence: number, box: [number, number, number, number], side: DocumentSide): OcrField {
  return { value: text.trim(), confidence, source_side: side, bounding_box: box };
}

interface FieldTarget {
  target: Record<string, OcrField | undefined>;
  field: string;
  aliases: string[];
}

interface LabelHit {
  lineIndex: number;
  target: Record<string, OcrField | undefined>;
  field: string;
}

/**
 * Groups line indices into left-to-right rows by y-center proximity (within ~0.6x a
 * line's own height of each other) - the same "is this roughly the same printed row"
 * test used elsewhere, factored out here since both the label side and the value side
 * of the grid-matching step below need it. Returns rows top-to-bottom.
 */
function clusterIntoRows(lines: RecognizedTextLine[], indices: number[]): number[][] {
  const withY = indices
    .map((i) => ({
      i,
      cy: (lines[i].boundingBox[1] + lines[i].boundingBox[3]) / 2,
      h: lines[i].boundingBox[3] - lines[i].boundingBox[1],
    }))
    .sort((a, b) => a.cy - b.cy);

  const rows: { indices: number[]; y: number }[] = [];
  for (const item of withY) {
    const row = rows.find((r) => Math.abs(r.y - item.cy) < item.h * 0.6);
    if (row) {
      row.indices.push(item.i);
      row.y = (row.y * (row.indices.length - 1) + item.cy) / row.indices.length;
    } else {
      rows.push({ indices: [item.i], y: item.cy });
    }
  }

  // Sort by center x, not left edge - a wide box (e.g. "Date of Birth") can start to
  // the left of a narrower box that's visually after it (e.g. "Sex"), which left-edge
  // sorting would get backwards.
  for (const row of rows) {
    row.indices.sort((a, b) => {
      const ax = (lines[a].boundingBox[0] + lines[a].boundingBox[2]) / 2;
      const bx = (lines[b].boundingBox[0] + lines[b].boundingBox[2]) / 2;
      return ax - bx;
    });
  }
  return rows.sort((a, b) => a.y - b.y).map((r) => r.indices);
}

/** Every not-yet-used line that is, on its own, nothing but a known field's label (empty remainder). */
function findLabelOnlyHits(lines: RecognizedTextLine[], used: Set<number>, fieldTargets: FieldTarget[]): LabelHit[] {
  const allAliasLists = fieldTargets.map((f) => f.aliases);
  const hits: LabelHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    for (const { target, field, aliases } of fieldTargets) {
      if (target[field]) continue;
      const { matched, remainder } = matchLabel(lines[i].text, aliases, allAliasLists);
      if (matched && remainder.length === 0) {
        hits.push({ lineIndex: i, target, field });
        break;
      }
    }
  }
  return hits;
}

/**
 * Handles the case findValueNear's one-field-at-a-time nearest-neighbor search gets
 * wrong: several short field labels printed in a row (e.g. "Nationality / Sex / Date of
 * Birth"), with their values in a matching row underneath. Matching each label
 * independently to "whichever unused line is nearest" breaks down here - labels are
 * often more tightly spaced than the values below them, so the nearest-by-distance
 * value for label N can actually belong to label N-1 or N+1, and because fields are
 * resolved one at a time, an earlier field can end up greedily claiming a later field's
 * value out from under it (this is exactly what produced the swapped
 * nationality/sex/date_of_birth values this was written to fix).
 *
 * Instead: find rows containing 2+ label-only hits, find the nearest row of unused
 * lines below that row, and pair them by rank (leftmost label with leftmost value, and
 * so on) - the same left-to-right correspondence a human reads the row with, rather
 * than per-field nearest-distance search.
 */
function resolveGridRows(
  lines: RecognizedTextLine[],
  used: Set<number>,
  fieldTargets: FieldTarget[],
  side: DocumentSide,
  allAliasLists: string[][]
): void {
  const labelHits = findLabelOnlyHits(lines, used, fieldTargets);
  if (labelHits.length < 2) return;

  const hitsByLine = new Map(labelHits.map((h) => [h.lineIndex, h]));
  const labelLineIndices = labelHits.map((h) => h.lineIndex);
  const labelRows = clusterIntoRows(lines, labelLineIndices);

  for (const labelRow of labelRows) {
    if (labelRow.length < 2) continue; // solo labels: leave for the existing per-field search

    const rowBottom = Math.max(...labelRow.map((i) => lines[i].boundingBox[3]));
    const rowHeight = Math.max(...labelRow.map((i) => lines[i].boundingBox[3] - lines[i].boundingBox[1]));

    const belowCandidates: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      // skip already-used lines, other labels, and lines that are themselves clearly
      // some other field's label rather than a value (see isLabelOnlyText's comment)
      if (used.has(i) || hitsByLine.has(i) || isLabelOnlyText(lines[i].text, allAliasLists)) continue;
      const top = lines[i].boundingBox[1];
      if (top > rowBottom - 2 && top < rowBottom + rowHeight * 5) belowCandidates.push(i);
    }
    if (belowCandidates.length < 2) continue;

    const valueRows = clusterIntoRows(lines, belowCandidates);
    const valueRow = valueRows[0]; // nearest row below
    if (valueRow.length < 2) continue;

    // Pair by nearest x-center column, not by rank (label[k] <-> value[k]): if one label in
    // the row wasn't recognized (garbled past even the fuzzy match, e.g. "Nationality"
    // read as just "Ma"), its value is still sitting in the value row, and rank pairing
    // would shift every label after it onto the wrong value. Matching each label to
    // whichever remaining value column is horizontally closest survives that - the
    // recognized labels still land on their own true values regardless of a gap earlier
    // in the row.
    const valueRemaining = new Set(valueRow);
    for (const labelIdx of labelRow) {
      const hit = hitsByLine.get(labelIdx)!;
      if (hit.target[hit.field]) continue;
      const labelCx = (lines[labelIdx].boundingBox[0] + lines[labelIdx].boundingBox[2]) / 2;
      const validator = FIELD_VALUE_VALIDATORS[hit.field];

      let bestValueIdx: number | undefined;
      let bestDist = Infinity;
      for (const valueIdx of valueRemaining) {
        if (validator && !validator(lines[valueIdx].text)) continue;
        const valueCx = (lines[valueIdx].boundingBox[0] + lines[valueIdx].boundingBox[2]) / 2;
        const dist = Math.abs(valueCx - labelCx);
        if (dist < bestDist) {
          bestDist = dist;
          bestValueIdx = valueIdx;
        }
      }
      if (bestValueIdx === undefined) continue;

      const valueLine = lines[bestValueIdx];
      hit.target[hit.field] = toOcrField(valueLine.text, valueLine.confidence, valueLine.boundingBox, side);
      used.add(labelIdx);
      used.add(bestValueIdx);
      valueRemaining.delete(bestValueIdx);
    }
  }
}

// PH IDs print a suffix ("JR", "SR", "II", "III", "IV") as its own separate word when
// present at all - checked so a real 4th value box in a merged name-label row (see
// resolveMergedNameLabelRow below) is recognized as name_extension rather than folded
// into last_name.
const NAME_SUFFIX_PATTERN = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;

/**
 * Some ID layouts (e.g. Postal ID) print ONE combined label covering every name field
 * at once ("First Name, Middle Name, Surname, Suffix" - OCR'd here as "...Sumame,
 * Suffix") with the actual values printed as several separate boxes in a row below it,
 * one word per box - not resolveGridRows's shape (2+ *separate* labels each paired
 * with one value) and not one comma-joined line either (splitCommaSeparatedName's
 * shape). The regular per-field search only ever looks for one nearby value per label:
 * whichever name field's alias happens to match this merged line first (first_name
 * here, since "first name" is the first alias text within it) claims the single
 * nearest box and stops there - a real bug report had first_name resolve to "JUANA"
 * (correctly, if only by luck of being leftmost) while last_name/middle_name stayed
 * completely unresolved, with "REYES"/"DELA"/"CRUZ" never even looked at.
 *
 * Runs before the regular per-field pass (like resolveGridRows) so it can claim the
 * whole row at once instead of losing it to the first single-value match: finds a
 * label-only hit for any name field, then the nearest row of 2+ unused boxes below/
 * right of it, and assigns them by the column order the label itself declares - first
 * box is first_name, second is middle_name, the rest are last_name (PH surnames
 * routinely being 2+ words, e.g. "DELA CRUZ") unless the last box is a recognized
 * suffix token, which becomes name_extension instead. This is a real column order
 * from the label, not a guess the way splitUndividedName's surname-prefix heuristic
 * is - the layout is what puts "JUANA" before "REYES" before "DELA CRUZ", not this
 * function.
 */
function resolveMergedNameLabelRow(
  lines: RecognizedTextLine[],
  used: Set<number>,
  common: Record<string, OcrField | undefined>,
  allAliasLists: string[][],
  side: DocumentSide
): void {
  if (common.first_name || common.last_name) return;

  const nameFieldGroups: { field: string; aliases: string[] }[] = [
    { field: "first_name", aliases: COMMON_FIELD_ALIASES.first_name },
    { field: "last_name", aliases: COMMON_FIELD_ALIASES.last_name },
    { field: "middle_name", aliases: COMMON_FIELD_ALIASES.middle_name },
    { field: "name_extension", aliases: COMMON_FIELD_ALIASES.name_extension },
  ];

  // A label is only "merged" (spans 2+ name fields, like "First Name, Middle Name,
  // Surname, Suffix") when its primary field's alias - matched as an exact prefix, the
  // same rule matchLabel itself trusts a remainder from - leaves a remainder that is
  // ITSELF a prefix match for a *different* field's alias. Checking only "does this
  // line match some name field's alias with an empty remainder" (an earlier version of
  // this function) isn't enough on its own: an ordinary bilingual single-field label
  // like "Gitnang Apelyido/Middle Name" (Filipino "Gitnang Apelyido" + English
  // "Middle Name", both middle_name's own synonyms) also produces an empty remainder
  // the same way - isKnownLabelText's whole job is recognizing that kind of same-field
  // repetition as still just a label. Without checking that the second match is a
  // genuinely different field, this wrongly treated PhilSys's ordinary middle_name
  // label as a merged row and went hunting for other unrelated boxes below it.
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const norm = normalize(lines[i].text);
    let isMergedLabel = false;
    for (const { field, aliases } of nameFieldGroups) {
      for (const alias of aliases) {
        const { matched, matchedLength, exact } = fuzzyMatchPrefix(norm, normalize(alias));
        if (!matched || !exact || matchedLength >= norm.length) continue;
        const remainder = lines[i].text.slice(matchedLength).replace(/^[\s:./|\\-]+/, "").trim();
        if (!remainder) continue;
        const remNorm = normalize(remainder);
        const matchesOtherField = nameFieldGroups.some(
          (other) => other.field !== field && other.aliases.some((oa) => fuzzyMatchPrefix(remNorm, normalize(oa)).matched)
        );
        if (matchesOtherField) {
          isMergedLabel = true;
          break;
        }
      }
      if (isMergedLabel) break;
    }
    if (!isMergedLabel) continue;

    const labelLine = lines[i];
    const labelBottom = labelLine.boundingBox[3];
    const labelHeight = labelLine.boundingBox[3] - labelLine.boundingBox[1];

    // Both bounds are relative to the label's own height, not fixed pixel margins - a
    // flat "-2" was too tight to catch a real bug report's immediately-adjacent value
    // line (a driver's license photo where a genuinely merged "Last Name.Fint
    // Nama.Middie Name" label's very next line, "SILVA, SEBASTIAN VINCENT PABLO QUE",
    // has its top edge a few pixels *above* the label's own bottom - ordinary text
    // ascender overlap), and a flat "labelHeight*3" reach was generous enough that once
    // that immediate line got excluded, the search kept going and swept up an unrelated
    // row three fields further down (a weight/height label row) instead, wrongly
    // treating it as the name row.
    const rowIndices: number[] = [];
    for (let j = 0; j < lines.length; j++) {
      if (used.has(j) || j === i) continue;
      const top = lines[j].boundingBox[1];
      if (
        top > labelBottom - labelHeight * 0.5 &&
        top < labelBottom + labelHeight * 1.5 &&
        !isLabelOnlyText(lines[j].text, allAliasLists)
      ) {
        rowIndices.push(j);
      }
    }
    if (rowIndices.length < 2) continue; // not this shape - leave it for the regular per-field search

    const rows = clusterIntoRows(lines, rowIndices);
    const row = rows[0];
    if (!row || row.length < 2) continue;

    const words = row.map((idx) => ({ idx, text: lines[idx].text.trim() }));
    let suffix: { idx: number; text: string } | undefined;
    if (words.length >= 3 && NAME_SUFFIX_PATTERN.test(words[words.length - 1].text)) {
      suffix = words.pop();
    }

    const [firstWord, ...rest] = words;
    if (rest.length === 0) continue; // need at least first + one more to be worth claiming here

    common.first_name = toOcrField(firstWord.text, lines[firstWord.idx].confidence, lines[firstWord.idx].boundingBox, side);
    used.add(firstWord.idx);

    if (rest.length === 1) {
      common.last_name = toOcrField(rest[0].text, lines[rest[0].idx].confidence, lines[rest[0].idx].boundingBox, side);
      used.add(rest[0].idx);
    } else {
      const middle = rest[0];
      const surnameWords = rest.slice(1);
      common.middle_name = toOcrField(middle.text, lines[middle.idx].confidence, lines[middle.idx].boundingBox, side);
      used.add(middle.idx);

      const surnameText = surnameWords.map((w) => w.text).join(" ");
      const surnameBox: [number, number, number, number] = [
        Math.min(...surnameWords.map((w) => lines[w.idx].boundingBox[0])),
        Math.min(...surnameWords.map((w) => lines[w.idx].boundingBox[1])),
        Math.max(...surnameWords.map((w) => lines[w.idx].boundingBox[2])),
        Math.max(...surnameWords.map((w) => lines[w.idx].boundingBox[3])),
      ];
      common.last_name = toOcrField(surnameText, lines[surnameWords[0].idx].confidence, surnameBox, side);
      surnameWords.forEach((w) => used.add(w.idx));
    }

    if (suffix) {
      common.name_extension = toOcrField(suffix.text, lines[suffix.idx].confidence, lines[suffix.idx].boundingBox, side);
      used.add(suffix.idx);
    }
    used.add(i);
    return;
  }
}

// How far outside a template region's own box (as a fraction of that box's width/height)
// a candidate line's center may still fall and count as a match. Covers minor scale/
// registration drift between the reference specimen and a real scanned card without this
// step in the extreme picking up neighboring fields' values.
const TEMPLATE_MATCH_MARGIN = 0.3;

/**
 * Matches fields against a known-good positional template for this exact id_type + side
 * (see idTemplates.ts), when one exists and the caller told us the image's pixel size.
 * Runs before the label-based heuristics below and claims lines outright: template
 * regions are captured from a confirmed-correct real specimen, so for the fields they
 * cover they're more trustworthy than proximity-to-a-label guessing - and unlike the
 * label heuristics, this doesn't depend on the label text being read correctly at all,
 * which is exactly what breaks it (see idTemplates.ts's doc comment).
 */
function resolveFromTemplate(
  lines: RecognizedTextLine[],
  used: Set<number>,
  fieldTargets: FieldTarget[],
  idType: IdType | undefined,
  side: DocumentSide,
  imageSize: ImageSize | undefined
): void {
  if (!idType || !imageSize) return;
  const template = ID_TEMPLATES[idType]?.[side];
  if (!template) return;

  for (const { target, field } of fieldTargets) {
    if (target[field]) continue;
    const region = template[field];
    if (!region) continue;

    const pixelBox: [number, number, number, number] = [
      region.box[0] * imageSize.width,
      region.box[1] * imageSize.height,
      region.box[2] * imageSize.width,
      region.box[3] * imageSize.height,
    ];
    const marginX = (pixelBox[2] - pixelBox[0]) * TEMPLATE_MATCH_MARGIN;
    const marginY = (pixelBox[3] - pixelBox[1]) * TEMPLATE_MATCH_MARGIN;
    const targetCenter = boxCenter(pixelBox);

    let best: { index: number; dist: number } | undefined;
    lines.forEach((line, i) => {
      if (used.has(i)) return;
      const c = boxCenter(line.boundingBox);
      if (c.x < pixelBox[0] - marginX || c.x > pixelBox[2] + marginX) return;
      if (c.y < pixelBox[1] - marginY || c.y > pixelBox[3] + marginY) return;
      const dist = Math.hypot(c.x - targetCenter.x, c.y - targetCenter.y);
      if (!best || dist < best.dist) best = { index: i, dist };
    });

    if (best) {
      const line = lines[best.index];
      target[field] = toOcrField(line.text, line.confidence, line.boundingBox, side);
      used.add(best.index);
    }
  }
}

// PH driver's license id_number ("N03-12-123456") immediately followed, with no
// separator, by an expiry_date ("2022/10/04"). Seen in a real bug report where the
// detector's box-merging (DB unclip pulling two close, same-row text boxes into one)
// fused the id_number and expiry_date cells into a single OCR line - the two values
// never existed as separate lines to match against, so no amount of label/position
// matching over `lines` can recover them; only recognizing the fused shape itself can.
const ID_NUMBER_PATTERN = /^[A-Z]\d{2}-\d{2}-\d{6}$/;
const COMPOUND_ID_EXPIRY_PATTERN = /^([A-Z]\d{2}-\d{2}-\d{6})(\d{4}\/\d{2}\/\d{2})$/;

/**
 * Recovers id_number/expiry_date from a single fused OCR line matching the compound
 * shape above (see its comment). Always trusts the split expiry_date over whatever's
 * already there - a value that fits this exact fused shape is itself evidence the
 * existing one is the same merged garbage - but only overwrites id_number if its current
 * value doesn't already look like a clean id_number on its own (e.g. from the position
 * template), since a template match is likely correct.
 */
function splitCompoundIdExpiry(lines: RecognizedTextLine[], variant: Record<string, OcrField | undefined>, side: DocumentSide): void {
  for (const line of lines) {
    const match = COMPOUND_ID_EXPIRY_PATTERN.exec(line.text.replace(/\s+/g, ""));
    if (!match) continue;
    variant.expiry_date = toOcrField(match[2], line.confidence, line.boundingBox, side);
    if (!variant.id_number || !ID_NUMBER_PATTERN.test(variant.id_number.value)) {
      variant.id_number = toOcrField(match[1], line.confidence, line.boundingBox, side);
    }
    return;
  }
}

/**
 * PhilHealth's FRONT layout prints no label at all next to last_name/date_of_birth/
 * sex/address - just the raw values stacked one below another (id_number, then the
 * full name, then date_of_birth+sex fused onto one line, then the address) with
 * nothing for label-proximity matching to search for. id_number itself still resolves
 * reliably (its own alias list fuzzy-matches the "PhilHealth" logo text well enough),
 * so this uses the fixed print order below it as the anchor instead of a label or a
 * pixel-position template: the real card layout is a fixed form, so that order is
 * consistent across cards of this type the same way position is - it just doesn't
 * need us to know the source image's actual pixel dimensions to use, the way a
 * position template (idTemplates.ts) would.
 *
 * Deliberately gated to only run for PHILHEALTH by its caller - this is that one
 * type's specific print order, not a general "no labels found" fallback, so it can't
 * change what any other id_type resolves to.
 */
function resolvePhilhealthUnlabeledFields(
  lines: RecognizedTextLine[],
  used: Set<number>,
  common: Record<string, OcrField | undefined>,
  variant: Record<string, OcrField | undefined>,
  allAliasLists: string[][],
  side: DocumentSide
): void {
  if (common.last_name || !variant.id_number?.bounding_box) return;

  const anchor = variant.id_number.bounding_box;
  const anchorHeight = anchor[3] - anchor[1];

  const candidates = lines
    .map((l, i) => ({ l, i }))
    .filter(
      ({ l, i }) =>
        !used.has(i) &&
        l.boundingBox[1] > anchor[3] - 2 &&
        Math.abs(l.boundingBox[0] - anchor[0]) < anchorHeight * 5 &&
        !isLabelOnlyText(l.text, allAliasLists)
    )
    .sort((a, b) => a.l.boundingBox[1] - b.l.boundingBox[1]);

  const [nameCand, dobSexCand, addressCand] = candidates;
  if (!nameCand) return;

  common.last_name = toOcrField(nameCand.l.text, nameCand.l.confidence, nameCand.l.boundingBox, side);
  used.add(nameCand.i);

  if (dobSexCand && DOB_SEX_PATTERN.test(dobSexCand.l.text.trim())) {
    common.date_of_birth = toOcrField(dobSexCand.l.text, dobSexCand.l.confidence, dobSexCand.l.boundingBox, side);
    used.add(dobSexCand.i);
  }

  if (addressCand && !common.address) {
    const extended = extendMultilineValue(addressCand.l, addressCand.i, lines, used, allAliasLists);
    extended.indices.forEach((idx) => used.add(idx));
    common.address = toOcrField(extended.text, addressCand.l.confidence, extended.box, side);
  }
}

// PhilHealth prints date_of_birth and sex fused onto one line with no label for
// either and no space around the separating "-" ("JANUARY 01,2022-MALE") - recovered
// by pattern-matching the fused shape directly, the same approach
// splitCompoundIdExpiry above takes for a different fused pair. Harmless to check
// unconditionally for every id_type: no other type's date_of_birth value can end up
// looking like "<date>-MALE/FEMALE/M/F" in the first place, since that shape would
// have already failed DATE_VALUE_PATTERN's own validator during normal resolution.
const DOB_SEX_PATTERN = /^(.*\d{4})-\s*(male|female|m|f)\s*$/i;

function splitFusedDobSex(common: Record<string, OcrField | undefined>): void {
  const current = common.date_of_birth;
  if (!current) return;
  const match = DOB_SEX_PATTERN.exec(current.value.trim());
  if (!match) return;
  common.date_of_birth = { ...current, value: match[1].trim() };
  if (!common.sex?.value) {
    common.sex = { ...current, value: match[2].toUpperCase() };
  }
}

// A real UMID bug report had "Sex"/"Date of Birth" fused onto one line with no space
// at all between either label and its value ("SEX M DATEOF BIRTH LAGOXOL/2B") - the
// regular per-field search does match "sex" as this line's own label (it's the exact
// start of the line), but the leftover remainder is the *entire rest of the line*,
// which fails sex's own value-shape validator (only a bare M/F, not a trailing
// sentence) and gets discarded outright rather than pulling just the "M" out of it.
// This scans for that specific fused shape directly and recovers just the M/F token -
// the date_of_birth capture group afterward still has to pass DATE_VALUE_PATTERN to
// be trusted (see below): in the real report, the recognizer misread that value as
// "LAGOXOL/2B" - not a garbled-but-recoverable date, just wrong characters entirely -
// so it's correctly left unresolved rather than accepting recognition garbage as a
// birthdate.
const SEX_DOB_FUSED_PATTERN = /\bsex\b\s*(m|f|male|female)\s+date\s*of\s*birth\b[:.\s]*(.*)$/i;

function splitFusedSexDob(lines: RecognizedTextLine[], common: Record<string, OcrField | undefined>, side: DocumentSide): void {
  if (common.sex?.value && common.date_of_birth?.value) return;
  for (const l of lines) {
    const match = SEX_DOB_FUSED_PATTERN.exec(l.text);
    if (!match) continue;
    if (!common.sex?.value) {
      common.sex = toOcrField(match[1].toUpperCase(), l.confidence, l.boundingBox, side);
    }
    const rest = match[2].trim();
    if (!common.date_of_birth?.value && rest && DATE_VALUE_PATTERN.test(rest)) {
      common.date_of_birth = toOcrField(rest, l.confidence, l.boundingBox, side);
    }
    return;
  }
}

/**
 * Some ID layouts (e.g. PWD) print one undivided "NAME" field instead of separate
 * label(s) - resolved here as a deliberately deferred, last-resort step, called only
 * after every other field's own resolution pass has already run and claimed its value,
 * not as one of last_name's regular aliases. Running it earlier let its search reach
 * past its own real value to steal a *different* field's value instead: a real bug
 * report had "NAME"'s nearest-candidate search skip past "JUAN DELA CRUZ" (its real
 * value, above it) and grab "PSYCHOSOCIAL" (below it) - which was actually
 * "TYPE OF DISABILITY"'s own value, sitting even closer to that label than to "NAME",
 * but not yet claimed because "last_name" (checked before "pwd_disability_type" in the
 * regular per-field pass) got there first. Deferring this until last means
 * "PSYCHOSOCIAL" is already used by the time this runs, correctly excluding it.
 */
function resolveStandaloneNameLabel(
  lines: RecognizedTextLine[],
  used: Set<number>,
  common: Record<string, OcrField | undefined>,
  allAliasLists: string[][],
  side: DocumentSide
): void {
  if (common.last_name) return;
  const isAcceptableValue = (l: RecognizedTextLine) => !isLabelOnlyText(l.text, allAliasLists);

  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const { matched, remainder } = matchLabel(lines[i].text, ["name"], allAliasLists);
    if (!matched || remainder.length > 0) continue;

    const found = findValueNear(lines[i], lines, used, isAcceptableValue);
    if (found) {
      used.add(i);
      used.add(found.index);
      common.last_name = toOcrField(found.line.text, found.line.confidence, found.line.boundingBox, side);
    }
    return;
  }
}

/**
 * PH IDs print the full name as one line, "LASTNAME, FIRSTNAME MIDDLENAME" (confirmed
 * standard format - see README). Label matching has no way to know that: it finds this
 * whole line as the value for whichever name field's label sat nearest, which in
 * practice is always last_name (since "Last Name" is the first label in the merged
 * "Last Name. First Name.Middle Name" line, and the printed name sits right below it),
 * leaving first_name/middle_name empty. Split it apart here, once, after the label
 * matching above has found it. The split parts share the whole line's bounding box -
 * there's no way to recover individual boxes for words that were never detected as
 * separate lines in the first place.
 *
 * The part after the comma is split from the END, not the start: Philippine naming
 * convention has the middle name as a single word (customarily the mother's maiden
 * surname), while the given name itself can be more than one word (e.g. "Juan Pedro")
 * - so the last word is the middle name and everything before it is the first name,
 * not the other way around.
 */
function splitCommaSeparatedName(common: Record<string, OcrField | undefined>): void {
  const current = common.last_name;
  if (!current || !current.value.includes(",")) return;

  const [lastPart, restPart] = current.value.split(",").map((s) => s.trim());
  if (!lastPart || !restPart) return;

  const words = restPart.split(/\s+/).filter(Boolean);
  if (words.length === 0) return;
  const middleWord = words.length > 1 ? words[words.length - 1] : undefined;
  const firstWords = middleWord ? words.slice(0, -1) : words;

  common.last_name = { ...current, value: lastPart };
  if (!common.first_name?.value) {
    common.first_name = { ...current, value: firstWords.join(" ") };
  }
  if (middleWord && !common.middle_name?.value) {
    common.middle_name = { ...current, value: middleWord };
  }
}

// Filipino surnames routinely start with one of these compound-surname markers ("Dela
// Cruz", "De los Santos", "San Juan", "Santa Maria"/"Sta. Maria", "Del Rosario"). A real
// PWD ID prints its "NAME" field as one undivided value with no comma ("JUAN DELA
// CRUZ") - recognizing these lets splitUndividedName below split it into
// first_name/last_name without guessing where the surname starts from word count
// alone, which would get a compound surname wrong more often than not. This is
// necessarily a guess, not a fix with a confirmed-correct answer the way the rest of
// this file's splits are: a name with no delimiter genuinely doesn't carry enough
// information to always get right. Falls back to "last word only" when none of these
// prefixes appear - correct for a plain single-word surname, wrong for a two-given-name
// person with a plain surname (e.g. "JUAN PEDRO SANTOS" would wrongly take just
// "SANTOS" as the surname).
const SURNAME_PREFIX_WORDS = new Set([
  "DE",
  "DEL",
  "DELA",
  "DELOS",
  "DELAS",
  "LA",
  "LAS",
  "LOS",
  "SAN",
  "SANTA",
  "STA",
  "STO",
  "SANTO",
  "MAC",
  "MC",
  "VAN",
  "VON",
  "DI",
]);

/**
 * Splits an undivided full name ("JUAN DELA CRUZ", no comma) into first_name/last_name
 * using SURNAME_PREFIX_WORDS above. Only runs when splitCommaSeparatedName didn't
 * already handle this value (no comma present) and first_name is still unresolved -
 * "name" is deliberately the last, lowest-priority alias for last_name
 * (idTypeAliases.ts), used only when nothing more specific matched.
 */
function splitUndividedName(common: Record<string, OcrField | undefined>): void {
  const current = common.last_name;
  if (!current || current.value.includes(",") || common.first_name?.value) return;

  const words = current.value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return;

  let splitIndex = words.length - 1; // fallback: last word only is the surname
  for (let i = 1; i < words.length; i++) {
    if (SURNAME_PREFIX_WORDS.has(words[i].toUpperCase().replace(/\.$/, ""))) {
      splitIndex = i;
      break;
    }
  }

  common.first_name = { ...current, value: words.slice(0, splitIndex).join(" ") };
  common.last_name = { ...current, value: words.slice(splitIndex).join(" ") };
}

/**
 * Label-keyword + bounding-box heuristic field extractor. Three passes: first
 * resolveFromTemplate claims fields a known-good position template covers (see its doc
 * comment); then resolveGridRows handles rows of 2+ short field labels with a matching
 * value row below (see its doc comment); then the remaining fields fall back to the
 * simpler per-field search - a line matching one of its label aliases, then the value
 * either from the rest of that same line (e.g. "Sex: F") or the nearest unused line to
 * its right/below (e.g. a solo label with the value printed underneath). Finally,
 * splitCompoundIdExpiry recovers id_number/expiry_date from a fused detection box, when
 * one of the fields those apply to is applicable to this id_type.
 */
export function extractFields(
  lines: RecognizedTextLine[],
  idType: IdType | undefined,
  side: DocumentSide,
  imageSize?: ImageSize
): { common_fields: CommonFields; variant_fields: VariantFields } {
  const common: CommonFields = {};
  const variant: VariantFields = {};
  const used = new Set<number>();

  const commonTarget = common as Record<string, OcrField | undefined>;
  const variantTarget = variant as Record<string, OcrField | undefined>;

  const applicableVariantFields = idType ? VARIANT_FIELDS_BY_ID_TYPE[idType] : Object.keys(VARIANT_FIELD_ALIASES);

  const fieldTargets: FieldTarget[] = [
    ...Object.entries(COMMON_FIELD_ALIASES).map(([field, aliases]) => ({ target: commonTarget, field, aliases })),
    ...applicableVariantFields
      .map((field) => ({ target: variantTarget, field, aliases: VARIANT_FIELD_ALIASES[field] }))
      .filter((f): f is FieldTarget => Boolean(f.aliases)),
  ];

  const allAliasLists = fieldTargets.map((f) => f.aliases);

  resolveFromTemplate(lines, used, fieldTargets, idType, side, imageSize);
  resolveGridRows(lines, used, fieldTargets, side, allAliasLists);
  resolveMergedNameLabelRow(lines, used, commonTarget, allAliasLists, side);

  function assign(target: Record<string, OcrField | undefined>, field: string, aliases: string[]) {
    if (target[field]) return; // already resolved by resolveGridRows or resolveMergedNameLabelRow
    const validator = FIELD_VALUE_VALIDATORS[field];
    const isAcceptableValue = (l: RecognizedTextLine) =>
      !isLabelOnlyText(l.text, allAliasLists) && (!validator || validator(l.text));

    for (let i = 0; i < lines.length; i++) {
      if (used.has(i)) continue;
      const { matched, remainder } = matchLabel(lines[i].text, aliases, allAliasLists);
      if (!matched) continue;

      if (remainder.length >= 1 && isAcceptableValue({ text: remainder, confidence: lines[i].confidence, boundingBox: lines[i].boundingBox })) {
        used.add(i);
        target[field] = toOcrField(remainder, lines[i].confidence, lines[i].boundingBox, side);
        return;
      }

      const found = findValueNear(lines[i], lines, used, isAcceptableValue);
      if (found) {
        used.add(i);
        used.add(found.index);
        if (MULTILINE_FIELDS.has(field)) {
          const extended = extendMultilineValue(found.line, found.index, lines, used, allAliasLists);
          extended.indices.forEach((idx) => used.add(idx));
          target[field] = toOcrField(extended.text, found.line.confidence, extended.box, side);
        } else {
          target[field] = toOcrField(found.line.text, found.line.confidence, found.line.boundingBox, side);
        }
        return;
      }
    }
  }

  for (const { target, field, aliases } of fieldTargets) {
    assign(target, field, aliases);
  }

  if (applicableVariantFields.includes("id_number") && applicableVariantFields.includes("expiry_date")) {
    splitCompoundIdExpiry(lines, variantTarget, side);
  }
  if (idType === "PHILHEALTH") {
    resolvePhilhealthUnlabeledFields(lines, used, commonTarget, variantTarget, allAliasLists, side);
  }
  resolveStandaloneNameLabel(lines, used, commonTarget, allAliasLists, side);
  splitCommaSeparatedName(commonTarget);
  splitUndividedName(commonTarget);
  splitFusedDobSex(commonTarget);
  splitFusedSexDob(lines, commonTarget, side);

  return { common_fields: common, variant_fields: variant };
}
