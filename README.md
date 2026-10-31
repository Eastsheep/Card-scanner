# 名片掃描 PWA

用 iPhone 相機拍名片，在手機上直接 OCR（繁中＋英文），自動填入姓名、公司、職稱、電話、Email、地址等欄位，資料只存在手機（IndexedDB），可一鍵匯出 CSV（UTF-8 BOM，Excel 開啟中文不亂碼）。

## 安裝到 iPhone 主畫面
1. 用 **Safari** 開啟 GitHub Pages 網址
2. 點下方「分享」按鈕 → 「加入主畫面」
3. 從主畫面圖示開啟即可使用（第一次辨識會下載約 5–9MB 引擎與字庫，之後可離線）

## 隱私與資料
- 照片與辨識都在手機上完成，不會上傳任何伺服器
- 主畫面 App 的資料與 Safari 分開存放；刪除 App 或清除網站資料會一起刪除，請定期匯出 CSV 備份

## 技術
- 純靜態網頁，無後端；部署於 GitHub Pages
- OCR：[Tesseract.js](https://github.com/naptha/tesseract.js) 7（Apache-2.0），字庫 chi_tra / eng（tessdata best_int）已放在 `vendor/`
- 欄位解析：`parser.js`（規則式，針對台灣名片格式）
