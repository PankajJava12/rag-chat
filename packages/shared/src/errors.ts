export class AppError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public retryable = false,
  ) {
    super(code);
  }
}
export function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "PROCESSING_ERROR";
}
