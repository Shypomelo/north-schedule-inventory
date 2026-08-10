export const MISSING_CORE_TABLES_MESSAGE =
  'Supabase 缺少資料表：projects / contractors / project_construction_progress，請先執行 create-missing-core-tables.sql';

export function isMissingCoreTablesError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const maybeError = error as { code?: unknown; message?: unknown };
  return (
    maybeError.code === 'PGRST205' ||
    maybeError.message === MISSING_CORE_TABLES_MESSAGE ||
    (typeof maybeError.message === 'string' && maybeError.message.includes('PGRST205')) ||
    (typeof maybeError.message === 'string' && maybeError.message.includes('schema cache'))
  );
}

export function getDatabaseErrorMessage(error: unknown, fallback: string): string {
  if (isMissingCoreTablesError(error)) {
    return MISSING_CORE_TABLES_MESSAGE;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return fallback;
}

export function throwMissingCoreTablesErrorIfNeeded(error: unknown): void {
  if (isMissingCoreTablesError(error)) {
    throw new Error(MISSING_CORE_TABLES_MESSAGE);
  }
}
