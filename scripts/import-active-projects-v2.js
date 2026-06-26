const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const crypto = require('crypto');

function importActiveProjectsV2() {
  const excelFilePath = path.join(__dirname, '../imports/進行中案場清單.xlsx');
  const mockJsonPath = path.join(__dirname, '../src/lib/db/mock-projects.json');
  const activeMockJsonPath = path.join(__dirname, '../src/lib/db/mock-active-projects.json');

  // 1. Read existing mock projects
  let allProjects = [];
  try {
    allProjects = JSON.parse(fs.readFileSync(mockJsonPath, 'utf8'));
  } catch (e) {
    console.error('Failed to read mock projects', e);
    return;
  }
  
  // Read Excel
  const workbook = xlsx.readFile(excelFilePath);
  const sheetName = '案場匯入';
  if (!workbook.Sheets[sheetName]) {
    console.error(`Sheet "${sheetName}" not found in the excel file.`);
    return;
  }

  const activeProjectsFromExcel = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  
  let matchCount = 0;
  let unmatchCount = 0;

  const activeProjects = [];

  activeProjectsFromExcel.forEach(row => {
    const code = row['案場代碼']?.toString().trim() || '';
    const name = row['案場名稱']?.toString().trim() || '';
    const shortName = row['案場簡稱']?.toString().trim() || '';
    const capacity = row['容量(kW)']?.toString().trim() || row['原始容量文字']?.toString().trim() || '';
    const status = row['狀態']?.toString().trim() || '';
    const notes = row['備註']?.toString().trim() || '';
    
    // Look for new columns if they exist
    let rawManager = row['人員']?.toString().trim() || '';
    let manager = rawManager;
    if (rawManager === '許子佑') manager = '柚子';
    else if (rawManager === '莊維揚') manager = '維揚';
    else if (rawManager === '郭育丞') manager = '育丞';
    const bracket_status = row['支架']?.toString().trim() || '';
    const power_status = row['電力']?.toString().trim() || '';
    const inspection_status = row['驗收']?.toString().trim() || '';
    const meter_status = row['掛表']?.toString().trim() || '';
    const roof_status = row['新設頂蓋']?.toString().trim() || '';
    const start_date = row['開工日期']?.toString().trim() || '';
    
    // Skip completely empty rows
    if (!code && !name && !shortName && !capacity && !status && !notes) {
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
    
    let matched_project_id = null;
    if (matchedProject) {
      matched_project_id = matchedProject.id;
      matchCount++;
    } else {
      unmatchCount++;
    }

    const newActiveProject = {
      id: crypto.randomUUID(),
      project_code: code,
      name: name || '未命名進行中案場',
      short_name: shortName || code,
      capacity: capacity,
      matched_project_id: matched_project_id,
      manager: manager,
      bracket_status: bracket_status,
      power_status: power_status,
      inspection_status: inspection_status,
      meter_status: meter_status,
      roof_status: roof_status,
      start_date: start_date,
      notes: notes,
      status: status,
      report_base_date: new Date().toISOString().split('T')[0], // Default base date to today
      report_section: '目前施工中案件',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    activeProjects.push(newActiveProject);
  });

  // Save back to mock-active-projects.json
  fs.writeFileSync(activeMockJsonPath, JSON.stringify(activeProjects, null, 2));

  // Reporting
  console.log(`讀到檔案: 進行中案場清單.xlsx`);
  console.log(`進行中案場讀到 ${activeProjects.length} 筆`);
  console.log(`成功對標所有案場: ${matchCount} 筆`);
  console.log(`無法對標: ${unmatchCount} 筆`);
  console.log(`所有案場維持原本主檔數量: ${allProjects.length}`);
}

importActiveProjectsV2();
