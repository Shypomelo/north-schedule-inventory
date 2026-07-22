# 系統登入與權限設定文件 (Auth Setup)

本文件紀錄北部工程排程與庫存管理系統目前使用的「Supabase Auth + Google OAuth」登入機制與設定細節。

## 1. 目前登入流程
1. 使用者進入系統，若未登入將被重新導向至 `/login` 頁面。
2. 點擊「使用 Google 帳號登入」，透過 Supabase Auth 轉跳至 Google OAuth 授權畫面。
3. 授權成功後，回到系統首頁，前端 `UserContext` 會取得使用者的 Google Email。
4. 系統利用該 Email 去比對資料庫（目前為 LocalStorage Mock）中的人員清單。
5. 若比對成功且帳號狀態為啟用，則將對應的姓名、權限 (Role) 寫入系統狀態，允許進入系統。
6. 若比對失敗或帳號停用，則中斷登入並顯示對應錯誤訊息。

## 2. Supabase Auth 設定內容
* **Provider**: Google
* **設定位置**: Supabase 控制台 -> Authentication -> Providers -> Google
* **狀態**: Enable Sign in with Google (已啟用)
* **所需金鑰**: 需填入來自 Google Cloud Console 的 `Client ID` 與 `Client Secret`（請勿外流）。

## 3. Google Cloud OAuth Client 設定內容
* **應用程式類型**: 網頁應用程式 (Web application)
* **設定位置**: Google Cloud Console -> API 和服務 -> 憑證 -> OAuth 2.0 用戶端 ID
* **測試階段限制**: 若 OAuth 應用程式狀態為「測試中 (Testing)」，則登入者的 Google 信箱必須先被加入到「測試使用者 (Test users)」名單中才能登入。
* **已授權的重新導向 URI**: 需填入下方的 Supabase Callback URL。

## 4. Supabase Callback URL
在 Google Cloud OAuth 設定中，必須將 Supabase 專案的授權回呼網址加入允許清單，格式如下：
`https://<您的-supabase-project-id>.supabase.co/auth/v1/callback`

## 5. 本機開發網址
* 本地開發測試網址：`http://localhost:3000`
* 登入後預設重新導向回根目錄 `/`。

## 6. .env.local 需要哪些變數
本機開發前，必須在專案根目錄建立 `.env.local` 檔案，並填入以下變數（請從 Supabase 控制台的 Project Settings -> API 取得）：
```env
NEXT_PUBLIC_SUPABASE_URL=<您的_SUPABASE_URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<您的_SUPABASE_ANON_KEY>
```
*(注意：基於安全考量，請勿將包含真實金鑰的 `.env.local` 提交至 Git 版本庫中。)*

## 7. 如何新增允許登入的人員
目前人員資料仍為 Mock 狀態。若要新增允許登入的人員：
1. 進入 `src/lib/db/mock.ts`。
2. 在 `initialUsers` 陣列或 localStorage 更新邏輯中加入新的使用者物件。
3. 確保 `email` 欄位與該人員的 Google 帳號完全一致。
4. 確保 `is_active` 欄位設定為 `true`。
*(未來正式轉移至 Supabase 後，將改為在 Supabase `users` / `team_members` 資料表中新增資料)*

## 8. 未授權帳號會如何處理
當登入的 Google 信箱不在系統的人員清單內時：
* 系統會在背景自動將其登出 (signOut)。
* 阻擋進入系統主畫面。
* 登入頁面上方會顯示錯誤提示：「**此 Google 帳號尚未被授權，請聯絡管理者**」。

## 9. 停用帳號會如何處理
當登入的 Google 信箱在系統中存在，但其 `is_active` 為 `false` 時：
* 系統會在背景自動將其登出 (signOut)。
* 阻擋進入系統主畫面。
* 登入頁面上方會顯示錯誤提示：「**此帳號已停用**」。

## 10. 目前限制與下一步待辦 (Limitations & Next Steps)
當前實作屬於第一階段的最小可行性驗證 (POC)，仍有以下限制：
* **人員資料仍是 mock / localStorage**：使用者的比對仍是仰賴前端 mock 資料庫。
* **尚未把 team_members 搬到 Supabase**：後端尚未建立正式的 `users` 或 `team_members` 資料表。
* **尚未做 RLS (Row Level Security)**：Supabase 資料庫層級的安全存取規則尚未實作，目前阻擋邏輯僅在前端執行。
* **尚未接 Google Calendar**：尚未整合行事曆的 API 授權與同步功能。
