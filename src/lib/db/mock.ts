import { User, Project, ActiveProject, ScheduleTask, ScheduleTaskMember, Todo, InventoryItem, InventoryTransaction, InventorySerial, InventoryTransactionSerial, InventoryMonthlyClosing, InventoryMonthlyClosingItem, StockCategory, ActivityLog, InventoryBatch, SESupplyRecord } from './types';

import mockProjectsData from './mock-projects.json';
import mockActiveProjectsData from './mock-active-projects.json';
import mockInventoryItemsData from './mock-inventory-items.json';

// Simple mock store in memory, periodically saved to localStorage if in browser
const IS_BROWSER = typeof window !== 'undefined';

interface MockDatabase {
  users: User[];
  projects: Project[];
  active_projects: ActiveProject[];
  schedule_tasks: ScheduleTask[];
  schedule_task_members: ScheduleTaskMember[];
  todos: Todo[];
  inventory_items: InventoryItem[];
  inventory_transactions: InventoryTransaction[];
  item_serials: InventorySerial[];
  inventory_transaction_serials: InventoryTransactionSerial[];
  inventory_monthly_closings: InventoryMonthlyClosing[];
  inventory_monthly_closing_items: InventoryMonthlyClosingItem[];
  inventory_batches: InventoryBatch[];
  activity_logs: ActivityLog[];
  se_supply_records: SESupplyRecord[];
}

const STORAGE_KEY = 'schedule-inventory-mock-db-v7';

const initialUsers: User[] = [
    {
      id: 'mock-user-admin',
      name: 'Admin User',
      short_name: 'Admin',
      email: 'admin@vibecode.com',
      role: 'ADMIN',
      category: 'OTHER',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 'mock-user-engineer',
      name: '柚子',
      short_name: '柚',
      email: 'yuzu@vibecode.com',
      role: 'ADMIN',
      category: 'ENGINEERING',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 'mock-user-weiyang',
      name: '維揚',
      short_name: '維',
      email: 'weiyang@vibecode.com',
      role: 'ENGINEER',
      category: 'ENGINEERING',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 'mock-user-yucheng',
      name: '育丞',
      short_name: '丞',
      email: 'yucheng@vibecode.com',
      role: 'ENGINEER',
      category: 'ENGINEERING',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 'mock-user-tzu-yun',
      name: '慈芸',
      short_name: '芸',
      email: 'tzuyun@vibecode.com',
      role: 'VIEWER',
      category: 'OTHER',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: 'mock-user-zhi-wei',
      name: '志偉',
      short_name: '偉',
      email: 'zhiwei@vibecode.com',
      role: 'ENGINEER',
      category: 'OTHER',
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
];

let db: MockDatabase = {
  users: [...initialUsers],
  projects: (mockProjectsData as any[]) as Project[],
  active_projects: (mockActiveProjectsData as any[]) as ActiveProject[],
  schedule_tasks: [],
  schedule_task_members: [],
  todos: [],
  inventory_items: mockInventoryItemsData.map(item => ({
    ...item,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })) as any[],
  inventory_transactions: [],
  item_serials: [],
  inventory_transaction_serials: [],
  inventory_monthly_closings: [],
  inventory_monthly_closing_items: [],
  inventory_batches: [],
  activity_logs: [],
  se_supply_records: []
};

if (IS_BROWSER) {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      db = JSON.parse(saved);
      if (!db.active_projects) {
        db.active_projects = (mockActiveProjectsData as any[]) as ActiveProject[];
      }
      if (!db.inventory_monthly_closing_items) {
        db.inventory_monthly_closing_items = [];
      }
      
      // Auto-migrate inventory items categories and sources
      let hasMigrationChanges = false;
      db.inventory_items = db.inventory_items.map(item => {
        let newItem = { ...item };
        let changed = false;
        if (!['設備維修', '建置 / 維修', 'SE 供貨'].includes(newItem.category)) {
          newItem.item_category = newItem.category; // Backup original category
          if (newItem.item_category === '逆變器' || newItem.item_category === '優化器' || newItem.item_category === '監控設備' || newItem.source_type?.includes('備機')) {
            newItem.category = '設備維修';
          } else {
            newItem.category = '建置 / 維修';
          }
          changed = true;
        }
        const validSources = ['陽光', '中部移轉', '南部移轉', 'SE 寄送', 'SE 自取', '其他'];
        if (!validSources.includes(newItem.source_type || '')) {
           if (newItem.source_type?.includes('SE')) newItem.source_type = 'SE 寄送';
           else if (newItem.source_type?.includes('中')) newItem.source_type = '中部移轉';
           else if (newItem.source_type?.includes('南')) newItem.source_type = '南部移轉';
           else newItem.source_type = '其他';
           changed = true;
        }
        if (changed) hasMigrationChanges = true;
        return newItem;
      });

      // Merge missing users
      const existingNames = db.users.map(u => u.name);
      const missingUsers = initialUsers.filter(u => !existingNames.includes(u.name));
      if (missingUsers.length > 0) {
        db.users = [...db.users, ...missingUsers];
      }

      // Merge inventory items
      const importedItems = mockInventoryItemsData as any[];
      let hasItemChanges = false;
      importedItems.forEach(importedItem => {
        const existingIdx = db.inventory_items.findIndex(i => i.code === importedItem.code);
        if (existingIdx >= 0) {
          // Update existing item, keeping id and timestamps
          db.inventory_items[existingIdx] = {
            ...db.inventory_items[existingIdx],
            ...importedItem,
            id: db.inventory_items[existingIdx].id,
            created_at: db.inventory_items[existingIdx].created_at,
            updated_at: new Date().toISOString()
          };
          hasItemChanges = true;
        } else {
          // Add new item
          db.inventory_items.push({
            ...importedItem,
            id: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          });
          hasItemChanges = true;
        }
      });

      
      // Auto-migrate batches
      if (!db.inventory_batches) db.inventory_batches = [];
      if (!db.se_supply_records) db.se_supply_records = [];
      
      let hasChanges = false;
      let batchCounter = 1;
      const getNextBatchNo = (dateStr: string) => {
        const ymd = dateStr.replace(/-/g, '').substring(0,8);
        return `IN-${ymd}-${String(batchCounter++).padStart(3, '0')}`;
      };

      let hasBatchMigrationChanges = false;
      if (db.inventory_batches.length === 0) {
        db.inventory_items.forEach(item => {
          if (item.opening_quantity && item.opening_quantity > 0) {
            const batch = {
              id: crypto.randomUUID(),
              batch_number: getNextBatchNo(item.created_at || new Date().toISOString()),
              item_id: item.id,
              in_date: (item.created_at || new Date().toISOString()).substring(0,10),
              source: item.source_type || '系統期初',
              quantity: item.opening_quantity,
              unit: item.unit,
              handler: '系統',
              notes: '期初庫存自動產生批次',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            db.inventory_batches.push(batch);
            
            db.item_serials.filter(s => s.item_id === item.id && !s.batch_id).forEach(s => {
              s.batch_id = batch.id;
            });
          }
        });

        db.inventory_transactions.filter(t => t.transaction_type === 'IN' || t.transaction_type === 'RETURN').forEach(tx => {
           const batch = {
              id: crypto.randomUUID(),
              batch_number: getNextBatchNo(tx.transaction_date || new Date().toISOString()),
              item_id: tx.item_id,
              in_date: tx.transaction_date,
              source: tx.source || (tx.transaction_type === 'RETURN' ? '退料' : '無來源'),
              quantity: tx.quantity,
              unit: tx.unit,
              handler: tx.handler || '系統',
              notes: '既有入庫紀錄自動產生批次',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            db.inventory_batches.push(batch);
            
            const txSerials = db.inventory_transaction_serials.filter(ts => ts.transaction_id === tx.id);
            txSerials.forEach(ts => {
               const serial = db.item_serials.find(s => s.serial_number === ts.serial_no && s.item_id === tx.item_id);
               if (serial && !serial.batch_id) {
                 serial.batch_id = batch.id;
               }
            });
        });
        hasBatchMigrationChanges = true;
      }

      if (missingUsers.length > 0 || hasItemChanges || hasMigrationChanges || hasBatchMigrationChanges) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      }
    } catch (e) {
      console.error('Failed to load mock DB', e);
    }
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }
}

function persist() {
  if (IS_BROWSER) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }
}

export const mockDbAdapter = {
  // --- Users ---
  getUsers: async () => [...db.users],
  createUser: async (u: Omit<User, 'id'|'created_at'|'updated_at'>) => {
    const newUser: User = {
      ...u,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.users.push(newUser);
    persist();
    return newUser;
  },
  updateUser: async (id: string, updates: Partial<Omit<User, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.users.findIndex(user => user.id === id);
    if (idx === -1) throw new Error("User not found");
    const updated = { ...db.users[idx], ...updates, updated_at: new Date().toISOString() };
    db.users[idx] = updated;
    persist();
    return updated;
  },
  
  // --- Projects ---
  getProjects: async () => [...db.projects].sort((a, b) => a.name.localeCompare(b.name)),
  
  createProject: async (p: Omit<Project, 'id'|'created_at'|'updated_at'>) => {
    const newProject: Project = {
      ...p,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.projects.push(newProject);
    persist();
    return newProject;
  },
  
  updateProject: async (id: string, updates: Partial<Omit<Project, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.projects.findIndex(proj => proj.id === id);
    if (idx === -1) throw new Error("Project not found");
    const updated = { ...db.projects[idx], ...updates, updated_at: new Date().toISOString() };
    db.projects[idx] = updated;
    persist();
    return updated;
  },

  // --- Active Projects ---
  getActiveProjects: async () => [...db.active_projects].sort((a, b) => a.name.localeCompare(b.name)),

  updateActiveProject: async (id: string, updates: Partial<Omit<ActiveProject, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.active_projects.findIndex(proj => proj.id === id);
    if (idx === -1) throw new Error("Active Project not found");
    const updated = { ...db.active_projects[idx], ...updates, updated_at: new Date().toISOString() };
    db.active_projects[idx] = updated;
    persist();
    return updated;
  },

  // --- Todos ---
  getTodos: async () => [...db.todos].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  createTodo: async (t: Omit<Todo, 'id'|'created_at'|'updated_at'>) => {
    const newTodo: Todo = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.todos.push(newTodo);
    persist();
    return newTodo;
  },
  updateTodo: async (id: string, updates: Partial<Omit<Todo, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.todos.findIndex(t => t.id === id);
    if (idx === -1) throw new Error("Todo not found");
    const updated = { ...db.todos[idx], ...updates, updated_at: new Date().toISOString() };
    db.todos[idx] = updated;
    persist();
    return updated;
  },
  deleteTodo: async (id: string) => {
    db.todos = db.todos.filter(t => t.id !== id);
    persist();
  },

  // --- Schedule Tasks ---
  getScheduleTasks: async () => [...db.schedule_tasks],
  createScheduleTask: async (t: Omit<ScheduleTask, 'id'|'created_at'|'updated_at'>, memberIds: string[] = []) => {
    const newTask: ScheduleTask = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.schedule_tasks.push(newTask);
    memberIds.forEach(uid => {
      db.schedule_task_members.push({
        id: crypto.randomUUID(),
        task_id: newTask.id,
        user_id: uid,
        created_at: new Date().toISOString()
      });
    });
    persist();
    return newTask;
  },
  updateScheduleTask: async (id: string, updates: Partial<Omit<ScheduleTask, 'id'|'created_at'|'updated_at'>>, newMemberIds?: string[]) => {
    const idx = db.schedule_tasks.findIndex(t => t.id === id);
    if (idx === -1) throw new Error("Task not found");
    const updated = { ...db.schedule_tasks[idx], ...updates, updated_at: new Date().toISOString() };
    db.schedule_tasks[idx] = updated;
    
    if (newMemberIds) {
      db.schedule_task_members = db.schedule_task_members.filter(m => m.task_id !== id);
      newMemberIds.forEach(uid => {
        db.schedule_task_members.push({
          id: crypto.randomUUID(),
          task_id: id,
          user_id: uid,
          created_at: new Date().toISOString()
        });
      });
    }
    persist();
    return updated;
  },
  deleteScheduleTask: async (id: string) => {
    db.schedule_tasks = db.schedule_tasks.filter(t => t.id !== id);
    db.schedule_task_members = db.schedule_task_members.filter(m => m.task_id !== id);
    persist();
  },
  getScheduleTaskMembers: async () => [...db.schedule_task_members],

  // --- Inventory Items ---
  getInventoryItems: async () => [...db.inventory_items],
  createInventoryItem: async (t: Omit<InventoryItem, 'id'|'created_at'|'updated_at'>) => {
    const newItem: InventoryItem = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.inventory_items.push(newItem);
    persist();
    return newItem;
  },
  updateInventoryItem: async (id: string, updates: Partial<Omit<InventoryItem, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.inventory_items.findIndex(t => t.id === id);
    if (idx === -1) throw new Error("Item not found");
    const updated = { ...db.inventory_items[idx], ...updates, updated_at: new Date().toISOString() };
    db.inventory_items[idx] = updated;
    persist();
    return updated;
  },
  deleteInventoryItem: async (id: string) => {
    db.inventory_items = db.inventory_items.filter(t => t.id !== id);
    persist();
  },

  // --- Inventory Transactions ---
  getInventoryTransactions: async () => [...db.inventory_transactions],
  getInventoryBatches: async () => [...db.inventory_batches].sort((a,b) => new Date(b.in_date).getTime() - new Date(a.in_date).getTime() || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),

  createInventoryTransaction: async (t: Omit<InventoryTransaction, 'id'|'created_at'|'updated_at'>, serialsData: Omit<InventoryTransactionSerial, 'id'|'transaction_id'|'created_at'>[] = [], user: string = 'system') => {
    const newTx: InventoryTransaction = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_voided: false,
    };
    db.inventory_transactions.push(newTx);

    let batchIdToLink = null;
    if (t.transaction_type === 'IN' || t.transaction_type === 'RETURN') {
      const todayYMD = t.transaction_date.replace(/-/g, '');
      const existingToday = db.inventory_batches.filter(b => b.batch_number && b.batch_number.includes(todayYMD)).length;
      const batchNo = `IN-${todayYMD}-${String(existingToday + 1).padStart(3, '0')}`;
      
      const newBatch: InventoryBatch = {
        id: crypto.randomUUID(),
        batch_number: batchNo,
        item_id: t.item_id,
        in_date: t.transaction_date,
        source: t.source || (t.transaction_type === 'RETURN' ? '退料' : null),
        quantity: t.quantity,
        unit: t.unit || null,
        handler: t.handler || user,
        notes: t.notes || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      db.inventory_batches.push(newBatch);
      batchIdToLink = newBatch.id;
    }


    // Log Activity
    db.activity_logs.push({
      id: crypto.randomUUID(),
      actor_user_id: 'system',
      actor_name: user,
      action_type: 'CREATE_TRANSACTION',
      target_type: 'INVENTORY_TRANSACTION',
      target_id: newTx.id,
      target_label: `建立異動紀錄`,
      project_id: newTx.project_id,
      project_name: newTx.project_name,
      before_value: null,
      after_value: JSON.stringify(newTx),
      message: null,
      created_at: new Date().toISOString()
    });

    serialsData.forEach(s => {
      db.inventory_transaction_serials.push({
        ...s,
        id: crypto.randomUUID(),
        transaction_id: newTx.id,
        created_at: new Date().toISOString()
      });
      if (batchIdToLink) {
         const serial = db.item_serials.find(x => x.serial_number === s.serial_no && x.item_id === t.item_id);
         if (serial) {
           serial.batch_id = batchIdToLink;
         }
      }
    });

    persist();
    return newTx;
  },
  voidInventoryTransaction: async (id: string, reason: string, user: string) => {
    const txIndex = db.inventory_transactions.findIndex(t => t.id === id);
    if (txIndex === -1) return;
    const tx = db.inventory_transactions[txIndex];
    if (tx.is_voided) throw new Error("此筆異動已經作廢。");

    const txSerials = db.inventory_transaction_serials.filter(ts => ts.transaction_id === id);
    
    // 阻擋邏輯：若為入庫，且有已被出庫的序號，則阻擋作廢
    if (tx.transaction_type === 'IN') {
      for (const ts of txSerials) {
        if (!ts.serial_id) continue;
        const serial = db.item_serials.find(s => s.id === ts.serial_id);
        if (serial && serial.status !== '在庫') {
           throw new Error("無法作廢：此入庫紀錄包含「已出庫」的序號。請先作廢對應的出庫紀錄。");
        }
      }
    }

    // Revert serial states
    for (const ts of txSerials) {
      if (!ts.serial_id) continue;
      const serialIndex = db.item_serials.findIndex(s => s.id === ts.serial_id);
      if (serialIndex === -1) continue;
      
      const serial = db.item_serials[serialIndex];
      
      if (tx.transaction_type === 'OUT') {
        db.item_serials[serialIndex] = { ...serial, status: '在庫', updated_at: new Date().toISOString() };
      } else if (tx.transaction_type === 'RETURN') {
        db.item_serials[serialIndex] = { ...serial, status: '已出庫', updated_at: new Date().toISOString() };
      } else if (tx.transaction_type === 'IN') {
        db.item_serials.splice(serialIndex, 1);
      }
    }

    const voidedTx = {
      ...tx,
      is_voided: true,
      voided_reason: reason,
      voided_by: user,
      voided_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.inventory_transactions[txIndex] = voidedTx;

    db.activity_logs.push({
      id: crypto.randomUUID(),
      actor_user_id: 'system',
      actor_name: user,
      action_type: 'VOID_TRANSACTION',
      target_type: 'INVENTORY_TRANSACTION',
      target_id: tx.id,
      target_label: `作廢異動紀錄`,
      project_id: tx.project_id,
      project_name: tx.project_name,
      before_value: JSON.stringify(tx),
      after_value: JSON.stringify(voidedTx),
      message: reason,
      created_at: new Date().toISOString()
    });

    persist();
  },
  updateInventoryTransaction: async (id: string, updates: Partial<Omit<InventoryTransaction, 'id'|'created_at'|'updated_at'>>, serialsData: Omit<InventoryTransactionSerial, 'id'|'transaction_id'|'created_at'>[] = [], reason: string, user: string) => {
    const txIndex = db.inventory_transactions.findIndex(t => t.id === id);
    if (txIndex === -1) throw new Error("Transaction not found");
    const oldTx = db.inventory_transactions[txIndex];
    if (oldTx.is_voided) throw new Error("無法編輯已作廢的紀錄。");
    
    const oldCreatedAt = oldTx.created_at;

    const txSerials = db.inventory_transaction_serials.filter(ts => ts.transaction_id === id);
    for (const ts of txSerials) {
      if (!ts.serial_id) continue;
      const serialIndex = db.item_serials.findIndex(s => s.id === ts.serial_id);
      if (serialIndex === -1) continue;
      const serial = db.item_serials[serialIndex];
      if (oldTx.transaction_type === 'OUT') {
        db.item_serials[serialIndex] = { ...serial, status: '在庫', updated_at: new Date().toISOString() };
      } else if (oldTx.transaction_type === 'RETURN') {
        db.item_serials[serialIndex] = { ...serial, status: '已出庫', updated_at: new Date().toISOString() };
      } else if (oldTx.transaction_type === 'IN') {
        db.item_serials.splice(serialIndex, 1);
      }
    }
    db.inventory_transaction_serials = db.inventory_transaction_serials.filter(ts => ts.transaction_id !== id);
    
    const updatedTx: InventoryTransaction = {
      ...oldTx,
      ...updates,
      id,
      created_at: oldCreatedAt,
      updated_at: new Date().toISOString(),
    };
    db.inventory_transactions[txIndex] = updatedTx;

    serialsData.forEach(s => {
      db.inventory_transaction_serials.push({
        ...s,
        id: crypto.randomUUID(),
        transaction_id: id,
        created_at: new Date().toISOString()
      });
    });

    db.activity_logs.push({
      id: crypto.randomUUID(),
      actor_user_id: 'system',
      actor_name: user,
      action_type: 'UPDATE_TRANSACTION',
      target_type: 'INVENTORY_TRANSACTION',
      target_id: updatedTx.id,
      target_label: `編輯異動紀錄`,
      project_id: updatedTx.project_id,
      project_name: updatedTx.project_name,
      before_value: JSON.stringify(oldTx),
      after_value: JSON.stringify(updatedTx),
      message: reason,
      created_at: new Date().toISOString()
    });

    persist();
    return updatedTx;
  },

  // --- Inventory Serials ---
  getInventorySerials: async () => [...db.item_serials],
  createInventorySerial: async (t: Omit<InventorySerial, 'id'|'created_at'|'updated_at'>) => {
    const newSerial: InventorySerial = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.item_serials.push(newSerial);
    persist();
    return newSerial;
  },
  updateInventorySerial: async (id: string, updates: Partial<Omit<InventorySerial, 'id'|'created_at'|'updated_at'>>) => {
    const idx = db.item_serials.findIndex(t => t.id === id);
    if (idx === -1) throw new Error("Serial not found");
    const updated = { ...db.item_serials[idx], ...updates, updated_at: new Date().toISOString() };
    db.item_serials[idx] = updated;
    persist();
    return updated;
  },
  deleteInventorySerial: async (id: string) => {
    db.item_serials = db.item_serials.filter(s => s.id !== id);
    persist();
  },
  
  getInventoryTransactionSerials: async () => [...db.inventory_transaction_serials],
  updateInventoryTransactionSerial: async (id: string, updates: Partial<Omit<InventoryTransactionSerial, 'id'|'transaction_id'|'created_at'>>) => {
    const idx = db.inventory_transaction_serials.findIndex(t => t.id === id);
    if (idx === -1) throw new Error("Transaction serial not found");
    const updated = { ...db.inventory_transaction_serials[idx], ...updates };
    db.inventory_transaction_serials[idx] = updated;
    persist();
    return updated;
  },

  // --- Balances ---
  getInventoryBalances: async () => {
    const balances: Record<string, { in: number, out: number, return: number, adjust: number, opening: number }> = {};
    
    db.inventory_items.forEach(item => {
      balances[item.id] = { in: 0, out: 0, return: 0, adjust: 0, opening: item.opening_quantity || 0 };
    });

    db.inventory_transactions.forEach(tx => {
      if (tx.is_voided) return; // Exclude voided transactions

      const key = tx.item_id;
      if (!balances[key]) balances[key] = { in: 0, out: 0, return: 0, adjust: 0, opening: 0 };
      
      if (tx.transaction_type === 'IN') balances[key].in += tx.quantity;
      else if (tx.transaction_type === 'OUT') balances[key].out += tx.quantity;
      else if (tx.transaction_type === 'RETURN') balances[key].return += tx.quantity;
      else if (tx.transaction_type === 'ADJUST') balances[key].adjust += tx.quantity; // adjust can be negative
    });

    return Object.keys(balances).map(item_id => {
      const b = balances[item_id];
      return {
        item_id,
        balance: b.opening + b.in - b.out + b.return + b.adjust
      };
    });
  },

  // --- Activity Logs ---
  getActivityLogs: async () => [...db.activity_logs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
  logActivity: async (log: Omit<ActivityLog, 'id' | 'created_at'>) => {
    const newLog: ActivityLog = {
      ...log,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString()
    };
    db.activity_logs.push(newLog);
    persist();
    return newLog;
  },

  // --- Monthly Closings ---
  getMonthlyClosings: async () => [...db.inventory_monthly_closings],
  getMonthlyClosingItems: async (closingId: string) => db.inventory_monthly_closing_items.filter(i => i.closing_id === closingId),
  createMonthlyClosing: async (closing: Omit<InventoryMonthlyClosing, 'id'>, items: Omit<InventoryMonthlyClosingItem, 'id' | 'closing_id'>[]) => {
    // Delete existing closing for this year/month if it exists
    const existingIndex = db.inventory_monthly_closings.findIndex(c => c.year === closing.year && c.month === closing.month);
    if (existingIndex >= 0) {
       const existingId = db.inventory_monthly_closings[existingIndex].id;
       db.inventory_monthly_closings.splice(existingIndex, 1);
       db.inventory_monthly_closing_items = db.inventory_monthly_closing_items.filter(i => i.closing_id !== existingId);
    }
    
    const newClosing: InventoryMonthlyClosing = {
      ...closing,
      id: crypto.randomUUID(),
    };
    db.inventory_monthly_closings.push(newClosing);

    items.forEach(item => {
      db.inventory_monthly_closing_items.push({
        ...item,
        id: crypto.randomUUID(),
        closing_id: newClosing.id,
      });
    });

    persist();
    return newClosing;
  },

  // --- SE Supply Records ---
  getSESupplyRecords: async (): Promise<SESupplyRecord[]> => {
    return [...(db.se_supply_records || [])].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  },
  createSESupplyRecord: async (data: Omit<SESupplyRecord, 'id'|'created_at'|'updated_at'>): Promise<SESupplyRecord> => {
    const newRecord: SESupplyRecord = {
      ...data,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (!db.se_supply_records) db.se_supply_records = [];
    db.se_supply_records.push(newRecord);
    persist();
    return newRecord;
  },
  updateSESupplyRecord: async (id: string, updates: Partial<SESupplyRecord>): Promise<SESupplyRecord | null> => {
    if (!db.se_supply_records) return null;
    const idx = db.se_supply_records.findIndex(r => r.id === id);
    if (idx === -1) throw new Error("Record not found");
    const updated = { ...db.se_supply_records[idx], ...updates, updated_at: new Date().toISOString() };
    db.se_supply_records[idx] = updated;
    persist();
    return updated;
  },
  deleteSESupplyRecord: async (id: string) => {
    if (!db.se_supply_records) return;
    db.se_supply_records = db.se_supply_records.filter(r => r.id !== id);
    persist();
  }
};
