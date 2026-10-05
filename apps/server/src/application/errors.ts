export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export function errorBody(error: ApplicationError) {
  return { error: { code: error.code, message: error.message } };
}
