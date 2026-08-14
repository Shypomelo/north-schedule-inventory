import { mockDbAdapter } from './mock';
import { pocSupabaseAdapter } from './poc-supabase';

const hasSupabase = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const isProduction = process.env.NODE_ENV === 'production';

const requireInventorySupabase = (methodName: string) => async () => {
  throw new Error(
    `Supabase is required for inventory in production. Refusing mock/localStorage fallback for ${methodName}.`
  );
};

const inventoryAdapter = hasSupabase
  ? {
      getInventoryItems: pocSupabaseAdapter.getInventoryItems,
      createInventoryItem: pocSupabaseAdapter.createInventoryItem,
      updateInventoryItem: pocSupabaseAdapter.updateInventoryItem,
      deleteInventoryItem: pocSupabaseAdapter.deleteInventoryItem,
      getInventoryTransactions: pocSupabaseAdapter.getInventoryTransactions,
      createInventoryTransaction: pocSupabaseAdapter.createInventoryTransaction,
      updateInventoryTransaction: pocSupabaseAdapter.updateInventoryTransaction,
      voidInventoryTransaction: pocSupabaseAdapter.voidInventoryTransaction,
      getInventorySerials: pocSupabaseAdapter.getInventorySerials,
      getInventoryTransactionSerials: pocSupabaseAdapter.getInventoryTransactionSerials,
      createInventorySerial: pocSupabaseAdapter.createInventorySerial,
      updateInventorySerial: pocSupabaseAdapter.updateInventorySerial,
      deleteInventorySerial: pocSupabaseAdapter.deleteInventorySerial,
      updateInventoryTransactionSerial: pocSupabaseAdapter.updateInventoryTransactionSerial,
      getInventoryBatches: pocSupabaseAdapter.getInventoryBatches,
      getInventoryBalances: pocSupabaseAdapter.getInventoryBalances,
      getMonthlyClosings: pocSupabaseAdapter.getMonthlyClosings,
      getMonthlyClosingItems: pocSupabaseAdapter.getMonthlyClosingItems,
      createMonthlyClosing: pocSupabaseAdapter.createMonthlyClosing,
      getInventoryMonthlyClosings: pocSupabaseAdapter.getInventoryMonthlyClosings,
      getInventoryMonthlyClosingItems: pocSupabaseAdapter.getInventoryMonthlyClosingItems,
    }
  : isProduction
    ? {
        getInventoryItems: requireInventorySupabase('getInventoryItems'),
        createInventoryItem: requireInventorySupabase('createInventoryItem'),
        updateInventoryItem: requireInventorySupabase('updateInventoryItem'),
        deleteInventoryItem: requireInventorySupabase('deleteInventoryItem'),
        getInventoryTransactions: requireInventorySupabase('getInventoryTransactions'),
        createInventoryTransaction: requireInventorySupabase('createInventoryTransaction'),
        updateInventoryTransaction: requireInventorySupabase('updateInventoryTransaction'),
        voidInventoryTransaction: requireInventorySupabase('voidInventoryTransaction'),
        getInventorySerials: requireInventorySupabase('getInventorySerials'),
        getInventoryTransactionSerials: requireInventorySupabase('getInventoryTransactionSerials'),
        createInventorySerial: requireInventorySupabase('createInventorySerial'),
        updateInventorySerial: requireInventorySupabase('updateInventorySerial'),
        deleteInventorySerial: requireInventorySupabase('deleteInventorySerial'),
        updateInventoryTransactionSerial: requireInventorySupabase('updateInventoryTransactionSerial'),
        getInventoryBatches: requireInventorySupabase('getInventoryBatches'),
        getInventoryBalances: requireInventorySupabase('getInventoryBalances'),
        getMonthlyClosings: requireInventorySupabase('getMonthlyClosings'),
        getMonthlyClosingItems: requireInventorySupabase('getMonthlyClosingItems'),
        createMonthlyClosing: requireInventorySupabase('createMonthlyClosing'),
        getInventoryMonthlyClosings: requireInventorySupabase('getInventoryMonthlyClosings'),
        getInventoryMonthlyClosingItems: requireInventorySupabase('getInventoryMonthlyClosingItems'),
      }
    : {
        getInventoryItems: mockDbAdapter.getInventoryItems,
        createInventoryItem: mockDbAdapter.createInventoryItem,
        updateInventoryItem: mockDbAdapter.updateInventoryItem,
        deleteInventoryItem: mockDbAdapter.deleteInventoryItem,
        getInventoryTransactions: mockDbAdapter.getInventoryTransactions,
        createInventoryTransaction: mockDbAdapter.createInventoryTransaction,
        updateInventoryTransaction: mockDbAdapter.updateInventoryTransaction,
        voidInventoryTransaction: mockDbAdapter.voidInventoryTransaction,
        getInventorySerials: mockDbAdapter.getInventorySerials,
        getInventoryTransactionSerials: mockDbAdapter.getInventoryTransactionSerials,
        createInventorySerial: mockDbAdapter.createInventorySerial,
        updateInventorySerial: mockDbAdapter.updateInventorySerial,
        deleteInventorySerial: mockDbAdapter.deleteInventorySerial,
        updateInventoryTransactionSerial: mockDbAdapter.updateInventoryTransactionSerial,
        getInventoryBatches: mockDbAdapter.getInventoryBatches,
        getInventoryBalances: mockDbAdapter.getInventoryBalances,
        getMonthlyClosings: mockDbAdapter.getMonthlyClosings,
        getMonthlyClosingItems: mockDbAdapter.getMonthlyClosingItems,
        createMonthlyClosing: mockDbAdapter.createMonthlyClosing,
        getInventoryMonthlyClosings: mockDbAdapter.getMonthlyClosings,
        getInventoryMonthlyClosingItems: mockDbAdapter.getMonthlyClosingItems,
      };

export const dbAdapter = {
  ...mockDbAdapter,
  getUsers: hasSupabase ? pocSupabaseAdapter.getUsers : mockDbAdapter.getUsers,
  createUser: hasSupabase ? pocSupabaseAdapter.createUser : mockDbAdapter.createUser,
  updateUser: hasSupabase ? pocSupabaseAdapter.updateUser : mockDbAdapter.updateUser,
  getScheduleTasks: hasSupabase ? pocSupabaseAdapter.getScheduleTasks : mockDbAdapter.getScheduleTasks,
  createScheduleTask: hasSupabase ? pocSupabaseAdapter.createScheduleTask : mockDbAdapter.createScheduleTask,
  updateScheduleTask: hasSupabase ? pocSupabaseAdapter.updateScheduleTask : mockDbAdapter.updateScheduleTask,
  deleteScheduleTask: hasSupabase ? pocSupabaseAdapter.deleteScheduleTask : mockDbAdapter.deleteScheduleTask,

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
  getActivityLogs: hasSupabase ? pocSupabaseAdapter.getActivityLogs : mockDbAdapter.getActivityLogs,
  logActivity: hasSupabase ? pocSupabaseAdapter.logActivity : mockDbAdapter.logActivity,
};
