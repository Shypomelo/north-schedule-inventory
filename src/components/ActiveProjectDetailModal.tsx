import React, { useState, useEffect } from 'react';
import { ActiveProject, InventoryTransaction, InventoryItem } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { X, Save, Lock, Unlock, CheckCircle2, Circle, AlertCircle, HelpCircle, FileText, Settings, ListChecks, PackageSearch, Layers, ArrowRightLeft } from 'lucide-react';
import { format } from 'date-fns';

interface ActiveProjectDetailModalProps {
  project: ActiveProject;
  onClose: () => void;
  onProjectUpdate?: () => void;
}

type TabKey = 'WEEKLY' | 'PROCESS' | 'MATERIAL' | 'PROCESS_SETTINGS' | 'MATERIAL_SETTINGS' | 'INVENTORY_USAGE';

const PREDEFINED_PROCESS_NODES = [
  '開案', '包商現勘', '爬梯現勘', '鐵皮丈量', '設計出圖', '圖面確認', 
  '開工清單-電力', '開工清單-鋼構', '進場', '完工', '掛表', 
  '竣工單', '支架驗收單', '電力驗收單', '結案'
];

const PREDEFINED_MATERIAL_NODES = [
  '太陽能模組', '逆變器', '交流配電箱', '直流配電箱', '線材', '支架材料', '螺絲配件'
];

const DEFAULT_PROCESS_NODES = ['開案', '圖面確認', '進場', '掛表', '結案'];

export function ActiveProjectDetailModal({ project, onClose, onProjectUpdate }: ActiveProjectDetailModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('WEEKLY');
  const [isSaving, setIsSaving] = useState(false);

  // Tab 1 Form State
  const [formData, setFormData] = useState({
    report_section: project.report_section || '',
    name: project.name || '',
    capacity: project.capacity || '',
    manager: project.manager || '',
    bracket_status: project.bracket_status || '',
    power_status: project.power_status || '',
    inspection_status: project.inspection_status || '',
    meter_status: project.meter_status || '',
    roof_status: project.roof_status || '',
    start_date: project.start_date || '',
    notes: project.notes || ''
  });

  const [transactions, setTransactions] = useState<InventoryTransaction[]>([]);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [isLoadingTx, setIsLoadingTx] = useState(false);

  useEffect(() => {
    async function fetchTx() {
      setIsLoadingTx(true);
      const [txs, itms] = await Promise.all([
        dbAdapter.getInventoryTransactions(),
        dbAdapter.getInventoryItems()
      ]);
      setTransactions(txs.filter(t => t.project_id === project.id || t.project_name === project.name).sort((a,b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      setItems(itms);
      setIsLoadingTx(false);
    }
    fetchTx();
  }, [project.id, project.name]);

  const activeProcessNodes = project.active_process_nodes || DEFAULT_PROCESS_NODES;
  const activeMaterialNodes = project.active_material_nodes || [];
  const processNodesData = project.process_nodes || {};

  useEffect(() => {
    setFormData({
      report_section: project.report_section || '',
      name: project.name || '',
      capacity: project.capacity || '',
      manager: project.manager || '',
      bracket_status: project.bracket_status || '',
      power_status: project.power_status || '',
      inspection_status: project.inspection_status || '',
      meter_status: project.meter_status || '',
      roof_status: project.roof_status || '',
      start_date: project.start_date || '',
      notes: project.notes || ''
    });
  }, [project]);

  const handleSaveTab1 = async () => {
    setIsSaving(true);
    try {
      await dbAdapter.updateActiveProject(project.id, formData);
      if (onProjectUpdate) onProjectUpdate();
    } catch (e) {
      console.error(e);
      alert('儲存失敗');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCloseProject = async () => {
    // 預留結案功能
    if (confirm('確定要將此案場結案並轉入所有案場主檔嗎？（目前為預留功能）')) {
      alert('預留功能：結案資料移轉機制尚未實作');
    }
  };

  const handleUpdateProcessNode = async (nodeKey: string, status: string, locked: boolean) => {
    const updatedNodes = {
      ...processNodesData,
      [nodeKey]: { status, locked }
    };
    try {
      await dbAdapter.updateActiveProject(project.id, { process_nodes: updatedNodes });
      if (onProjectUpdate) onProjectUpdate();
    } catch (e) {
      console.error(e);
      alert('更新節點失敗');
    }
  };

  const cycleNodeStatus = (nodeKey: string) => {
    const current = processNodesData[nodeKey] || { status: '', locked: false };
    if (current.locked) return; // Cannot cycle if locked

    let nextStatus = '';
    if (!current.status || current.status === '') nextStatus = '完成';
    else if (current.status === '完成') nextStatus = '進行中';
    else if (current.status === '進行中') nextStatus = 'N/A';
    else if (current.status === 'N/A') nextStatus = '';

    handleUpdateProcessNode(nodeKey, nextStatus, current.locked);
  };

  const toggleNodeLock = (nodeKey: string) => {
    const current = processNodesData[nodeKey] || { status: '', locked: false };
    handleUpdateProcessNode(nodeKey, current.status, !current.locked);
  };

  const toggleActiveProcessNode = async (nodeKey: string) => {
    const newActive = activeProcessNodes.includes(nodeKey)
      ? activeProcessNodes.filter(k => k !== nodeKey)
      : [...activeProcessNodes, nodeKey];
    
    try {
      await dbAdapter.updateActiveProject(project.id, { active_process_nodes: newActive });
      if (onProjectUpdate) onProjectUpdate();
    } catch (e) {
      console.error(e);
    }
  };

  const toggleActiveMaterialNode = async (nodeKey: string) => {
    const newActive = activeMaterialNodes.includes(nodeKey)
      ? activeMaterialNodes.filter(k => k !== nodeKey)
      : [...activeMaterialNodes, nodeKey];
    
    try {
      await dbAdapter.updateActiveProject(project.id, { active_material_nodes: newActive });
      if (onProjectUpdate) onProjectUpdate();
    } catch (e) {
      console.error(e);
    }
  };

  const tabs = [
    { key: 'WEEKLY', label: '周回報資料', icon: FileText },
    { key: 'PROCESS', label: '流程節點', icon: ListChecks },
    { key: 'MATERIAL', label: '物料整備', icon: PackageSearch },
    { key: 'INVENTORY_USAGE', label: '案場用料紀錄', icon: ArrowRightLeft },
    { key: 'PROCESS_SETTINGS', label: '流程項目設定', icon: Settings },
    { key: 'MATERIAL_SETTINGS', label: '物料項目設定', icon: Layers },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-4xl h-full bg-slate-900 border-l border-slate-700/50 shadow-2xl flex flex-col animate-in slide-in-from-right duration-300">
        
        {/* Header */}
        <div className="px-6 pt-5 pb-0 border-b border-slate-800 flex flex-col bg-slate-800/50">
          <div className="flex justify-between items-start mb-4">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <span className={`px-2 py-1 rounded-md text-xs font-semibold bg-emerald-500/20 text-emerald-400`}>
                  進行中
                </span>
                <span className="px-2 py-1 bg-indigo-500/20 text-indigo-400 rounded-md text-xs font-semibold">
                  {project.report_section || '未分區'}
                </span>
              </div>
              <h2 className="text-2xl font-bold text-slate-50">{project.name}</h2>
              {project.short_name && <p className="text-slate-400 text-sm mt-1">簡稱：{project.short_name}</p>}
            </div>
            <div className="flex gap-2">
              <button 
                onClick={handleCloseProject}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-slate-100 rounded-lg text-sm font-medium transition"
              >
                完工結案 (預留)
              </button>
              <button 
                onClick={onClose}
                className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-lg transition"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 overflow-x-auto no-scrollbar border-b border-slate-700/50">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key as TabKey)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    isActive 
                      ? 'border-emerald-500 text-emerald-400' 
                      : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <Icon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth bg-slate-900">
          
          {/* 第 1 頁：周回報資料 */}
          {activeTab === 'WEEKLY' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-lg font-semibold text-emerald-400 mb-6 border-b border-slate-700/50 pb-2">周回報詳細欄位</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <label className="flex flex-col gap-2 md:col-span-2">
                  <span className="text-sm font-semibold text-slate-300">手動分區 (report_section)</span>
                  <select 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.report_section}
                    onChange={e => setFormData({...formData, report_section: e.target.value})}
                  >
                    <option value="">(無)</option>
                    <option value="目前施工中案件">目前施工中案件</option>
                    <option value="下兩周預計進場之案件">下兩周預計進場之案件</option>
                    <option value="其他負責案件">其他負責案件</option>
                    <option value="前兩周掛表案件">前兩周掛表案件</option>
                  </select>
                </label>
                
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">案場名稱</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.name}
                    onChange={e => setFormData({...formData, name: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">容量 KWH</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.capacity}
                    onChange={e => setFormData({...formData, capacity: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">人員</span>
                  <select
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-slate-200 outline-none focus:border-emerald-500 cursor-pointer"
                    value={formData.manager}
                    onChange={e => setFormData({...formData, manager: e.target.value})}
                  >
                    <option value="">未指定</option>
                    <option value="柚子">柚子</option>
                    <option value="維揚">維揚</option>
                    <option value="育丞">育丞</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">支架</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.bracket_status}
                    onChange={e => setFormData({...formData, bracket_status: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">電力</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.power_status}
                    onChange={e => setFormData({...formData, power_status: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">驗收</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.inspection_status}
                    onChange={e => setFormData({...formData, inspection_status: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">掛表</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.meter_status}
                    onChange={e => setFormData({...formData, meter_status: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">新設頂蓋</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.roof_status}
                    onChange={e => setFormData({...formData, roof_status: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold text-slate-300">開工日期</span>
                  <input 
                    type="text" 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100"
                    value={formData.start_date}
                    onChange={e => setFormData({...formData, start_date: e.target.value})}
                  />
                </label>

                <label className="flex flex-col gap-2 md:col-span-2">
                  <span className="text-sm font-semibold text-slate-300">備註</span>
                  <textarea 
                    className="bg-slate-900 border border-slate-700 rounded-lg p-2.5 focus:border-emerald-500 outline-none text-slate-100 min-h-[100px]"
                    value={formData.notes}
                    onChange={e => setFormData({...formData, notes: e.target.value})}
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <button 
                  onClick={handleSaveTab1}
                  disabled={isSaving}
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-lg shadow-lg shadow-emerald-600/20 transition transform hover:-translate-y-0.5 disabled:opacity-50 disabled:transform-none"
                >
                  <Save size={18} />
                  {isSaving ? '儲存中...' : '儲存修改'}
                </button>
              </div>
            </div>
          )}

          {/* 第 2 頁：流程節點 */}
          {activeTab === 'PROCESS' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <div className="flex justify-between items-center mb-6 border-b border-slate-700/50 pb-2">
                <h3 className="text-lg font-semibold text-emerald-400">流程節點狀態</h3>
                <p className="text-sm text-slate-400">點擊狀態按鈕進行切換</p>
              </div>

              {activeProcessNodes.length === 0 ? (
                <div className="text-center py-10 text-slate-500">
                  <ListChecks size={48} className="mx-auto mb-3 opacity-20" />
                  <p>尚未啟用任何流程節點</p>
                  <button onClick={() => setActiveTab('PROCESS_SETTINGS')} className="text-emerald-400 hover:underline mt-2 text-sm">
                    前往設定
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {activeProcessNodes.map(nodeKey => {
                    const current = processNodesData[nodeKey] || { status: '', locked: false };
                    
                    let StatusIcon = Circle;
                    let btnClass = "bg-slate-800 hover:bg-slate-700 text-slate-400 border-slate-600";
                    if (current.status === '完成') {
                      StatusIcon = CheckCircle2;
                      btnClass = "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 border-emerald-500/30";
                    } else if (current.status === '進行中') {
                      StatusIcon = AlertCircle;
                      btnClass = "bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border-amber-500/30";
                    } else if (current.status === 'N/A') {
                      StatusIcon = HelpCircle;
                      btnClass = "bg-slate-800 hover:bg-slate-700 text-slate-500 border-slate-700";
                    }

                    if (current.locked) {
                      btnClass += " opacity-60 cursor-not-allowed hover:bg-transparent";
                    }

                    return (
                      <div key={nodeKey} className="flex items-center justify-between p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
                        <span className="font-medium text-slate-200 w-24">{nodeKey}</span>
                        
                        <div className="flex items-center gap-2 flex-1 justify-end">
                          <button
                            onClick={() => cycleNodeStatus(nodeKey)}
                            disabled={current.locked}
                            className={`flex items-center gap-2 px-4 py-1.5 rounded border transition-colors min-w-[100px] justify-center ${btnClass}`}
                          >
                            <StatusIcon size={16} />
                            {current.status || '空白'}
                          </button>

                          <button
                            onClick={() => toggleNodeLock(nodeKey)}
                            className={`p-2 rounded transition-colors ${
                              current.locked 
                                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' 
                                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
                            }`}
                            title={current.locked ? "解鎖以編輯" : "鎖定避免誤觸"}
                          >
                            {current.locked ? <Lock size={16} /> : <Unlock size={16} />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 第 3 頁：物料整備狀況 */}
          {activeTab === 'MATERIAL' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-lg font-semibold text-emerald-400 mb-6 border-b border-slate-700/50 pb-2">物料整備狀況</h3>
              <div className="text-slate-500 text-center py-16 border border-dashed border-slate-700 rounded-lg bg-slate-900/30">
                <PackageSearch size={48} className="mx-auto mb-4 opacity-20" />
                <p>此頁面為預留功能，後續將與物料系統串接整合。</p>
              </div>
            </div>
          )}

          {/* 案場用料紀錄 */}
          {activeTab === 'INVENTORY_USAGE' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-lg font-semibold text-emerald-400 mb-6 border-b border-slate-700/50 pb-2">案場用料紀錄 (出庫與退料)</h3>
              
              {isLoadingTx ? (
                <div className="text-slate-400 text-center py-10">載入中...</div>
              ) : transactions.length === 0 ? (
                <div className="text-slate-500 text-center py-10 bg-slate-900/30 rounded-lg border border-dashed border-slate-700">
                  目前無用料紀錄
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-sm">
                    <thead className="bg-slate-800 text-slate-300">
                      <tr>
                        <th className="p-3 font-semibold rounded-tl-lg">日期</th>
                        <th className="p-3 font-semibold">類型</th>
                        <th className="p-3 font-semibold">品項</th>
                        <th className="p-3 font-semibold text-right">數量</th>
                        <th className="p-3 font-semibold">單位</th>
                        <th className="p-3 font-semibold">領料人/退料人</th>
                        <th className="p-3 font-semibold rounded-tr-lg">備註</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/50">
                      {transactions.map(tx => {
                        const item = items.find(i => i.id === tx.item_id);
                        const isReturn = tx.transaction_type === 'RETURN';
                        return (
                          <tr key={tx.id} className="hover:bg-slate-700/30 transition-colors">
                            <td className="p-3 text-slate-400">{format(new Date(tx.transaction_date || tx.created_at), 'yyyy/MM/dd')}</td>
                            <td className="p-3">
                              <span className={`px-2 py-1 rounded-full text-xs font-semibold ${isReturn ? 'bg-indigo-900/50 text-indigo-400' : 'bg-red-900/50 text-red-400'}`}>
                                {isReturn ? '退料' : '出庫'}
                              </span>
                            </td>
                            <td className="p-3 text-slate-100 font-medium">{item?.name}</td>
                            <td className={`p-3 text-right font-bold ${isReturn ? 'text-indigo-400' : 'text-red-400'}`}>
                              {isReturn ? '+' : '-'}{Math.abs(tx.quantity)}
                            </td>
                            <td className="p-3 text-slate-400">{tx.unit || item?.unit}</td>
                            <td className="p-3 text-slate-300">{tx.handler || '-'}</td>
                            <td className="p-3 text-slate-400 max-w-[150px] truncate" title={tx.notes || ''}>{tx.notes || '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* 第 4 頁：流程項目設定 */}
          {activeTab === 'PROCESS_SETTINGS' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-lg font-semibold text-emerald-400 mb-2">流程項目設定</h3>
              <p className="text-sm text-slate-400 mb-6 border-b border-slate-700/50 pb-4">
                勾選要在此案場追蹤的流程節點。打勾的項目會顯示在「流程節點」頁籤中供編輯狀態。
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {PREDEFINED_PROCESS_NODES.map(nodeKey => {
                  const isActive = activeProcessNodes.includes(nodeKey);
                  return (
                    <label 
                      key={nodeKey} 
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        isActive ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900/50 border-slate-700/50 hover:bg-slate-800'
                      }`}
                    >
                      <input 
                        type="checkbox" 
                        checked={isActive}
                        onChange={() => toggleActiveProcessNode(nodeKey)}
                        className="w-5 h-5 accent-emerald-500"
                      />
                      <span className={isActive ? 'text-emerald-400 font-medium' : 'text-slate-300'}>{nodeKey}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* 第 5 頁：物料項目設定 */}
          {activeTab === 'MATERIAL_SETTINGS' && (
            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 shadow-sm backdrop-blur-sm animate-in fade-in zoom-in-95 duration-200">
              <h3 className="text-lg font-semibold text-emerald-400 mb-2">物料項目設定</h3>
              <p className="text-sm text-slate-400 mb-6 border-b border-slate-700/50 pb-4">
                勾選要在此案場追蹤整備狀況的物料清單。此為預留設定功能。
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {PREDEFINED_MATERIAL_NODES.map(nodeKey => {
                  const isActive = activeMaterialNodes.includes(nodeKey);
                  return (
                    <label 
                      key={nodeKey} 
                      className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        isActive ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900/50 border-slate-700/50 hover:bg-slate-800'
                      }`}
                    >
                      <input 
                        type="checkbox" 
                        checked={isActive}
                        onChange={() => toggleActiveMaterialNode(nodeKey)}
                        className="w-5 h-5 accent-emerald-500"
                      />
                      <span className={isActive ? 'text-emerald-400 font-medium' : 'text-slate-300'}>{nodeKey}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          
        </div>
      </div>
    </div>
  );
}
