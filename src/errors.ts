export class ControllerError extends Error {
  readonly code: string;
  readonly detailsPath: string | null;

  constructor(code: string, message: string, detailsPath: string | null = null) {
    super(message);
    this.name = "ControllerError";
    this.code = code;
    this.detailsPath = detailsPath;
  }
}

export function asControllerError(error: unknown, fallbackCode = "unexpected_error"): ControllerError {
  if (error instanceof ControllerError) return error;
  if (error instanceof Error) return new ControllerError(fallbackCode, error.message);
  return new ControllerError(fallbackCode, String(error));
}
