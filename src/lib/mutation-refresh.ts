export async function runMutationWithParentRefresh<T>(
  mutation: () => Promise<T>,
  refreshParent?: () => Promise<void>,
): Promise<T> {
  const result = await mutation();
  await refreshParent?.();
  return result;
}
