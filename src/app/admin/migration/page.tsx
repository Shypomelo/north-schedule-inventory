"use client";

import React, { useEffect, useState } from 'react';
import { useUser } from '@/components/UserContext';
import { dbAdapter } from '@/lib/db';
import { supabase } from '@/lib/db/supabaseClient';
import {
  Contractor,
  InventoryBatch,
  InventoryItem,
  InventoryMonthlyClosing,
  InventoryMonthlyClosingItem,
  InventorySerial,
  InventoryTransaction,
  InventoryTransactionSerial,
  Project,
} from '@/lib/db/types';
import {
  AlertTriangle,
  Check,
  Database,
  HardDrive,
  Info,
  RefreshCw,
  Server,
  SkipForward,
} from 'lucide-react';

const MOCK_DB_KEY = 'schedule-inventory-mock-db-v7';
const LEGACY_MOCK_DB_KEY = 'schedule-inventory-db';

type MigrationAction = 'SKIP' | 'INSERT';
type InventoryTableName =
  | 'inventory_items'
  | 'inventory_transactions'
  | 'inventory_batches'
  | 'inventory_serials'
  | 'inventory_transaction_serials'
  | 'inventory_monthly_closings'
  | 'inventory_monthly_closing_items';

type LocalMockDatabase = {
  projects?: Project[];
  contractors?: Contractor[];
  inventory_items?: InventoryItem[];
  inventory_transactions?: InventoryTransaction[];
  inventory_batches?: InventoryBatch[];
  inventory_serials?: InventorySerial[];
  item_serials?: InventorySerial[];
  inventory_transaction_serials?: InventoryTransactionSerial[];
  inventory_monthly_closings?: InventoryMonthlyClosing[];
  inventory_monthly_closing_items?: InventoryMonthlyClosingItem[];
};

interface MigrationPreviewItem<T> {
  local: T;
  supabaseMatch?: T | null;
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  reason?: string;
  action: MigrationAction;
}

interface InventoryTableConfig {
  table: InventoryTableName;
  label: string;
  sourceKeys: Array<keyof LocalMockDatabase>;
}

interface InventoryTablePreview extends InventoryTableConfig {
  localCount: number;
  existingCount: number;
  duplicateIds: number;
  readyToInsert: number;
}

interface InventoryTableImportResult {
  table: InventoryTableName;
  label: string;
  added: number;
  skippedDuplicateId: number;
  skippedInvalidFk: number;
  errors: string[];
}

interface InventoryImportContext {
  projectIdMap: Map<string, string>;
  projectIds: Set<string>;
  itemIds: Set<string>;
  transactionIds: Set<string>;
  batchIds: Set<string>;
  serialIds: Set<string>;
  closingIds: Set<string>;
}

const INVENTORY_TABLES: InventoryTableConfig[] = [
  { table: 'inventory_items', label: '庫存品項', sourceKeys: ['inventory_items'] },
  { table: 'inventory_transactions', label: '庫存異動', sourceKeys: ['inventory_transactions'] },
  { table: 'inventory_batches', label: '入庫批次', sourceKeys: ['inventory_batches'] },
  { table: 'inventory_serials', label: '序號資料', sourceKeys: ['inventory_serials', 'item_serials'] },
  { table: 'inventory_transaction_serials', label: '異動序號關聯', sourceKeys: ['inventory_transaction_serials'] },
  { table: 'inventory_monthly_closings', label: '月結主檔', sourceKeys: ['inventory_monthly_closings'] },
  { table: 'inventory_monthly_closing_items', label: '月結明細', sourceKeys: ['inventory_monthly_closing_items'] },
];

function readLocalDb(allowLegacyFallback: boolean): LocalMockDatabase {
  const saved =
    localStorage.getItem(MOCK_DB_KEY) ||
    (allowLegacyFallback ? localStorage.getItem(LEGACY_MOCK_DB_KEY) : null);

  if (!saved) {
    const keys = allowLegacyFallback ? `${MOCK_DB_KEY} / ${LEGACY_MOCK_DB_KEY}` : MOCK_DB_KEY;
    throw new Error(`找不到 localStorage 資料：${keys}`);
  }

  return JSON.parse(saved) as LocalMockDatabase;
}

function rowsFromLocalDb<T>(localDb: LocalMockDatabase, config: InventoryTableConfig): T[] {
  for (const key of config.sourceKeys) {
    const rows = localDb[key];
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}

async function fetchAllRows<T extends Record<string, any>>(
  table: string,
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...((data || []) as unknown as T[]));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function fetchExistingIds(table: InventoryTableName): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string }>(table, 'id');
  return new Set(rows.map((row) => row.id));
}

function valueOrNull<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function numberOrZero(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolOrFalse(value: boolean | null | undefined): boolean {
  return value === true;
}

function boolOrTrue(value: boolean | null | undefined): boolean {
  return value !== false;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowIso(): string {
  return new Date().toISOString();
}

function dateOrToday(value: string | null | undefined): string {
  return value || todayDate();
}

function dateTimeOrNow(value: string | null | undefined): string {
  return value || nowIso();
}

function resolveProjectId(projectId: string | null | undefined, context: InventoryImportContext): string | null {
  if (!projectId) return null;
  const mappedProjectId = context.projectIdMap.get(projectId);
  if (mappedProjectId) return mappedProjectId;
  return context.projectIds.has(projectId) ? projectId : null;
}

function buildProjectIdMap(localProjects: Project[], supabaseProjects: Project[]) {
  const projectIds = new Set(supabaseProjects.map((project) => project.id));
  const byCode = new Map(supabaseProjects.filter((project) => project.project_code).map((project) => [project.project_code, project.id]));
  const byName = new Map(supabaseProjects.filter((project) => project.name).map((project) => [project.name, project.id]));
  const byShortName = new Map(
    supabaseProjects
      .filter((project) => project.short_name)
      .map((project) => [project.short_name, project.id]),
  );
  const projectIdMap = new Map<string, string>();

  for (const localProject of localProjects) {
    const matchedId =
      (localProject.project_code && byCode.get(localProject.project_code)) ||
      (localProject.name && byName.get(localProject.name)) ||
      (localProject.short_name && byShortName.get(localProject.short_name)) ||
      null;

    if (matchedId) projectIdMap.set(localProject.id, matchedId);
  }

  return { projectIds, projectIdMap };
}

function prepareInventoryRow(
  table: InventoryTableName,
  row: any,
  context: InventoryImportContext,
): { payload?: Record<string, any>; invalidFk?: string } {
  switch (table) {
    case 'inventory_items':
      return {
        payload: {
          id: row.id,
          code: row.code,
          category: row.category || '',
          item_category: valueOrNull(row.item_category),
          name: row.name,
          source_type: valueOrNull(row.source_type),
          unit: row.unit || '',
          opening_quantity: numberOrZero(row.opening_quantity),
          low_stock_threshold: numberOrZero(row.low_stock_threshold),
          requires_serial: boolOrFalse(row.requires_serial),
          notes: valueOrNull(row.notes),
          is_active: boolOrTrue(row.is_active),
          created_at: dateTimeOrNow(row.created_at),
          updated_at: dateTimeOrNow(row.updated_at),
        },
      };

    case 'inventory_transactions':
      if (!context.itemIds.has(row.item_id)) {
        return { invalidFk: `item_id ${row.item_id || '(空白)'} 不存在` };
      }
      return {
        payload: {
          id: row.id,
          item_id: row.item_id,
          transaction_type: row.transaction_type,
          transaction_date: dateOrToday(row.transaction_date),
          quantity: numberOrZero(row.quantity),
          unit: valueOrNull(row.unit),
          project_id: resolveProjectId(row.project_id, context),
          project_name: valueOrNull(row.project_name),
          handler: valueOrNull(row.handler),
          source: valueOrNull(row.source),
          notes: valueOrNull(row.notes),
          pending_serial_count: numberOrZero(row.pending_serial_count),
          is_voided: boolOrFalse(row.is_voided),
          voided_reason: valueOrNull(row.voided_reason),
          voided_by: valueOrNull(row.voided_by),
          voided_at: valueOrNull(row.voided_at),
          created_at: dateTimeOrNow(row.created_at),
          updated_at: dateTimeOrNow(row.updated_at),
        },
      };

    case 'inventory_batches':
      if (!context.itemIds.has(row.item_id)) {
        return { invalidFk: `item_id ${row.item_id || '(空白)'} 不存在` };
      }
      return {
        payload: {
          id: row.id,
          batch_number: row.batch_number,
          item_id: row.item_id,
          in_date: dateOrToday(row.in_date),
          source: valueOrNull(row.source),
          quantity: numberOrZero(row.quantity),
          unit: valueOrNull(row.unit),
          handler: valueOrNull(row.handler),
          notes: valueOrNull(row.notes),
          created_at: dateTimeOrNow(row.created_at),
          updated_at: dateTimeOrNow(row.updated_at),
        },
      };

    case 'inventory_serials':
      if (!context.itemIds.has(row.item_id)) {
        return { invalidFk: `item_id ${row.item_id || '(空白)'} 不存在` };
      }
      return {
        payload: {
          id: row.id,
          item_id: row.item_id,
          batch_id: row.batch_id && context.batchIds.has(row.batch_id) ? row.batch_id : null,
          serial_number: row.serial_number,
          status: row.status || '',
          project_id: resolveProjectId(row.project_id, context),
          notes: valueOrNull(row.notes),
          created_at: dateTimeOrNow(row.created_at),
          updated_at: dateTimeOrNow(row.updated_at),
        },
      };

    case 'inventory_transaction_serials':
      if (!context.transactionIds.has(row.transaction_id)) {
        return { invalidFk: `transaction_id ${row.transaction_id || '(空白)'} 不存在` };
      }
      return {
        payload: {
          id: row.id,
          transaction_id: row.transaction_id,
          serial_id: row.serial_id && context.serialIds.has(row.serial_id) ? row.serial_id : null,
          serial_no: valueOrNull(row.serial_no),
          is_pending: boolOrFalse(row.is_pending),
          created_at: dateTimeOrNow(row.created_at),
        },
      };

    case 'inventory_monthly_closings':
      return {
        payload: {
          id: row.id,
          year: row.year || '',
          month: row.month || '',
          closed_at: dateTimeOrNow(row.closed_at),
          closed_by: row.closed_by || 'system',
          status: row.status || 'CLOSED',
          notes: valueOrNull(row.notes),
        },
      };

    case 'inventory_monthly_closing_items':
      if (!context.closingIds.has(row.closing_id)) {
        return { invalidFk: `closing_id ${row.closing_id || '(空白)'} 不存在` };
      }
      return {
        payload: {
          id: row.id,
          closing_id: row.closing_id,
          inventory_item_id: row.inventory_item_id && context.itemIds.has(row.inventory_item_id) ? row.inventory_item_id : null,
          stock_category: row.stock_category || '',
          source: row.source || '',
          item_name: row.item_name || '',
          item_type: row.item_type || '',
          unit: row.unit || '',
          opening_quantity: numberOrZero(row.opening_quantity),
          monthly_in: numberOrZero(row.monthly_in),
          monthly_out: numberOrZero(row.monthly_out),
          monthly_return: numberOrZero(row.monthly_return),
          monthly_adjust: numberOrZero(row.monthly_adjust),
          closing_quantity: numberOrZero(row.closing_quantity),
          usage_quantity: numberOrZero(row.usage_quantity),
          status: row.status || '',
          notes: valueOrNull(row.notes),
        },
      };
  }
}

function addKnownId(table: InventoryTableName, id: string, context: InventoryImportContext) {
  if (table === 'inventory_items') context.itemIds.add(id);
  if (table === 'inventory_transactions') context.transactionIds.add(id);
  if (table === 'inventory_batches') context.batchIds.add(id);
  if (table === 'inventory_serials') context.serialIds.add(id);
  if (table === 'inventory_monthly_closings') context.closingIds.add(id);
}

export default function MigrationPage() {
  const { currentUser, isLoading: userLoading } = useUser();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [contractorPreviews, setContractorPreviews] = useState<MigrationPreviewItem<Contractor>[]>([]);
  const [projectPreviews, setProjectPreviews] = useState<MigrationPreviewItem<Project>[]>([]);
  const [inventoryPreviews, setInventoryPreviews] = useState<InventoryTablePreview[]>([]);

  const [migrating, setMigrating] = useState(false);
  const [inventoryMigrating, setInventoryMigrating] = useState(false);
  const [migrationResult, setMigrationResult] = useState<any>(null);
  const [inventoryResult, setInventoryResult] = useState<InventoryTableImportResult[] | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showInventoryConfirm, setShowInventoryConfirm] = useState(false);

  useEffect(() => {
    if (userLoading) return;
    if (currentUser?.role?.toLowerCase() !== 'admin') {
      setLoading(false);
      return;
    }
    loadPreview();
  }, [userLoading, currentUser]);

  const loadPreview = async () => {
    try {
      setLoading(true);
      setError(null);

      const localDb = readLocalDb(true);
      const localProjects: Project[] = localDb.projects || [];
      const localContractors: Contractor[] = localDb.contractors || [];

      const [supaProjects, supaContractors] = await Promise.all([
        dbAdapter.getProjects(),
        dbAdapter.getContractors(),
      ]);

      const cPreviews: MigrationPreviewItem<Contractor>[] = localContractors.map((localContractor) => {
        const match = supaContractors.find((supaContractor) => supaContractor.name === localContractor.name);
        if (match) {
          return {
            local: localContractor,
            supabaseMatch: match,
            status: 'DUPLICATE',
            reason: `名稱「${localContractor.name}」已存在`,
            action: 'SKIP',
          };
        }
        return { local: localContractor, supabaseMatch: null, status: 'NEW', action: 'SKIP' };
      });

      const pPreviews: MigrationPreviewItem<Project>[] = localProjects.map((localProject) => {
        const match = supaProjects.find(
          (supaProject) =>
            (localProject.project_code && localProject.project_code === supaProject.project_code) ||
            (localProject.name && localProject.name === supaProject.name) ||
            (localProject.short_name && localProject.short_name === supaProject.short_name),
        );

        if (match) {
          const reasons = [];
          if (localProject.project_code === match.project_code) reasons.push('案場編號相同');
          if (localProject.name === match.name) reasons.push('名稱相同');
          if (localProject.short_name === match.short_name) reasons.push('簡稱相同');
          return {
            local: localProject,
            supabaseMatch: match,
            status: 'DUPLICATE',
            reason: reasons.join(' / '),
            action: 'SKIP',
          };
        }
        return { local: localProject, supabaseMatch: null, status: 'NEW', action: 'SKIP' };
      });

      const inventoryPreviewRows: InventoryTablePreview[] = [];
      const v7LocalDb = localStorage.getItem(MOCK_DB_KEY) ? readLocalDb(false) : null;
      for (const config of INVENTORY_TABLES) {
        const localRows = v7LocalDb ? rowsFromLocalDb<{ id?: string }>(v7LocalDb, config) : [];
        const existingIds = await fetchExistingIds(config.table);
        const duplicateIds = localRows.filter((row) => row.id && existingIds.has(row.id)).length;

        inventoryPreviewRows.push({
          ...config,
          localCount: localRows.length,
          existingCount: existingIds.size,
          duplicateIds,
          readyToInsert: localRows.length - duplicateIds,
        });
      }

      setContractorPreviews(cPreviews);
      setProjectPreviews(pPreviews);
      setInventoryPreviews(inventoryPreviewRows);
    } catch (err: any) {
      console.error(err);
      setError(err.message || '載入 migration 預覽失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleContractorAction = (idx: number, action: MigrationAction) => {
    const next = [...contractorPreviews];
    next[idx].action = action;
    setContractorPreviews(next);
  };

  const handleProjectAction = (idx: number, action: MigrationAction) => {
    const next = [...projectPreviews];
    next[idx].action = action;
    setProjectPreviews(next);
  };

  const executeMigration = async () => {
    try {
      setShowConfirm(false);
      setMigrating(true);
      setError(null);

      const result = {
        contractorsAdded: 0,
        contractorsSkipped: 0,
        projectsAdded: 0,
        projectsSkipped: 0,
        progressAdded: 0,
        errors: 0,
        errorMsgs: [] as string[],
      };

      const contractorIdMap = new Map<string, string>();
      for (const cp of contractorPreviews) {
        if (cp.action === 'INSERT') {
          try {
            const newContractor = await dbAdapter.createContractor({
              name: cp.local.name,
              contractor_type: cp.local.contractor_type,
              work_capabilities: cp.local.work_capabilities?.length
                ? cp.local.work_capabilities
                : [cp.local.contractor_type],
              contact_person: cp.local.contact_person,
              phone: cp.local.phone,
              notes: cp.local.notes,
              is_active: cp.local.is_active,
            });
            contractorIdMap.set(cp.local.id, newContractor.id);
            result.contractorsAdded++;
          } catch (err: any) {
            result.errors++;
            result.errorMsgs.push(`包商 ${cp.local.name} 匯入失敗：${err.message}`);
          }
        } else {
          result.contractorsSkipped++;
          if (cp.supabaseMatch) contractorIdMap.set(cp.local.id, cp.supabaseMatch.id);
        }
      }

      for (const pp of projectPreviews) {
        if (pp.action === 'INSERT') {
          try {
            const localProject = pp.local;
            const workTypes = ['racking', 'electrical', 'steel', 'roof_cover', 'civil', 'other'];
            const mappedProject: Partial<Project> = {
              name: localProject.name,
              short_name: localProject.short_name,
              project_code: localProject.project_code,
              capacity: localProject.capacity,
              address: localProject.address,
              region: localProject.region,
              manager: localProject.manager,
              status: localProject.status,
              meter_expected_date: localProject.meter_expected_date,
              notes: localProject.notes,
            };

            let hasProgress = false;
            for (const workType of workTypes) {
              const cidKey = `${workType}_contractor_id` as keyof Project;
              const sDateKey = `${workType}_expected_start_date` as keyof Project;
              const eDateKey = `${workType}_completion_date` as keyof Project;
              const statusKey = `${workType}_status` as keyof Project;
              const notesKey = `${workType}_notes` as keyof Project;
              const cNameKey = `${workType}_contractor_name` as keyof Project;

              const oldContractorId = localProject[cidKey] as string;
              if (
                oldContractorId ||
                localProject[sDateKey] ||
                localProject[eDateKey] ||
                localProject[statusKey] ||
                localProject[notesKey]
              ) {
                hasProgress = true;
                let oldContractorName = localProject[cNameKey] as string | null;
                if (!oldContractorName && oldContractorId) {
                  oldContractorName = contractorPreviews.find((c) => c.local.id === oldContractorId)?.local.name || null;
                }

                (mappedProject as any)[cidKey] = oldContractorId ? contractorIdMap.get(oldContractorId) || null : null;
                (mappedProject as any)[cNameKey] = oldContractorName || null;
                (mappedProject as any)[sDateKey] = localProject[sDateKey] || null;
                (mappedProject as any)[eDateKey] = localProject[eDateKey] || null;
                (mappedProject as any)[statusKey] = localProject[statusKey] || null;
                (mappedProject as any)[notesKey] = localProject[notesKey] || null;
              }
            }

            await dbAdapter.createProject(mappedProject as any);
            result.projectsAdded++;
            if (hasProgress) result.progressAdded++;
          } catch (err: any) {
            result.errors++;
            result.errorMsgs.push(`案場 ${pp.local.name} 匯入失敗：${err.message}`);
          }
        } else {
          result.projectsSkipped++;
        }
      }

      setMigrationResult(result);
      await loadPreview();
    } catch (err: any) {
      console.error(err);
      setError(err.message || '匯入失敗');
    } finally {
      setMigrating(false);
    }
  };

  const executeInventoryMigration = async () => {
    try {
      setShowInventoryConfirm(false);
      setInventoryMigrating(true);
      setInventoryResult(null);
      setError(null);

      const localDb = readLocalDb(false);
      const supaProjects = await dbAdapter.getProjects();
      const { projectIds, projectIdMap } = buildProjectIdMap(localDb.projects || [], supaProjects);

      const context: InventoryImportContext = {
        projectIdMap,
        projectIds,
        itemIds: await fetchExistingIds('inventory_items'),
        transactionIds: await fetchExistingIds('inventory_transactions'),
        batchIds: await fetchExistingIds('inventory_batches'),
        serialIds: await fetchExistingIds('inventory_serials'),
        closingIds: await fetchExistingIds('inventory_monthly_closings'),
      };

      const results: InventoryTableImportResult[] = [];

      for (const config of INVENTORY_TABLES) {
        const localRows = rowsFromLocalDb<{ id?: string }>(localDb, config);
        const existingIds = await fetchExistingIds(config.table);
        const tableResult: InventoryTableImportResult = {
          table: config.table,
          label: config.label,
          added: 0,
          skippedDuplicateId: 0,
          skippedInvalidFk: 0,
          errors: [],
        };

        for (const localRow of localRows) {
          if (!localRow.id) {
            tableResult.skippedInvalidFk++;
            tableResult.errors.push(`${config.table}: 略過缺少 id 的資料列`);
            continue;
          }

          if (existingIds.has(localRow.id)) {
            tableResult.skippedDuplicateId++;
            addKnownId(config.table, localRow.id, context);
            continue;
          }

          const prepared = prepareInventoryRow(config.table, localRow, context);
          if (!prepared.payload) {
            tableResult.skippedInvalidFk++;
            tableResult.errors.push(`${config.table} ${localRow.id}: ${prepared.invalidFk || '關聯資料不存在'}`);
            continue;
          }

          const { error: insertError } = await supabase.from(config.table).insert(prepared.payload);
          if (insertError) {
            tableResult.errors.push(`${config.table} ${localRow.id}: ${insertError.message}`);
            continue;
          }

          tableResult.added++;
          existingIds.add(localRow.id);
          addKnownId(config.table, localRow.id, context);
        }

        results.push(tableResult);
      }

      setInventoryResult(results);
      await loadPreview();
    } catch (err: any) {
      console.error(err);
      setError(err.message || '庫存資料匯入失敗');
    } finally {
      setInventoryMigrating(false);
    }
  };

  if (userLoading || loading) {
    return <div className="p-8 text-secondary">載入中...</div>;
  }

  if (currentUser?.role?.toLowerCase() !== 'admin') {
    return (
      <div className="p-8 flex flex-col items-center justify-center h-full text-secondary">
        <AlertTriangle size={48} className="text-warning mb-4" />
        <h2 className="text-2xl font-bold text-primary mb-2">權限不足</h2>
        <p>只有管理員可以使用資料匯入工具。</p>
      </div>
    );
  }

  const selectedContractors = contractorPreviews.filter((c) => c.action === 'INSERT').length;
  const selectedProjects = projectPreviews.filter((p) => p.action === 'INSERT').length;
  const inventoryReadyCount = inventoryPreviews.reduce((sum, item) => sum + item.readyToInsert, 0);

  return (
    <div className="p-6 max-w-7xl mx-auto text-primary">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-primary mb-2 flex items-center gap-3">
          <HardDrive className="text-accent" />
          資料匯入工具
        </h1>
        <p className="text-secondary">
          從 localStorage 匯入資料到 Supabase。庫存匯入固定讀取 {MOCK_DB_KEY}。
        </p>
      </div>

      {error && (
        <div className="bg-danger/10 border border-danger/30 text-danger p-4 rounded-lg mb-6 flex items-start gap-3">
          <AlertTriangle className="shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {migrationResult && (
        <div className="bg-success/10 border border-success/30 p-6 rounded-lg mb-8">
          <h3 className="text-success font-bold text-xl mb-4 flex items-center gap-2">
            <Check /> 包商 / 案場匯入結果
          </h3>
          <ul className="space-y-2 text-secondary">
            <li>成功新增包商：{migrationResult.contractorsAdded} 筆</li>
            <li>略過包商：{migrationResult.contractorsSkipped} 筆</li>
            <li>成功新增案場：{migrationResult.projectsAdded} 筆</li>
            <li>略過案場：{migrationResult.projectsSkipped} 筆</li>
            <li>成功寫入施工進度案場數：{migrationResult.progressAdded} 筆</li>
            {migrationResult.errors > 0 && (
              <li className="text-danger font-bold mt-4">
                錯誤：{migrationResult.errors} 筆
                <ul className="text-sm font-normal mt-2 ml-4 list-disc space-y-1">
                  {migrationResult.errorMsgs.map((msg: string, i: number) => (
                    <li key={i}>{msg}</li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </div>
      )}

      {inventoryResult && (
        <div className="bg-accent/10 border border-accent/30 p-6 rounded-lg mb-8">
          <h3 className="text-accent font-bold text-xl mb-4 flex items-center gap-2">
            <Database /> 庫存資料匯入結果
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-secondary border-b border-theme-border">
                <tr>
                  <th className="text-left py-2 pr-4">資料表</th>
                  <th className="text-right py-2 px-4">成功新增</th>
                  <th className="text-right py-2 px-4">重複 id 略過</th>
                  <th className="text-right py-2 px-4">關聯不足略過</th>
                  <th className="text-right py-2 pl-4">錯誤</th>
                </tr>
              </thead>
              <tbody>
                {inventoryResult.map((result) => (
                  <tr key={result.table} className="border-b border-theme-border/50">
                    <td className="py-2 pr-4">
                      <div className="font-semibold text-primary">{result.table}</div>
                      <div className="text-xs text-secondary/70">{result.label}</div>
                    </td>
                    <td className="text-right py-2 px-4 text-success font-semibold">{result.added}</td>
                    <td className="text-right py-2 px-4 text-secondary">{result.skippedDuplicateId}</td>
                    <td className="text-right py-2 px-4 text-secondary">{result.skippedInvalidFk}</td>
                    <td className="text-right py-2 pl-4 text-danger">{result.errors.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {inventoryResult.some((result) => result.errors.length > 0) && (
            <div className="mt-4 max-h-48 overflow-y-auto text-sm text-danger bg-page/50 border border-theme-border/50 rounded-lg p-3">
              {inventoryResult.flatMap((result) => result.errors).map((msg, index) => (
                <div key={`${msg}-${index}`}>{msg}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <section className="mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4 bg-card p-4 rounded-lg border border-theme-border shadow-sm">
          <div>
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <Server className="text-accent" />
              包商 / 案場 migration
            </h2>
            <p className="text-sm text-secondary mt-1">
              保留原本選擇新增流程，重複資料預設略過。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={loadPreview}
              className="px-4 py-2 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded-lg text-sm transition-colors flex items-center gap-2 font-medium"
            >
              <RefreshCw size={16} /> 重新整理
            </button>
            <button
              onClick={() => setShowConfirm(true)}
              disabled={migrating || (selectedContractors === 0 && selectedProjects === 0)}
              className="px-5 py-2 bg-accent hover:bg-accent-hover disabled:bg-theme-border/30 disabled:text-secondary/50 text-white rounded-lg font-bold transition-colors shadow-lg shadow-accent/20"
            >
              開始匯入選取資料
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
          <div className="bg-page/50 rounded-lg border border-theme-border/50 overflow-hidden flex flex-col h-[600px]">
            <div className="p-4 bg-card/80 border-b border-theme-border/50 font-bold flex justify-between items-center text-primary">
              <span>包商預覽 ({contractorPreviews.length} 筆)</span>
              <button
                onClick={() => {
                  const next = contractorPreviews.map(
                    (c) => ({ ...c, action: c.status === 'NEW' ? 'INSERT' : 'SKIP' }) as const,
                  );
                  setContractorPreviews(next);
                }}
                className="text-xs px-2 py-1 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded flex items-center gap-1 transition"
              >
                <Check size={14} /> 選取新資料
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {contractorPreviews.length === 0 ? (
                <div className="p-8 text-center text-secondary/70">沒有包商資料</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {contractorPreviews.map((cp, i) => (
                    <div
                      key={cp.local.id || i}
                      className={`p-3 rounded-lg border ${
                        cp.status === 'DUPLICATE'
                          ? 'bg-warning/10 border-warning/30'
                          : 'bg-card border-theme-border'
                      } flex items-center justify-between`}
                    >
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="font-bold truncate text-primary">{cp.local.name}</div>
                        <div className="text-xs text-secondary mt-1 flex gap-2">
                          <span className="bg-page border border-theme-border px-1.5 py-0.5 rounded">{cp.local.contractor_type}</span>
                          {cp.reason && <span className="text-warning">{cp.reason}</span>}
                        </div>
                      </div>
                      <select
                        value={cp.action}
                        onChange={(e) => handleContractorAction(i, e.target.value as MigrationAction)}
                        className={`text-sm rounded border-none py-1 pl-2 pr-6 outline-none focus:ring-2 focus:ring-accent ${
                          cp.action === 'INSERT' ? 'bg-accent text-white font-medium' : 'bg-page border border-theme-border text-secondary'
                        }`}
                      >
                        <option value="SKIP">略過</option>
                        <option value="INSERT">新增</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="bg-page/50 rounded-lg border border-theme-border/50 overflow-hidden flex flex-col h-[600px]">
            <div className="p-4 bg-card/80 border-b border-theme-border/50 font-bold flex justify-between items-center text-primary">
              <span>案場預覽 ({projectPreviews.length} 筆)</span>
              <button
                onClick={() => {
                  const next = projectPreviews.map(
                    (p) => ({ ...p, action: p.status === 'NEW' ? 'INSERT' : 'SKIP' }) as const,
                  );
                  setProjectPreviews(next);
                }}
                className="text-xs px-2 py-1 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded flex items-center gap-1 transition"
              >
                <Check size={14} /> 選取新資料
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2">
              {projectPreviews.length === 0 ? (
                <div className="p-8 text-center text-secondary/70">沒有案場資料</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {projectPreviews.map((pp, i) => (
                    <div
                      key={pp.local.id || i}
                      className={`p-3 rounded-lg border ${
                        pp.status === 'DUPLICATE'
                          ? 'bg-warning/10 border-warning/30'
                          : 'bg-card border-theme-border'
                      } flex items-center justify-between`}
                    >
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="font-bold truncate text-primary">{pp.local.name}</div>
                        <div className="text-xs text-secondary mt-1 flex flex-wrap gap-2">
                          {pp.local.project_code && (
                            <span className="bg-page border border-theme-border px-1.5 py-0.5 rounded">{pp.local.project_code}</span>
                          )}
                          <span className="bg-accent/20 text-accent px-1.5 py-0.5 rounded font-medium">
                            {pp.local.status || '未設定'}
                          </span>
                          {pp.reason && <span className="text-warning truncate">{pp.reason}</span>}
                        </div>
                      </div>
                      <select
                        value={pp.action}
                        onChange={(e) => handleProjectAction(i, e.target.value as MigrationAction)}
                        className={`text-sm rounded border-none py-1 pl-2 pr-6 outline-none focus:ring-2 focus:ring-accent ${
                          pp.action === 'INSERT' ? 'bg-accent text-white font-medium' : 'bg-page border border-theme-border text-secondary'
                        }`}
                      >
                        <option value="SKIP">略過</option>
                        <option value="INSERT">新增</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-4 bg-card p-4 rounded-lg border border-theme-border shadow-sm">
          <div>
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <Database className="text-accent" />
              庫存資料匯入
            </h2>
            <p className="text-sm text-secondary mt-1">
              依 FK 順序匯入七張庫存表；既有 id 不覆蓋，直接略過。
            </p>
          </div>
          <button
            onClick={() => setShowInventoryConfirm(true)}
            disabled={inventoryMigrating || inventoryReadyCount === 0}
            className="px-5 py-2 bg-accent hover:bg-accent-hover disabled:bg-theme-border/30 disabled:text-secondary/50 rounded-lg font-bold transition-colors flex items-center gap-2 text-white shadow-lg shadow-accent/20"
          >
            <Database size={18} /> 匯入庫存資料
          </button>
        </div>

        <div className="bg-page/50 rounded-lg border border-theme-border/50 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-page text-secondary border-b border-theme-border">
              <tr>
                <th className="text-left py-3 px-4">匯入順序 / 資料表</th>
                <th className="text-right py-3 px-4">localStorage</th>
                <th className="text-right py-3 px-4">Supabase 既有</th>
                <th className="text-right py-3 px-4">重複 id</th>
                <th className="text-right py-3 px-4">預計新增</th>
              </tr>
            </thead>
            <tbody>
              {inventoryPreviews.map((preview, index) => (
                <tr key={preview.table} className="border-b border-theme-border/50">
                  <td className="py-3 px-4">
                    <div className="font-semibold text-primary">
                      {index + 1}. {preview.table}
                    </div>
                    <div className="text-xs text-secondary/70">{preview.label}</div>
                  </td>
                  <td className="text-right py-3 px-4 text-secondary">{preview.localCount}</td>
                  <td className="text-right py-3 px-4 text-secondary">{preview.existingCount}</td>
                  <td className="text-right py-3 px-4 text-warning">{preview.duplicateIds}</td>
                  <td className="text-right py-3 px-4 text-success font-semibold">{preview.readyToInsert}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showConfirm && (
        <div className="fixed inset-0 bg-page/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-theme-border rounded-xl max-w-md w-full p-6 shadow-2xl">
            <h3 className="text-2xl font-bold text-primary mb-4 flex items-center gap-3">
              <Server className="text-accent" /> 確認匯入
            </h3>
            <p className="text-secondary mb-6">
              即將匯入選取的包商與案場資料到 Supabase。
              <br />
              <br />
              新增包商：<strong className="text-primary">{selectedContractors}</strong> 筆
              <br />
              新增案場：<strong className="text-primary">{selectedProjects}</strong> 筆
            </p>
            <div className="flex gap-4 justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                disabled={migrating}
                className="px-4 py-2 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded-lg font-medium flex items-center gap-2 transition"
              >
                <SkipForward size={16} /> 取消
              </button>
              <button
                onClick={executeMigration}
                disabled={migrating}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-bold flex items-center gap-2 transition shadow-lg shadow-accent/20"
              >
                {migrating ? '匯入中...' : '確認匯入'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showInventoryConfirm && (
        <div className="fixed inset-0 bg-page/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-theme-border rounded-xl max-w-lg w-full p-6 shadow-2xl">
            <h3 className="text-2xl font-bold text-primary mb-4 flex items-center gap-3">
              <Database className="text-accent" /> 確認庫存匯入
            </h3>
            <div className="text-secondary mb-6 space-y-4">
              <p>
                將從 <code className="bg-page border border-theme-border px-1.5 py-0.5 rounded text-primary">{MOCK_DB_KEY}</code> 依指定順序匯入庫存資料。
              </p>
              <div className="bg-page/60 border border-theme-border rounded-lg p-3 text-sm flex gap-2">
                <Info size={16} className="text-accent shrink-0 mt-0.5" />
                <span className="text-secondary">
                  重複 id 會略過，不會覆蓋 Supabase 既有資料。案場關聯會優先用名稱、簡稱或案號對應到 Supabase 案場。
                </span>
              </div>
              <p>
                預計新增：<strong className="text-primary">{inventoryReadyCount}</strong> 筆
              </p>
            </div>
            <div className="flex gap-4 justify-end">
              <button
                onClick={() => setShowInventoryConfirm(false)}
                disabled={inventoryMigrating}
                className="px-4 py-2 bg-card hover:bg-page border border-theme-border text-secondary hover:text-primary rounded-lg font-medium flex items-center gap-2 transition"
              >
                <SkipForward size={16} /> 取消
              </button>
              <button
                onClick={executeInventoryMigration}
                disabled={inventoryMigrating}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg font-bold flex items-center gap-2 transition shadow-lg shadow-accent/20"
              >
                {inventoryMigrating ? '匯入中...' : '確認匯入庫存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
