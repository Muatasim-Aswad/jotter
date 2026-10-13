// Generated from packages/protocol/openapi.json. Do not edit.
interface Validator {
  (value: unknown): boolean;
  errors?: Array<{ keyword: string; instancePath: string }> | null;
}
export const Envelope: Validator;
export const BootstrapResponse: Validator;
export const ConflictListResponse: Validator;
export const ResolveRequest: Validator;
export const ResolveResponse: Validator;
export const HealthResponse: Validator;
export const HttpErrorResponse: Validator;
