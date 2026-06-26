const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

// Configuration
const EXCEL_FILE = path.join(__dirname, '../imports/庫存批次匯入_品項主檔.xlsx');
const SHEET_NAME = '品項主檔_匯入用';
const OUTPUT_FILE = path.join(__dirname, '../src/lib/db/mock-inventory-items.json');

function parseExcel() {
  console.log(`讀取檔案: ${EXCEL_FILE}`);
  
  if (!fs.existsSync(EXCEL_FILE)) {
    console.error('找不到匯入檔案！請確認路徑與檔名。');
    process.exit(1);
  }

  const workbook = xlsx.readFile(EXCEL_FILE);
  
  if (!workbook.SheetNames.includes(SHEET_NAME)) {
    console.error(`找不到工作表: ${SHEET_NAME}`);
    console.log(`可用的工作表有: ${workbook.SheetNames.join(', ')}`);
    process.exit(1);
  }

  const sheet = workbook.Sheets[SHEET_NAME];
  const rawData = xlsx.utils.sheet_to_json(sheet, { defval: '' });

  console.log(`成功讀取工作表，共 ${rawData.length} 筆原始資料。`);

  // Mapping logic
  // * 品項代碼 → code
  // * 分類 → category
  // * 品名 → name
  // * 規格 → spec
  // * 單位 → unit
  // * 期初數量 → opening_quantity
  // * 低庫存門檻 → low_stock_threshold
  // * 是否需要序號 → requires_serial
  // * 備註 → notes
  // * 是否啟用 → is_active

  const items = [];
  const categoryCounts = {};

  rawData.forEach((row, index) => {
    // Normalize keys (remove spaces)
    const normalizedRow = {};
    for (const key in row) {
      normalizedRow[key.trim()] = row[key];
    }

    const code = normalizedRow['品項代碼'];
    const name = normalizedRow['品名'];
    if (!code || !name) {
      console.warn(`第 ${index + 2} 行略過：缺少代碼或品名。`);
      return;
    }

    const requiresSerialStr = String(normalizedRow['是否需要序號'] || '').trim().toUpperCase();
    const isActiveStr = String(normalizedRow['是否啟用'] || '').trim().toUpperCase();

    const category = normalizedRow['分類'] || '其他';

    categoryCounts[category] = (categoryCounts[category] || 0) + 1;

    const item = {
      code: String(code).trim(),
      category: category.trim(),
      name: String(name).trim(),
      source_type: String(normalizedRow['規格'] || '').trim(),
      unit: String(normalizedRow['單位'] || '個').trim(),
      opening_quantity: parseInt(normalizedRow['期初數量']) || 0,
      low_stock_threshold: parseInt(normalizedRow['低庫存門檻']) || 0,
      requires_serial: requiresSerialStr === 'Y' || requiresSerialStr === '是' || requiresSerialStr === 'TRUE',
      notes: String(normalizedRow['備註'] || '').trim(),
      is_active: isActiveStr !== 'N' && isActiveStr !== '否' && isActiveStr !== 'FALSE'
    };

    items.push(item);
  });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`\n匯入完成！成功轉換 ${items.length} 筆品項並寫入 ${OUTPUT_FILE}`);
  console.log('分類統計:');
  for (const cat in categoryCounts) {
    console.log(`  - ${cat}: ${categoryCounts[cat]} 筆`);
  }
}

parseExcel();
