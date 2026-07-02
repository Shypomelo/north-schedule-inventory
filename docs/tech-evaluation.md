# 資料庫技術評估：Supabase vs Firebase

針對「北部工程排程與庫存管理系統」，以下為 Supabase (PostgreSQL 關聯式) 與 Firebase/Firestore (NoSQL 非關聯式) 的深度技術評估與比較。

---

## 1. Supabase (PostgreSQL) 評估

Supabase 提供基於 PostgreSQL 的關聯式資料庫，非常適合具備高度關聯與需要精確計算（如庫存加減）的系統。

* **排程資料如何儲存**：
  * 使用 `tasks` 表格，欄位包含 `task_date`, `start_time`, `end_time`。
  * 透過 Foreign Key 關聯至 `projects(id)` 與 `users(id)`。
  * 協同人員可使用 `task_members` 關聯表儲存多對多關係，或者直接在 `tasks` 使用 Postgres 的 `text[]` (Array) 欄位儲存。
* **新增任務後如何立即更新畫面**：
  * **Optimistic UI (樂觀更新)**：前端點擊「儲存」時，先在 React State 中插入這筆資料（假裝成功），背後非同步呼叫 Supabase API。若 API 回傳失敗再 rollback 畫面。
* **拖曳改期後如何同步資料**：
  * 前端拖曳放開的瞬間，更新該任務的 `task_date` 與時間 React State，並觸發 `supabase.from('tasks').update({ task_date: newDate }).eq('id', taskId)`。
* **是否需要 Realtime**：
  * **建議開啟**：若有多個管理員/工程師同時在看排程表，Supabase Realtime 可以透過 WebSocket 即時推播 `UPDATE`/`INSERT` 事件，其他人的畫面會瞬間自動移動卡片，避免發生任務指派衝突。
* **哪些欄位需要 index**：
  * 排程：`task_date` (最常篩選區間), `main_assignee_id` (個人視角), `project_id`。
  * 庫存：`item_id` (加總流水用), `created_at` (報表日期區間), `transaction_type`。
  * 案場：`status`, `is_active`。
* **免費方案或冷啟動延遲**：
  * Supabase 免費專案若 **連續 7 天完全沒有 API 請求** 會進入暫停狀態（Pause）。喚醒需要 1~2 分鐘。只要平日有在使用就不會冷啟動。
  * API 延遲極低（可開在東京或新加坡節點）。

---

## 2. Firebase / Firestore (NoSQL) 評估

Firestore 是彈性的 NoSQL 文件資料庫，特點是極佳的即時性，但處理複雜關聯與統計會比較繁瑣。

* **排程資料如何儲存**：
  * 建立 `tasks` Collection。每一筆 Task Document 中需包含 `project_id`、但也建議「寫死 (Denormalize)」`project_name` 與 `assignee_name`，以避免每次讀取都要額外 Join `projects` 或 `users` Collection。
* **人員、案場、庫存流水如何設計**：
  * 人員 (`users`) 與 案場 (`projects`) 為獨立 Collection。
  * 庫存流水 (`inventory_transactions`) 每一筆是一份 Document。
  * 為了保證庫存精確，當有異動時，必須使用 **Firestore Batch Write** 或 **Transaction**，同時寫入 `inventory_transactions` 並更新 `inventory_items` Document 的 `current_quantity`。
* **是否適合庫存月結與報表**：
  * **較不適合**：NoSQL 缺乏 `SUM()` 或 `GROUP BY` 等聚合函數 (Aggregation)。要算月結報表，必須將當月所有異動 Document 讀到前端（或透過 Cloud Functions）自己寫迴圈加總；或者必須設計額外的「計數器 (Counters) Collection」來每月動態維護。
* **權限規則如何做**：
  * 透過 Firebase Security Rules 實作。需要在使用者的 Auth Token 中加入 Role Claims（如 `ADMIN`），或者在 Rules 裡面去讀取 `users` collection 確認權限。
* **未來匯出 Excel 是否方便**：
  * 基礎匯出很方便，前端全拉資料轉換 JSON 即可。
  * 但若資料量破萬筆，Firestore 讀取費會飆高，且需要依靠 Cloud Functions 來做分批拉取產生檔案。

---

## 3. 技術比較表

| 評估項目 | Supabase (PostgreSQL) | Firebase (Firestore) | 勝出 / 優勢 |
| :--- | :--- | :--- | :--- |
| **速度感 (Latency)** | 快（傳統 API 呼叫，有 React Query 輔助更佳） | 極快（前端 SDK 內建快取與 Offline First） | **Firebase** (Offline 體驗佳) |
| **即時同步 (Realtime)** | 可選開啟 WebSocket 監聽特定 Table | 預設即時同步 (onSnapshot) | **平手** (兩者皆可輕易做到) |
| **關聯資料 (JOIN)** | 極強（輕鬆 Join 案場、人員、待辦） | 弱（需自己手動存多份副本 Denormalization） | **Supabase** |
| **庫存流水計算** | 極強（`SUM()`, `GROUP BY` 或 Trigger） | 繁瑣（無原生 SUM，需自己維護 Counters） | **Supabase** |
| **月結報表產生** | 極快（一個 SQL Query 解決，不耗費頻寬） | 慢且耗成本（需抓取數百筆明細到前端計算） | **Supabase** |
| **權限控管 (RLS/Rules)**| Row Level Security (基於 SQL，極度嚴密) | Security Rules (語法較特殊，維護稍微吃力) | **Supabase** |
| **Google Calendar 整合**| 需寫 Edge Function 或獨立後端處理 Token | 需寫 Cloud Functions 處理 Token | **平手** (皆需後端介入) |
| **維護難度** | 中等（需懂 SQL 基礎、關聯設計） | 簡單入門，但複雜業務（如庫存）會越寫越亂 | **Supabase** (長期維護成本低) |
| **未來擴充性** | 高（標準 SQL，隨時可搬家） | 中（被綁定在 Google 雲端，難以遷移） | **Supabase** |

---

## 4. 總結與建議

### 是否維持 Supabase？
**強烈建議維持 Supabase（或標準關聯式資料庫）。**
您的系統包含了 **「庫存流水」、「進退料總計」、「月結報表」** 以及大量的 **「案場-人員-排程」關聯**。這是關聯式資料庫 (PostgreSQL) 的絕對強項。若改用 Firestore，為了產生每個月的庫存報表或處理案場更名，會產生極大的額外開發與維護成本。

### 是否改 Firebase？
**不建議。** 除非系統非常需要「無網路環境下的離線操作 (Offline First)」能力。

### 是否只用 Google Calendar，不使用 Google Sheets/DB？
**絕對不可行。**
Google Calendar 的 API 只是用來「記錄時間點與文字」，它**不是資料庫**。它無法幫您：
1. 計算總庫存量。
2. 進行排程的複雜過濾（如：篩選某個保固狀態的案場、只看某分類的任務）。
3. 綁定待辦事項 (Todos) 與 派工狀態。
4. 追蹤案場的掛表進度與檢驗日期。

### 是否需要做一個小型 POC 測試？
**建議可以做一個極小型的「API 串接 POC」。**
因為目前介面與邏輯 (React State) 已經非常完善，我們只需要：
1. 建立一個免費的 Supabase 專案。
2. 將目前的 `mock.ts` 中的 `dbAdapter` 換成真實的 Supabase API 呼叫。
3. 測試「拖曳一張卡片」或「新增一筆領料」，觀察畫面的流暢度與即時性。

如果 POC 結果順暢，就能毫無懸念地將系統正式過渡到 Database 階段。
