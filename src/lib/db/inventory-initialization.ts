import { supabase } from './supabaseClient';
import { InventoryItem } from './types';
import type { InventoryMonthlyInitializationBaseline } from './inventory-monthly-report';

export const getInventoryMonthlyInitializationBaselines = async (): Promise<InventoryMonthlyInitializationBaseline[]> => {
  const baselines: InventoryMonthlyInitializationBaseline[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('inventory_initialization_items')
      .select('id, inventory_item_id, inventory_initializations!inner(baseline_date, initialized_at)')
      .order('id')
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    for (const row of data || []) {
      // Supabase clients without generated schema types infer embeds as arrays.
      const initialization = Array.isArray(row.inventory_initializations)
        ? row.inventory_initializations[0]
        : row.inventory_initializations;
      if (!initialization?.baseline_date || !initialization.initialized_at) {
        throw new Error('庫存初始化基準資料不完整');
      }
      baselines.push({
        inventory_item_id: row.inventory_item_id,
        baseline_date: initialization.baseline_date,
        initialized_at: initialization.initialized_at,
      });
    }
    if ((data || []).length < pageSize) return baselines;
  }
};

export const getInventoryInitializationBaselineDate = async (): Promise<string | null> => {
  const { data, error } = await supabase.from('inventory_initialization_items')
    .select('inventory_initializations!inner(baseline_date)').limit(1).maybeSingle();
  if (error) throw error;
  const header = data?.inventory_initializations;
  const row = Array.isArray(header) ? header[0] : header;
  return row?.baseline_date ?? null;
};

export interface InitializationItemInput {
  id: string;
  new_opening_quantity: number;
  retained_in_stock_serial_ids?: string[];
}

export interface InitializationPreviewResult {
  item_id: string;
  name: string;
  requires_serial: boolean;
  current_opening_quantity: number;
  new_opening_quantity: number;
  in_stock_serial_count: number;
  out_serial_count: number;
  used_serial_count: number;
  returned_serial_count: number;
  scrapped_serial_count: number;
  voided_serial_count: number;
  pending_serial_count: number;
  can_initialize: boolean;
  error_reason: string | null;
  in_stock_serials?: { id: string; serial_number: string }[];
}

export interface InitializationStatus {
  already_initialized: boolean;
  can_execute_now?: boolean;
  earliest_initialization_date?: string;
  initialized_at?: string;
  baseline_date?: string;
  items?: InitializationPreviewResult[];
}

export const previewInventoryInitialization = async (items: InitializationItemInput[]): Promise<InitializationStatus> => {
  const { data, error } = await supabase.rpc('preview_inventory_initialization', {
    items: items,
  });

  if (error) {
    throw new Error(`Preview failed: ${error.message}`);
  }

  return data as InitializationStatus;
};

export const initializeInventory = async (items: InitializationItemInput[]): Promise<string> => {
  const { data, error } = await supabase.rpc('initialize_inventory', {
    items: items,
  });

  if (error) {
    throw new Error(`Initialization failed: ${error.message}`);
  }

  return data as string;
};
