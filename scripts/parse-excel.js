const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXCEL_PATH = path.join(__dirname, '../imports/北部案場主檔_含新竹_含聯絡資料.xlsx');
const OUTPUT_PATH = path.join(__dirname, '../src/lib/db/mock-projects.json');

try {
  console.log('Reading Excel file from:', EXCEL_PATH);
  const workbook = xlsx.readFile(EXCEL_PATH);
  
  // 優先使用「完整資料_可展開」
  const sheetName = workbook.SheetNames.includes('完整資料_可展開') 
    ? '完整資料_可展開' 
    : workbook.SheetNames[0];

  console.log('Using sheet:', sheetName);
  
  const worksheet = workbook.Sheets[sheetName];
  const rawData = xlsx.utils.sheet_to_json(worksheet, { defval: '' });
  
  const projects = rawData.map(row => {
    // 根據實際 Excel 的標題，這裡使用容錯的方式讀取
    // 假設 Excel 欄位名稱如下：
    // [案場代碼, 保固狀態, 案場名稱, 案場簡稱, 聯絡人, 聯絡方式, 地址, 備註, 容量, 案場區域, 案件型式, 狀態, 
    // 屋主/場地所有人, 屋主電話, 資料來源, 完工日, 工程保固年, 保固終止日, 維保合約有無, 維保起始日, 維保終止日, 
    // 維保說明, 逆變器廠牌, 逆變器保固, 監控系統, 模組固定方式]
    
    // 輔助函式：取得欄位值（去除前後空白）
    const getVal = (keys) => {
      for (const k of keys) {
        if (row[k] !== undefined) return String(row[k]).trim();
      }
      return '';
    };

      const contact = getVal(['聯絡人']);
      const notesVal = getVal(['備註']);
      const nameVal = getVal(['案場名稱']);
      const textToSearch = `${nameVal} ${contact} ${notesVal}`.toLowerCase();
      
      let manager = '';
      if (textToSearch.includes('柚子') || textToSearch.includes('yuzu')) manager = '柚子';
      else if (textToSearch.includes('維揚') || textToSearch.includes('weiyang')) manager = '維揚';
      else if (textToSearch.includes('育丞') || textToSearch.includes('yucheng')) manager = '育丞';
      
      let statusVal = getVal(['狀態']);
      if (!statusVal) statusVal = '未設定';

      return {
        id: crypto.randomUUID(),
        name: nameVal,
        short_name: getVal(['案場簡稱', '簡稱']),
        address: getVal(['地址', '案場地址']),
        owner_name: getVal(['屋主/場地所有人', '屋主', '場地所有人']),
        contact_name: contact,
        contact_phone: getVal(['聯絡方式', '聯絡電話']),
        notes: notesVal,
        is_active: true,
      is_active_project: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        
        capacity: getVal(['容量', '容量(kW)', '案場容量(kW)']),
        region: getVal(['案場區域', '區域']),
        project_type: getVal(['案件型式', '建置形式']),
        status: statusVal,
        manager: manager,
      
      owner_phone: getVal(['屋主電話']),
      data_source: getVal(['資料來源']),
      
      warranty_status: getVal(['保固狀態']),
      completion_date: getVal(['完工日', '併網日期']),
      warranty_years: getVal(['工程保固年', '保固年限']),
      warranty_end_date: getVal(['保固終止日', '保固到期日']),
      has_maintenance_contract: getVal(['維保合約有無', '維保合約']),
      maintenance_start_date: getVal(['維保起始日']),
      maintenance_end_date: getVal(['維保終止日']),
      maintenance_notes: getVal(['維保說明']),
      
      inverter_brand: getVal(['逆變器廠牌', 'Inverter']),
      inverter_warranty: getVal(['逆變器保固']),
      monitoring_system: getVal(['監控系統']),
      module_mounting_type: getVal(['模組固定方式']),
      
      last_inspection_date: null,
      inspection_cycle_months: null,
      next_inspection_date: null,
      inspection_reminder_days: null,
      is_inspection_reminder_active: false
    };
  }).filter(p => p.name); // 過濾掉沒有名稱的空列

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(projects, null, 2), 'utf-8');
  console.log(`Successfully extracted ${projects.length} projects to ${OUTPUT_PATH}`);

} catch (error) {
  console.error('Error parsing Excel:', error);
  process.exit(1);
}
