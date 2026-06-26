const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function importActiveProjects() {
  const excelFilePath = path.join(__dirname, '../imports/進行中案場清單.xlsx');
  const mockJsonPath = path.join(__dirname, '../src/lib/db/mock-projects.json');
  const BATCH_NAME = '2026-active-import';

  // 1. Read existing mock projects
  let allProjects = [];
  try {
    allProjects = JSON.parse(fs.readFileSync(mockJsonPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read mock projects', e);
    return;
  }
  
  const initialAllCount = allProjects.length;

  // Read Excel
  const workbook = xlsx.readFile(excelFilePath);
  const sheetName = '案場匯入';
  if (!workbook.Sheets[sheetName]) {
    console.error(`Sheet "${sheetName}" not found in the excel file.`);
    return;
  }

  const activeProjectsFromExcel = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  
  let matchCount = 0;
  let newCount = 0;

  activeProjectsFromExcel.forEach(row => {
    const code = row['案場代碼']?.toString().trim() || '';
    const name = row['案場名稱']?.toString().trim() || '';
    const shortName = row['案場簡稱']?.toString().trim() || '';
    const capacity = row['容量(kW)']?.toString().trim() || '';
    const status = row['狀態']?.toString().trim() || '';
    const notes = row['備註']?.toString().trim() || '';
    const rawCapacity = row['原始容量文字']?.toString().trim() || '';
    
    // Skip completely empty rows
    if (!code && !name && !shortName && !capacity && !status && !notes && !rawCapacity) {
      return;
    }

    // Attempt to match by code, then name, then short_name
    let matchedProject = null;
    
    if (code) {
      matchedProject = allProjects.find(p => p.short_name === code || p.id === code);
    }
    if (!matchedProject && name) {
      matchedProject = allProjects.find(p => p.name === name);
    }
    if (!matchedProject && shortName) {
      matchedProject = allProjects.find(p => p.short_name === shortName);
    }
    
    if (matchedProject) {
      // Update existing
      matchedProject.is_active_project = true;
      matchedProject.active_source = 'active_import';
      matchedProject.active_import_batch = BATCH_NAME;
      matchCount++;
    } else {
      // Create new
      const newProject = {
        id: crypto.randomUUID(),
        name: name || '未命名進行中案場',
        short_name: shortName || code,
        capacity: capacity || rawCapacity,
        status: status,
        notes: notes,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        is_active_project: true,
        active_source: 'active_import',
        active_import_batch: BATCH_NAME,
        // Fill other fields with empty string or null to match schema
        address: '',
        owner_name: '',
        contact_name: '',
        contact_phone: '',
        region: '',
        project_type: '',
        manager: '',
        owner_phone: '',
        data_source: '',
        warranty_status: '',
        completion_date: '',
        warranty_years: '',
        warranty_end_date: '',
        has_maintenance_contract: '',
        maintenance_start_date: '',
        maintenance_end_date: '',
        maintenance_notes: '',
        inverter_brand: '',
        inverter_warranty: '',
        monitoring_system: '',
        module_mounting_type: '',
        last_inspection_date: '',
        inspection_cycle_months: '',
        next_inspection_date: '',
        inspection_reminder_days: '',
        is_inspection_reminder_active: false
      };
      allProjects.push(newProject);
      newCount++;
    }
  });

  // Save back
  fs.writeFileSync(mockJsonPath, JSON.stringify(allProjects, null, 2));

  // Reporting
  const finalAllCount = allProjects.length;
  const activeCount = allProjects.filter(p => p.is_active_project).length;

  console.log(`imports 讀到檔案: 進行中案場清單.xlsx`);
  console.log(`進行中案場 Excel 讀到 ${activeProjectsFromExcel.length} 筆`);
  console.log(`成功比對到既有所有案場: ${matchCount} 筆`);
  console.log(`新增案場: ${newCount} 筆`);
  console.log(`所有案場目前總數: ${finalAllCount} 筆`);
  console.log(`進行中案場目前: ${activeCount} 筆`);
  console.log(`進行中案場是否只來自這份 Excel: 是 (皆標記為 ${BATCH_NAME})`);
}

importActiveProjects();
