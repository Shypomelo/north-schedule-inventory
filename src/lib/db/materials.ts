import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConfirmMaterialReceiptInput,
  MaterialCatalogItem,
  MaterialCatalogItemCreateInput,
  MaterialCatalogItemUpdateInput,
  MaterialGroup,
  MaterialGroupCreateInput,
  MaterialGroupUpdateInput,
  MaterialReceipt,
  ProjectMaterialBatch,
  ProjectMaterialBatchCreateInput,
  ProjectMaterialBatchUpdateInput,
  ProjectMaterial,
  ProjectMaterialCreateInput,
  ProjectMaterialUpdateInput,
  ReverseMaterialReceiptInput,
} from './types';

const cleanNullableText = (value: string | null | undefined): string | null | undefined => {
  if (value === undefined) return undefined;
  const clean = value?.trim() || '';
  return clean || null;
};

const cleanCatalogCreate = (input: MaterialCatalogItemCreateInput) => ({
  ...input,
  group_name: cleanNullableText(input.group_name),
  name: input.name.trim(),
  default_specification: cleanNullableText(input.default_specification),
  default_unit: input.default_unit.trim(),
  default_reminder_days_before: input.default_reminder_enabled
    ? input.default_reminder_days_before
    : null,
});

const cleanGroupCreate = (input: MaterialGroupCreateInput) => ({
  ...input,
  name: input.name.trim(),
});

const cleanGroupUpdate = (input: MaterialGroupUpdateInput) => {
  const payload: Record<string, unknown> = { ...input };
  if (input.name !== undefined) payload.name = input.name.trim();
  return payload;
};

const cleanCatalogUpdate = (input: MaterialCatalogItemUpdateInput) => {
  const payload: Record<string, unknown> = { ...input };
  if (input.group_name !== undefined) payload.group_name = cleanNullableText(input.group_name);
  if (input.name !== undefined) payload.name = input.name.trim();
  if (input.default_specification !== undefined) {
    payload.default_specification = cleanNullableText(input.default_specification);
  }
  if (input.default_unit !== undefined) payload.default_unit = input.default_unit.trim();
  if (input.default_reminder_enabled === false) payload.default_reminder_days_before = null;
  return payload;
};

const cleanProjectMaterialCreate = (input: ProjectMaterialCreateInput) => ({
  ...input,
  item_name: input.item_name.trim(),
  specification: cleanNullableText(input.specification),
  unit: input.unit.trim(),
  reminder_days_before: input.reminder_enabled ? input.reminder_days_before : null,
  delivery_destination_note: input.delivery_destination === 'OTHER'
    ? cleanNullableText(input.delivery_destination_note)
    : null,
  notes: cleanNullableText(input.notes),
});

const cleanProjectMaterialUpdate = (input: ProjectMaterialUpdateInput) => {
  const payload: Record<string, unknown> = { ...input };
  if (input.item_name !== undefined) payload.item_name = input.item_name.trim();
  if (input.specification !== undefined) payload.specification = cleanNullableText(input.specification);
  if (input.unit !== undefined) payload.unit = input.unit.trim();
  if (input.notes !== undefined) payload.notes = cleanNullableText(input.notes);
  if (input.reminder_enabled === false) payload.reminder_days_before = null;
  if (input.delivery_destination !== undefined && input.delivery_destination !== 'OTHER') {
    payload.delivery_destination_note = null;
  } else if (input.delivery_destination_note !== undefined) {
    payload.delivery_destination_note = cleanNullableText(input.delivery_destination_note);
  }
  return payload;
};

const cleanBatchCreate = (input: ProjectMaterialBatchCreateInput) => ({
  ...input,
  batch_name: input.batch_name.trim(),
  notes: cleanNullableText(input.notes),
});

const cleanBatchUpdate = (input: ProjectMaterialBatchUpdateInput) => {
  const payload: Record<string, unknown> = { ...input };
  delete payload.planned_receipt_at;
  delete payload.received_at;
  if (input.batch_name !== undefined) payload.batch_name = input.batch_name.trim();
  if (input.notes !== undefined) payload.notes = cleanNullableText(input.notes);
  return payload;
};

export const createMaterialsAdapter = (client: SupabaseClient) => ({
  listMaterialGroups: async (includeInactive = false): Promise<MaterialGroup[]> => {
    let query = client
      .from('material_groups')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as MaterialGroup[];
  },

  createMaterialGroup: async (input: MaterialGroupCreateInput): Promise<MaterialGroup> => {
    const { data, error } = await client
      .from('material_groups')
      .insert(cleanGroupCreate(input))
      .select()
      .single();
    if (error) throw error;
    return data as MaterialGroup;
  },

  updateMaterialGroup: async (
    id: string,
    input: MaterialGroupUpdateInput,
  ): Promise<MaterialGroup> => {
    const { data, error } = await client
      .from('material_groups')
      .update(cleanGroupUpdate(input))
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as MaterialGroup;
  },

  listProjectMaterialBatches: async (projectId: string): Promise<ProjectMaterialBatch[]> => {
    const { data, error } = await client
      .from('project_material_batches')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    return (data ?? []) as ProjectMaterialBatch[];
  },

  createProjectMaterialBatch: async (
    input: ProjectMaterialBatchCreateInput,
  ): Promise<ProjectMaterialBatch> => {
    const { data, error } = await client
      .from('project_material_batches')
      .insert(cleanBatchCreate(input))
      .select()
      .single();
    if (error) throw error;
    return data as ProjectMaterialBatch;
  },

  updateProjectMaterialBatch: async (
    id: string,
    input: ProjectMaterialBatchUpdateInput,
  ): Promise<ProjectMaterialBatch> => {
    const { data, error } = await client
      .from('project_material_batches')
      .update(cleanBatchUpdate(input))
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as ProjectMaterialBatch;
  },

  updateMaterialReceiptPlan: async (
    batchId: string,
    plannedReceiptAt: string | null,
  ): Promise<ProjectMaterialBatch> => {
    const { data, error } = await client
      .rpc('update_material_receipt_plan', {
        p_batch_id: batchId,
        p_planned_receipt_at: plannedReceiptAt,
      })
      .single();
    if (error) throw error;
    return data as ProjectMaterialBatch;
  },

  setMaterialBatchSameDay: async (
    batchId: string,
    sameDayDelivery: boolean,
  ): Promise<ProjectMaterialBatch> => {
    const { data, error } = await client.rpc('set_material_batch_same_day', {
      p_batch_id: batchId,
      p_same_day_delivery: sameDayDelivery,
    }).single();
    if (error) throw error;
    return data as ProjectMaterialBatch;
  },

  updateMaterialReceiptOverride: async (
    materialId: string,
    expectedDeliveryAt: string | null,
  ): Promise<ProjectMaterial> => {
    const { data, error } = await client.rpc('update_material_receipt_override', {
      p_material_id: materialId,
      p_expected_delivery_at: expectedDeliveryAt,
    }).single();
    if (error) throw error;
    return data as ProjectMaterial;
  },

  rescheduleMaterialReceiptGroup: async (
    scheduleTaskId: string,
    expectedDeliveryAt: string,
  ): Promise<void> => {
    const { error } = await client.rpc('reschedule_material_receipt_group', {
      p_schedule_task_id: scheduleTaskId,
      p_expected_delivery_at: expectedDeliveryAt,
    });
    if (error) throw error;
  },

  completeMaterialReceiptSchedule: async (
    scheduleTaskId: string,
    completedAt: string,
  ): Promise<void> => {
    const { error } = await client.rpc('complete_material_receipt_schedule', {
      p_schedule_task_id: scheduleTaskId,
      p_completed_at: completedAt,
    });
    if (error) throw error;
  },

  deleteProjectMaterialBatch: async (id: string): Promise<void> => {
    const { error } = await client.from('project_material_batches').delete().eq('id', id);
    if (error) throw error;
  },

  listMaterialCatalogItems: async (includeInactive = false): Promise<MaterialCatalogItem[]> => {
    let query = client
      .from('material_catalog_items')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as MaterialCatalogItem[];
  },

  createMaterialCatalogItem: async (
    input: MaterialCatalogItemCreateInput,
  ): Promise<MaterialCatalogItem> => {
    const { data, error } = await client
      .from('material_catalog_items')
      .insert(cleanCatalogCreate(input))
      .select()
      .single();
    if (error) throw error;
    return data as MaterialCatalogItem;
  },

  updateMaterialCatalogItem: async (
    id: string,
    input: MaterialCatalogItemUpdateInput,
  ): Promise<MaterialCatalogItem> => {
    const { data, error } = await client
      .from('material_catalog_items')
      .update(cleanCatalogUpdate(input))
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as MaterialCatalogItem;
  },

  listProjectMaterials: async (projectId: string): Promise<ProjectMaterial[]> => {
    const { data, error } = await client
      .from('project_materials')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectMaterial[];
  },

  listProjectMaterialBatchesForReminder: async (
    projectIds: string[],
    _through: string,
  ): Promise<ProjectMaterialBatch[]> => {
    if (projectIds.length === 0) return [];
    const { data, error } = await client
      .from('project_material_batches')
      .select('*')
      .in('project_id', projectIds)
      .is('received_at', null)
      .order('planned_receipt_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectMaterialBatch[];
  },

  listProjectMaterialsByBatchIds: async (batchIds: string[]): Promise<ProjectMaterial[]> => {
    if (batchIds.length === 0) return [];
    const { data, error } = await client
      .from('project_materials')
      .select('*')
      .in('batch_id', batchIds)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectMaterial[];
  },

  listMaterialReceivingBatches: async (): Promise<ProjectMaterialBatch[]> => {
    const { data, error } = await client
      .from('project_material_batches')
      .select('*')
      .order('planned_receipt_at', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectMaterialBatch[];
  },

  listOfficeProjectMaterials: async (): Promise<ProjectMaterial[]> => {
    const { data, error } = await client
      .from('project_materials')
      .select('*')
      .eq('delivery_destination', 'OFFICE')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ProjectMaterial[];
  },

  listMaterialReceipts: async (): Promise<MaterialReceipt[]> => {
    const { data, error } = await client
      .from('material_receipts')
      .select('*')
      .order('received_at', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    return (data ?? []) as MaterialReceipt[];
  },

  confirmMaterialReceipt: async (
    input: ConfirmMaterialReceiptInput,
  ): Promise<MaterialReceipt> => {
    const { data, error } = await client
      .rpc('confirm_material_receipt', {
        p_source_type: input.sourceType,
        p_source_id: input.sourceId,
        p_quantity_received: input.quantityReceived,
        p_received_at: input.receivedAt,
        p_notes: cleanNullableText(input.notes),
      })
      .single();
    if (error) throw error;
    return data as MaterialReceipt;
  },

  reverseMaterialReceipt: async (
    input: ReverseMaterialReceiptInput,
  ): Promise<MaterialReceipt> => {
    const { data, error } = await client
      .rpc('reverse_material_receipt', {
        p_receipt_id: input.receiptId,
        p_quantity_reversed: input.quantityReversed,
        p_reversed_at: input.reversedAt,
        p_notes: cleanNullableText(input.notes),
      })
      .single();
    if (error) throw error;
    return data as MaterialReceipt;
  },

  createProjectMaterial: async (
    input: ProjectMaterialCreateInput,
  ): Promise<ProjectMaterial> => {
    const { data, error } = await client
      .from('project_materials')
      .insert(cleanProjectMaterialCreate(input))
      .select()
      .single();
    if (error) throw error;
    return data as ProjectMaterial;
  },

  updateProjectMaterial: async (
    id: string,
    input: ProjectMaterialUpdateInput,
  ): Promise<ProjectMaterial> => {
    const { data, error } = await client
      .from('project_materials')
      .update(cleanProjectMaterialUpdate(input))
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data as ProjectMaterial;
  },

  deleteProjectMaterial: async (id: string): Promise<void> => {
    const { error } = await client.from('project_materials').delete().eq('id', id);
    if (error) throw error;
  },
});
