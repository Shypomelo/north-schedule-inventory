"use client";

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/components/UserContext';
import { Contractor, ContractorType } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { Plus, Edit2, Wrench } from 'lucide-react';

const CONTRACTOR_TYPES: { key: ContractorType; label: string; color: string }[] = [
  { key: 'racking', label: '支架', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' },
  { key: 'electrical', label: '電力', color: 'text-blue-400 bg-blue-500/10 border-blue-500/20' },
  { key: 'steel', label: '鋼構', color: 'text-purple-400 bg-purple-500/10 border-purple-500/20' },
  { key: 'roof_cover', label: '新設頂蓋', color: 'text-orange-400 bg-orange-500/10 border-orange-500/20' },
  { key: 'civil', label: '土木', color: 'text-amber-400 bg-amber-500/10 border-amber-500/20' },
  { key: 'other', label: '其他', color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' },
];

export default function AdminContractorsPage() {
  const router = useRouter();
  const { currentUser, isLoading: contextLoading } = useUser();
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(null);
  
  const [formData, setFormData] = useState<Partial<Contractor>>({
    name: '',
    contractor_type: 'racking',
    contact_person: '',
    phone: '',
    is_active: true,
    notes: ''
  });

  useEffect(() => {
    if (!contextLoading) {
      if (currentUser?.role !== 'ADMIN') {
        router.push('/');
      } else {
        loadContractors();
      }
    }
  }, [currentUser, contextLoading, router]);

  async function loadContractors() {
    setIsLoading(true);
    const data = await dbAdapter.getContractors();
    setContractors(data);
    setIsLoading(false);
  }

  if (contextLoading || currentUser?.role !== 'ADMIN') {
    return <div className="p-8 text-center text-slate-400">驗證權限中...</div>;
  }

  const handleOpenModal = (contractor?: Contractor) => {
    if (contractor) {
      setEditingContractor(contractor);
      setFormData({
        name: contractor.name,
        contractor_type: contractor.contractor_type,
        contact_person: contractor.contact_person || '',
        phone: contractor.phone || '',
        is_active: contractor.is_active,
        notes: contractor.notes || ''
      });
    } else {
      setEditingContractor(null);
      setFormData({
        name: '',
        contractor_type: 'racking',
        contact_person: '',
        phone: '',
        is_active: true,
        notes: ''
      });
    }
    setIsModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name) {
      alert("包商名稱必填");
      return;
    }
    
    try {
      if (editingContractor) {
        await dbAdapter.updateContractor(editingContractor.id, formData);
      } else {
        await dbAdapter.createContractor(formData as any);
      }
      setIsModalOpen(false);
      loadContractors();
    } catch (err: any) {
      alert("儲存失敗: " + err.message);
    }
  };

  const getTypeStyle = (type: ContractorType) => {
    const t = CONTRACTOR_TYPES.find(x => x.key === type);
    return t ? t.color : 'text-slate-400 bg-slate-500/10 border-slate-500/20';
  };

  const getTypeLabel = (type: ContractorType) => {
    const t = CONTRACTOR_TYPES.find(x => x.key === type);
    return t ? t.label : '未知';
  };

  return (
    <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8 flex flex-col gap-6">
      <div className="flex justify-between items-center bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Wrench className="text-emerald-500" />
            系統管理 - 包商管理
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            新增或管理各類工程包商，包含聯絡資訊與類別。
          </p>
        </div>
        <button 
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-lg shadow-lg shadow-emerald-600/20 transition transform hover:-translate-y-0.5 font-medium"
        >
          <Plus size={18} />
          新增包商
        </button>
      </div>

      <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl overflow-hidden shadow-xl backdrop-blur-sm">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400">載入中...</div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="bg-slate-900/80 text-slate-300 text-sm border-b border-slate-700/60">
              <tr>
                <th className="p-4 font-semibold w-[120px]">狀態</th>
                <th className="p-4 font-semibold">包商名稱</th>
                <th className="p-4 font-semibold">工程類別</th>
                <th className="p-4 font-semibold">聯絡人</th>
                <th className="p-4 font-semibold">電話</th>
                <th className="p-4 font-semibold w-[80px]">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50 text-sm">
              {contractors.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-slate-500">尚無包商資料</td>
                </tr>
              ) : (
                contractors.map(c => (
                  <tr key={c.id} className="hover:bg-slate-700/30 transition-colors">
                    <td className="p-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${c.is_active ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
                        {c.is_active ? '啟用' : '停用'}
                      </span>
                    </td>
                    <td className="p-4 font-medium text-slate-200">
                      {c.name}
                      {c.notes && <div className="text-xs text-slate-500 font-normal mt-1">{c.notes}</div>}
                    </td>
                    <td className="p-4">
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium border ${getTypeStyle(c.contractor_type)}`}>
                        {getTypeLabel(c.contractor_type)}
                      </span>
                    </td>
                    <td className="p-4 text-slate-300">{c.contact_person || '-'}</td>
                    <td className="p-4 text-slate-300">{c.phone || '-'}</td>
                    <td className="p-4">
                      <button 
                        onClick={() => handleOpenModal(c)}
                        className="p-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                        title="編輯包商"
                      >
                        <Edit2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-800 border border-slate-700/60 p-6 rounded-2xl w-full max-w-md shadow-2xl relative animate-in zoom-in-95 duration-200">
            <h2 className="text-xl font-bold text-slate-100 mb-6">
              {editingContractor ? '編輯包商' : '新增包商'}
            </h2>
            
            <form onSubmit={handleSave} className="flex flex-col gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">包商名稱 *</label>
                <input 
                  type="text" 
                  required
                  autoFocus
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">工程類別</label>
                <select 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  value={formData.contractor_type}
                  onChange={e => setFormData({...formData, contractor_type: e.target.value as ContractorType})}
                >
                  {CONTRACTOR_TYPES.map(t => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">聯絡人</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500"
                    value={formData.contact_person || ''}
                    onChange={e => setFormData({...formData, contact_person: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">電話</label>
                  <input 
                    type="text" 
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500"
                    value={formData.phone || ''}
                    onChange={e => setFormData({...formData, phone: e.target.value})}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">備註</label>
                <input 
                  type="text" 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:border-emerald-500"
                  value={formData.notes || ''}
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                />
              </div>

              <div className="flex items-center gap-2 mt-2">
                <input 
                  type="checkbox" 
                  id="is_active"
                  className="w-4 h-4 rounded bg-slate-900 border-slate-700 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-800 cursor-pointer"
                  checked={formData.is_active}
                  onChange={e => setFormData({...formData, is_active: e.target.checked})}
                />
                <label htmlFor="is_active" className="text-sm text-slate-300 cursor-pointer select-none">
                  啟用此包商
                </label>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-700/60">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors font-medium"
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors font-medium shadow-lg shadow-emerald-500/20"
                >
                  儲存設定
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
