export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (what = 'Forbidden') => new HttpError(403, what);
export const badRequest = (what: string) => new HttpError(400, what);
export const conflict = (what: string) => new HttpError(409, what);
