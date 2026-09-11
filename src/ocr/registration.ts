import type { IdType, PhIdOcrResult } from "./types";

export const DEFAULT_REGISTRATION_ENDPOINT =
  "https://registration-service-403247701908.asia-southeast1.run.app/api/v1/register";

/**
 * The confirmed request envelope for POST /api/v1/register: `id_data` is the only
 * property, and the only required one (RegistrationRequest in the service's OpenAPI
 * spec) - confirmed by directly probing the live endpoint, not assumed.
 *
 * client_reference and consent are deliberately NOT included here, even though we
 * know we'll need them: the service currently has no `additionalProperties: false`
 * on this schema, so extra top-level keys are silently dropped rather than rejected
 * - sending them today would look like it worked and actually do nothing. Add them
 * to this type (and to registerId's signature) once the service's contract actually
 * declares and requires them; see README Status for the open question sent back
 * proposing `client_reference` (string) and `consent: { given, timestamp }`.
 */
export interface RegistrationEnvelope {
  id_data: PhIdOcrResult;
}

/**
 * Confirmed shape of a successful (201) response - just an echo of id_type, no
 * registration ID or timestamp yet. We've asked for a `registration_id` and
 * `created_at` to be added; until that's confirmed, there is no way to reference a
 * submission after this call returns, so callers shouldn't assume they can look one
 * up later.
 */
export interface RegistrationSuccessResponse {
  status: string;
  message: string;
  id_type: IdType;
}

export class RegistrationError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/**
 * POSTs an OCR result to registration-service. Throws RegistrationError on any
 * non-2xx response, with the parsed response body attached (e.g. the 422 validation
 * error body, which names the specific invalid field) so callers can surface a
 * meaningful message instead of a generic failure.
 *
 * No authentication is sent - the service currently accepts unauthenticated POSTs
 * (confirmed: reaches validation, returns 422, not 401). That's flagged as a gap on
 * the service's end, not something for this function to work around; update this
 * once auth is added server-side.
 */
export async function registerId(
  payload: PhIdOcrResult,
  endpoint: string = DEFAULT_REGISTRATION_ENDPOINT
): Promise<RegistrationSuccessResponse> {
  const envelope: RegistrationEnvelope = { id_data: payload };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Empty or non-JSON body - leave body as null rather than failing the whole call.
  }

  if (!response.ok) {
    throw new RegistrationError(
      `registration-service responded ${response.status} to POST ${endpoint}`,
      response.status,
      body
    );
  }

  return body as RegistrationSuccessResponse;
}
