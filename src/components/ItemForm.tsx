"use client";

import React, { useState } from 'react';
import { InventoryItem } from '@/lib/db/types';
import { useUser } from './UserContext';

interface ItemFormProps {
  initialData?: Partial<InventoryItem>;
  onSubmit: (data: Omit<InventoryItem, 'id' | 'created_at' | 'updated_at'>) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
}

export function ItemForm({ initialData, onSubmit, onCancel, isSubmitting }: ItemFormProps) {
  const { currentUser } = useUser();
  const isViewer = currentUser?.role === 'VIEWER';
  const [formData, setFormData] = useState({
    code: initialData?.code || '',
    name: initialData?.name || '',
    source_type: initialData?.source_type || '',
    category: initialData?.category || '設備維修',
    item_category: initialData?.item_category || '',
    unit: initialData?.unit || '個',
    opening_quantity: initialData?.opening_quantity || 0,
    low_stock_threshold: initialData?.low_stock_threshold || 0,
    requires_serial: initialData?.requires_serial || false,
    is_active: initialData?.is_active ?? true,
    notes: initialData?.notes || '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.code) return alert('品項代碼與名稱為必填');
    await onSubmit(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">品項代碼 *</span>
          <input 
            type="text" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.code} onChange={e => setFormData({...formData, code: e.target.value})} 
          />
        </label>
        
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">品項名稱 *</span>
          <input 
            type="text" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} 
          />
        </label>
        
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">來源</span>
          <select 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.source_type || ''} onChange={e => setFormData({...formData, source_type: e.target.value})} 
          >
            <option value="">請選擇來源</option>
            <option value="陽光">陽光</option>
            <option value="中部移轉">中部移轉</option>
            <option value="南部移轉">南部移轉</option>
            <option value="其他">其他</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">庫存分類</span>
          <select 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} 
          >
            <option value="設備維修">設備維修</option>
            <option value="建置 / 維修">建置 / 維修</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">品項分類</span>
          <input 
            type="text" 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.item_category || ''} onChange={e => setFormData({...formData, item_category: e.target.value})} 
            placeholder="例如：逆變器、線材"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">單位</span>
          <input 
            type="text" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.unit} onChange={e => setFormData({...formData, unit: e.target.value})} 
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">期初數量</span>
          <input 
            type="number" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.opening_quantity} onChange={e => setFormData({...formData, opening_quantity: parseInt(e.target.value) || 0})} 
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">低庫存門檻</span>
          <input 
            type="number" min="0" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.low_stock_threshold} onChange={e => setFormData({...formData, low_stock_threshold: parseInt(e.target.value) || 0})} 
          />
        </label>

        <label className="flex items-center gap-2 mt-8 md:col-span-1">
          <input 
            type="checkbox" 
            className="w-4 h-4 accent-emerald-500"
            checked={formData.requires_serial} onChange={e => setFormData({...formData, requires_serial: e.target.checked})} 
          />
          <span className="text-sm font-semibold text-slate-300">是否需要序號追蹤</span>
        </label>

        <label className="flex items-center gap-2 md:col-span-2">
          <input 
            type="checkbox" 
            className="w-4 h-4 accent-emerald-500"
            checked={formData.is_active} onChange={e => setFormData({...formData, is_active: e.target.checked})} 
          />
          <span className="text-sm font-semibold text-slate-300">是否啟用</span>
        </label>

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm font-semibold text-slate-300">備註</span>
          <textarea 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100 min-h-[80px]"
            value={formData.notes || ''} onChange={e => setFormData({...formData, notes: e.target.value})} 
          />
        </label>
      </div>

      <div className="flex justify-end gap-3 mt-4 border-t border-slate-700 pt-4">
        <button type="button" onClick={onCancel} disabled={isSubmitting} className="px-4 py-2 rounded text-slate-300 hover:bg-slate-800 disabled:opacity-50">
          取消
        </button>
        <button type="submit" disabled={isSubmitting || isViewer} className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-50">
          {isSubmitting ? '儲存中...' : (isViewer ? '檢視權限' : '儲存品項')}
        </button>
      </div>
    </form>
  );
}
