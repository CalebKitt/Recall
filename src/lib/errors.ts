/**
 * Framework-free error types.
 *
 * Kept separate from `api.ts` so the service layer can throw these without
 * pulling `next/server` into the import graph — which is what lets the same
 * services run under plain Node in the integration tests.
 */

/** An expected, user-facing failure. `status` becomes the HTTP status. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
