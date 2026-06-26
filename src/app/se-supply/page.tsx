"use client";

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { dbAdapter } from '@/lib/db';
import { Project, SESupplyRecord } from '@/lib/db/types';
import { Plus, Trash2, Download, Search, Filter } from 'lucide-react';
import * as XLSX from 'xlsx';

const RECEIVE_METHODS = [
  'SE 寄件到北辦',
  '楊梅倉自取',
  '北辦倉庫',
  'SE 工程師交貨',
  '其他'
];

export default function SESupplyPage() {
  const [records, setRecords] = useState<SESupplyRecord[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMethod, setFilterMethod] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const loadData = async () => {
    setIsLoading(true);
    const [recs, projs] = await Promise.all([
      // @ts-ignore
      dbAdapter.getSESupplyRecords ? dbAdapter.getSESupplyRecords() : Promise.resolve([]),
      dbAdapter.getProjects()
    ]);
    setRecords(recs);
    setProjects(projs);
    setIsLoading(false);
  };

  useEffect(() => {
    loadData();
  }, []);

  const getStatus = (receive_date: string | null, replace_date: string | null) => {
    if (replace_date) return '已更換';
    if (receive_date) return '已收料 / 待更換';
    return '待收料';
  };

  const filteredRecords = useMemo(() => {
    return records.filter(r => {
      const matchSearch = 
        (r.project_name || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (r.faulty_serial || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (r.new_serial || '').toLowerCase().includes(searchTerm.toLowerCase());
      
      const matchMethod = filterMethod ? r.receive_method === filterMethod : true;
      const status = getStatus(r.receive_date, r.replace_date);
      const matchStatus = filterStatus ? status === filterStatus : true;

      return matchSearch && matchMethod && matchStatus;
    });
  }, [records, searchTerm, filterMethod, filterStatus]);

  const handleAddRow = async () => {
    try {
      // @ts-ignore
      const newRec = await dbAdapter.createSESupplyRecord({
        project_name: '',
        old_model: '',
        faulty_serial: '',
        fault_reason: '',
        new_serial: '',
        receive_method: '',
        receive_date: '',
        replace_date: '',
        notes: ''
      });
      setRecords([newRec, ...records]);
    } catch (e) {
      console.error(e);
      alert('新增失敗');
    }
  };

  const handleDeleteRow = async (id: string) => {
    if (!confirm('確定要刪除這筆紀錄嗎？')) return;
    try {
      // @ts-ignore
      await dbAdapter.deleteSESupplyRecord(id);
      setRecords(records.filter(r => r.id !== id));
    } catch (e) {
      console.error(e);
      alert('刪除失敗');
    }
  };

  const handleCellChange = (id: string, field: keyof SESupplyRecord, value: string) => {
    setRecords(records.map(r => r.id === id ? { ...r, [field]: value } : r));
  };

  const handleCellBlur = async (id: string, field: keyof SESupplyRecord, value: string) => {
    try {
      // @ts-ignore
      await dbAdapter.updateSESupplyRecord(id, { [field]: value });
    } catch (e) {
      console.error(e);
      // Silently fail but log, UI remains optimistic
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>, id: string, field: keyof SESupplyRecord, value: string) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
    }
  };

  const exportExcel = () => {
    const data = filteredRecords.map(r => ({
      '案名': r.project_name || '',
      '原故障型號': r.old_model || '',
      '故障序號': r.faulty_serial || '',
      '故障原因': r.fault_reason || '',
      '新物料序號': r.new_serial || '',
      '收貨方式': r.receive_method || '',
      '收取物料時間': r.receive_date || '',
      '更換日期': r.replace_date || '',
      '狀態': getStatus(r.receive_date, r.replace_date),
      '備註事項': r.notes || '',
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "SE供貨紀錄");
    XLSX.writeFile(wb, `SE供貨紀錄_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  if (isLoading) {
    return <div className="p-8 text-slate-400">載入中...</div>;
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden p-4 md:p-6 pb-20">
      <div className="flex justify-between items-center mb-6 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">SE 供貨追蹤</h1>
          <p className="text-slate-400 text-sm mt-1">獨立追蹤 SE 物料更換與流向，可直接點擊表格進行編輯。</p>
        </div>
        <button 
          onClick={exportExcel}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded shadow transition font-semibold"
        >
          <Download size={18} />
          匯出 Excel
        </button>
      </div>

      <div className="flex flex-wrap gap-4 mb-4 shrink-0 bg-slate-900 p-4 rounded-lg border border-slate-800">
        <div className="flex items-center gap-2 bg-slate-800 rounded px-3 py-1.5 flex-1 min-w-[200px]">
          <Search size={16} className="text-slate-400" />
          <input 
            type="text" 
            placeholder="搜尋案名 / 序號..." 
            className="bg-transparent border-none outline-none text-slate-200 text-sm w-full"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="flex items-center gap-2">
          <Filter size={16} className="text-slate-400" />
          <select 
            className="bg-slate-800 border-none outline-none text-slate-200 text-sm p-1.5 rounded"
            value={filterMethod}
            onChange={e => setFilterMethod(e.target.value)}
          >
            <option value="">所有收貨方式</option>
            {RECEIVE_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <Filter size={16} className="text-slate-400" />
          <select 
            className="bg-slate-800 border-none outline-none text-slate-200 text-sm p-1.5 rounded"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            <option value="">所有狀態</option>
            <option value="待收料">待收料</option>
            <option value="已收料 / 待更換">已收料 / 待更換</option>
            <option value="已更換">已更換</option>
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto bg-slate-900 rounded-xl border border-slate-700 relative">
        <table className="w-full text-sm text-left whitespace-nowrap min-w-[1200px]">
          <thead className="text-xs text-slate-400 bg-slate-800 sticky top-0 z-10 shadow">
            <tr>
              <th className="px-3 py-3 w-10 text-center">操作</th>
              <th className="px-3 py-3 w-48">案名</th>
              <th className="px-3 py-3 w-32">原故障型號</th>
              <th className="px-3 py-3 w-40">故障序號</th>
              <th className="px-3 py-3 w-32">故障原因</th>
              <th className="px-3 py-3 w-40">新物料序號</th>
              <th className="px-3 py-3 w-40">收貨方式</th>
              <th className="px-3 py-3 w-36">收取物料時間</th>
              <th className="px-3 py-3 w-36">更換日期</th>
              <th className="px-3 py-3 w-32">狀態</th>
              <th className="px-3 py-3 w-48">備註事項</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            <tr className="bg-slate-900/50 hover:bg-slate-800/80 transition-colors">
              <td colSpan={11} className="p-0">
                <button 
                  onClick={handleAddRow}
                  className="w-full flex items-center justify-center gap-2 py-3 text-emerald-400 hover:bg-emerald-900/20 hover:text-emerald-300 transition-colors font-medium"
                >
                  <Plus size={16} /> 新增一筆供貨紀錄
                </button>
              </td>
            </tr>
            {filteredRecords.length === 0 ? (
              <tr>
                <td colSpan={11} className="p-8 text-center text-slate-500">尚無符合條件的紀錄</td>
              </tr>
            ) : (
              filteredRecords.map(r => {
                const status = getStatus(r.receive_date, r.replace_date);
                return (
                  <tr key={r.id} className="bg-slate-900 hover:bg-slate-800/50 transition-colors group">
                    <td className="px-3 py-1.5 text-center">
                      <button 
                        onClick={() => handleDeleteRow(r.id)}
                        className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all p-1"
                        title="刪除紀錄"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        list="projects-list"
                        value={r.project_name || ''}
                        onChange={e => handleCellChange(r.id, 'project_name', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'project_name', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'project_name', e.currentTarget.value)}
                        placeholder="輸入案名..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        value={r.old_model || ''}
                        onChange={e => handleCellChange(r.id, 'old_model', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'old_model', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'old_model', e.currentTarget.value)}
                        placeholder="例: SE100K"
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        value={r.faulty_serial || ''}
                        onChange={e => handleCellChange(r.id, 'faulty_serial', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'faulty_serial', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'faulty_serial', e.currentTarget.value)}
                        placeholder="序號..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 font-mono text-[13px] transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        list="fault-reasons"
                        value={r.fault_reason || ''}
                        onChange={e => handleCellChange(r.id, 'fault_reason', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'fault_reason', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'fault_reason', e.currentTarget.value)}
                        placeholder="故障原因..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        value={r.new_serial || ''}
                        onChange={e => handleCellChange(r.id, 'new_serial', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'new_serial', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'new_serial', e.currentTarget.value)}
                        placeholder="新序號..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 font-mono text-[13px] transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        list="receive-methods"
                        value={r.receive_method || ''}
                        onChange={e => handleCellChange(r.id, 'receive_method', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'receive_method', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'receive_method', e.currentTarget.value)}
                        placeholder="選擇或輸入..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 transition-colors"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="date"
                        value={r.receive_date || ''}
                        onChange={e => handleCellChange(r.id, 'receive_date', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'receive_date', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'receive_date', e.currentTarget.value)}
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 transition-colors [color-scheme:dark]"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="date"
                        value={r.replace_date || ''}
                        onChange={e => handleCellChange(r.id, 'replace_date', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'replace_date', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'replace_date', e.currentTarget.value)}
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 transition-colors [color-scheme:dark]"
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={`px-2 py-1 rounded text-[11px] font-bold tracking-wide whitespace-nowrap
                        ${status === '已更換' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800' : 
                          status === '已收料 / 待更換' ? 'bg-blue-900/30 text-blue-400 border border-blue-800' : 
                          'bg-amber-900/30 text-amber-400 border border-amber-800'}`}
                      >
                        {status}
                      </span>
                    </td>
                    <td className="px-1 py-1">
                      <input 
                        type="text"
                        value={r.notes || ''}
                        onChange={e => handleCellChange(r.id, 'notes', e.target.value)}
                        onBlur={e => handleCellBlur(r.id, 'notes', e.target.value)}
                        onKeyDown={e => handleKeyDown(e, r.id, 'notes', e.currentTarget.value)}
                        placeholder="備註..."
                        className="w-full bg-transparent border border-transparent hover:border-slate-700 focus:border-emerald-500 focus:bg-slate-950 rounded px-2 py-1 outline-none text-slate-200 placeholder-slate-600 transition-colors"
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <datalist id="projects-list">
        {projects.filter(p => p.is_active).map(p => <option key={p.id} value={p.name} />)}
      </datalist>
      <datalist id="receive-methods">
        {RECEIVE_METHODS.map(m => <option key={m} value={m} />)}
      </datalist>
      <datalist id="fault-reasons">
        <option value="18XBC" />
        <option value="18X89" />
        <option value="181" />
        <option value="188" />
        <option value="188/182" />
        <option value="未確認" />
      </datalist>
    </div>
  );
}
