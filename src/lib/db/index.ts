import { mockDbAdapter } from './mock';
import { pocSupabaseAdapter } from './poc-supabase';
import { supabase } from './supabaseClient';

const hasSupabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isProduction = process.env.NODE_ENV === 'production';
const GOOGLE_REMOTE_DELETED_CODE = 'GOOGLE_EVENT_REMOTE_DELETED';

class GoogleRemoteDeletedSyncError extends Error {
  code = GOOGLE_REMOTE_DELETED_CODE;
  taskId?: string;
  googleEventId?: string;

  constructor(taskId?: string, googleEventId?: string) {
    super('Google event was deleted remotely');
    this.name = 'GoogleRemoteDeletedSyncError';
    this.taskId = taskId;
    this.googleEventId = googleEventId;
  }
}

export const isGoogleRemoteDeletedError = (error: unknown): error is GoogleRemoteDeletedSyncError => (
  !!error
  && typeof error === 'object'
  && 'code' in error
  && (error as { code?: string }).code === GOOGLE_REMOTE_DELETED_CODE
);

const requireInventorySupabase = (methodName: string) => async () => {
  throw new Error(
    `Supabase is required for inventory in production. Refusing mock/localStorage fallback for ${methodName}.`
  );
};

const inventoryAdapter = hasSupabase
  ? {
      getInventoryItems: pocSupabaseAdapter.getInventoryItems,
      hasInventoryItemMonthlyClosing: pocSupabaseAdapter.hasInventoryItemMonthlyClosing,
      createInventoryItem: pocSupabaseAdapter.createInventoryItem,
      updateInventoryItem: pocSupabaseAdapter.updateInventoryItem,
      deleteInventoryItem: pocSupabaseAdapter.deleteInventoryItem,
      getInventoryTransactions: pocSupabaseAdapter.getInventoryTransactions,
      createInventoryTransaction: pocSupabaseAdapter.createInventoryTransaction,
      updateInventoryTransaction: pocSupabaseAdapter.updateInventoryTransaction,
      voidInventoryTransaction: pocSupabaseAdapter.voidInventoryTransaction,
      getInventorySerials: pocSupabaseAdapter.getInventorySerials,
      lookupInventorySerial: pocSupabaseAdapter.lookupInventorySerial,
      getInventoryTransactionSerials: pocSupabaseAdapter.getInventoryTransactionSerials,
      createInventorySerial: pocSupabaseAdapter.createInventorySerial,
      updateInventorySerial: pocSupabaseAdapter.updateInventorySerial,
      deleteInventorySerial: pocSupabaseAdapter.deleteInventorySerial,
      updateInventoryTransactionSerial: pocSupabaseAdapter.updateInventoryTransactionSerial,
      getInventoryBatches: pocSupabaseAdapter.getInventoryBatches,
      getInventoryBalances: pocSupabaseAdapter.getInventoryBalances,
      getMonthlyClosings: pocSupabaseAdapter.getMonthlyClosings,
      getMonthlyClosingItems: pocSupabaseAdapter.getMonthlyClosingItems,
      unsealInventoryMonth: pocSupabaseAdapter.unsealInventoryMonth,
      createMonthlyClosing: pocSupabaseAdapter.createMonthlyClosing,
      getInventoryMonthlyClosings: pocSupabaseAdapter.getInventoryMonthlyClosings,
      getInventoryMonthlyClosingItems: pocSupabaseAdapter.getInventoryMonthlyClosingItems,
    }
  : isProduction
    ? {
        getInventoryItems: requireInventorySupabase('getInventoryItems'),
        hasInventoryItemMonthlyClosing: requireInventorySupabase('hasInventoryItemMonthlyClosing'),
        createInventoryItem: requireInventorySupabase('createInventoryItem'),
        updateInventoryItem: requireInventorySupabase('updateInventoryItem'),
        deleteInventoryItem: requireInventorySupabase('deleteInventoryItem'),
        getInventoryTransactions: requireInventorySupabase('getInventoryTransactions'),
        createInventoryTransaction: requireInventorySupabase('createInventoryTransaction'),
        updateInventoryTransaction: requireInventorySupabase('updateInventoryTransaction'),
        voidInventoryTransaction: requireInventorySupabase('voidInventoryTransaction'),
        getInventorySerials: requireInventorySupabase('getInventorySerials'),
        lookupInventorySerial: requireInventorySupabase('lookupInventorySerial'),
        getInventoryTransactionSerials: requireInventorySupabase('getInventoryTransactionSerials'),
        createInventorySerial: requireInventorySupabase('createInventorySerial'),
        updateInventorySerial: requireInventorySupabase('updateInventorySerial'),
        deleteInventorySerial: requireInventorySupabase('deleteInventorySerial'),
        updateInventoryTransactionSerial: requireInventorySupabase('updateInventoryTransactionSerial'),
        getInventoryBatches: requireInventorySupabase('getInventoryBatches'),
        getInventoryBalances: requireInventorySupabase('getInventoryBalances'),
        getMonthlyClosings: requireInventorySupabase('getMonthlyClosings'),
        getMonthlyClosingItems: requireInventorySupabase('getMonthlyClosingItems'),
        unsealInventoryMonth: requireInventorySupabase('unsealInventoryMonth'),
        createMonthlyClosing: requireInventorySupabase('createMonthlyClosing'),
        getInventoryMonthlyClosings: requireInventorySupabase('getInventoryMonthlyClosings'),
        getInventoryMonthlyClosingItems: requireInventorySupabase('getInventoryMonthlyClosingItems'),
      }
    : {
        getInventoryItems: mockDbAdapter.getInventoryItems,
        hasInventoryItemMonthlyClosing: mockDbAdapter.hasInventoryItemMonthlyClosing,
        createInventoryItem: mockDbAdapter.createInventoryItem,
        updateInventoryItem: mockDbAdapter.updateInventoryItem,
        deleteInventoryItem: mockDbAdapter.deleteInventoryItem,
        getInventoryTransactions: mockDbAdapter.getInventoryTransactions,
        createInventoryTransaction: mockDbAdapter.createInventoryTransaction,
        updateInventoryTransaction: mockDbAdapter.updateInventoryTransaction,
        voidInventoryTransaction: mockDbAdapter.voidInventoryTransaction,
        getInventorySerials: mockDbAdapter.getInventorySerials,
        lookupInventorySerial: mockDbAdapter.lookupInventorySerial,
        getInventoryTransactionSerials: mockDbAdapter.getInventoryTransactionSerials,
        createInventorySerial: mockDbAdapter.createInventorySerial,
        updateInventorySerial: mockDbAdapter.updateInventorySerial,
        deleteInventorySerial: mockDbAdapter.deleteInventorySerial,
        updateInventoryTransactionSerial: mockDbAdapter.updateInventoryTransactionSerial,
        getInventoryBatches: mockDbAdapter.getInventoryBatches,
        getInventoryBalances: mockDbAdapter.getInventoryBalances,
        getMonthlyClosings: mockDbAdapter.getMonthlyClosings,
        getMonthlyClosingItems: mockDbAdapter.getMonthlyClosingItems,
        unsealInventoryMonth: mockDbAdapter.unsealInventoryMonth,
        createMonthlyClosing: mockDbAdapter.createMonthlyClosing,
        getInventoryMonthlyClosings: mockDbAdapter.getMonthlyClosings,
        getInventoryMonthlyClosingItems: mockDbAdapter.getMonthlyClosingItems,
      };

const requireSESupplySupabase = (methodName: string) => async () => {
  throw new Error(
    `Supabase is required for SE Supply in production. Refusing mock/localStorage fallback for ${methodName}.`
  );
};

const seSupplyAdapter = hasSupabase
  ? {
      getSESupplyRecords: pocSupabaseAdapter.getSESupplyRecords,
      createSESupplyRecord: pocSupabaseAdapter.createSESupplyRecord,
      updateSESupplyRecord: pocSupabaseAdapter.updateSESupplyRecord,
      deleteSESupplyRecord: pocSupabaseAdapter.deleteSESupplyRecord,
    }
  : isProduction
    ? {
        getSESupplyRecords: requireSESupplySupabase('getSESupplyRecords'),
        createSESupplyRecord: requireSESupplySupabase('createSESupplyRecord'),
        updateSESupplyRecord: requireSESupplySupabase('updateSESupplyRecord'),
        deleteSESupplyRecord: requireSESupplySupabase('deleteSESupplyRecord'),
      }
    : {
        getSESupplyRecords: mockDbAdapter.getSESupplyRecords,
        createSESupplyRecord: mockDbAdapter.createSESupplyRecord,
        updateSESupplyRecord: mockDbAdapter.updateSESupplyRecord,
        deleteSESupplyRecord: mockDbAdapter.deleteSESupplyRecord,
      };

const requireScheduleTaskTypesSupabase = (methodName: string) => async (..._args: unknown[]) => {
  throw new Error(
    `Supabase is required for schedule task types in production. Refusing mock/localStorage fallback for ${methodName}.`
  );
};

const scheduleTaskTypesAdapter = hasSupabase
  ? {
      listScheduleTaskTypes: pocSupabaseAdapter.listScheduleTaskTypes,
      createScheduleTaskType: pocSupabaseAdapter.createScheduleTaskType,
      updateScheduleTaskType: pocSupabaseAdapter.updateScheduleTaskType,
      reorderScheduleTaskTypes: pocSupabaseAdapter.reorderScheduleTaskTypes,
    }
  : isProduction
    ? {
        listScheduleTaskTypes: requireScheduleTaskTypesSupabase('listScheduleTaskTypes'),
        createScheduleTaskType: requireScheduleTaskTypesSupabase('createScheduleTaskType'),
        updateScheduleTaskType: requireScheduleTaskTypesSupabase('updateScheduleTaskType'),
        reorderScheduleTaskTypes: requireScheduleTaskTypesSupabase('reorderScheduleTaskTypes'),
      }
    : {
        listScheduleTaskTypes: mockDbAdapter.listScheduleTaskTypes,
        createScheduleTaskType: mockDbAdapter.createScheduleTaskType,
        updateScheduleTaskType: mockDbAdapter.updateScheduleTaskType,
        reorderScheduleTaskTypes: mockDbAdapter.reorderScheduleTaskTypes,
      };

const syncToGoogle = async (action: 'CREATE' | 'UPDATE' | 'DELETE', task: any, skipGoogleSync?: boolean) => {
  if (skipGoogleSync) return;
  try {
    if (typeof window === 'undefined') return;

    const { data: { session }, error } = await supabase.auth.getSession();
    if (error || !session?.access_token) return;

    const baseUrl = typeof window !== 'undefined' ? '' : process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
    const response = await fetch(`${baseUrl}/api/google-calendar/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action, task }),
    });

    const result = await response.json().catch(() => null);
    if (result?.remote_deleted && action !== 'DELETE') {
      throw new GoogleRemoteDeletedSyncError(result.taskId, result.googleEventId);
    }

    if (!response.ok) {
      console.error('Google Calendar Sync failed:', result?.error || response.statusText);
    }
  } catch (error) {
    if (isGoogleRemoteDeletedError(error)) throw error;
    console.error('Google Calendar Sync failed:', error);
  }
};

export const dbAdapter = {
  ...mockDbAdapter,
  ...scheduleTaskTypesAdapter,
  getUsers: hasSupabase ? pocSupabaseAdapter.getUsers : mockDbAdapter.getUsers,
  createUser: hasSupabase ? pocSupabaseAdapter.createUser : mockDbAdapter.createUser,
  updateUser: hasSupabase ? pocSupabaseAdapter.updateUser : mockDbAdapter.updateUser,
  getScheduleTasks: hasSupabase ? pocSupabaseAdapter.getScheduleTasks : mockDbAdapter.getScheduleTasks,
  getScheduleTaskMembers: hasSupabase ? pocSupabaseAdapter.getScheduleTaskMembers : mockDbAdapter.getScheduleTaskMembers,

  createScheduleTask: async (t: any, newMemberIds?: string[], skipGoogleSync = false) => {
    const fn = hasSupabase ? pocSupabaseAdapter.createScheduleTask : mockDbAdapter.createScheduleTask;
    const result = await fn(t, newMemberIds);
    await syncToGoogle('CREATE', result, skipGoogleSync);
    return result;
  },

  updateScheduleTask: async (id: string, updates: any, newMemberIds?: string[], skipGoogleSync = false) => {
    const fn = hasSupabase ? pocSupabaseAdapter.updateScheduleTask : mockDbAdapter.updateScheduleTask;
    const result = await fn(id, updates, newMemberIds);
    await syncToGoogle('UPDATE', result, skipGoogleSync);
    return result;
  },

  deleteScheduleTask: async (id: string, skipGoogleSync = false) => {
    let taskToDelete;
    if (!skipGoogleSync) {
      const getFn = hasSupabase ? pocSupabaseAdapter.getScheduleTasks : mockDbAdapter.getScheduleTasks;
      const allTasks = await getFn();
      taskToDelete = allTasks.find(t => t.id === id);
    }

    const fn = hasSupabase ? pocSupabaseAdapter.deleteScheduleTask : mockDbAdapter.deleteScheduleTask;
    await fn(id);

    if (taskToDelete) {
      await syncToGoogle('DELETE', taskToDelete, skipGoogleSync);
    }
  },

  // Contractors
  getContractors: hasSupabase ? pocSupabaseAdapter.getContractors : mockDbAdapter.getContractors,
  createContractor: hasSupabase ? pocSupabaseAdapter.createContractor : mockDbAdapter.createContractor,
  updateContractor: hasSupabase ? pocSupabaseAdapter.updateContractor : mockDbAdapter.updateContractor,
  deleteContractor: hasSupabase ? pocSupabaseAdapter.deleteContractor : mockDbAdapter.deleteContractor,

  // Projects
  getProjects: hasSupabase ? pocSupabaseAdapter.getProjects : mockDbAdapter.getProjects,
  createProject: hasSupabase ? pocSupabaseAdapter.createProject : mockDbAdapter.createProject,
  updateProject: hasSupabase ? pocSupabaseAdapter.updateProject : mockDbAdapter.updateProject,
  deleteProject: hasSupabase ? pocSupabaseAdapter.deleteProject : mockDbAdapter.deleteProject,

  ...inventoryAdapter,
  ...seSupplyAdapter,
  getActivityLogs: hasSupabase ? pocSupabaseAdapter.getActivityLogs : mockDbAdapter.getActivityLogs,
  logActivity: hasSupabase ? pocSupabaseAdapter.logActivity : mockDbAdapter.logActivity,
};
