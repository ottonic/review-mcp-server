/**
 * Normalize a thrown value into a stable code and a model-readable message.
 * Domain errors carry `code`; anything else becomes `internal_error`.
 */
export function describeError(error: unknown): { code: string; message: string } {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const raw = error as { code?: unknown; message?: unknown };
    if (typeof raw.code === 'string') {
      return { code: raw.code, message: typeof raw.message === 'string' ? raw.message : '' };
    }
  }
  return {
    code: 'internal_error',
    message: error instanceof Error ? error.message : String(error),
  };
}
