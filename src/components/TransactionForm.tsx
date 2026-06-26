"use client";

import React, { useState, useEffect, useMemo } from 'react';
import { InventoryTransaction, InventoryItem, Project, TransactionType, InventorySerial, InventoryBatch } from '@/lib/db/types';
import { useUser } from './UserContext';
import { format } from 'date-fns';
import { Plus } from 'lucide-react';

interface TransactionSubmitData extends Omit<InventoryTransaction, 'id' | 'created_at' | 'updated_at'> {
  category: string;
}

interface TransactionFormProps {
  items: InventoryItem[];
  projects: Project[];
  balances: { item_id: string, balance: number }[];
  allSerials: InventorySerial[];
  batches?: InventoryBatch[];
  onSubmit: (data: TransactionSubmitData, serialsInput: string, isPendingSerial: boolean, editReason?: string) => Promise<void>;
  onCancel: () => void;
  isSubmitting: boolean;
  initialData?: Partial<InventoryTransaction> & { created_at?: string, updated_at?: string };
  initialSerials?: string[];
  onAddNewItem?: () => void;
}

export function TransactionForm({ items, projects, balances, allSerials, batches = [], onSubmit, onCancel, isSubmitting, initialData, initialSerials = [], onAddNewItem }: TransactionFormProps) {
  const { currentUser } = useUser();
  const [formData, setFormData] = useState({
    transaction_type: initialData?.transaction_type || 'OUT' as TransactionType,
    item_id: initialData?.item_id || '',
    quantity: 1,
    unit: '',
    project_name: '',
    handler: currentUser?.name || '',
    category: '',
    source: '',
    transaction_date: format(new Date(), 'yyyy-MM-dd'),
    notes: '',
  });

  const [inSerialInputs, setInSerialInputs] = useState<string[]>(
    initialData?.transaction_type === 'IN' && initialSerials.length > 0
      ? (initialSerials.length >= 2 ? initialSerials : [...initialSerials, ...Array(2 - initialSerials.length).fill('')])
      : ['', '']
  );
  const [isPendingSerial, setIsPendingSerial] = useState(initialData?.pending_serial_count ? initialData.pending_serial_count > 0 : false);
  const [selectedSerials, setSelectedSerials] = useState<string[]>(initialData?.transaction_type !== 'IN' ? initialSerials : []);
  const [editReason, setEditReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isEditMode = !!initialData?.id;

  const [itemSearchText, setItemSearchText] = useState('');
  const [isItemDropdownOpen, setIsItemDropdownOpen] = useState(false);
  const dropdownRef = React.useRef<HTMLLabelElement>(null);

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsItemDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredItems = items.filter(i => 
    i.name.toLowerCase().includes(itemSearchText.toLowerCase()) || 
    i.code.toLowerCase().includes(itemSearchText.toLowerCase())
  );

  const selectedItem = items.find(i => i.id === formData.item_id);
  const currentBalance = balances.find(b => b.item_id === formData.item_id)?.balance || 0;

  const handleItemChange = (itemId: string) => {
    const item = items.find(i => i.id === itemId);
    setFormData({
      ...formData,
      item_id: itemId,
      unit: item?.unit || '',
      category: item?.category || '',
      source: item?.source_type || ''
    });
    setInSerialInputs(['', '']);
    setSelectedSerials([]);
    setIsPendingSerial(false);
  };

  // FIFO Logic
  const availableSerialsFIFO = useMemo(() => {
    if (!selectedItem?.requires_serial || !formData.item_id) return [];
    
    // Combine serial with batch in_date for sorting
    const eligible = allSerials
      .filter(s => s.item_id === formData.item_id && (s.status === '在庫' || initialSerials.includes(s.serial_number)))
      .map(s => {
        const batch = batches.find(b => b.id === s.batch_id);
        return {
          ...s,
          in_date: batch?.in_date || '9999-12-31'
        };
      });

    // Sort by batch in_date ascending, then serial created_at ascending
    eligible.sort((a, b) => {
      const dateDiff = new Date(a.in_date).getTime() - new Date(b.in_date).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    return eligible;
  }, [allSerials, batches, formData.item_id, selectedItem?.requires_serial, initialSerials]);

  // Auto select FIFO serials when quantity or transaction_type changes
  useEffect(() => {
    if ((formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN') && selectedItem?.requires_serial) {
      if (!isEditMode) {
        // Auto select first N serials
        const toSelect = availableSerialsFIFO.slice(0, formData.quantity).map(s => s.serial_number);
        setSelectedSerials(toSelect);
      }
    }
  }, [formData.quantity, formData.transaction_type, availableSerialsFIFO, selectedItem?.requires_serial, isEditMode]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    
    if (isEditMode && !editReason.trim()) return setErrorMsg('修改異動紀錄必須填寫修改原因');
    if (!formData.item_id) return setErrorMsg('請選擇品項');
    if (formData.quantity === 0) return setErrorMsg('數量不能為 0');
    if (formData.quantity < 0 && formData.transaction_type !== 'ADJUST') return setErrorMsg('除了盤點調整，其他異動數量必須大於 0');
    
    if (formData.transaction_type === 'OUT' && formData.quantity > currentBalance) {
      if (!confirm(`警告：目前庫存僅剩 ${currentBalance}，出庫後庫存將變為負數。確定要繼續嗎？`)) {
        return;
      }
    }

    if ((formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN') && !formData.project_name) {
      return setErrorMsg('出庫與退料必須填寫關聯案場');
    }

    if (formData.transaction_type === 'ADJUST' && !formData.notes) {
      return setErrorMsg('調整庫存必須填寫備註原因');
    }

    if (selectedItem?.requires_serial) {
      if (formData.transaction_type === 'IN') {
        const inSerials = inSerialInputs.map(s => s.trim()).filter(Boolean);
        if (inSerials.length > formData.quantity) {
          return setErrorMsg(`輸入的序號數量 (${inSerials.length}) 超過入庫數量 (${formData.quantity})，請檢查！`);
        }
        if (inSerials.length < formData.quantity && !isPendingSerial) {
          return setErrorMsg(`輸入的序號數量 (${inSerials.length}) 少於入庫數量 (${formData.quantity})。若確定要留待之後補登，請勾選「本次先不補齊序號，標記為待補」。`);
        }
        
        // Check for duplicate serials within the input
        const uniqueSerials = new Set(inSerials);
        if (uniqueSerials.size !== inSerials.length) {
          return setErrorMsg('輸入的序號有重複，請檢查！');
        }
      } else if (formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN') {
        if (selectedSerials.length !== formData.quantity) {
          if (availableSerialsFIFO.length < formData.quantity && currentBalance >= formData.quantity) {
            return setErrorMsg('此品項仍有待補序號，請先至明細補登序號後再出庫。設備不得完全無序號出庫。');
          }
          return setErrorMsg(`設備類${formData.transaction_type === 'OUT' ? '出庫' : '退回'}必須有完全相符的序號數量！\n目前異動數量: ${formData.quantity}\n已勾選現有序號: ${selectedSerials.length}\n總和不符，請檢查！`);
        }
      }
    }

    let finalSource = formData.source || null;
    if (formData.transaction_type === 'RETURN') {
      finalSource = '案場退料';
    }

    const matchedProject = projects.find(p => p.name === formData.project_name);
    
    let finalSerials = inSerialInputs.map(s => s.trim()).filter(Boolean).join('\n');
    if (formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN') {
      finalSerials = selectedSerials.join('\n');
    }

    const submitData: TransactionSubmitData = {
      item_id: formData.item_id,
      transaction_type: formData.transaction_type,
      transaction_date: formData.transaction_date,
      quantity: formData.quantity,
      unit: formData.unit,
      project_id: matchedProject ? matchedProject.id : null,
      project_name: formData.project_name || null,
      handler: formData.handler || null,
      category: formData.category,
      source: finalSource,
      notes: formData.notes || null,
      pending_serial_count: formData.transaction_type === 'IN' ? Math.max(0, formData.quantity - inSerialInputs.filter(s => s.trim()).length) : 0
    };

    await onSubmit(submitData, finalSerials, isPendingSerial, isEditMode ? editReason : undefined);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {isEditMode && (
        <div className="flex gap-4 mb-2 bg-slate-800/50 p-3 rounded-lg border border-slate-700/50">
          <div className="text-xs text-slate-400">
            <span className="font-semibold">建立時間：</span>
            {initialData.created_at ? format(new Date(initialData.created_at), 'yyyy-MM-dd HH:mm:ss') : '-'}
          </div>
          <div className="text-xs text-slate-400">
            <span className="font-semibold">最後修改：</span>
            {initialData.updated_at ? format(new Date(initialData.updated_at), 'yyyy-MM-dd HH:mm:ss') : '-'}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm font-semibold text-slate-300">異動類型 *</span>
          <div className="flex gap-4 mt-1">
            {[
              { type: 'OUT', label: '📤 出庫' },
              { type: 'RETURN', label: '↩️ 退料' },
              { type: 'IN', label: '📥 入庫' },
              { type: 'ADJUST', label: '⚖️ 調整' }
            ].map(t => (
              <label key={t.type} className={`flex-1 flex items-center justify-center gap-2 p-3 rounded-lg border cursor-pointer transition-all ${formData.transaction_type === t.type ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400 font-bold' : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-500'}`}>
                <input 
                  type="radio" name="txType" className="hidden"
                  checked={formData.transaction_type === t.type}
                  onChange={() => setFormData({...formData, transaction_type: t.type as TransactionType})}
                />
                {t.label}
              </label>
            ))}
          </div>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">日期 *</span>
          <input 
            type="date" required 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
            value={formData.transaction_date} onChange={e => setFormData({...formData, transaction_date: e.target.value})} 
          />
        </label>

        <label className="flex flex-col gap-1 relative" ref={dropdownRef}>
          <span className="text-sm font-semibold text-slate-300">品項 *</span>
          <div 
            className="bg-slate-900 border border-slate-700 rounded p-2 focus-within:border-emerald-500 flex items-center cursor-text"
            onClick={() => setIsItemDropdownOpen(true)}
          >
            {formData.item_id && !isItemDropdownOpen ? (
              <div className="flex-1 text-slate-100 flex justify-between items-center">
                <span>{selectedItem?.name}</span>
                <button 
                  type="button" 
                  className="text-slate-500 hover:text-slate-300 px-2"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleItemChange('');
                    setItemSearchText('');
                    setIsItemDropdownOpen(true);
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <input 
                type="text" 
                className="bg-transparent outline-none w-full text-slate-100"
                placeholder={formData.item_id ? "搜尋品項..." : "(請輸入關鍵字搜尋或選擇)"}
                value={itemSearchText}
                onChange={e => setItemSearchText(e.target.value)}
                onFocus={() => setIsItemDropdownOpen(true)}
              />
            )}
          </div>
          {isItemDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 max-h-60 overflow-y-auto bg-slate-800 border border-slate-600 rounded shadow-xl z-50">
              {filteredItems.length === 0 ? (
                <div className="p-3 text-slate-400 text-sm text-center">找不到符合的品項</div>
              ) : (
                filteredItems.map(i => (
                  <div 
                    key={i.id}
                    className={`p-3 cursor-pointer border-b border-slate-700/50 hover:bg-emerald-600/20 hover:text-emerald-400 transition-colors ${formData.item_id === i.id ? 'bg-slate-700 text-emerald-400' : 'text-slate-300'}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleItemChange(i.id);
                      setItemSearchText('');
                      setIsItemDropdownOpen(false);
                    }}
                  >
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs opacity-70 mt-1 flex gap-3">
                      <span>庫存分類: {i.category}</span>
                      <span>來源: {i.source_type || '無'}</span>
                      {i.requires_serial && <span className="text-amber-400">需序號</span>}
                    </div>
                  </div>
                ))
              )}
              {onAddNewItem && (
                <div 
                  className="p-3 text-center cursor-pointer text-emerald-400 hover:bg-emerald-600/20 transition-colors border-t border-slate-700 font-semibold"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsItemDropdownOpen(false);
                    onAddNewItem();
                  }}
                >
                  ＋ 新增品項
                </div>
              )}
            </div>
          )}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-slate-300">數量 * {formData.transaction_type === 'ADJUST' && '(可為正負數)'}</span>
          <div className="relative flex items-center gap-2">
            <input 
              type="number" required 
              className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none w-full text-slate-100"
              value={formData.quantity} onChange={e => setFormData({...formData, quantity: parseInt(e.target.value) || 0})} 
            />
            {selectedItem && <span className="text-slate-400 font-medium whitespace-nowrap">{selectedItem.unit}</span>}
            {formData.item_id && (
              <span className={`absolute right-14 top-2 text-xs font-semibold ${currentBalance > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                目前庫存: {currentBalance}
              </span>
            )}
          </div>
        </label>

        {formData.item_id && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-300">庫存分類</span>
              <select 
                className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100 disabled:opacity-60 disabled:cursor-not-allowed" 
                value={formData.category} 
                onChange={e => setFormData({...formData, category: e.target.value})}
                disabled={formData.transaction_type !== 'IN'}
              >
                 <option value="設備維修">設備維修</option>
                 <option value="建置 / 維修">建置 / 維修</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-300">來源</span>
              <select 
                className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100 disabled:opacity-60 disabled:cursor-not-allowed" 
                value={formData.source} 
                onChange={e => setFormData({...formData, source: e.target.value})}
                disabled={formData.transaction_type !== 'IN'}
              >
                <option value="陽光">陽光</option>
                <option value="中部移轉">中部移轉</option>
                <option value="南部移轉">南部移轉</option>
                <option value="其他">其他</option>
              </select>
            </label>
          </>
        )}

        {(formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN') && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-amber-400">案場 ({formData.transaction_type === 'OUT' ? '出庫' : '退料'}必填) *</span>
              <input 
                list="projects-list"
                required
                placeholder="選擇或輸入案場名稱..."
                className="bg-slate-900 border border-amber-700/50 rounded p-2 focus:border-amber-500 outline-none text-slate-100"
                value={formData.project_name} onChange={e => setFormData({...formData, project_name: e.target.value})} 
              />
              <datalist id="projects-list">
                {projects.map(p => <option key={p.id} value={p.name} />)}
              </datalist>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-slate-300">{formData.transaction_type === 'OUT' ? '領料人' : '退料人'}</span>
              <select 
                className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none text-slate-100"
                value={formData.handler} onChange={e => setFormData({...formData, handler: e.target.value})} 
              >
                <option value="">(請選擇)</option>
                <option value="柚子">柚子</option>
                <option value="維揚">維揚</option>
                <option value="育丞">育丞</option>
              </select>
            </label>
          </>
        )}

        {selectedItem?.requires_serial && (
          <div className="flex flex-col gap-4 md:col-span-2 bg-slate-900/50 border border-indigo-500/30 rounded-xl p-4 mt-2">
            <h4 className="font-bold text-indigo-400 flex items-center gap-2">
              <span className="bg-indigo-500 text-white w-6 h-6 rounded-full flex items-center justify-center text-sm">#</span>
              設備序號區塊
            </h4>
            
            {formData.transaction_type === 'IN' ? (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center text-sm bg-slate-800 p-3 rounded-lg border border-slate-700">
                  <div className="text-slate-300">入庫數量：<span className="text-white font-bold">{formData.quantity}</span></div>
                  <div className="text-slate-300">已輸入序號：<span className="text-emerald-400 font-bold">{inSerialInputs.filter(s => s.trim()).length}</span></div>
                  <div className="text-slate-300">待補序號：<span className="text-amber-400 font-bold">{Math.max(0, formData.quantity - inSerialInputs.filter(s => s.trim()).length)}</span></div>
                </div>
                
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between items-end">
                    <span className="text-sm font-semibold text-slate-300">掃描或輸入序號 (每格一組)</span>
                    <button 
                      type="button" 
                      onClick={() => setInSerialInputs(prev => [...prev, ''])}
                      className="text-xs flex items-center gap-1 bg-indigo-600/30 text-indigo-300 hover:bg-indigo-600/50 hover:text-white px-2 py-1 rounded transition"
                    >
                      + 新增格子
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {inSerialInputs.map((val, idx) => (
                      <input 
                        key={idx}
                        type="text"
                        placeholder={`第 ${idx + 1} 個序號...`}
                        className="serial-input bg-slate-900 border border-indigo-700/50 rounded p-2 focus:border-indigo-500 outline-none text-slate-100 w-full"
                        value={val}
                        onChange={e => {
                          const newInputs = [...inSerialInputs];
                          newInputs[idx] = e.target.value;
                          setInSerialInputs(newInputs);
                        }}
                        onKeyDown={e => {
                          if (e.key === 'Tab' && !e.shiftKey && idx === inSerialInputs.length - 1 && val.trim() !== '') {
                            e.preventDefault();
                            setInSerialInputs(prev => [...prev, '']);
                            setTimeout(() => {
                              const inputs = document.querySelectorAll('.serial-input');
                              if (inputs.length > idx + 1) {
                                (inputs[idx + 1] as HTMLInputElement).focus();
                              }
                            }, 10);
                          }
                        }}
                      />
                    ))}
                  </div>
                </div>
                
                <label className="flex items-center gap-2 mt-1 cursor-pointer">
                  <input 
                    type="checkbox" 
                    className="w-4 h-4 accent-indigo-500 rounded" 
                    checked={isPendingSerial} 
                    onChange={e => setIsPendingSerial(e.target.checked)} 
                  />
                  <span className="text-sm font-semibold text-amber-400">本次先不補齊序號，標記為待補</span>
                </label>
              </div>
            ) : formData.transaction_type === 'OUT' || formData.transaction_type === 'RETURN' ? (
              <div className="md:col-span-2 space-y-4 bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                <div className="flex justify-between items-center">
                  <h3 className="font-semibold text-slate-200">設備{formData.transaction_type === 'OUT' ? '出庫' : '退料'}序號選取 (FIFO)</h3>
                  <div className="text-sm">
                     已選 <span className="text-indigo-400 font-bold">{selectedSerials.length}</span> / 需選 <span className="text-slate-100 font-bold">{formData.quantity}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-sm text-slate-300">請從系統現有序號庫存中勾選（已自動按照入庫批次時間為您勾選最舊的序號）</span>
                  <div className="bg-slate-900/50 p-3 rounded-lg border border-slate-700/50 max-h-60 overflow-auto">
                    {availableSerialsFIFO.length === 0 ? (
                      <div className="text-sm text-slate-500 py-2 text-center">目前無可用的庫存序號</div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {availableSerialsFIFO.map(s => {
                            const isSelected = selectedSerials.includes(s.serial_number);
                            return (
                              <label key={s.id} className={`flex items-center gap-2 cursor-pointer p-2 rounded transition-colors ${isSelected ? 'bg-indigo-600/30 border border-indigo-500' : 'hover:bg-slate-800 border border-transparent'}`}>
                                <input 
                                  type="checkbox" 
                                  className="accent-indigo-500 w-4 h-4 rounded"
                                  checked={isSelected}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedSerials(prev => [...prev, s.serial_number]);
                                    } else {
                                      setSelectedSerials(prev => prev.filter(x => x !== s.serial_number));
                                    }
                                  }}
                                />
                                <div className="flex flex-col">
                                   <span className="text-sm text-slate-300 font-mono">{s.serial_number}</span>
                                   <span className="text-[10px] text-slate-500">入庫: {s.in_date}</span>
                                </div>
                              </label>
                            );
                        })}
                      </div>
                    )}
                  </div>
                  {availableSerialsFIFO.length < formData.quantity && currentBalance >= formData.quantity && (
                    <div className="mt-2 text-sm text-amber-400 bg-amber-900/20 p-2 rounded border border-amber-700/30">
                      ⚠️ 此品項有未補登的設備序號，現有序號不足本次出庫。請先至明細補登後再出庫。
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-400">盤點調整不需指定序號，數量將直接增減。</div>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-sm font-semibold text-slate-300">備註 {formData.transaction_type === 'ADJUST' && <span className="text-red-400">* (盤點調整必填)</span>}</span>
          <textarea 
            required={formData.transaction_type === 'ADJUST'}
            className="bg-slate-900 border border-slate-700 rounded p-2 focus:border-emerald-500 outline-none min-h-[60px] text-slate-100"
            value={formData.notes} onChange={e => setFormData({...formData, notes: e.target.value})} 
          />
        </label>
      </div>

      <div className="flex flex-col gap-3 mt-6 pt-4 border-t border-slate-700/50">
        {errorMsg && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-lg text-sm font-medium whitespace-pre-wrap">
            {errorMsg}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition">取消</button>
          <button type="submit" disabled={isSubmitting} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded shadow-lg shadow-indigo-900/20 disabled:opacity-50 transition">
            {isSubmitting ? '處理中...' : (isEditMode ? '儲存修改' : '確認送出')}
          </button>
        </div>
      </div>
      
      {isEditMode && (
        <div className="mt-6 bg-amber-500/10 border border-amber-500/20 p-4 rounded-xl">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-semibold text-amber-500">修改原因 (必填)</span>
            <input 
              type="text"
              required
              placeholder="請簡述為什麼需要修改這筆紀錄 (例如: 數量誤填、案場選錯...)"
              className="bg-slate-900/50 border border-amber-500/30 rounded p-2 focus:border-amber-500 outline-none text-amber-50 w-full"
              value={editReason}
              onChange={e => setEditReason(e.target.value)}
            />
          </label>
        </div>
      )}
    </form>
  );
}
