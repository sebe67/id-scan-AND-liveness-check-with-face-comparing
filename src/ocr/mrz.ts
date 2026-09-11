/**
 * ICAO TD3 (2-line, 44-char) MRZ parser for the Philippine passport's biodata page.
 * MRZ fields are fixed-width and checksum-validated, so where a valid MRZ is found
 * it's a much more reliable source for name/DOB/passport-number/expiry than
 * label-matching printed text.
 */
export interface MrzResult {
  documentNumber: string;
  documentNumberValid: boolean;
  surname: string;
  givenNames: string;
  nationality: string;
  /** YYMMDD */
  dateOfBirth: string;
  dateOfBirthValid: boolean;
  sex: "MALE" | "FEMALE" | "UNSPECIFIED";
  /** YYMMDD */
  expiryDate: string;
  expiryDateValid: boolean;
  raw: [string, string];
}

const CHECK_WEIGHTS = [7, 3, 1];

function mrzCharValue(ch: string): number {
  if (ch === "<") return 0;
  if (ch >= "0" && ch <= "9") return ch.charCodeAt(0) - 48;
  if (ch >= "A" && ch <= "Z") return ch.charCodeAt(0) - 55; // A=10 ... Z=35
  return 0;
}

function checkDigit(field: string): number {
  let sum = 0;
  for (let i = 0; i < field.length; i++) {
    sum += mrzCharValue(field[i]) * CHECK_WEIGHTS[i % 3];
  }
  return sum % 10;
}

/** Scans OCR'd lines for two adjacent 44-char MRZ lines starting with the TD3 document-type char. */
export function findMrzLines(rawText: string): [string, string] | null {
  const candidates = rawText
    .toUpperCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/[^A-Z0-9<]/g, ""))
    .filter((l) => l.length >= 40 && (l.match(/</g)?.length ?? 0) >= 2);

  for (let i = 0; i < candidates.length - 1; i++) {
    const l1 = candidates[i].padEnd(44, "<").slice(0, 44);
    if (/^[PV]</.test(l1)) {
      const l2 = candidates[i + 1].padEnd(44, "<").slice(0, 44);
      return [l1, l2];
    }
  }
  return null;
}

export function parseTd3Mrz(rawText: string): MrzResult | null {
  const lines = findMrzLines(rawText);
  if (!lines) return null;
  const [line1, line2] = lines;

  const namesField = line1.slice(5); // after document type + issuing country, e.g. "P<PHL"
  const [surnameRaw, givenRaw] = namesField.split("<<");
  const surname = (surnameRaw ?? "").replace(/</g, " ").trim();
  const givenNames = (givenRaw ?? "").replace(/</g, " ").trim();

  const documentNumber = line2.slice(0, 9).replace(/</g, "");
  const documentNumberCheck = line2[9];
  const nationality = line2.slice(10, 13).replace(/</g, "");
  const dateOfBirth = line2.slice(13, 19);
  const dobCheck = line2[19];
  const sexChar = line2[20];
  const expiryDate = line2.slice(21, 27);
  const expiryCheck = line2[27];

  return {
    documentNumber,
    documentNumberValid: String(checkDigit(line2.slice(0, 9))) === documentNumberCheck,
    surname,
    givenNames,
    nationality,
    dateOfBirth,
    dateOfBirthValid: String(checkDigit(dateOfBirth)) === dobCheck,
    sex: sexChar === "M" ? "MALE" : sexChar === "F" ? "FEMALE" : "UNSPECIFIED",
    expiryDate,
    expiryDateValid: String(checkDigit(expiryDate)) === expiryCheck,
    raw: [line1, line2],
  };
}
