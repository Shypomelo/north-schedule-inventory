import type { MaterialReceipt, ProjectMaterial, ProjectMaterialBatch } from './db/types';
import { summarizeMaterialReceipts } from './material-receiving';

export interface ProjectMaterialOverviewRow {
  key: string;
  name: string;
  specification: string;
  unit: string;
  ordered: number;
  received: number;
  remaining: number;
  sources: { materialId: string; batchId: string; batchName: string; quantity: number; received: number }[];
}

export function buildProjectMaterialOverview(
  projectId: string,
  materials: readonly ProjectMaterial[],
  batches: readonly ProjectMaterialBatch[],
  receipts: readonly MaterialReceipt[],
): ProjectMaterialOverviewRow[] {
  const batchNames = new Map(batches.filter(batch => batch.project_id === projectId).map(batch => [batch.id, batch.batch_name]));
  const uniqueReceipts = Array.from(new Map(receipts.map(receipt => [receipt.id, receipt])).values());
  const groups = new Map<string, ProjectMaterialOverviewRow>();
  for (const material of materials) {
    if (material.project_id !== projectId || !batchNames.has(material.batch_id)) continue;
    const name = material.item_name.trim();
    const specification = material.specification?.trim() || '';
    const unit = material.unit.trim();
    const key = JSON.stringify([name, specification, unit]);
    const received = summarizeMaterialReceipts(uniqueReceipts, 'PROJECT_MATERIAL', material.id, Number(material.quantity)).effectiveQuantity;
    const group = groups.get(key) || { key, name, specification, unit, ordered: 0, received: 0, remaining: 0, sources: [] };
    group.ordered += Number(material.quantity);
    group.received += received;
    group.remaining = Math.max(0, group.ordered - group.received);
    group.sources.push({ materialId: material.id, batchId: material.batch_id, batchName: batchNames.get(material.batch_id)!, quantity: Number(material.quantity), received });
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-TW') || a.specification.localeCompare(b.specification, 'zh-TW'));
}
