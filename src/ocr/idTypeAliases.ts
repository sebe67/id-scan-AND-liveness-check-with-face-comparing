import type { IdType } from "./types";

/**
 * Keyword lists for classifying which PH ID type a card is, and for locating each
 * field's printed label (English + Filipino) so its value can be pulled from the
 * OCR'd text lines nearby. These lists are a starting point — expand them as you
 * test against real cards, especially PHILSYS/UMID/PRC/POSTAL/VOTERS/SSS/TIN/
 * PHILHEALTH, which weren't in the original PaddleOCR-vs-Tesseract benchmark.
 *
 * SENIOR_CITIZEN and PWD are issued per-LGU (city/municipality), not by one national
 * agency, so their physical layout and label wording vary far more than the other
 * types here — expect lower field-recall for those two regardless of tuning.
 */

export const ID_TYPE_DETECTION_KEYWORDS: Record<IdType, string[]> = {
  PHILSYS: ["philippine identification", "philsys", "pambansang pagkakakilanlan", "psa"],
  UMID: ["unified multi-purpose id", "umid", "crn"],
  DRIVERS_LICENSE: ["driver's license", "drivers license", "lto", "land transportation office", "license no"],
  PASSPORT: ["passport", "republika ng pilipinas", "dfa", "department of foreign affairs"],
  PRC: ["professional regulation commission", "prc id"],
  POSTAL: ["postal id", "philippine postal corporation", "phlpost"],
  VOTERS: ["comelec", "commission on elections", "voter's id", "voters id"],
  SSS: ["social security system", "sss"],
  TIN: ["bureau of internal revenue", "bir", "tin id", "taxpayer identification"],
  PHILHEALTH: ["philhealth", "philippine health insurance"],
  SENIOR_CITIZEN: ["senior citizen", "osca", "office of senior citizens affairs"],
  PWD: ["persons with disability", "pwd id"],
};

export type FieldAliasMap = Record<string, string[]>;

export const COMMON_FIELD_ALIASES: FieldAliasMap = {
  last_name: ["surname", "last name", "apelyido"],
  first_name: ["given name", "given names", "first name", "pangalan", "mga pangalan"],
  middle_name: ["middle name", "gitnang apelyido", "gitnang pangalan"],
  name_extension: ["ext name", "suffix", "name extension"],
  date_of_birth: ["date of birth", "birth date", "petsa ng kapanganakan", "kapanganakan", "dob"],
  sex: ["sex", "kasarian", "gender"],
  address: ["address", "tirahan", "permanent address"],
  blood_type: ["blood type", "uring dugo"],
};

export const VARIANT_FIELD_ALIASES: FieldAliasMap = {
  id_number: [
    "id no",
    "id number",
    "license no",
    "crn",
    "passport no",
    "tin",
    "sss no",
    "philhealth no",
    "pin",
    "precinct no",
    "registration no",
  ],
  issue_date: ["date issued", "issue date", "petsa ng pagkakalabas", "registration date"],
  expiry_date: ["date of expiry", "expiry date", "valid until", "expiration date"],
  place_of_birth: ["place of birth", "lugar ng kapanganakan"],
  civil_status: ["civil status", "katayuang sibil"],
  nationality: ["nationality", "citizenship", "bansa"],
  weight: ["weight"],
  height: ["height"],
  emergency_contact: ["emergency contact", "in case of emergency", "ice"],
  license_restrictions: ["restrictions", "conditions"],
  prc_profession: ["profession", "propesyon"],
  pwd_disability_type: ["disability type", "type of disability"],
};

/** Which variant_fields are worth attempting per id_type — keeps extraction from guessing at fields that ID never prints. */
export const VARIANT_FIELDS_BY_ID_TYPE: Record<IdType, string[]> = {
  PHILSYS: ["id_number"],
  UMID: ["id_number"],
  DRIVERS_LICENSE: ["id_number", "expiry_date", "nationality", "weight", "height", "license_restrictions", "civil_status"],
  PASSPORT: ["id_number", "issue_date", "expiry_date", "nationality", "place_of_birth"],
  PRC: ["id_number", "issue_date", "expiry_date", "prc_profession"],
  POSTAL: ["id_number", "expiry_date"],
  VOTERS: ["id_number"],
  SSS: ["id_number"],
  TIN: ["id_number"],
  PHILHEALTH: ["id_number"],
  SENIOR_CITIZEN: ["id_number"],
  PWD: ["id_number", "pwd_disability_type"],
};
