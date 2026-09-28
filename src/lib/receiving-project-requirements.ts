export interface ReceivingProjectRequirement {
  id: string; batch_id: string; batch_name: string; item_name: string; specification: string | null;
  unit: string; quantity: number; received: number; created_at: string;
}
export function compatibleProjectRequirements(rows: ReceivingProjectRequirement[], quantity: number) {
  return rows.filter(r => Number(r.quantity) - Number(r.received) >= quantity && Number(r.quantity) > Number(r.received));
}
export function selectProjectRequirement(rows: ReceivingProjectRequirement[], quantity: number, explicit: string) {
  const compatible = compatibleProjectRequirements(rows, quantity);
  if (explicit) return compatible.some(r => r.id === explicit) ? { materialId: explicit, createNew: false } : null;
  if (compatible.length === 1) return { materialId: compatible[0].id, createNew: false };
  if (!compatible.length) return { materialId: null, createNew: true };
  return null;
}
