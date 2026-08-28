import React, { useState, useEffect } from 'react';
import { X, AlertTriangle, CheckCircle, Save, Loader2, ArrowRight } from 'lucide-react';
import { InventoryItem } from '@/lib/db/types';
import { InitializationItemInput, InitializationPreviewResult, InitializationStatus, previewInventoryInitialization, initializeInventory } from '@/lib/db/inventory-initialization';

interface InventoryInitializationModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: InventoryItem[];
  onSuccess: () => void;
}

export const InventoryInitializationModal: React.FC<InventoryInitializationModalProps> = ({
  isOpen,
  onClose,
  items,
  onSuccess,
}) => {
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [previewResults, setPreviewResults] = useState<InitializationPreviewResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initStatus, setInitStatus] = useState<{ isInitialized: boolean; date?: string; at?: string; canExecuteNow?: boolean; earliestInitDate?: string } | null>(null);
  const [retainedSerials, setRetainedSerials] = useState<Record<string, string[]>>({});
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (isOpen) {
      const initialInputs: Record<string, number> = {};
      items.forEach(item => {
        initialInputs[item.id] = item.opening_quantity || 0;
      });
      setInputs(initialInputs);
      setPreviewResults(null);
      setError(null);
      setRetainedSerials({});
      setExpandedItem(null);
      setSearchQuery('');

      // Check initialization status
      setLoading(true);
      previewInventoryInitialization([])
        .then(res => {
          if (res.already_initialized) {
            setInitStatus({ isInitialized: true, date: res.baseline_date, at: res.initialized_at, canExecuteNow: res.can_execute_now, earliestInitDate: res.earliest_initialization_date });
          } else {
            setInitStatus({ isInitialized: false, canExecuteNow: res.can_execute_now, earliestInitDate: res.earliest_initialization_date });
          }
        })
        .catch(err => {
          setError(err.message || '無法取得初始化狀態');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isOpen, items]);

  if (!isOpen) return null;

  const handleInputChange = (id: string, value: string) => {
    const num = parseInt(value, 10);
    setInputs(prev => ({
      ...prev,
      [id]: isNaN(num) ? 0 : Math.max(0, num),
    }));
    setPreviewResults(null); // Reset preview on change
  };

  const toggleRetainedSerial = (itemId: string, serialId: string) => {
    setRetainedSerials(prev => {
      const current = prev[itemId] || [];
      const updated = current.includes(serialId)
        ? current.filter(id => id !== serialId)
        : [...current, serialId];
      return { ...prev, [itemId]: updated };
    });
    setPreviewResults(null);
  };

  const setAllRetainedSerials = (itemId: string, serialIds: string[]) => {
    setRetainedSerials(prev => ({ ...prev, [itemId]: serialIds }));
    setPreviewResults(null);
  };

  const handlePreview = async () => {
    try {
      setLoading(true);
      setError(null);

      const payload: InitializationItemInput[] = items.map(item => {
        const itemPayload: InitializationItemInput = {
          id: item.id,
          new_opening_quantity: inputs[item.id] || 0,
        };
        if (item.requires_serial && retainedSerials[item.id]) {
          itemPayload.retained_in_stock_serial_ids = retainedSerials[item.id];
        }
        return itemPayload;
      });

      const result = await previewInventoryInitialization(payload);
      if (result.already_initialized) {
        setInitStatus({ isInitialized: true, date: result.baseline_date, at: result.initialized_at, canExecuteNow: result.can_execute_now, earliestInitDate: result.earliest_initialization_date });
      } else {
        const pItems = result.items || [];
        setPreviewResults(pItems);

        // Initialize retainedSerials for serial items that haven't been touched yet
        setRetainedSerials(prev => {
          const next = { ...prev };
          let changed = false;
          pItems.forEach(pi => {
            if (pi.requires_serial && pi.in_stock_serials && !next[pi.item_id]) {
              next[pi.item_id] = pi.in_stock_serials.map(s => s.id);
              changed = true;
            }
          });
          return changed ? next : prev;
        });

        setInitStatus(prev => prev ? { ...prev, canExecuteNow: result.can_execute_now, earliestInitDate: result.earliest_initialization_date } : null);
      }
    } catch (err: any) {
      setError(err.message || '預覽失敗');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    if (!previewResults || previewResults.some(r => !r.can_initialize)) return;

    const confirmed = window.confirm(
      "⚠️ 警告：這是一次正式切帳操作！\n\n" +
      "此操作將：\n" +
      "1. 設定所有品項的期初庫存量\n" +
      "2. 建立 2026-08 正式結算點\n" +
      "3. 將所有既有測試異動標記為歷史記錄\n\n" +
      "確定要執行嗎？"
    );

    if (!confirmed) return;

    try {
      setLoading(true);
      setError(null);

      const payload: InitializationItemInput[] = items.map(item => {
        const itemPayload: InitializationItemInput = {
          id: item.id,
          new_opening_quantity: inputs[item.id] || 0,
        };
        if (item.requires_serial && retainedSerials[item.id]) {
          itemPayload.retained_in_stock_serial_ids = retainedSerials[item.id];
        }
        return itemPayload;
      });

      await initializeInventory(payload);
      alert('初始化成功！');
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message || '初始化失敗');
    } finally {
      setLoading(false);
    }
  };

  const canConfirm = previewResults && previewResults.every(r => r.can_initialize) && initStatus?.canExecuteNow;

  return (
    <div className="fixed inset-0 bg-page/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-card border border-theme-border rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="p-6 border-b border-theme-border/50 flex justify-between items-center bg-card/50">
          <div>
            <h2 className="text-2xl font-bold text-primary flex items-center gap-3">
              {initStatus?.isInitialized ? <CheckCircle className="w-6 h-6 text-success" /> : <AlertTriangle className="w-6 h-6 text-warning" />}
              {initStatus?.isInitialized ? '庫存已完成初始化' : '正式庫存初始化 / 切帳 (Phase 2B)'}
            </h2>
            <p className="text-secondary mt-2">
              基準日固定為：<strong className="text-primary">2026-08-31</strong>
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-theme-border/50 hover:text-primary rounded-lg text-secondary transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {error && (
            <div className="mb-6 p-4 bg-danger/10 border border-danger/20 rounded-lg flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-danger mt-0.5 flex-shrink-0" />
              <div className="text-danger whitespace-pre-wrap">{error}</div>
            </div>
          )}

          {!initStatus?.isInitialized && initStatus?.canExecuteNow === false && (
            <div className="mb-6 p-4 bg-warning/10 border border-warning/20 rounded-lg flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-warning mt-0.5 flex-shrink-0" />
              <div className="text-warning font-semibold whitespace-pre-wrap">
                正式初始化最早可於 {initStatus.earliestInitDate ? initStatus.earliestInitDate.replace(/-/g, '/') : '2026/08/31'} 執行
              </div>
            </div>
          )}

          {initStatus?.isInitialized ? (
            <div className="flex flex-col items-center justify-center py-12 text-center h-full">
              <div className="bg-success/10 p-6 rounded-full mb-6">
                <CheckCircle className="w-16 h-16 text-success" />
              </div>
              <h3 className="text-2xl font-bold text-primary mb-4">系統已完成切帳作業</h3>
              <div className="bg-card/50 border border-theme-border rounded-lg p-6 max-w-md w-full text-left space-y-4">
                <div className="flex justify-between items-center border-b border-theme-border pb-4">
                  <span className="text-secondary">基準日</span>
                  <span className="font-bold text-primary">{initStatus.date || '2026-08-31'}</span>
                </div>
                <div className="flex justify-between items-center border-b border-theme-border pb-4">
                  <span className="text-secondary">初始化時間</span>
                  <span className="font-medium text-primary">
                    {initStatus.at ? new Date(initStatus.at).toLocaleString() : 'N/A'}
                  </span>
                </div>
                <div className="text-sm text-secondary pt-2">
                  <p>• 所有正式庫存資料已依照此基準日生效</p>
                  <p>• 不再允許重新初始化</p>
                  <p>• 先前測試交易已歸檔不再列入計算</p>
                </div>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto border border-theme-border rounded-lg">
              <table className="w-full text-left border-collapse text-sm">
                <thead className="bg-card text-secondary sticky top-0">
                  <tr>
                    <th className="p-3 font-semibold">品項名稱</th>
                    <th className="p-3 font-semibold">序號管理</th>
                    <th className="p-3 font-semibold text-right">目前初始量</th>
                    <th className="p-3 font-semibold w-32">新初始量</th>
                    {previewResults && (
                      <>
                        <th className="p-3 font-semibold text-right">有效在庫序號</th>
                        <th className="p-3 font-semibold text-right">待補序號</th>
                        <th className="p-3 font-semibold">狀態</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-theme-border/50">
                  {items.map(item => {
                    const preview = previewResults?.find(r => r.item_id === item.id);
                    const isError = preview && !preview.can_initialize;

                    return (
                      <React.Fragment key={item.id}>
                        <tr className={`hover:bg-card/60 transition-colors ${isError ? 'bg-danger/10' : ''}`}>
                          <td className="p-3 font-medium text-primary">{item.name}</td>
                          <td className="p-3 text-secondary">{item.requires_serial ? '是' : '否'}</td>
                          <td className="p-3 text-right text-secondary">{item.opening_quantity}</td>
                          <td className="p-3">
                            <input
                              type="number"
                              min="0"
                              value={inputs[item.id] ?? 0}
                              onChange={(e) => handleInputChange(item.id, e.target.value)}
                              className="w-full bg-page border border-theme-border rounded p-1 text-primary text-right focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                              disabled={loading}
                            />
                          </td>
                          {preview && (
                            <>
                              <td className="p-3 text-right">
                                {item.requires_serial ? (
                                  <div className="flex flex-col items-end gap-1">
                                    <span className="text-secondary">{preview.in_stock_serial_count}</span>
                                    {preview.in_stock_serial_count > 0 && (
                                      <button
                                        onClick={() => setExpandedItem(expandedItem === item.id ? null : item.id)}
                                        className="text-xs text-accent hover:text-accent-hover underline"
                                      >
                                        {expandedItem === item.id ? '收起序號' : '整理在庫序號'}
                                      </button>
                                    )}
                                  </div>
                                ) : '-'}
                              </td>
                              <td className={`p-3 text-right font-bold ${preview.pending_serial_count > 0 ? 'text-warning' : 'text-secondary/50'}`}>
                                {item.requires_serial ? preview.pending_serial_count : '-'}
                              </td>
                              <td className="p-3">
                                {preview.can_initialize ? (
                                  <div className="flex items-center gap-2 text-success">
                                    <CheckCircle className="w-4 h-4" />
                                    <span>OK</span>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2 text-danger" title={preview.error_reason || ''}>
                                    <AlertTriangle className="w-4 h-4" />
                                    <span className="text-xs truncate max-w-[150px]">{preview.error_reason}</span>
                                  </div>
                                )}
                              </td>
                            </>
                          )}
                        </tr>
                        {expandedItem === item.id && preview && item.requires_serial && preview.in_stock_serials && (
                          <tr>
                            <td colSpan={7} className="p-0 border-t-0">
                              <div className="bg-page/50 p-4 border-b border-theme-border flex flex-col gap-3">
                                <div className="flex items-center justify-between">
                                  <div className="text-sm font-semibold text-primary">盤點在庫序號</div>
                                  <div className="text-sm text-secondary">
                                    已選保留: <span className="font-bold text-accent">{(retainedSerials[item.id] || []).length}</span> / {preview.in_stock_serial_count}
                                  </div>
                                </div>

                                {preview.in_stock_serial_count > (inputs[item.id] || 0) && (
                                  <div className="p-2 bg-warning/10 border border-warning/20 rounded text-warning text-xs flex items-center gap-2">
                                    <AlertTriangle className="w-4 h-4" />
                                    目前系統在庫：{preview.in_stock_serial_count}，盤點實際庫存：{inputs[item.id] || 0}，請確認需排除 {Math.max(0, preview.in_stock_serial_count - (inputs[item.id] || 0))} 個序號
                                  </div>
                                )}

                                <div className="flex gap-2 items-center">
                                  <input
                                    type="text"
                                    placeholder="搜尋序號..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="flex-1 bg-card border border-theme-border rounded px-3 py-1.5 text-sm text-primary focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                                  />
                                  <button
                                    onClick={() => setAllRetainedSerials(item.id, preview.in_stock_serials!.map(s => s.id))}
                                    className="px-3 py-1.5 text-xs bg-theme-border/50 hover:bg-theme-border rounded text-primary transition-colors"
                                  >
                                    全選
                                  </button>
                                  <button
                                    onClick={() => setAllRetainedSerials(item.id, [])}
                                    className="px-3 py-1.5 text-xs bg-theme-border/50 hover:bg-theme-border rounded text-primary transition-colors"
                                  >
                                    全不選
                                  </button>
                                </div>

                                <div className="max-h-48 overflow-y-auto bg-card border border-theme-border rounded grid grid-cols-2 gap-px p-px">
                                  {preview.in_stock_serials
                                    .filter(s => !searchQuery || s.serial_number.toLowerCase().includes(searchQuery.toLowerCase()))
                                    .map(serial => {
                                      const isChecked = (retainedSerials[item.id] || []).includes(serial.id);
                                      return (
                                        <label
                                          key={serial.id}
                                          className={`flex items-center gap-2 p-2 cursor-pointer transition-colors ${isChecked ? 'bg-accent/10' : 'bg-page hover:bg-theme-border/30'}`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() => toggleRetainedSerial(item.id, serial.id)}
                                            className="w-4 h-4 rounded border-theme-border text-accent focus:ring-accent bg-card"
                                          />
                                          <span className={`text-sm ${isChecked ? 'text-primary' : 'text-secondary'}`}>
                                            {serial.serial_number}
                                          </span>
                                        </label>
                                      );
                                    })}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-theme-border bg-page/50 flex justify-between items-center">
          <div className="text-sm text-secondary">
            {initStatus?.isInitialized ? (
              <span className="text-success flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                已安全完成初始化
              </span>
            ) : initStatus?.canExecuteNow === false ? (
              <span className="text-warning flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                時間未到，目前僅供預覽
              </span>
            ) : previewResults ? (
              canConfirm ? (
                <span className="text-success flex items-center gap-2">
                  <CheckCircle className="w-4 h-4" />
                  驗證通過，可執行正式初始化
                </span>
              ) : (
                <span className="text-danger flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  存在驗證錯誤，請修正後重新預覽
                </span>
              )
            ) : (
              "請輸入所有品項的新初始量並點擊預覽"
            )}
          </div>
          <div className="flex gap-4">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-6 py-2 rounded-lg font-medium text-secondary hover:text-primary hover:bg-card transition-colors disabled:opacity-50"
            >
              {initStatus?.isInitialized ? '關閉' : '取消'}
            </button>

            {!initStatus?.isInitialized && (
              !previewResults ? (
                <button
                  onClick={handlePreview}
                  disabled={loading}
                  className="px-6 py-2 rounded-lg font-medium bg-accent text-white hover:bg-accent-hover transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  預覽
                </button>
              ) : (
                <button
                  onClick={handleConfirm}
                  disabled={loading || !canConfirm}
                  className="px-6 py-2 rounded-lg font-medium bg-danger text-white hover:bg-danger/80 transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  確認並正式切帳
                </button>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
