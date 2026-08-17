import { supabase } from './supabaseClient';
import {
  ScheduleTask,
  User,
  UserRole,
  Contractor,
  Project,
  InventoryItem,
  InventoryTransaction,
  InventorySerial,
  InventoryTransactionSerial,
  InventoryBatch,
  InventoryMonthlyClosing,
  InventoryMonthlyClosingItem,
  ActivityLog,
} from './types';
import { throwMissingCoreTablesErrorIfNeeded } from './supabase-errors';
import { getInventoryTransactionQuantityDelta } from './inventory-stock';

const mapUser = (row: any): User => ({
  id: row.id,
  name: row.name,
  short_name: row.name.charAt(0),
  email: row.email,
  role: (row.role || 'viewer').toUpperCase() as UserRole,
  category: (row.category || 'other').toUpperCase() as 'ENGINEERING' | 'OTHER',
  is_active: row.is_active ?? true,
  google_calendar_email: row.google_calendar_email || null,
  notes: row.notes || null,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const toNumber = (value: number | string | null | undefined): number => {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const SERIAL_STATUS_IN_STOCK = '在庫';
const SERIAL_STATUS_OUT = '已出庫';
const SERIAL_STATUS_RETURNED = '已退回';

const mapInventoryItem = (row: any): InventoryItem => ({
  id: row.id,
  code: row.code || '',
  category: row.category || '',
  item_category: row.item_category || null,
  name: row.name || '',
  source_type: row.source_type || null,
  unit: row.unit || '',
  opening_quantity: toNumber(row.opening_quantity),
  low_stock_threshold: toNumber(row.low_stock_threshold),
  requires_serial: !!row.requires_serial,
  notes: row.notes || null,
  is_active: row.is_active ?? true,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const buildInventoryItemPayload = (
  item: Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>>,
  options: { isNew?: boolean } = {},
): Record<string, any> => {
  const payload: Record<string, any> = {};

  if (item.code !== undefined) payload.code = item.code;
  if (item.category !== undefined) payload.category = item.category;
  if (item.item_category !== undefined) payload.item_category = item.item_category || null;
  if (item.name !== undefined) payload.name = item.name;
  if (item.source_type !== undefined) payload.source_type = item.source_type || null;
  if (item.unit !== undefined) payload.unit = item.unit;
  if (item.opening_quantity !== undefined) payload.opening_quantity = toNumber(item.opening_quantity);
  if (item.low_stock_threshold !== undefined) payload.low_stock_threshold = toNumber(item.low_stock_threshold);
  if (item.requires_serial !== undefined) payload.requires_serial = !!item.requires_serial;
  if (item.notes !== undefined) payload.notes = item.notes || null;
  if (item.is_active !== undefined) payload.is_active = !!item.is_active;

  if (options.isNew) {
    payload.code = payload.code || `ITEM-${Date.now()}`;
    payload.category = payload.category || '';
    payload.name = payload.name || '';
    payload.unit = payload.unit || '';
    payload.opening_quantity = payload.opening_quantity ?? 0;
    payload.low_stock_threshold = payload.low_stock_threshold ?? 0;
    payload.requires_serial = payload.requires_serial ?? false;
    payload.is_active = payload.is_active ?? true;
  } else {
    payload.updated_at = new Date().toISOString();
  }

  return payload;
};

const resolveUniqueInventoryItemCode = async (baseCode: string): Promise<string> => {
  const normalizedBaseCode = baseCode.trim() || `ITEM-${Date.now()}`;
  let candidate = normalizedBaseCode;

  for (let attempt = 0; attempt < 100; attempt++) {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('id')
      .eq('code', candidate)
      .maybeSingle();

    if (error) {
      console.error('Error checking inventory_item code:', error);
      throw error;
    }

    if (!data) return candidate;
    candidate = `${normalizedBaseCode}-${attempt + 2}`;
  }

  return `${normalizedBaseCode}-${Date.now()}`;
};

const mapInventoryTransaction = (row: any): InventoryTransaction => ({
  id: row.id,
  item_id: row.item_id,
  transaction_type: row.transaction_type,
  transaction_date: row.transaction_date,
  quantity: toNumber(row.quantity),
  unit: row.unit || null,
  project_id: row.project_id || null,
  project_name: row.project_name || null,
  handler: row.handler || null,
  source: row.source || null,
  notes: row.notes || null,
  pending_serial_count: toNumber(row.pending_serial_count),
  is_voided: !!row.is_voided,
  voided_reason: row.voided_reason || null,
  voided_by: row.voided_by || null,
  voided_at: row.voided_at || null,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const mapInventoryBatch = (row: any): InventoryBatch => ({
  id: row.id,
  batch_number: row.batch_number || '',
  item_id: row.item_id,
  in_date: row.in_date,
  source: row.source || null,
  quantity: toNumber(row.quantity),
  unit: row.unit || null,
  handler: row.handler || null,
  notes: row.notes || null,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const mapInventorySerial = (row: any): InventorySerial => ({
  id: row.id,
  item_id: row.item_id,
  batch_id: row.batch_id || null,
  serial_number: row.serial_number || '',
  status: row.status || '',
  project_id: row.project_id || null,
  notes: row.notes || null,
  created_at: row.created_at || new Date().toISOString(),
  updated_at: row.updated_at || new Date().toISOString(),
});

const mapInventoryTransactionSerial = (row: any): InventoryTransactionSerial => ({
  id: row.id,
  transaction_id: row.transaction_id,
  serial_id: row.serial_id || null,
  serial_no: row.serial_no || null,
  is_pending: !!row.is_pending,
  created_at: row.created_at || new Date().toISOString(),
});

const mapInventoryMonthlyClosing = (row: any): InventoryMonthlyClosing => ({
  id: row.id,
  year: row.year || '',
  month: row.month || '',
  closed_at: row.closed_at || new Date().toISOString(),
  closed_by: row.closed_by || '',
  status: row.status || '',
  notes: row.notes || null,
});

const mapInventoryMonthlyClosingItem = (row: any): InventoryMonthlyClosingItem => ({
  id: row.id,
  closing_id: row.closing_id,
  inventory_item_id: row.inventory_item_id || '',
  stock_category: row.stock_category || '',
  source: row.source || '',
  item_name: row.item_name || '',
  item_type: row.item_type || '',
  unit: row.unit || '',
  opening_quantity: toNumber(row.opening_quantity),
  monthly_in: toNumber(row.monthly_in),
  monthly_out: toNumber(row.monthly_out),
  monthly_return: toNumber(row.monthly_return),
  monthly_adjust: toNumber(row.monthly_adjust),
  closing_quantity: toNumber(row.closing_quantity),
  usage_quantity: toNumber(row.usage_quantity),
  status: row.status || '',
  notes: row.notes || null,
});

const mapActivityLog = (row: any): ActivityLog => ({
  id: String(row.id),
  actor_user_id: row.actor_user_id || row.user_id || 'system',
  actor_name: row.actor_name || row.user_name || 'system',
  action_type: row.action_type || row.action,
  target_type: row.target_type,
  target_id: row.target_id,
  target_label: row.target_label || row.description || '',
  project_id: row.project_id || null,
  project_name: row.project_name || null,
  before_value: row.before_value || (row.changes?.before ? JSON.stringify(row.changes.before) : null),
  after_value: row.after_value || (row.changes?.after ? JSON.stringify(row.changes.after) : null),
  message: row.message || row.description || null,
  created_at: row.created_at || new Date().toISOString(),
});

const buildActivityLogPayload = (log: Omit<ActivityLog, 'id' | 'created_at'>): Record<string, any> => {
  let beforeJson: any = null;
  let afterJson: any = null;

  try {
    beforeJson = log.before_value ? JSON.parse(log.before_value) : null;
  } catch {
    beforeJson = log.before_value;
  }

  try {
    afterJson = log.after_value ? JSON.parse(log.after_value) : null;
  } catch {
    afterJson = log.after_value;
  }

  return {
    action: log.action_type,
    target_type: log.target_type,
    target_id: log.target_id,
    description: log.message || log.target_label || null,
    changes: {
      before: beforeJson,
      after: afterJson,
    },
    user_id: log.actor_user_id || 'system',
    user_name: log.actor_name || 'system',
    actor_user_id: log.actor_user_id || 'system',
    actor_name: log.actor_name || 'system',
    action_type: log.action_type,
    target_label: log.target_label || '',
    project_id: log.project_id || null,
    project_name: log.project_name || null,
    before_value: log.before_value || null,
    after_value: log.after_value || null,
    message: log.message || null,
  };
};

const fetchInventoryItemsFromSupabase = async (): Promise<InventoryItem[]> => {
  const { data, error } = await supabase
    .from('inventory_items')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    console.error('Error fetching inventory_items:', error);
    throw error;
  }

  return (data || []).map(mapInventoryItem);
};

const createInventoryItemInSupabase = async (
  item: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>,
): Promise<InventoryItem> => {
  const payload = buildInventoryItemPayload(item, { isNew: true });
  payload.code = await resolveUniqueInventoryItemCode(String(payload.code || ''));

  const { data, error } = await supabase
    .from('inventory_items')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('Error creating inventory_item:', error);
    throw error;
  }

  return mapInventoryItem(data);
};

const updateInventoryItemInSupabase = async (
  id: string,
  updates: Partial<Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>>,
): Promise<InventoryItem> => {
  const { data, error } = await supabase
    .from('inventory_items')
    .update(buildInventoryItemPayload(updates))
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating inventory_item:', error);
    throw error;
  }

  return mapInventoryItem(data);
};

const deleteInventoryItemFromSupabase = async (id: string): Promise<void> => {
  const { error } = await supabase
    .from('inventory_items')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    console.error('Error deleting inventory_item:', error);
    throw error;
  }
};

const fetchInventoryTransactionsFromSupabase = async (): Promise<InventoryTransaction[]> => {
  const { data, error } = await supabase
    .from('inventory_transactions')
    .select('*')
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching inventory_transactions:', error);
    throw error;
  }

  return (data || []).map(mapInventoryTransaction);
};

const fetchInventorySerialsFromSupabase = async (): Promise<InventorySerial[]> => {
  const { data, error } = await supabase
    .from('inventory_serials')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching inventory_serials:', error);
    throw error;
  }

  return (data || []).map(mapInventorySerial);
};

const fetchInventoryTransactionSerialsFromSupabase = async (): Promise<InventoryTransactionSerial[]> => {
  const { data, error } = await supabase
    .from('inventory_transaction_serials')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching inventory_transaction_serials:', error);
    throw error;
  }

  return (data || []).map(mapInventoryTransactionSerial);
};

const createInventorySerialInSupabase = async (
  serial: Omit<InventorySerial, 'id' | 'created_at' | 'updated_at'>,
): Promise<InventorySerial> => {
  const payload = {
    item_id: serial.item_id,
    batch_id: serial.batch_id || null,
    serial_number: serial.serial_number,
    status: serial.status,
    project_id: serial.project_id || null,
    notes: serial.notes || null,
  };

  const { data, error } = await supabase
    .from('inventory_serials')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('Error creating inventory_serial:', error);
    throw error;
  }

  return mapInventorySerial(data);
};

const updateInventorySerialInSupabase = async (
  id: string,
  updates: Partial<Omit<InventorySerial, 'id' | 'created_at' | 'updated_at'>>,
): Promise<InventorySerial> => {
  const payload: Record<string, any> = {};
  if (updates.item_id !== undefined) payload.item_id = updates.item_id;
  if (updates.batch_id !== undefined) payload.batch_id = updates.batch_id || null;
  if (updates.serial_number !== undefined) payload.serial_number = updates.serial_number;
  if (updates.status !== undefined) payload.status = updates.status;
  if (updates.project_id !== undefined) payload.project_id = updates.project_id || null;
  if (updates.notes !== undefined) payload.notes = updates.notes || null;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('inventory_serials')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating inventory_serial:', error);
    throw error;
  }

  return mapInventorySerial(data);
};

const deleteInventorySerialFromSupabase = async (id: string): Promise<void> => {
  const { error } = await supabase
    .from('inventory_serials')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('Error deleting inventory_serial:', error);
    throw error;
  }
};

const updateInventoryTransactionSerialInSupabase = async (
  id: string,
  updates: Partial<Omit<InventoryTransactionSerial, 'id' | 'transaction_id' | 'created_at'>>,
): Promise<InventoryTransactionSerial> => {
  const payload: Record<string, any> = {};
  if (updates.serial_id !== undefined) payload.serial_id = updates.serial_id || null;
  if (updates.serial_no !== undefined) payload.serial_no = updates.serial_no || null;
  if (updates.is_pending !== undefined) payload.is_pending = updates.is_pending;

  const { data, error } = await supabase
    .from('inventory_transaction_serials')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating inventory_transaction_serial:', error);
    throw error;
  }

  return mapInventoryTransactionSerial(data);
};

const buildInventoryTransactionPayload = (
  transaction: Partial<InventoryTransaction>,
  options: { isNew?: boolean } = {},
): Record<string, any> => {
  const payload: Record<string, any> = {};

  if (transaction.item_id !== undefined) payload.item_id = transaction.item_id;
  if (transaction.transaction_type !== undefined) payload.transaction_type = transaction.transaction_type;
  if (transaction.transaction_date !== undefined) payload.transaction_date = transaction.transaction_date;
  if (transaction.quantity !== undefined) payload.quantity = transaction.quantity;
  if (transaction.unit !== undefined) payload.unit = transaction.unit || null;
  if (transaction.project_id !== undefined) payload.project_id = transaction.project_id || null;
  if (transaction.project_name !== undefined) payload.project_name = transaction.project_name || null;
  if (transaction.handler !== undefined) payload.handler = transaction.handler || null;
  if (transaction.source !== undefined) payload.source = transaction.source || null;
  if (transaction.notes !== undefined) payload.notes = transaction.notes || null;
  if (transaction.pending_serial_count !== undefined) {
    payload.pending_serial_count = toNumber(transaction.pending_serial_count);
  }
  if (transaction.is_voided !== undefined) payload.is_voided = !!transaction.is_voided;
  if (transaction.voided_reason !== undefined) payload.voided_reason = transaction.voided_reason || null;
  if (transaction.voided_by !== undefined) payload.voided_by = transaction.voided_by || null;
  if (transaction.voided_at !== undefined) payload.voided_at = transaction.voided_at || null;

  if (options.isNew) {
    payload.is_voided = false;
  } else {
    payload.updated_at = new Date().toISOString();
  }

  return payload;
};

const createInventoryBatchForTransaction = async (
  transaction: InventoryTransaction | Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'>,
  user: string,
): Promise<InventoryBatch | null> => {
  if (transaction.transaction_type !== 'IN' && transaction.transaction_type !== 'RETURN') return null;

  const ymd = transaction.transaction_date.replace(/-/g, '');
  const prefix = `IN-${ymd}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const { count, error: countError } = await supabase
      .from('inventory_batches')
      .select('id', { count: 'exact', head: true })
      .like('batch_number', `${prefix}%`);

    if (countError) {
      console.error('Error counting inventory_batches:', countError);
      throw countError;
    }

    const batchNumber = `${prefix}${String((count || 0) + 1 + attempt).padStart(3, '0')}`;
    const payload = {
      batch_number: batchNumber,
      item_id: transaction.item_id,
      in_date: transaction.transaction_date,
      source: transaction.source || (transaction.transaction_type === 'RETURN' ? '退料' : null),
      quantity: transaction.quantity,
      unit: transaction.unit || null,
      handler: transaction.handler || user,
      notes: transaction.notes || null,
    };

    const { data, error } = await supabase
      .from('inventory_batches')
      .insert(payload)
      .select()
      .single();

    if (!error) return mapInventoryBatch(data);
    if (error.code !== '23505') {
      console.error('Error creating inventory_batch:', error);
      throw error;
    }
  }

  throw new Error('Unable to create a unique inventory batch number');
};

const resolveInventorySerial = async (
  serial: Partial<InventoryTransactionSerial>,
  itemId: string,
): Promise<InventorySerial | null> => {
  if (serial.serial_id) {
    const { data, error } = await supabase
      .from('inventory_serials')
      .select('*')
      .eq('id', serial.serial_id)
      .maybeSingle();

    if (error) {
      console.error('Error resolving inventory_serial by id:', error);
      throw error;
    }
    if (data) return mapInventorySerial(data);
  }

  if (serial.serial_no) {
    const { data, error } = await supabase
      .from('inventory_serials')
      .select('*')
      .eq('item_id', itemId)
      .eq('serial_number', serial.serial_no)
      .maybeSingle();

    if (error) {
      console.error('Error resolving inventory_serial by serial_no:', error);
      throw error;
    }
    if (data) return mapInventorySerial(data);
  }

  return null;
};

const getSerialUpdateForTransaction = (
  transactionType: InventoryTransaction['transaction_type'],
  projectId: string | null | undefined,
  batchId?: string | null,
): Record<string, any> | null => {
  const payload: Record<string, any> = { updated_at: new Date().toISOString() };
  if (batchId) payload.batch_id = batchId;

  if (transactionType === 'IN') {
    payload.status = SERIAL_STATUS_IN_STOCK;
  } else if (transactionType === 'OUT') {
    payload.status = SERIAL_STATUS_OUT;
    payload.project_id = projectId || null;
  } else if (transactionType === 'RETURN') {
    payload.status = SERIAL_STATUS_RETURNED;
  } else {
    return batchId ? payload : null;
  }

  return payload;
};

const updateSerialForTransaction = async (
  serialId: string,
  transactionType: InventoryTransaction['transaction_type'],
  projectId: string | null | undefined,
  batchId?: string | null,
) => {
  const payload = getSerialUpdateForTransaction(transactionType, projectId, batchId);
  if (!payload) return;

  const { error } = await supabase
    .from('inventory_serials')
    .update(payload)
    .eq('id', serialId);

  if (error) {
    console.error('Error syncing inventory_serial for transaction:', error);
    throw error;
  }
};

const insertTransactionSerialLinks = async (
  transaction: InventoryTransaction,
  serialsData: Omit<InventoryTransactionSerial, 'id' | 'transaction_id' | 'created_at'>[] = [],
  batchIdToLink: string | null = null,
) => {
  for (const serialData of serialsData) {
    const serial = await resolveInventorySerial(serialData, transaction.item_id);
    const serialId = serial?.id || null;
    const serialNo = serialData.serial_no || serial?.serial_number || null;

    if (serialId) {
      await updateSerialForTransaction(serialId, transaction.transaction_type, transaction.project_id, batchIdToLink);
    }

    const payload = {
      transaction_id: transaction.id,
      serial_id: serialId,
      serial_no: serialNo,
      is_pending: !!serialData.is_pending,
    };

    const { error } = await supabase
      .from('inventory_transaction_serials')
      .insert(payload);

    if (error) {
      console.error('Error creating inventory_transaction_serial:', error);
      throw error;
    }
  }
};

const revertSerialsForTransaction = async (transaction: InventoryTransaction) => {
  const { data, error } = await supabase
    .from('inventory_transaction_serials')
    .select('*')
    .eq('transaction_id', transaction.id);

  if (error) {
    console.error('Error fetching transaction serial links:', error);
    throw error;
  }

  const txSerials = (data || []).map(mapInventoryTransactionSerial);

  if (transaction.transaction_type === 'IN') {
    for (const txSerial of txSerials) {
      if (!txSerial.serial_id) continue;
      const { data: serialData, error: serialError } = await supabase
        .from('inventory_serials')
        .select('*')
        .eq('id', txSerial.serial_id)
        .maybeSingle();

      if (serialError) {
        console.error('Error checking inventory_serial before IN revert:', serialError);
        throw serialError;
      }

      if (serialData && serialData.status !== SERIAL_STATUS_IN_STOCK) {
        throw new Error('Cannot void or edit an IN transaction after its serial has already left stock');
      }
    }
  }

  for (const txSerial of txSerials) {
    if (!txSerial.serial_id) continue;

    if (transaction.transaction_type === 'OUT') {
      await updateInventorySerialInSupabase(txSerial.serial_id, { status: SERIAL_STATUS_IN_STOCK });
    } else if (transaction.transaction_type === 'RETURN') {
      await updateInventorySerialInSupabase(txSerial.serial_id, { status: SERIAL_STATUS_OUT });
    } else if (transaction.transaction_type === 'IN') {
      await deleteInventorySerialFromSupabase(txSerial.serial_id);
    }
  }

  return txSerials;
};

const createInventoryTransactionInSupabase = async (
  transaction: Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'>,
  serialsData: Omit<InventoryTransactionSerial, 'id' | 'transaction_id' | 'created_at'>[] = [],
  user: string = 'system',
): Promise<InventoryTransaction> => {
  const payload = buildInventoryTransactionPayload(transaction, { isNew: true });

  const { data, error } = await supabase
    .from('inventory_transactions')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('Error creating inventory_transaction:', error);
    throw error;
  }

  const createdTransaction = mapInventoryTransaction(data);
  const batch = await createInventoryBatchForTransaction(createdTransaction, user);
  await insertTransactionSerialLinks(createdTransaction, serialsData, batch?.id || null);
  await logActivityInSupabase({
    actor_user_id: 'system',
    actor_name: user,
    action_type: 'CREATE_TRANSACTION',
    target_type: 'INVENTORY_TRANSACTION',
    target_id: createdTransaction.id,
    target_label: '建立異動紀錄',
    project_id: createdTransaction.project_id,
    project_name: createdTransaction.project_name,
    before_value: null,
    after_value: JSON.stringify(createdTransaction),
    message: null,
  });

  return createdTransaction;
};

const updateInventoryTransactionInSupabase = async (
  id: string,
  updates: Partial<Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'>>,
  serialsData: Omit<InventoryTransactionSerial, 'id' | 'transaction_id' | 'created_at'>[] = [],
  reason: string,
  user: string,
): Promise<InventoryTransaction> => {
  const { data: existingData, error: existingError } = await supabase
    .from('inventory_transactions')
    .select('*')
    .eq('id', id)
    .single();

  if (existingError) {
    console.error('Error fetching inventory_transaction before update:', existingError);
    throw existingError;
  }

  const existingTransaction = mapInventoryTransaction(existingData);
  if (existingTransaction.is_voided) {
    throw new Error('Cannot update a voided inventory transaction');
  }

  await revertSerialsForTransaction(existingTransaction);

  const payload = buildInventoryTransactionPayload(updates);
  if (reason) payload.notes = updates.notes !== undefined ? updates.notes : existingTransaction.notes;

  const { data, error } = await supabase
    .from('inventory_transactions')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('Error updating inventory_transaction:', error);
    throw error;
  }

  const updatedTransaction = mapInventoryTransaction(data);

  const { error: deleteLinksError } = await supabase
    .from('inventory_transaction_serials')
    .delete()
    .eq('transaction_id', id);

  if (deleteLinksError) {
    console.error('Error deleting old inventory_transaction_serials:', deleteLinksError);
    throw deleteLinksError;
  }

  const shouldCreateBatch =
    (updatedTransaction.transaction_type === 'IN' || updatedTransaction.transaction_type === 'RETURN') &&
    existingTransaction.transaction_type !== updatedTransaction.transaction_type;
  const batch = shouldCreateBatch ? await createInventoryBatchForTransaction(updatedTransaction, user) : null;
  await insertTransactionSerialLinks(updatedTransaction, serialsData, batch?.id || null);
  await logActivityInSupabase({
    actor_user_id: 'system',
    actor_name: user,
    action_type: 'UPDATE_TRANSACTION',
    target_type: 'INVENTORY_TRANSACTION',
    target_id: updatedTransaction.id,
    target_label: '編輯異動紀錄',
    project_id: updatedTransaction.project_id,
    project_name: updatedTransaction.project_name,
    before_value: JSON.stringify(existingTransaction),
    after_value: JSON.stringify(updatedTransaction),
    message: reason,
  });

  return updatedTransaction;
};

const voidInventoryTransactionInSupabase = async (
  id: string,
  reason: string,
  user: string,
): Promise<void> => {
  const { data, error: fetchError } = await supabase
    .from('inventory_transactions')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError) {
    console.error('Error fetching inventory_transaction before void:', fetchError);
    throw fetchError;
  }

  const transaction = mapInventoryTransaction(data);
  if (transaction.is_voided) {
    throw new Error('Inventory transaction is already voided');
  }

  await revertSerialsForTransaction(transaction);

  const { error } = await supabase
    .from('inventory_transactions')
    .update({
      is_voided: true,
      voided_reason: reason,
      voided_by: user,
      voided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    console.error('Error voiding inventory_transaction:', error);
    throw error;
  }

  const voidedTransaction: InventoryTransaction = {
    ...transaction,
    is_voided: true,
    voided_reason: reason,
    voided_by: user,
    voided_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await logActivityInSupabase({
    actor_user_id: 'system',
    actor_name: user,
    action_type: 'VOID_TRANSACTION',
    target_type: 'INVENTORY_TRANSACTION',
    target_id: transaction.id,
    target_label: '作廢異動紀錄',
    project_id: transaction.project_id,
    project_name: transaction.project_name,
    before_value: JSON.stringify(transaction),
    after_value: JSON.stringify(voidedTransaction),
    message: reason,
  });
};

const fetchInventoryBatchesFromSupabase = async (): Promise<InventoryBatch[]> => {
  const { data, error } = await supabase
    .from('inventory_batches')
    .select('*')
    .order('in_date', { ascending: false })
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching inventory_batches:', error);
    throw error;
  }

  return (data || []).map(mapInventoryBatch);
};

const fetchInventoryMonthlyClosingsFromSupabase = async (): Promise<InventoryMonthlyClosing[]> => {
  const { data, error } = await supabase
    .from('inventory_monthly_closings')
    .select('*')
    .order('year', { ascending: false })
    .order('month', { ascending: false });

  if (error) {
    console.error('Error fetching inventory_monthly_closings:', error);
    throw error;
  }

  return (data || []).map(mapInventoryMonthlyClosing);
};

const fetchInventoryMonthlyClosingItemsFromSupabase = async (
  closingId: string,
): Promise<InventoryMonthlyClosingItem[]> => {
  const { data, error } = await supabase
    .from('inventory_monthly_closing_items')
    .select('*')
    .eq('closing_id', closingId)
    .order('item_name', { ascending: true });

  if (error) {
    console.error('Error fetching inventory_monthly_closing_items:', error);
    throw error;
  }

  return (data || []).map(mapInventoryMonthlyClosingItem);
};

const createMonthlyClosingInSupabase = async (
  closing: Omit<InventoryMonthlyClosing, 'id'>,
  items: Omit<InventoryMonthlyClosingItem, 'id' | 'closing_id'>[],
): Promise<InventoryMonthlyClosing> => {
  const { data: existingClosing, error: existingError } = await supabase
    .from('inventory_monthly_closings')
    .select('id')
    .eq('year', closing.year)
    .eq('month', closing.month)
    .maybeSingle();

  if (existingError) {
    console.error('Error checking inventory_monthly_closings:', existingError);
    throw existingError;
  }

  if (existingClosing) {
    const { error: deleteError } = await supabase
      .from('inventory_monthly_closings')
      .delete()
      .eq('id', existingClosing.id);

    if (deleteError) {
      console.error('Error replacing inventory_monthly_closing:', deleteError);
      throw deleteError;
    }
  }

  const { data, error } = await supabase
    .from('inventory_monthly_closings')
    .insert({
      year: closing.year,
      month: closing.month,
      closed_at: closing.closed_at,
      closed_by: closing.closed_by,
      status: closing.status,
      notes: closing.notes || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Error creating inventory_monthly_closing:', error);
    throw error;
  }

  const createdClosing = mapInventoryMonthlyClosing(data);
  if (items.length > 0) {
    const itemPayloads = items.map((item) => ({
      closing_id: createdClosing.id,
      inventory_item_id: item.inventory_item_id || null,
      stock_category: item.stock_category,
      source: item.source,
      item_name: item.item_name,
      item_type: item.item_type,
      unit: item.unit,
      opening_quantity: item.opening_quantity,
      monthly_in: item.monthly_in,
      monthly_out: item.monthly_out,
      monthly_return: item.monthly_return,
      monthly_adjust: item.monthly_adjust,
      closing_quantity: item.closing_quantity,
      usage_quantity: item.usage_quantity,
      status: item.status,
      notes: item.notes || null,
    }));

    const { error: itemsError } = await supabase
      .from('inventory_monthly_closing_items')
      .insert(itemPayloads);

    if (itemsError) {
      console.error('Error creating inventory_monthly_closing_items:', itemsError);
      throw itemsError;
    }
  }

  return createdClosing;
};

const fetchActivityLogsFromSupabase = async (): Promise<ActivityLog[]> => {
  const { data, error } = await supabase
    .from('activity_logs')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching activity_logs:', error);
    throw error;
  }

  return (data || []).map(mapActivityLog);
};

const logActivityInSupabase = async (
  log: Omit<ActivityLog, 'id' | 'created_at'>,
): Promise<ActivityLog> => {
  const { data, error } = await supabase
    .from('activity_logs')
    .insert(buildActivityLogPayload(log))
    .select()
    .single();

  if (error) {
    console.error('Error creating activity_log:', error);
    throw error;
  }

  return mapActivityLog(data);
};

const calculateInventoryBalancesFromSupabase = async (): Promise<{ item_id: string; balance: number }[]> => {
  const [items, transactions] = await Promise.all([
    fetchInventoryItemsFromSupabase(),
    fetchInventoryTransactionsFromSupabase(),
  ]);

  const balances: Record<string, number> = {};

  items.forEach((item) => {
    balances[item.id] = item.opening_quantity || 0;
  });

  transactions.forEach((tx) => {
    if (tx.is_voided) return;

    const key = tx.item_id;
    if (balances[key] === undefined) balances[key] = 0;

    balances[key] += getInventoryTransactionQuantityDelta(tx.transaction_type, tx.quantity);
  });

  return Object.keys(balances).map((item_id) => {
    return {
      item_id,
      balance: balances[item_id],
    };
  });
};

const syncProjectProgress = async (projectId: string, p: Partial<Project>) => {
  const workTypes = ['racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other'];
  
  const { data: contractorsData, error: contractorsError } = await supabase.from('contractors').select('id, name');
  throwMissingCoreTablesErrorIfNeeded(contractorsError);
  const contractorsMap = new Map((contractorsData || []).map((c: any) => [c.id, c.name]));

  const { data: existingProgress, error: progressError } = await supabase
    .from('project_construction_progress')
    .select('*')
    .eq('project_id', projectId);
  throwMissingCoreTablesErrorIfNeeded(progressError);
    
  for (const type of workTypes) {
    const cidKey = `${type}_contractor_id` as keyof Project;
    const sDateKey = `${type}_expected_start_date` as keyof Project;
    const eDateKey = `${type}_completion_date` as keyof Project;
    const statusKey = `${type}_status` as keyof Project;
    const notesKey = `${type}_notes` as keyof Project;

    if (
      p[cidKey] === undefined && p[sDateKey] === undefined && 
      p[eDateKey] === undefined && p[statusKey] === undefined && 
      p[notesKey] === undefined
    ) {
      continue;
    }

    const existing = existingProgress?.find((x: any) => x.work_type === type);
    
    const payload: any = {
      project_id: projectId,
      work_type: type,
    };
    
    let hasData = false;
    
    if (p[cidKey] !== undefined) {
      payload.contractor_id = p[cidKey] || null;
      if (payload.contractor_id) {
         payload.contractor_name = contractorsMap.get(payload.contractor_id) || null;
      } else {
         payload.contractor_name = null;
      }
      hasData = true;
    } else if (existing) {
      payload.contractor_id = existing.contractor_id;
      payload.contractor_name = existing.contractor_name;
    }

    if (p[sDateKey] !== undefined) { payload.planned_start_date = p[sDateKey] || null; hasData = true; }
    else if (existing) { payload.planned_start_date = existing.planned_start_date; }

    if (p[eDateKey] !== undefined) { payload.completed_date = p[eDateKey] || null; hasData = true; }
    else if (existing) { payload.completed_date = existing.completed_date; }

    if (p[statusKey] !== undefined) { payload.status_override = p[statusKey] || null; hasData = true; }
    else if (existing) { payload.status_override = existing.status_override; }

    if (p[notesKey] !== undefined) { payload.notes = p[notesKey] || null; hasData = true; }
    else if (existing) { payload.notes = existing.notes; }

    if (hasData || existing) {
       const isNowEmpty = !payload.contractor_id && !payload.planned_start_date && !payload.completed_date && !payload.status_override && !payload.notes;
       
       if (existing) {
          if (isNowEmpty) {
             await supabase.from('project_construction_progress').update({ deleted_at: new Date().toISOString() }).eq('id', existing.id);
          } else {
             payload.deleted_at = null;
             await supabase.from('project_construction_progress').update(payload).eq('id', existing.id);
          }
       } else {
          if (!isNowEmpty) {
             await supabase.from('project_construction_progress').insert(payload);
          }
       }
    }
  }
};

export const pocSupabaseAdapter = {
  // --- Users (team_members) ---
  getUsers: async (): Promise<User[]> => {
    const { data, error } = await supabase
      .from('team_members')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
      
    if (error) {
      console.error('Error fetching team_members:', error);
      throw error;
    }
    
    return data.map(mapUser);
  },

  createUser: async (u: Omit<User, 'id'|'created_at'|'updated_at'>): Promise<User> => {
    const dbData = {
      name: u.name,
      email: u.email,
      role: u.role.toLowerCase(),
      category: u.category?.toLowerCase() || 'other',
      is_active: u.is_active,
      google_calendar_email: u.google_calendar_email || null,
      notes: u.notes || null,
    };
    
    const { data, error } = await supabase
      .from('team_members')
      .insert(dbData)
      .select()
      .single();
      
    if (error) {
      console.error('Error creating team_member:', error);
      throw error;
    }
    
    return mapUser(data);
  },

  updateUser: async (id: string, updates: Partial<Omit<User, 'id'|'created_at'|'updated_at'>>): Promise<User> => {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.email !== undefined) dbUpdates.email = updates.email;
    if (updates.role !== undefined) dbUpdates.role = updates.role.toLowerCase();
    if (updates.category !== undefined) dbUpdates.category = updates.category.toLowerCase();
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;
    if (updates.google_calendar_email !== undefined) dbUpdates.google_calendar_email = updates.google_calendar_email;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    
    // updated_at can be handled by trigger, but we set it here just in case
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('team_members')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();
      
    if (error) {
      console.error('Error updating team_member:', error);
      throw error;
    }
    
    return mapUser(data);
  },

  // --- Schedule Tasks ---
  getScheduleTasks: async (): Promise<ScheduleTask[]> => {
    const { data, error } = await supabase
      .from('schedule_tasks')
      .select('*');
    if (error) {
      console.error('Error fetching schedule_tasks:', error);
      throw error;
    }

    // Map Supabase schema back to frontend ScheduleTask
    return data.map((row: any) => ({
      id: row.id,
      task_type: row.task_type || '',
      title: row.title || '',
      project_id: row.project_id || null,
      project_name: row.project_name || null,
      address: row.address || null,
      task_date: row.task_date || '',
      start_time: row.start_time ? String(row.start_time).slice(0, 5) : null,
      end_time: row.end_time ? String(row.end_time).slice(0, 5) : null,
      is_all_day: !!row.is_all_day,
      is_tentative: !!row.is_tentative,
      status: row.status || '未開始',
      main_assignee_id: row.primary_member_id || null,
      description: row.notes || null,
      source_todo_id: null,
      google_calendar_id: row.google_calendar_id || null,
      google_event_id: row.google_event_id || null,
      google_sync_status: row.google_sync_status || null,
      google_sync_error: row.google_sync_error || null,
      last_synced_at: row.last_synced_at || null,
      created_by: row.created_by || 'system',
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
    })) as ScheduleTask[];
  },

  createScheduleTask: async (
    t: Omit<ScheduleTask, 'id' | 'created_at' | 'updated_at'>,
    newMemberIds: string[] = [] // members are handled in dbAdapter.createScheduleTask
  ): Promise<ScheduleTask> => {
    const taskData = {
      project_id: t.project_id,
      project_name: t.project_name,
      task_type: t.task_type,
      title: t.title,
      notes: t.description || null,
      task_date: t.task_date,
      start_time: t.start_time || null,
      end_time: t.end_time || null,
      is_all_day: t.is_all_day,
      primary_member_id: t.main_assignee_id,
      primary_member_name: null,
      assistant_member_ids: newMemberIds || [],
      assistant_member_names: [],
      status: t.status,
      is_tentative: t.is_tentative || false,
      address: t.address || null,
      google_maps_url: null,
      created_by: 'system',
      updated_by: 'system',
    };

    const { data, error } = await supabase
      .from('schedule_tasks')
      .insert(taskData)
      .select()
      .single();

    if (error) {
      console.error('Error creating schedule_task:', error);
      throw error;
    }
    
    // Convert back
    return {
      ...t,
      id: data.id,
      created_at: data.created_at,
      updated_at: data.updated_at,
    } as ScheduleTask;
  },

  updateScheduleTask: async (
    id: string,
    updates: Partial<ScheduleTask>,
    newMemberIds?: string[]
  ): Promise<ScheduleTask> => {
    const dbUpdates: any = {};
    if (updates.project_id !== undefined) dbUpdates.project_id = updates.project_id;
    if (updates.project_name !== undefined) dbUpdates.project_name = updates.project_name;
    if (updates.task_type !== undefined) dbUpdates.task_type = updates.task_type;
    if (updates.title !== undefined) dbUpdates.title = updates.title;
    if (updates.description !== undefined) dbUpdates.notes = updates.description;
    if (updates.task_date !== undefined) dbUpdates.task_date = updates.task_date;
    if (updates.start_time !== undefined) dbUpdates.start_time = updates.start_time;
    if (updates.end_time !== undefined) dbUpdates.end_time = updates.end_time;
    if (updates.is_all_day !== undefined) dbUpdates.is_all_day = updates.is_all_day;
    if (updates.main_assignee_id !== undefined) dbUpdates.primary_member_id = updates.main_assignee_id;
    if (updates.status !== undefined) dbUpdates.status = updates.status;
    if (updates.is_tentative !== undefined) dbUpdates.is_tentative = updates.is_tentative;
    if (updates.address !== undefined) dbUpdates.address = updates.address;
    if (updates.google_calendar_id !== undefined) dbUpdates.google_calendar_id = updates.google_calendar_id;
    if (updates.google_event_id !== undefined) dbUpdates.google_event_id = updates.google_event_id;
    if (updates.google_sync_status !== undefined) dbUpdates.google_sync_status = updates.google_sync_status;
    if (updates.google_sync_error !== undefined) dbUpdates.google_sync_error = updates.google_sync_error;
    if (updates.last_synced_at !== undefined) dbUpdates.last_synced_at = updates.last_synced_at;
    if (newMemberIds !== undefined) dbUpdates.assistant_member_ids = newMemberIds;
    
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('schedule_tasks')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating schedule_task:', error);
      throw error;
    }
    
    return {
      id: data.id,
      task_type: data.task_type || '',
      title: data.title || '',
      project_id: data.project_id || null,
      project_name: data.project_name || null,
      address: data.address || null,
      task_date: data.task_date || '',
      start_time: data.start_time ? String(data.start_time).slice(0, 5) : null,
      end_time: data.end_time ? String(data.end_time).slice(0, 5) : null,
      is_all_day: !!data.is_all_day,
      is_tentative: !!data.is_tentative,
      status: data.status || '未開始',
      main_assignee_id: data.primary_member_id || null,
      description: data.notes || null,
      source_todo_id: null,
      google_calendar_id: data.google_calendar_id || null,
      google_event_id: data.google_event_id || null,
      google_sync_status: data.google_sync_status || null,
      google_sync_error: data.google_sync_error || null,
      last_synced_at: data.last_synced_at || null,
      created_by: data.created_by || 'system',
      created_at: data.created_at || new Date().toISOString(),
      updated_at: data.updated_at || new Date().toISOString(),
    } as ScheduleTask;
  },

  deleteScheduleTask: async (id: string): Promise<void> => {
    // For POC, hard delete to keep it simple
    const { error } = await supabase
      .from('schedule_tasks')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Error deleting schedule_task:', error);
      throw error;
    }
  },

  // --- Contractors ---
  getContractors: async (): Promise<Contractor[]> => {
    const { data, error } = await supabase
      .from('contractors')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });
      
    if (error) {
      console.error('Error fetching contractors:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
    
    return data as Contractor[];
  },

  createContractor: async (c: Omit<Contractor, 'id' | 'created_at' | 'updated_at'>): Promise<Contractor> => {
    const dbData = {
      name: c.name,
      contractor_type: c.contractor_type,
      contact_person: c.contact_person || null,
      phone: c.phone || null,
      notes: c.notes || null,
      is_active: c.is_active ?? true,
    };
    
    const { data, error } = await supabase
      .from('contractors')
      .insert(dbData)
      .select()
      .single();
      
    if (error) {
      console.error('Error creating contractor:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
    
    return data as Contractor;
  },

  updateContractor: async (id: string, updates: Partial<Contractor>): Promise<Contractor> => {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.contractor_type !== undefined) dbUpdates.contractor_type = updates.contractor_type;
    if (updates.contact_person !== undefined) dbUpdates.contact_person = updates.contact_person;
    if (updates.phone !== undefined) dbUpdates.phone = updates.phone;
    if (updates.notes !== undefined) dbUpdates.notes = updates.notes;
    if (updates.is_active !== undefined) dbUpdates.is_active = updates.is_active;
    
    // updated_at is handled by trigger
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('contractors')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();
      
    if (error) {
      console.error('Error updating contractor:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
    
    return data as Contractor;
  },

  deleteContractor: async (id: string): Promise<void> => {
    // Soft delete
    const { error } = await supabase
      .from('contractors')
      .update({ deleted_at: new Date().toISOString(), is_active: false })
      .eq('id', id);

    if (error) {
      console.error('Error deleting contractor:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
  },

  // --- Projects (Step 3: Basic Data + Step 4: Progress) ---
  
  getProjects: async (): Promise<Project[]> => {
    const { data, error } = await supabase
      .from('projects')
      .select('*, project_construction_progress(*)')
      .is('deleted_at', null)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Error fetching projects:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }

    return data.map((row: any) => {
      const pData: any = {};
      if (row.project_construction_progress) {
        row.project_construction_progress.forEach((prog: any) => {
          if (prog.deleted_at) return;
          const type = prog.work_type; // 'racking', 'electrical', etc.
          pData[`${type}_contractor_id`] = prog.contractor_id;
          pData[`${type}_contractor_name`] = prog.contractor_name;
          pData[`${type}_expected_start_date`] = prog.planned_start_date;
          pData[`${type}_completion_date`] = prog.completed_date;
          pData[`${type}_status`] = prog.status_override;
          pData[`${type}_notes`] = prog.notes;
        });
      }

      return {
        id: row.id,
        project_code: row.project_code || null,
        name: row.project_name || '',
        short_name: row.project_short_name || null,
        capacity: row.capacity_kw || null,
        address: row.address || null,
        region: row.region || null,
        manager: row.responsible_member_name || null,
        status: row.status || '開案',
        meter_expected_date: row.meter_date || null,
        notes: row.notes || null,
        is_active: row.deleted_at === null,
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString(),
        
        owner_name: null, contact_name: null, contact_phone: null, project_type: null,
        owner_phone: null, data_source: null, warranty_status: null, completion_date: row.completed_at ? row.completed_at.split('T')[0] : null,
        warranty_years: null, warranty_end_date: null, has_maintenance_contract: null,
        maintenance_start_date: null, maintenance_end_date: null, maintenance_notes: null,
        inverter_brand: null, inverter_warranty: null, monitoring_system: null, module_mounting_type: null,
        last_inspection_date: null, inspection_cycle_months: null, next_inspection_date: null,
        inspection_reminder_days: null, report_base_date: null, report_section: row.stage || null,
        
        bracket_status: null, power_status: null, inspection_status: null, inspection_expected_date: null,
        inspection_completion_date: null, meter_status: null, meter_completion_date: null,
        roof_status: null, start_date: null,
        
        racking_contractor_id: pData.racking_contractor_id || null,
        racking_contractor_name: pData.racking_contractor_name || null,
        racking_expected_start_date: pData.racking_expected_start_date || null,
        racking_completion_date: pData.racking_completion_date || null,
        racking_status: pData.racking_status || null,
        racking_notes: pData.racking_notes || null,
        
        electrical_contractor_id: pData.electrical_contractor_id || null,
        electrical_contractor_name: pData.electrical_contractor_name || null,
        electrical_expected_start_date: pData.electrical_expected_start_date || null,
        electrical_completion_date: pData.electrical_completion_date || null,
        electrical_status: pData.electrical_status || null,
        electrical_notes: pData.electrical_notes || null,
        
        steel_contractor_id: pData.steel_contractor_id || null,
        steel_contractor_name: pData.steel_contractor_name || null,
        steel_expected_start_date: pData.steel_expected_start_date || null,
        steel_completion_date: pData.steel_completion_date || null,
        steel_status: pData.steel_status || null,
        steel_notes: pData.steel_notes || null,
        
        roof_cover_contractor_id: pData.roof_cover_contractor_id || null,
        roof_cover_contractor_name: pData.roof_cover_contractor_name || null,
        roof_cover_expected_start_date: pData.roof_cover_expected_start_date || null,
        roof_cover_completion_date: pData.roof_cover_completion_date || null,
        roof_cover_status: pData.roof_cover_status || null,
        roof_cover_notes: pData.roof_cover_notes || null,
        
        civil_contractor_id: pData.civil_contractor_id || null,
        civil_contractor_name: pData.civil_contractor_name || null,
        civil_expected_start_date: pData.civil_expected_start_date || null,
        civil_completion_date: pData.civil_completion_date || null,
        civil_status: pData.civil_status || null,
        civil_notes: pData.civil_notes || null,
        
        other_contractor_id: pData.other_contractor_id || null,
        other_contractor_name: pData.other_contractor_name || null,
        other_expected_start_date: pData.other_expected_start_date || null,
        other_completion_date: pData.other_completion_date || null,
        other_status: pData.other_status || null,
        other_notes: pData.other_notes || null,
      };
    });
  },

  createProject: async (p: Partial<Project>): Promise<Project> => {
    // Current user context is not easily available here unless passed down. 
    // We'll skip created_by/updated_by for now or assume it's handled by trigger/rls later if needed.
    const dbData: any = {
      project_code: p.project_code || null,
      project_name: p.name || '未命名案場',
      project_short_name: p.short_name || null,
      capacity_kw: p.capacity || null,
      address: p.address || null,
      region: p.region || null,
      responsible_member_name: p.manager || null,
      status: p.status || '開案',
      stage: p.report_section || null,
      meter_date: p.meter_expected_date || null,
      notes: p.notes || null,
    };

    if (dbData.status === '已結案') {
      dbData.completed_at = new Date().toISOString();
    }

    const { data, error } = await supabase
      .from('projects')
      .insert(dbData)
      .select()
      .single();

    if (error) {
      console.error('Error creating project:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
    
    await syncProjectProgress(data.id, p);

    return {
      ...p,
      id: data.id,
      name: data.project_name,
      status: data.status,
      created_at: data.created_at,
      updated_at: data.updated_at,
    } as Project;
  },

  updateProject: async (id: string, p: Partial<Project>): Promise<Project> => {
    const dbUpdates: any = {};
    if (p.project_code !== undefined) dbUpdates.project_code = p.project_code;
    if (p.name !== undefined) dbUpdates.project_name = p.name;
    if (p.short_name !== undefined) dbUpdates.project_short_name = p.short_name;
    if (p.capacity !== undefined) dbUpdates.capacity_kw = p.capacity;
    if (p.address !== undefined) dbUpdates.address = p.address;
    if (p.region !== undefined) dbUpdates.region = p.region;
    if (p.manager !== undefined) dbUpdates.responsible_member_name = p.manager;
    if (p.status !== undefined) {
      dbUpdates.status = p.status;
      if (p.status === '已結案') {
        dbUpdates.completed_at = new Date().toISOString();
      }
    }
    if (p.meter_expected_date !== undefined) dbUpdates.meter_date = p.meter_expected_date;
    if (p.notes !== undefined) dbUpdates.notes = p.notes;
    if (p.report_section !== undefined) dbUpdates.stage = p.report_section;

    // handled by trigger
    dbUpdates.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('projects')
      .update(dbUpdates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Error updating project:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }

    await syncProjectProgress(id, p);

    return {
      ...p,
      id: data.id,
      name: data.project_name,
      status: data.status,
      updated_at: data.updated_at,
    } as Project;
  },

  deleteProject: async (id: string): Promise<void> => {
    const { error } = await supabase
      .from('projects')
      .update({ deleted_at: new Date().toISOString(), status: '作廢' })
      .eq('id', id);

    if (error) {
      console.error('Error deleting project:', error);
      throwMissingCoreTablesErrorIfNeeded(error);
      throw error;
    }
  },

  // --- Inventory Reads ---
  getInventoryItems: fetchInventoryItemsFromSupabase,
  createInventoryItem: createInventoryItemInSupabase,
  updateInventoryItem: updateInventoryItemInSupabase,
  deleteInventoryItem: deleteInventoryItemFromSupabase,
  getInventoryTransactions: fetchInventoryTransactionsFromSupabase,
  createInventoryTransaction: createInventoryTransactionInSupabase,
  updateInventoryTransaction: updateInventoryTransactionInSupabase,
  voidInventoryTransaction: voidInventoryTransactionInSupabase,
  getInventorySerials: fetchInventorySerialsFromSupabase,
  getInventoryTransactionSerials: fetchInventoryTransactionSerialsFromSupabase,
  createInventorySerial: createInventorySerialInSupabase,
  updateInventorySerial: updateInventorySerialInSupabase,
  deleteInventorySerial: deleteInventorySerialFromSupabase,
  updateInventoryTransactionSerial: updateInventoryTransactionSerialInSupabase,
  getInventoryBatches: fetchInventoryBatchesFromSupabase,
  getInventoryBalances: calculateInventoryBalancesFromSupabase,
  getMonthlyClosings: fetchInventoryMonthlyClosingsFromSupabase,
  getMonthlyClosingItems: fetchInventoryMonthlyClosingItemsFromSupabase,
  createMonthlyClosing: createMonthlyClosingInSupabase,
  getInventoryMonthlyClosings: fetchInventoryMonthlyClosingsFromSupabase,
  getInventoryMonthlyClosingItems: fetchInventoryMonthlyClosingItemsFromSupabase,
  getActivityLogs: fetchActivityLogsFromSupabase,
  logActivity: logActivityInSupabase,
};
