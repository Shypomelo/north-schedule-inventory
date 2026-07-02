const fs = require('fs');
const path = require('path');

// 1. Patch page.tsx
const pagePath = path.join(__dirname, '../src/app/projects/[[...filter]]/page.tsx');
let pageContent = fs.readFileSync(pagePath, 'utf8');

pageContent = pageContent.replace(/ActiveProject, /g, '');
pageContent = pageContent.replace(/const \[activeProjects, setActiveProjects\] = useState<ActiveProject\[\]>\(\[\]\);/g, '');
pageContent = pageContent.replace(/const \[viewingActiveProject, setViewingActiveProject\] = useState<ActiveProject \| null>\(null\);/g, 'const [viewingActiveProject, setViewingActiveProject] = useState<Project | null>(null);');

pageContent = pageContent.replace(/const activeData = await dbAdapter\.getActiveProjects\(\);/, '');
pageContent = pageContent.replace(/setActiveProjects\(activeData\);/, '');

// Fix filteredBaseProjects to only show '已結案' or '作廢'
pageContent = pageContent.replace(/const filteredBaseProjects = useMemo\(\(\) => \{[\s\S]*?return true;\s*\}\);\s*\}, \[projects, searchTerm, filterCity, filterWarrantyStatus, filterInverterBrand\]\);/, `const filteredBaseProjects = useMemo(() => {
    return projects.filter(p => {
      if (p.status !== '已結案' && p.status !== '作廢') return false;
      if (filterCity && getCity(p.address) !== filterCity) return false;
      if (filterWarrantyStatus && p.warranty_status?.split('(')[0].trim() !== filterWarrantyStatus) return false;
      if (filterInverterBrand && p.inverter_brand !== filterInverterBrand) return false;

      if (searchTerm) {
        const lowerTerm = searchTerm.toLowerCase();
        const matchSearch = 
          (p.name && p.name.toLowerCase().includes(lowerTerm)) || 
          (p.contact_name && p.contact_name.toLowerCase().includes(lowerTerm)) ||
          (p.contact_phone && p.contact_phone.toLowerCase().includes(lowerTerm)) ||
          (p.address && p.address.toLowerCase().includes(lowerTerm)) ||
          (p.notes && p.notes.toLowerCase().includes(lowerTerm));
        if (!matchSearch) return false;
      }
      return true;
    });
  }, [projects, searchTerm, filterCity, filterWarrantyStatus, filterInverterBrand]);`);

// Fix filteredActiveProjects to show everything else
pageContent = pageContent.replace(/const filteredActiveProjects = useMemo\(\(\) => \{[\s\S]*?return true;\s*\}\);\s*\}, \[activeProjects, searchTerm, filterUser\]\);/, `const filteredActiveProjects = useMemo(() => {
    return projects.filter(p => {
      if (p.status === '已結案' || p.status === '作廢') return false;
      if (filterUser && p.manager !== filterUser.name) return false;

      if (searchTerm) {
        const lowerTerm = searchTerm.toLowerCase();
        const matchSearch = 
          (p.name && p.name.toLowerCase().includes(lowerTerm)) || 
          (p.project_code && p.project_code.toLowerCase().includes(lowerTerm)) ||
          (p.notes && p.notes.toLowerCase().includes(lowerTerm));
        if (!matchSearch) return false;
      }
      return true;
    });
  }, [projects, searchTerm, filterUser]);`);

// activeCategories array type
pageContent = pageContent.replace(/section1: \[\] as ActiveProject\[\],/g, 'section1: [] as Project[],');
pageContent = pageContent.replace(/section2: \[\] as ActiveProject\[\],/g, 'section2: [] as Project[],');
pageContent = pageContent.replace(/section3: \[\] as ActiveProject\[\],/g, 'section3: [] as Project[],');
pageContent = pageContent.replace(/section4: \[\] as ActiveProject\[\],/g, 'section4: [] as Project[],');

// handleCreateActive
pageContent = pageContent.replace(/const newActive: Omit<ActiveProject, 'id' \| 'created_at' \| 'updated_at'> = \{[\s\S]*?active_process_nodes: \['開案', '圖面確認', '進場', '掛表', '結案'\],[\s\S]*?process_nodes: \{\}\s*\};/, `const newActive: Omit<Project, 'id' | 'created_at' | 'updated_at'> = {
        project_code: formData.get('project_code') as string || '',
        name: formData.get('name') as string || '',
        short_name: formData.get('name') as string || '',
        capacity: formData.get('capacity') as string || '',
        manager: formData.get('manager') as string || '',
        bracket_status: formData.get('bracket_status') as string || '',
        power_status: formData.get('power_status') as string || '',
        inspection_status: formData.get('inspection_status') as string || '',
        meter_status: formData.get('meter_status') as string || '',
        roof_status: formData.get('roof_status') as string || '',
        start_date: formData.get('start_date') as string || '',
        notes: formData.get('notes') as string || '',
        status: '進行中',
        report_section: '其他負責案件',
        is_active: true,
        address: null,
        owner_name: null,
        contact_name: null,
        contact_phone: null,
        region: null,
        project_type: null,
        owner_phone: null,
        data_source: null,
        warranty_status: null,
        completion_date: null,
        warranty_years: null,
        warranty_end_date: null,
        has_maintenance_contract: null,
        maintenance_start_date: null,
        maintenance_end_date: null,
        maintenance_notes: null,
        inverter_brand: null,
        inverter_warranty: null,
        monitoring_system: null,
        module_mounting_type: null,
        last_inspection_date: null,
        inspection_cycle_months: null,
        next_inspection_date: null,
        inspection_reminder_days: null,
        racking_contractor_id: null,
        racking_expected_start_date: null,
        racking_completion_date: null,
        racking_status: null,
        racking_notes: null,
        electrical_contractor_id: null,
        electrical_expected_start_date: null,
        electrical_completion_date: null,
        electrical_status: null,
        electrical_notes: null,
        steel_contractor_id: null,
        steel_expected_start_date: null,
        steel_completion_date: null,
        steel_status: null,
        steel_notes: null,
        roof_cover_contractor_id: null,
        roof_cover_expected_start_date: null,
        roof_cover_completion_date: null,
        roof_cover_status: null,
        roof_cover_notes: null,
        civil_contractor_id: null,
        civil_expected_start_date: null,
        civil_completion_date: null,
        civil_status: null,
        civil_notes: null,
        other_contractor_id: null,
        other_expected_start_date: null,
        other_completion_date: null,
        other_status: null,
        other_notes: null
      };`);

pageContent = pageContent.replace(/const adapter = dbAdapter as any;\s*const dbInstance = await adapter\.getActiveProjects\(\);\s*dbInstance\.push\(newRecord\);[\s\S]*?active_projects: dbInstance\s*\}\)\);\s*\}/, `await dbAdapter.createProject(newActive);`);

// handleCompleteProject
pageContent = pageContent.replace(/const handleCompleteProject = async \(project: ActiveProject\) => \{[\s\S]*?await fetchProjects\(\);\s*\} catch \(e\) \{/, `const handleCompleteProject = async (project: Project) => {
    if (!confirm(\`確定要結案「\${project.name}」嗎？這將會把它移出進行中案場，並更新至所有案場中。\`)) {
      return;
    }
    setIsSubmitting(true);
    try {
      await dbAdapter.updateProject(project.id, {
        status: '已結案'
      });
      await fetchProjects();
    } catch (e) {`);

// handleActiveProjectInlineChange
pageContent = pageContent.replace(/const handleActiveProjectInlineChange = async \(id: string, field: string, value: string\) => \{[\s\S]*?await dbAdapter\.updateActiveProject\(id, \{ \[field\]: value \}\);/g, `const handleActiveProjectInlineChange = async (id: string, field: string, value: string) => {
    try {
      setSaveStatus('儲存中');
      const updatedProjects = projects.map(p => p.id === id ? { ...p, [field]: value } as Project : p);
      setProjects(updatedProjects);
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await dbAdapter.updateProject(id, { [field]: value });`);

// Backup uses activeProjects
pageContent = pageContent.replace(/JSON\.stringify\(activeProjects\)/g, 'JSON.stringify(filteredActiveProjects)');

fs.writeFileSync(pagePath, pageContent, 'utf8');
console.log('Patched page.tsx');

// 2. Patch ActiveProjectDetailModal.tsx
const modalPath = path.join(__dirname, '../src/components/ActiveProjectDetailModal.tsx');
let modalContent = fs.readFileSync(modalPath, 'utf8');

modalContent = modalContent.replace(/ActiveProject, /g, '');
modalContent = modalContent.replace(/project: ActiveProject;/g, 'project: Project;');
modalContent = modalContent.replace(/onUpdate: \(updated: ActiveProject\) => void;/g, 'onUpdate: (updated: Project) => void;');
modalContent = modalContent.replace(/dbAdapter\.updateActiveProject/g, 'dbAdapter.updateProject');
modalContent = modalContent.replace(/key as keyof ActiveProject/g, 'key as keyof Project');

// remove any nodeKey type errors implicitly any
modalContent = modalContent.replace(/const handleNodeLock = async \(nodeKey\) => \{/g, 'const handleNodeLock = async (nodeKey: string) => {');

fs.writeFileSync(modalPath, modalContent, 'utf8');
console.log('Patched ActiveProjectDetailModal.tsx');
