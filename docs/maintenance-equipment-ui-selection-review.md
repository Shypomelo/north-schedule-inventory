# 設備維修 Modal：先設備，再序號

日期：2026-09-21
Branch：feat/maintenance-material-usage-phase-b-integration
HEAD：9b99ef38b7c7f9b2f234d64a107cc0346de00045
Worktree：C:\Vibecode\maintenance-material-usage-phase-b-integration

## 本輪修改

- `src/components/MaintenanceEquipmentModal.tsx`：設備、型號、數量、限定範圍的序號多選。
- `scripts/test-maintenance-equipment-selection.cjs`：新增 8 個 modal targeted tests。
- 本報告。

既有 dirty Phase B 成果保留。未修改 DB、migration、RPC、Inventory canonical OUT、SE atomic update、backend BOTH resolution、RLS、Schedule completion 或 Production。未 commit、未 push。

## 選擇規則

初始不 render 序號卡片或搜尋框；數量預設 1。設備選項由既有候選型號的連字號前綴作顯示分組，例如 P401；第二層保留 canonical 完整型號 P401-5RM4MRM。這只是 UI 分組，不建立新設備分類或改寫來源 identity。無自由輸入型號。

設備及型號選妥後，先按設備分組及完整型號限定候選，再使用既有 case-insensitive substring filter。搜尋不重新讀取全部來源、不會把其他型號展示出來。來源標籤及 conflict eligibility 原樣保留。

正整數數量 N 必須對應恰好 N 個選取，才啟用提交；選滿後其餘序號不可再選。切換設備、型號或數量都清空選取；搜尋不清掉同型號的已選序號，仍可在已選清單移除。掃描器輸入 Enter 不會意外提交。

既有 RPC 每次處理一台，多選按順序逐台登錄，各筆使用獨立且可重試的 request ID。單台原子性不變，並非跨 N 台的原子交易。部分失敗會保留已成功紀錄，移除成功選取，顯示剩餘數量；連線結果不確定時鎖定資料，以同 request ID 重試未確認項目。來源衝突則重新載入並要求重選。

## 真實 localhost 驗收

Chrome 已登入的 `http://localhost:3000/schedule`，使用「新竹香山-邱淑芳 14:00–16:00」維修排程。HMR 顯示本次修改。所有操作僅選取／搜尋，未按確認登錄、未寫入業務資料、未新增 DB fixtures。

| Case | 結果與證據 |
| --- | --- |
| 1 | PASS：開啟後只顯示設備／型號／數量及操作按鈕，零序號卡片。 |
| 2 | PASS：P401 → P401-5RM4MRM → 數量 1，只有該型號的 5 筆庫存序號。 |
| 3 | PASS：數量 2，0/2、1/2 按鈕 disabled；2/2 才 enabled，第三筆不可加選。沒有實際提交。 |
| 4 | PASS：型號改回未選時卡片消失；重新選型號後為 0/2，舊選取清除。切設備後型號與搜尋一併重置。 |
| 5 | PASS：ae、6c0、完整 SJ1823A-0306856C0-AE 都只顯示 P401-5RM4MRM 對應項目。 |
| 6 | 庫存、SE供貨標籤真實 UI PASS；SE 衝突提示／禁選保留。此排程全部可見設備／型號逐一檢查，沒有 BOTH 項目，因此 BOTH 真實頁面未覆蓋；targeted test 已確認 BOTH 標籤與雙來源 identity 保留。 |

現有 UI 候選共 114 筆：庫存 107 筆、SE供貨 7 筆、BOTH 0 筆。未為補足 BOTH 驗證而修改資料。

## Verification

- `node --test scripts/test-maintenance-equipment-selection.cjs scripts/test-maintenance-ui-wiring.cjs scripts/test-maintenance-usage.cjs`：16/16 PASS。
- `git diff --check`：PASS。
- `npx.cmd tsc --noEmit`：PASS。
- 未跑 full suite、build、DB tests。

實作完成，READY FOR LOCAL UI REVIEW。BOTH 真實資料驗證限制如上，不宣稱六個案例全部完整覆蓋。
