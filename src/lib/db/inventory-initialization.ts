import { supabase } from './supabaseClient';
import { InventoryItem } from './types';

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
