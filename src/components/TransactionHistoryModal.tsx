"use client";

import React, { useEffect, useState } from 'react';
import { ActivityLog } from '@/lib/db/types';
import { dbAdapter } from '@/lib/db';
import { format } from 'date-fns';

interface TransactionHistoryModalProps {
  transactionId: string;
  onClose: () => void;
}

export function TransactionHistoryModal({ transactionId, onClose }: TransactionHistoryModalProps) {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const allLogs = await dbAdapter.getActivityLogs();
        const txLogs = allLogs.filter(log => log.target_id === transactionId && log.target_type === 'INVENTORY_TRANSACTION');
        // Sort descending by created_at
        setLogs(txLogs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      } catch (error) {
        console.error("Failed to fetch logs", error);
      } finally {
        setIsLoading(false);
      }
    };
    fetchLogs();
  }, [transactionId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-slate-800 rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden border border-slate-700 flex flex-col max-h-[85vh]">
        <div className="p-4 border-b border-slate-700 flex justify-between items-center bg-slate-900/50">
          <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
            異動紀錄歷史
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition">✕</button>
        </div>
        
        <div className="p-6 flex-1 overflow-auto bg-slate-900/50">
          {isLoading ? (
            <div className="text-slate-400 text-center py-8">載入中...</div>
          ) : logs.length === 0 ? (
            <div className="text-slate-500 text-center py-8">查無相關修改紀錄</div>
          ) : (
            <div className="space-y-6">
              {logs.map((log) => (
                <div key={log.id} className="bg-slate-800 border border-slate-700 p-4 rounded-lg">
                  <div className="flex justify-between items-start mb-2 border-b border-slate-700/50 pb-2">
                    <div className="flex flex-col">
                      <span className="font-semibold text-indigo-400">
                        {log.action_type === 'CREATE_TRANSACTION' ? '新增異動' : 
                         log.action_type === 'UPDATE_TRANSACTION' ? '編輯紀錄' : 
                         log.action_type === 'VOID_TRANSACTION' ? '作廢紀錄' : log.action_type}
                      </span>
                      <span className="text-sm text-slate-400 mt-1">操作人: {log.actor_name || '系統'}</span>
                    </div>
                    <span className="text-xs text-slate-500">{format(new Date(log.created_at), 'yyyy/MM/dd HH:mm:ss')}</span>
                  </div>
                  
                  {log.message && (
                    <div className="mb-3 text-sm">
                      <span className="text-amber-500 font-semibold">原因/備註：</span>
                      <span className="text-slate-300 ml-2">{log.message}</span>
                    </div>
                  )}

                  {log.action_type === 'UPDATE_TRANSACTION' && log.before_value && log.after_value && (
                    <div className="grid grid-cols-2 gap-4 text-xs mt-3">
                      <div className="bg-red-900/20 border border-red-900/30 p-2 rounded">
                        <div className="text-red-400 font-bold mb-1 border-b border-red-900/30 pb-1">修改前</div>
                        <pre className="text-slate-400 whitespace-pre-wrap font-mono overflow-auto max-h-40">
                          {formatJsonDiff(log.before_value, log.after_value, false)}
                        </pre>
                      </div>
                      <div className="bg-emerald-900/20 border border-emerald-900/30 p-2 rounded">
                        <div className="text-emerald-400 font-bold mb-1 border-b border-emerald-900/30 pb-1">修改後</div>
                        <pre className="text-slate-300 whitespace-pre-wrap font-mono overflow-auto max-h-40">
                          {formatJsonDiff(log.before_value, log.after_value, true)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="p-4 border-t border-slate-700 bg-slate-800 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded transition">
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}

// 簡易的前後差異呈現工具
function formatJsonDiff(beforeStr: string, afterStr: string, showAfter: boolean) {
  try {
    const before = JSON.parse(beforeStr);
    const after = JSON.parse(afterStr);
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let result = '';
    
    keys.forEach(k => {
      // 忽略不需要對比的系統欄位
      if (['updated_at', 'id', 'created_at'].includes(k)) return;
      
      const bVal = before[k];
      const aVal = after[k];
      
      if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
        result += `${k}: ${showAfter ? JSON.stringify(aVal) : JSON.stringify(bVal)}\n`;
      }
    });
    return result || '無欄位變動';
  } catch (e) {
    return showAfter ? afterStr : beforeStr;
  }
}
