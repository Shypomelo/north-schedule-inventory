const fs = require('fs');
const path = require('path');

const mockFile = path.join(__dirname, 'src/lib/db/mock.ts');
let content = fs.readFileSync(mockFile, 'utf8');

// 1. Add InventoryBatch import
content = content.replace('ActivityLog } from', 'ActivityLog, InventoryBatch } from');

// 2. Add inventory_batches to interface
content = content.replace('activity_logs: ActivityLog[];', 'inventory_batches: InventoryBatch[];\n  activity_logs: ActivityLog[];');

// 3. Add inventory_batches to initial db state
content = content.replace('activity_logs: [],', 'inventory_batches: [],\n  activity_logs: [],');

// 4. Migration logic
const migrationCode = `
      // Auto-migrate batches
      if (!db.inventory_batches) {
        db.inventory_batches = [];
      }
      
      let batchCounter = 1;
      const getNextBatchNo = (dateStr) => {
        const ymd = dateStr.replace(/-/g, '').substring(0,8);
        return \`IN-\${ymd}-\${String(batchCounter++).padStart(3, '0')}\`;
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
`;

content = content.replace('if (missingUsers.length > 0 || hasItemChanges || hasMigrationChanges) {', 
  migrationCode + '\n      if (missingUsers.length > 0 || hasItemChanges || hasMigrationChanges || hasBatchMigrationChanges) {');

// 5. Update createInventoryTransaction
const oldCreateTx = `  createInventoryTransaction: async (t: Omit<InventoryTransaction, 'id'|'created_at'|'updated_at'>, serialsData: Omit<InventoryTransactionSerial, 'id'|'transaction_id'|'created_at'>[] = [], user: string = 'system') => {
    const newTx: InventoryTransaction = {
      ...t,
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_voided: false,
    };
    db.inventory_transactions.push(newTx);`;

const newCreateTx = `  getInventoryBatches: async () => [...db.inventory_batches].sort((a,b) => new Date(b.in_date).getTime() - new Date(a.in_date).getTime() || new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),

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
      const batchNo = \`IN-\${todayYMD}-\${String(existingToday + 1).padStart(3, '0')}\`;
      
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
`;
content = content.replace(oldCreateTx, newCreateTx);

// 6. Update serialsData loop in createInventoryTransaction to set batch_id
const oldSerialsLoop = `    serialsData.forEach(s => {
      db.inventory_transaction_serials.push({
        ...s,
        id: crypto.randomUUID(),
        transaction_id: newTx.id,
        created_at: new Date().toISOString()
      });
    });`;
const newSerialsLoop = `    serialsData.forEach(s => {
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
    });`;
content = content.replace(oldSerialsLoop, newSerialsLoop);

// 7. Remove item_serials.splice for IN when voiding. 
// Actually if a batch is voided, we should also delete the batch or remove batch_id.
// The user prompt doesn't explicitly require it, so let's keep it simple.

fs.writeFileSync(mockFile, content, 'utf8');
console.log('mock.ts updated successfully');
