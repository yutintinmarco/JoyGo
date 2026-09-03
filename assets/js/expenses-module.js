import { db } from "./firebase-service.js";
import { resolveTripId } from "./trip-session-service.js";
import {
  subscribeAuthState,
  signInWithGoogle,
  signOutCurrentUser
} from "./auth-service.js";
import { getDocsFromCache } from "https://www.gstatic.com/firebasejs/11.8.0/firebase-firestore.js";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  limit,
  getDoc,
  setDoc,
  writeBatch
} from "./firestore-observed-service.js";

function mountExpensesHtml(root) {
  root.innerHTML = `<div class="expenses-module">
<main class="expenses-app">
  <div id="expensePrimaryContent" class="expense-primary-content">
    <section class="expense-page-heading" aria-label="支出">
      <div class="trip-library-eyebrow">Expenses</div>
      <h2 class="trip-info-heading">支出</h2>
    </section>
    <section class="expense-snapshot-card" id="expenseSnapshotCard">
      <div class="snapshot-layout">
        <div class="snapshot-left">
          <p class="snapshot-eyebrow">目前總支出</p>
          <div class="snapshot-hero-amount" id="expenseSnapshotTotal">--</div>
          <div class="snapshot-count-line" id="expenseSnapshotCats"></div>
        </div>
        <div class="snapshot-right" id="expenseSnapshotPersons"></div>
      </div>
    </section>

    <div class="expenses-inner-tabs" id="expensesInnerTabs" role="tablist" aria-label="支出內容">
      <button type="button" class="expenses-inner-tab active" data-expenses-tab="add">概覽</button>
      <button type="button" class="expenses-inner-tab" data-expenses-tab="details">明細</button>
      <button type="button" class="expenses-inner-tab" data-expenses-tab="settlement">結算</button>
      <button type="button" class="expenses-inner-tab" data-expenses-tab="analytics">分析</button>
    </div>

    <section class="expenses-panel active" data-expenses-panel="add">
      <section class="card quick-add-card" id="quickAddCard">
        <div class="quick-add-header">
          <div>
            <p class="eyebrow">Quick Add</p>
            <h2>快速新增</h2>
          </div>
          <span class="quick-pill">全員平均分</span>
        </div>

        <div class="quick-grid">
          <label class="quick-label-full">
            項目名稱
            <input type="text" id="quickTitle" placeholder="例如：Ichiran Ramen / Taxi / Hotel" autocomplete="off" />
          </label>

          <label>
            金額
            <input type="number" id="quickAmount" step="0.01" min="0" inputmode="decimal" placeholder="0.00" />
          </label>

          <label>
            貨幣
            <select id="quickCurrency">
              <option value="HKD">HKD</option>
              <option value="JPY">JPY</option>
              <option value="CNY">CNY</option>
              <option value="TWD">TWD</option>
              <option value="KRW">KRW</option>
              <option value="USD">USD</option>
            </select>
          </label>

          <label>
            付款人
            <select id="quickPaidBy"></select>
          </label>

          <label>
            分類
            <select id="quickCategory">
              <option value="Food">Food</option>
              <option value="Transport">Transport</option>
              <option value="Hotel">Hotel</option>
              <option value="Shopping">Shopping</option>
              <option value="Ticket">Ticket</option>
              <option value="Other">Other</option>
            </select>
          </label>

          <button type="button" id="quickAddBtn" class="quick-add-main-btn quick-label-full">快速新增</button>
        </div>
      </section>

      <section class="card expense-actions-card">
        <h2>進階入數</h2>
        <div class="expense-action-grid">
          <button type="button" id="openFullAddBtn" class="secondary-btn">＋ 完整新增</button>
          <button type="button" id="openOcrEntryBtn" class="secondary-btn">📷 OCR 入單</button>
        </div>
      </section>

      <section class="card recent-expenses-card">
        <h2>最近支出</h2>
        <div id="recentExpenseList" class="recent-expense-list is-pending" aria-busy="true">
          <div class="recent-expense-skeleton" aria-hidden="true">
            <div class="recent-expense-skeleton-row"><span></span><i></i></div>
            <div class="recent-expense-skeleton-row"><span></span><i></i></div>
            <div class="recent-expense-skeleton-row"><span></span><i></i></div>
          </div>
        </div>
      </section>

    </section>

    <section class="expenses-panel" data-expenses-panel="details">
      <section class="card">
        <h2>支出明細</h2>
        <div id="expenseList"></div>
      </section>
    </section>

    <section class="expenses-panel" data-expenses-panel="settlement">
      <section class="card">
        <h2>結算 Summary</h2>
        <div id="summary"></div>
      </section>
    </section>

    <section class="expenses-panel" data-expenses-panel="analytics">
      <section class="card" id="analyticsCard">
        <h2>圖表分析</h2>
        <div id="analyticsSummary"></div>
      </section>
    </section>

    <div class="expense-footer-note">

      <span id="syncStatus">Connecting...</span>
      <span id="tripStatusText" class="hidden"></span>
    </div>
  </div>

  <section id="expenseSettingsInline" class="expense-settings-inline hidden" aria-label="支出設定">
    <section class="card expense-inline-settings-card">
      <div class="expense-inline-settings-heading">
        <button type="button" id="expenseSettingsBack" class="expense-inline-back" aria-label="返回支出">
          <svg viewBox="0 0 18 28" aria-hidden="true"><path d="M15 2L3 14l12 12"/></svg>
          <span>返回</span>
        </button>
        <div>
          <h2>支出設定</h2>
        </div>
      </div>
      <div class="settings-menu-grid expense-inline-settings-grid">
        <button type="button" class="settings-menu-btn" data-settings-open="members"><span>👥</span><strong>成員管理</strong></button>
        <button type="button" class="settings-menu-btn" data-settings-open="rates" data-admin-only="true"><span>💱</span><strong>匯率設定</strong></button>
        <button type="button" class="settings-menu-btn" data-settings-open="lock" data-admin-only="true"><span>🔒</span><strong>支出鎖定</strong></button>
        <button type="button" class="settings-menu-btn" data-settings-open="deleted"><span>🗑️</span><strong>已刪除項目</strong></button>
      </div>
    </section>
  </section>

</main>


  <div id="expenseFormModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card expense-form-modal-card">
      <div class="modal-heading-row expense-native-sheet-heading expense-form-manage-heading">
        <h3><span class="expense-form-title-icon" aria-hidden="true">💸</span><span id="expenseFormModalTitle">完整新增支出</span></h3>
      </div>
      <form id="expenseForm" class="modal-body-scroll expense-form-body expense-native-form">
        <section class="expense-native-section">
          <div class="expense-native-section-label">基本資料</div>
          <div class="expense-native-group">
            <label class="expense-native-row"><span>日期</span><input type="date" id="date" required /></label>
            <label class="expense-native-row"><span>項目</span><input type="text" id="title" placeholder="Lunch / Taxi" required /></label>
            <label class="expense-native-row"><span>金額</span><input type="number" id="amount" step="0.01" min="0" inputmode="decimal" placeholder="0.00" required /></label>
            <label class="expense-native-row"><span>貨幣</span><select id="currency"><option value="HKD">HKD</option><option value="JPY">JPY</option><option value="CNY">CNY</option><option value="TWD">TWD</option><option value="KRW">KRW</option><option value="USD">USD</option></select></label>
            <label class="expense-native-row"><span>付款人</span><select id="paidBy"></select></label>
          </div>
        </section>

        <section class="expense-native-section">
          <div class="expense-native-section-label">分帳</div>
          <div class="expense-native-group">
            <div class="expense-native-stacked-row">
              <div class="expense-native-stacked-title">分攤對象</div>
              <div id="sharedByGroup" class="checkbox-grid"></div>
            </div>
            <label class="expense-native-row"><span>分帳方式</span><select id="splitMethod"><option value="equal">平均分</option><option value="amount">指定金額</option><option value="percentage">指定百分比</option></select></label>
            <div id="splitConfig" class="split-config expense-native-split-config"></div>
          </div>
          <p id="splitValidationMessage" class="validation-message"></p>
        </section>

        <section class="expense-native-section">
          <div class="expense-native-section-label">其他</div>
          <div class="expense-native-group">
            <label class="expense-native-row"><span>分類</span><select id="category"><option value="Food">Food</option><option value="Transport">Transport</option><option value="Hotel">Hotel</option><option value="Shopping">Shopping</option><option value="Ticket">Ticket</option><option value="Other">Other</option></select></label>
            <label class="expense-native-row expense-native-note-row"><span>備註</span><textarea id="note" rows="2" placeholder="Optional"></textarea></label>
          </div>
        </section>
      </form>
      <div class="modal-footer-actions expense-form-manage-actions">
        <button type="button" id="closeExpenseFormModalBtn" class="expense-form-cancel-btn">取消</button>
        <button type="submit" id="submitBtn" form="expenseForm">新增</button>
        <button type="button" id="cancelEditBtn" class="secondary-btn hidden" aria-hidden="true" tabindex="-1">取消編輯</button>
      </div>
    </div>
  </div>

  <div id="ocrEntryModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="medium">
    <div class="modal-card">
      <div class="modal-heading-row">
        <h3><span class="modal-title-icon">📷</span><span>OCR 入單</span></h3>
      </div>
      <div class="modal-body-scroll">
        <label>
          收據圖片
          <input type="file" id="ocrReceiptInput" accept="image/*" />
        </label>
      </div>
      <div class="modal-footer-actions">
        <button type="button" id="ocrScanBtn" class="secondary-btn">掃描並分析</button>
        <button type="button" id="closeOcrEntryModalBtn" class="modal-close-btn">關閉</button>
      </div>
    </div>
  </div>

  <div id="expenseDetailModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="medium">
    <div class="modal-card expense-detail-modal-card">
      <div class="modal-heading-row">
        <h3><span class="modal-title-icon">🧾</span><span>支出詳情</span></h3>
      </div>
      <div id="expenseDetailContent" class="modal-body-scroll"></div>
      <div id="expenseDetailFooterActions" class="modal-footer-actions">
        <button type="button" class="modal-close-btn" id="closeExpenseDetailModalBtn">關閉</button>
      </div>
    </div>
  </div>

  <div id="settlementActionModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="medium">
    <div class="modal-card settlement-action-modal-card">
      <div class="modal-heading-row">
        <h3><span class="modal-title-icon">💸</span><span>找數</span></h3>
      </div>
      <div id="settlementActionContent" class="modal-body-scroll"></div>
      <div class="modal-footer-actions">
        <button type="button" class="modal-close-btn" id="closeSettlementActionModalBtn">關閉</button>
      </div>
    </div>
  </div>

  <div id="accountSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="medium">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">👤</span><span>帳戶與登入</span></h3></div>
      <div class="modal-body-scroll">
        <div class="auth-row">
          <button type="button" id="googleSignInBtn" class="google-login-btn"><span class="google-g-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38z"/></svg></span><span>Google 登入</span></button>
          <button type="button" id="signOutBtn" class="secondary-btn hidden">登出</button>
        </div>
        <p id="authUserText" class="hint"></p>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="accountSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="backupSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="compact">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">📊</span><span>支出 Excel 報表</span></h3></div>
      <div class="modal-body-scroll">
        <div class="backup-actions">
          <button type="button" id="exportExcelReportBtn" data-action="export-excel" class="secondary-btn">匯出 Excel Report</button>
        </div>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="backupSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="ratesSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">💱</span><span>匯率設定</span></h3></div>
      <div class="modal-body-scroll">
      <label>
        結算基準幣別
        <select id="baseCurrency">
          <option value="HKD">HKD</option>
          <option value="JPY">JPY</option>
          <option value="CNY">CNY</option>
          <option value="TWD">TWD</option>
          <option value="KRW">KRW</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <section class="active-currency-panel">
        <div class="setting-subtitle">本旅程使用幣值</div>
        <div id="activeCurrencyGroup" class="currency-check-grid"></div>
      </section>
      <div id="ratesContainer" class="rates-grid"></div>
      </div>
      <div class="modal-footer-actions"><button type="button" id="saveRatesBtn" class="secondary-btn">儲存匯率</button><button type="button" class="modal-close-btn" data-modal-close="ratesSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="membersSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">👥</span><span>成員管理</span></h3></div>
      <div class="modal-body-scroll">
      <div class="member-controls">
        <div id="memberList" class="member-list"></div>
        <div class="member-add-row">
          <input type="text" id="memberNameInput" placeholder="新增成員名稱" />
          <button type="button" id="addMemberBtn" class="secondary-btn">新增成員</button>
        </div>
      </div>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="membersSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="accessSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">🔐</span><span>權限管理</span></h3></div>
      <div class="modal-body-scroll">
      <section class="hidden" id="adminPanel">
        <div class="setting-subtitle">可使用此旅程的 Google Email</div>
        <div id="allowedEmailList" class="member-list"></div>
        <div class="member-add-row" style="margin-top:12px">
          <input type="email" id="allowedEmailInput" placeholder="example@gmail.com" />
          <button type="button" id="addAllowedEmailBtn" class="secondary-btn">新增</button>
        </div>
        <div class="setting-subtitle" style="margin-top:16px">Admin Google Email</div>
        <div id="adminEmailList" class="member-list"></div>
        <div class="member-add-row" style="margin-top:12px">
          <input type="email" id="adminEmailInput" placeholder="admin@gmail.com" />
          <button type="button" id="addAdminEmailBtn" class="secondary-btn">新增 Admin</button>
        </div>
      </section>
      <p id="accessNoAdminHint" class="hint">目前旅程尚未建立雲端角色，或你沒有 Owner / Admin 權限。</p>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="accessSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="lockSettingsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="compact">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">🔒</span><span>支出鎖定</span></h3></div>
      <div class="modal-body-scroll">
      <section class="hidden" id="tripControlPanel">
        <div class="form-actions">
          <button type="button" id="lockTripBtn">鎖定此旅程</button>
          <button type="button" id="unlockTripBtn" class="secondary-btn hidden">解除支出鎖定</button>
        </div>
      </section>
      <p id="lockNoAdminHint" class="hint">只有 Owner / Admin 可以鎖定或解除支出鎖定。</p>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="lockSettingsModal">關閉</button></div>
    </div>
  </div>

  <div id="deletedItemsModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">🗑️</span><span>已刪除項目</span></h3></div>
      <div class="modal-body-scroll">
        <div id="deletedExpenseList"></div>
      </div>

    </div>
  </div>

  <div id="activityLogModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">🧾</span><span>操作記錄</span></h3></div>
      <div class="modal-body-scroll">
        <div id="activityLogList"></div>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="activityLogModal">關閉</button></div>
    </div>
  </div>

  <div id="aboutAppModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="medium">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">ℹ️</span><span>關於本 App</span></h3></div>
      <div class="modal-body-scroll">
        <div class="about-app-box">
          <div class="about-app-title">JoyGo 樂遊</div>
          <div class="about-app-row"><span>App version</span><strong>${window.APP_VERSION || "6.7.3"}</strong></div>
          <div class="about-app-row"><span>Expenses module</span><strong>${window.EXPENSES_MODULE_VERSION || window.APP_VERSION || "6.7.3"}</strong></div>
          <div class="about-app-row"><span>Trip ID</span><strong id="aboutTripIdText">載入中</strong></div>
          <div class="about-app-row"><span>Mode</span><strong>PWA / GitHub Pages</strong></div>
        </div>
      </div>
      <div class="modal-footer-actions"><button type="button" class="modal-close-btn" data-modal-close="aboutAppModal">關閉</button></div>
    </div>
  </div>

  <div id="ocrPreviewModal" class="modal expense-presentation-sheet hidden" data-presentation="sheet" data-sheet-size="large">
    <div class="modal-card">
      <div class="modal-heading-row"><h3><span class="modal-title-icon">✅</span><span>確認收據資料</span></h3></div>
      <div class="modal-body-scroll">
        <label>商戶 <input type="text" id="aiMerchantInput" /></label>
        <label>日期 <input type="date" id="aiDateInput" /></label>
        <label>
          幣別
          <select id="aiCurrencyInput">
            <option value="HKD">HKD</option>
            <option value="JPY">JPY</option>
            <option value="CNY">CNY</option>
            <option value="TWD">TWD</option>
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
          </select>
        </label>
        <label>總額 <input type="number" id="aiTotalInput" step="0.01" min="0" /></label>
        <label>信心值 <input type="text" id="aiConfidenceInput" readonly /></label>
        <label>解析說明 <textarea id="aiReasonInput" rows="3" readonly></textarea></label>
      </div>
      <div class="modal-footer-actions">
        <button type="button" id="confirmAiFillBtn">確認填入完整表格</button>
        <button type="button" id="cancelAiFillBtn" class="modal-close-btn">關閉</button>
      </div>
    </div>
  </div>
</div>`;
}

let expensesModuleStarted = false;
let expensesModuleSuspendedForTripSwitch = false;
let activeExpensesTab = "add";

export function initExpensesModule(tripData) {
  if (expensesModuleStarted) return;
  const root = document.getElementById("expenses-root");
  if (!root) return;
  mountExpensesHtml(root);
  const moduleShell = root.querySelector(".expenses-module");
  let modalPortal = document.getElementById("expenses-modal-portal");
  if (!modalPortal) {
    modalPortal = document.createElement("div");
    modalPortal.id = "expenses-modal-portal";
    modalPortal.className = "expenses-module expenses-modal-portal";
    document.body.appendChild(modalPortal);
  }
  moduleShell?.querySelectorAll(":scope > .modal").forEach(modal => modalPortal.appendChild(modal));
  expensesModuleStarted = true;


let expensesConfig = tripData?.meta?.expenses || {};
let tripId = resolveTripId(tripData);
window.__expensesModuleTripId = tripId;
const defaultExpenseRates = { HKD: 1, JPY: 0.055, CNY: 1.08, TWD: 0.24, KRW: 0.0058, USD: 7.8 };
function settingsFromExpensesConfig(config = {}) {
  const rates = config.defaultExchangeRates || defaultExpenseRates;
  return {
    baseCurrency: config.baseCurrency || "HKD",
    exchangeRates: { ...rates },
    activeCurrencies: Array.isArray(config.currencies) && config.currencies.length ? [...config.currencies] : Object.keys(rates)
  };
}
let members = [];
let tripSettings = settingsFromExpensesConfig(expensesConfig);
// v8.0.12 · Expense split members are canonical in settings/expenses.defaultMembers
// for schemaVersion >= 2. The Trip-root members array remains a compatibility
// mirror only, so older clients / backups can still understand the list.
let expenseMembersSettingsResolved = false;
let expenseMembersSettingsCanonical = false;
let expenseMembersSettingsFallback = [];
let expenseMembersCanonicalVersion = 0;
let expenseMembersRootResolved = false;
let expenseMembersRootFallback = [];
let expenseMembersSchemaVersion = 2;
let expenseMembersSource = "none";

const form = document.getElementById("expenseForm");
const dateInput = document.getElementById("date");
const titleInput = document.getElementById("title");
const amountInput = document.getElementById("amount");
const currencyInput = document.getElementById("currency");
const paidByInput = document.getElementById("paidBy");
const sharedByGroup = document.getElementById("sharedByGroup");
const splitMethodInput = document.getElementById("splitMethod");
const splitConfig = document.getElementById("splitConfig");
const splitValidationMessage = document.getElementById("splitValidationMessage");
const categoryInput = document.getElementById("category");
const noteInput = document.getElementById("note");
const syncStatus = document.getElementById("syncStatus");
const expenseList = document.getElementById("expenseList");
const summary = document.getElementById("summary");
const analyticsSummary = document.getElementById("analyticsSummary");
const submitBtn = document.getElementById("submitBtn");
const cancelEditBtn = document.getElementById("cancelEditBtn");
const memberList = document.getElementById("memberList");
const memberNameInput = document.getElementById("memberNameInput");
const addMemberBtn = document.getElementById("addMemberBtn");

const baseCurrencyInput = document.getElementById("baseCurrency");
const ratesContainer = document.getElementById("ratesContainer");
const saveRatesBtn = document.getElementById("saveRatesBtn");
const activeCurrencyGroup = document.getElementById("activeCurrencyGroup");

const ocrFileInput = document.getElementById("ocrReceiptInput");
const ocrBtn = document.getElementById("ocrScanBtn");

const ocrPreviewModal = document.getElementById("ocrPreviewModal");
const aiMerchantInput = document.getElementById("aiMerchantInput");
const aiDateInput = document.getElementById("aiDateInput");
const aiCurrencyInput = document.getElementById("aiCurrencyInput");
const aiTotalInput = document.getElementById("aiTotalInput");
const aiConfidenceInput = document.getElementById("aiConfidenceInput");
const aiReasonInput = document.getElementById("aiReasonInput");
const confirmAiFillBtn = document.getElementById("confirmAiFillBtn");
const cancelAiFillBtn = document.getElementById("cancelAiFillBtn");

const googleSignInBtn = document.getElementById("googleSignInBtn");
const signOutBtn = document.getElementById("signOutBtn");
const authUserText = document.getElementById("authUserText");

const adminPanel = document.getElementById("adminPanel");
const allowedEmailList = document.getElementById("allowedEmailList");
const allowedEmailInput = document.getElementById("allowedEmailInput");
const addAllowedEmailBtn = document.getElementById("addAllowedEmailBtn");
const adminEmailList = document.getElementById("adminEmailList");
const adminEmailInput = document.getElementById("adminEmailInput");
const addAdminEmailBtn = document.getElementById("addAdminEmailBtn");
const aboutTripIdText = document.getElementById("aboutTripIdText");
if (aboutTripIdText) aboutTripIdText.textContent = tripId;
const exportExcelBtn = document.getElementById("exportExcelBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportJsonBackupBtn = document.getElementById("exportJsonBackupBtn");
const exportExcelReportBtn = document.getElementById("exportExcelReportBtn");

const quickAddCard = document.getElementById("quickAddCard");
const quickTitleInput = document.getElementById("quickTitle");
const quickAmountInput = document.getElementById("quickAmount");
const quickCurrencyInput = document.getElementById("quickCurrency");
const quickPaidByInput = document.getElementById("quickPaidBy");
const quickCategoryInput = document.getElementById("quickCategory");
const quickAddBtn = document.getElementById("quickAddBtn");
const quickAddHint = document.getElementById("quickAddHint");
const quickAddFab = document.getElementById("quickAddFab");
let quickAddTapGuard = false;
let quickAddTapGuardTimer = null;
const QUICK_ADD_TAP_GUARD_MS = 360;

function setQuickAddTapGuard(nextState) {
  quickAddTapGuard = Boolean(nextState);
  if (quickAddBtn) {
    quickAddBtn.setAttribute("aria-busy", quickAddTapGuard ? "true" : "false");
    quickAddBtn.textContent = "快速新增";
  }
  updateTripStatusUi();
}

function releaseQuickAddTapGuardSoon() {
  if (quickAddTapGuardTimer) clearTimeout(quickAddTapGuardTimer);
  quickAddTapGuardTimer = setTimeout(() => {
    quickAddTapGuardTimer = null;
    setQuickAddTapGuard(false);
    // Do not auto-refocus Quick Add after submit. On iOS, focusing an input
    // without a visible keyboard still makes the shared keyboard manager hide
    // the bottom navigation. The user can tap the next field when ready.
  }, QUICK_ADD_TAP_GUARD_MS);
}

const tripControlPanel = document.getElementById("tripControlPanel");
const tripStatusText = document.getElementById("tripStatusText");
const lockTripBtn = document.getElementById("lockTripBtn");
const unlockTripBtn = document.getElementById("unlockTripBtn");
const deletedExpenseList = document.getElementById("deletedExpenseList");
const activityLogList = document.getElementById("activityLogList");
const expenseSnapshotCard = document.getElementById("expenseSnapshotCard");
const expenseSnapshotTotal = document.getElementById("expenseSnapshotTotal");
const expenseSnapshotCats = document.getElementById("expenseSnapshotCats");
const expenseSnapshotPersons = document.getElementById("expenseSnapshotPersons");
const recentExpenseList = document.getElementById("recentExpenseList");
let recentExpenseCacheHydrationStarted = false;
let recentExpensesLiveReady = false;
let settlementsLiveReady = false;
let activityLogsLiveReady = false;
let expenseSettingsLiveReady = false;
let lastExpenseSettingsSignature = "";
let lastLegacyTripSettingsSignature = "";
let lastSettlementRenderSignature = "";
let lastActivityLogRenderSignature = "";
const backupSyncMeta = {
  settings: { seen:false, fromCache:true, hasPendingWrites:false },
  expenses: { seen:false, fromCache:true, hasPendingWrites:false },
  settlements: { seen:false, fromCache:true, hasPendingWrites:false },
  activityLogs: { seen:false, fromCache:true, hasPendingWrites:false }
};
function resetBackupSyncMeta(){
  Object.keys(backupSyncMeta).forEach(key=>{backupSyncMeta[key]={seen:false,fromCache:true,hasPendingWrites:false};});
  expenseSettingsLiveReady=false;
  lastExpenseSettingsSignature="";
  lastLegacyTripSettingsSignature="";
  lastSettlementRenderSignature="";
  lastActivityLogRenderSignature="";
  lastExpenseRenderSignature="";
}
function updateBackupSyncMeta(key,snapshot){
  backupSyncMeta[key]={
    seen:true,
    fromCache:snapshot?.metadata?.fromCache===true,
    hasPendingWrites:snapshot?.metadata?.hasPendingWrites===true
  };
  // Let the passive Full Backup gate repaint immediately when an existing
  // Expense realtime listener changes freshness. This does not create a read.
  try{window.dispatchEvent(new Event("expense-backup-freshness-change"));}catch(error){}
  const values=Object.values(backupSyncMeta);
  if(values.every(meta=>meta.seen===true&&meta.fromCache===false&&meta.hasPendingWrites!==true)){
    expenseRealtimeRetryAttempt=0;
    clearExpenseRealtimeRetry();
  }
}
function currentExpenseBackupFreshness(){
  const sources=Object.fromEntries(Object.entries(backupSyncMeta).map(([key,value])=>[key,{...value}]));
  const values=Object.values(sources);
  const serverConfirmed=values.every(meta=>meta.seen===true&&meta.fromCache===false);
  const hasPendingWrites=values.some(meta=>meta.hasPendingWrites===true);
  return {serverConfirmed:serverConfirmed&&!hasPendingWrites,hasPendingWrites,sources};
}
let pendingExcelExportRequested = false;
let pendingExcelExportTimer = null;
let pendingExcelExportStartedAt = 0;
const openFullAddBtn = document.getElementById("openFullAddBtn");
const openOcrEntryBtn = document.getElementById("openOcrEntryBtn");
const expenseFormModal = document.getElementById("expenseFormModal");
const expenseFormModalTitle = document.getElementById("expenseFormModalTitle");
const closeExpenseFormModalBtn = document.getElementById("closeExpenseFormModalBtn");
const ocrEntryModal = document.getElementById("ocrEntryModal");
const closeOcrEntryModalBtn = document.getElementById("closeOcrEntryModalBtn");
const expenseDetailModal = document.getElementById("expenseDetailModal");
const expenseDetailContent = document.getElementById("expenseDetailContent");
const expenseDetailFooterActions = document.getElementById("expenseDetailFooterActions");
const closeExpenseDetailModalBtn = document.getElementById("closeExpenseDetailModalBtn");
const settlementActionModal = document.getElementById("settlementActionModal");
const settlementActionContent = document.getElementById("settlementActionContent");
const closeSettlementActionModalBtn = document.getElementById("closeSettlementActionModalBtn");
const accessNoAdminHint = document.getElementById("accessNoAdminHint");
const lockNoAdminHint = document.getElementById("lockNoAdminHint");
const expensePrimaryContent = document.getElementById("expensePrimaryContent");
const expenseSettingsInline = document.getElementById("expenseSettingsInline");
const expenseSettingsBack = document.getElementById("expenseSettingsBack");
let activeExpenseDrag = null;


let lastModuleStatus = "Connecting";
const MODULE_STATUS_COPY = Object.freeze({
    "No access to settlements": "找數資料暫時未能同步",
    "No access to expenses": "支出資料暫時未能同步",
    "No access to activity logs": "操作記錄暫時未能同步",
    "Waiting for Firestore Rules": "雲端權限設定尚未完成",
    "Confirming Trip access": "正在確認旅程權限…",
    "No Trip access": "目前帳戶沒有此旅程的支出寫入權限",
    "Connecting": "正在同步支出資料…",
    "Sync error": "支出資料同步失敗，請稍後再試",
    "Settlement sync error": "找數資料同步失敗，請稍後再試",
    "Activity log sync error": "操作記錄同步失敗，請稍後再試",
    "Preparing Excel...": "正在準備 Excel…",
    "Preparing Excel data...": "正在整理 Excel 資料…",
    "Export error": "Excel 匯出失敗，請再試",
    "Preparing JSON backup...": "正在準備 JSON Backup…",
    "JSON export error": "JSON Backup 匯出失敗，請再試",
    "OCR error": "OCR 辨識失敗，請再試",
    "Init error": "支出功能暫時未能載入",
    "Please sign in": "請先登入 Google 帳戶"
  });


function renderCompactModuleStatus(message = lastModuleStatus) {
  lastModuleStatus = message || lastModuleStatus || "Ready";
  if (!syncStatus) return;

  const footer = syncStatus.closest(".expense-footer-note");
  const raw = String(lastModuleStatus || "");
  const healthy = /^(Synced|Connected|OCR ready)/i.test(raw);
  if (healthy) {
    syncStatus.textContent = "";
    if (footer) {
      footer.hidden = true;
      footer.classList.remove("is-warning","is-loading");
    }
    return;
  }

  const friendly = MODULE_STATUS_COPY[raw] || getCleanModuleStatus(raw);

  syncStatus.textContent = friendly;
  if (footer) {
    footer.hidden = false;
    footer.classList.toggle("is-loading", /Connecting|Preparing|OCR/i.test(raw));
    footer.classList.toggle("is-warning", /No access|error|Rules|failed/i.test(raw));
  }
}

function setModuleStatus(message) {
  renderCompactModuleStatus(message);
}

let currentUser = null;
let phase2TripRole = null;
let phase2TripAccessReady = Boolean(window.__appTripAccess?.ready);
let phase2TripAccessTripId = String(window.__appTripAccess?.tripId || "");
let expenseAccessRecoveryTimer = null;
let expenseAccessRecoveryAttempt = 0;
let cloudExpenseStarted = false;
let expenseBindingEpoch = 0;
let expenseRealtimeRetryTimer = null;
let expenseRealtimeRetryAttempt = 0;
let allExpenses = [];
let expenses = [];
let lastExpenseRenderSignature = "";
let settlements = [];
let activityLogs = [];
let tripStatus = "open";
let tripLockedAt = null;
let tripLockedBy = null;
let tripLockedByName = "";
let expenseLockExplicit = false;
let legacyExpenseLock = { locked:false, lockedAt:null, lockedBy:null, lockedByName:"" };
let globalTripLocked = false;
let editingExpenseId = null;
let stopTripListener = null;
let stopExpenseSettingsListener = null;
let stopExpensesListener = null;
let stopSettlementsListener = null;
let stopActivityLogsListener = null;
function clearExpenseRealtimeRetry(){
  if(expenseRealtimeRetryTimer) clearTimeout(expenseRealtimeRetryTimer);
  expenseRealtimeRetryTimer = null;
}
function markExpenseFreshnessUnavailable(key){
  if(backupSyncMeta[key]) backupSyncMeta[key]={seen:false,fromCache:true,hasPendingWrites:false};
  if(key==="settings") expenseSettingsLiveReady=false;
  if(key==="expenses") recentExpensesLiveReady=false;
  if(key==="settlements") settlementsLiveReady=false;
  if(key==="activityLogs") activityLogsLiveReady=false;
  try{window.dispatchEvent(new Event("expense-backup-freshness-change"));}catch(error){}
}
function scheduleExpenseRealtimeRetry(bindingEpochAtError){
  if(expensesModuleSuspendedForTripSwitch||!currentUser||bindingEpochAtError!==expenseBindingEpoch)return;
  if(expenseRealtimeRetryTimer)return;
  const delay=Math.min(5000,700*Math.pow(2,Math.min(3,expenseRealtimeRetryAttempt++)));
  const retryTripId=tripId;
  expenseRealtimeRetryTimer=setTimeout(()=>{
    expenseRealtimeRetryTimer=null;
    if(expensesModuleSuspendedForTripSwitch||!currentUser||bindingEpochAtError!==expenseBindingEpoch||retryTripId!==tripId)return;
    // New generation: any callback already queued by the failed listener set is
    // stale from this point onward and cannot mutate the replacement binding.
    expenseBindingEpoch += 1;
    cloudExpenseStarted=false;
    recentExpensesLiveReady=false;
    lastExpenseRenderSignature="";
    settlementsLiveReady=false;
    activityLogsLiveReady=false;
    resetBackupSyncMeta();
    startExpenseCloudIfAllowed();
  },delay);
}
let tripAllowedUids = [];
let tripCreatorUid = null;
let tripAdminUids = [];
let adminEmailsCache = [];
let allowedEmailsCache = [];
const analyticsCategoryOrder = ["Food", "Transport", "Hotel", "Shopping", "Ticket", "Other"];
const analyticsCategoryColors = {
  Food: "#ff9f43",
  Transport: "#4A90D9",
  Hotel: "#7c5cff",
  Shopping: "#ff6b81",
  Ticket: "#2ecc71",
  Other: "#8e8e93"
};
let analyticsSelectedCategories = null;
let settlementViewMode = localStorage.getItem("expense_settlement_view_mode") || "base";
let expenseModalLockCount = 0;
let expenseModalLockedScrollTop = 0;

/* utils */
const safeEscape = (text) => String(text ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

function emptyStateHtml(icon, text) {
  return `<div class="expense-empty-state"><span class="expense-empty-icon">${icon}</span><p class="expense-empty-text">${text}</p></div>`;
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
function localDateISO(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}
function snapshotDataWithServerEstimate(snapshot) {
  if (!snapshot || typeof snapshot.data !== "function") return {};
  try {
    return snapshot.data({ serverTimestamps: "estimate" }) || {};
  } catch (error) {
    return snapshot.data() || {};
  }
}
function semanticRecordSignature(value, ignoredKeys = []) {
  const ignored = new Set(ignoredKeys);
  const normalize = input => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!input || typeof input !== "object") return input;
    if (typeof input.toMillis === "function") return input.toMillis();
    const output = {};
    Object.keys(input).sort().forEach(key => {
      if (!ignored.has(key)) output[key] = normalize(input[key]);
    });
    return output;
  };
  try { return JSON.stringify(normalize(value)); }
  catch (error) { return String(value ?? ""); }
}
function expenseRenderSignature(list) {
  const rows = [...(list || [])];
  const displayOrder = rows.map(item => String(item?.id || "")).join("|");
  const ordered = [...rows].sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || "")));
  return `${displayOrder}::${semanticRecordSignature(ordered, ["createdAt", "updatedAt"])}`;
}
function sortExpensesForDisplay(list) {
  return [...(list || [])].sort((a, b) => {
    const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
    if (dateCompare !== 0) return dateCompare;
    return timestampMillis(b.createdAt || b.updatedAt) - timestampMillis(a.createdAt || a.updatedAt);
  });
}
const getTripDocRef = () => doc(db, "trips", tripId);
const getExpensesCollection = () => collection(db, "trips", tripId, "expenses");
const getSettlementsCollection = () => collection(db, "trips", tripId, "settlements");
const getActivityLogsCollection = () => collection(db, "trips", tripId, "activityLogs");
const uniqueStrings = (arr) => [...new Set((arr || []).filter(Boolean).map(v => String(v)))];
const normalizeEmail = (e) => String(e || "").trim().toLowerCase();
const escapeRegExp = (text) => String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


function getAllConfiguredCurrencies() {
  const fromConfig = Array.isArray(expensesConfig.currencies) ? expensesConfig.currencies : [];
  const fromRates = Object.keys(tripSettings.exchangeRates || {});
  const defaults = ["JPY", "HKD", "CNY", "TWD", "KRW", "USD"];
  return uniqueStrings([...fromConfig, ...fromRates, tripSettings.baseCurrency, ...defaults]);
}

function getActiveCurrencies() {
  const configured = getAllConfiguredCurrencies();
  const active = Array.isArray(tripSettings.activeCurrencies) && tripSettings.activeCurrencies.length
    ? tripSettings.activeCurrencies
    : configured;
  return uniqueStrings([tripSettings.baseCurrency, ...active]).filter(code => configured.includes(code));
}

function buildCurrencyOptions(currencies, selectedValue) {
  const selected = selectedValue && currencies.includes(selectedValue) ? selectedValue : currencies[0];
  return currencies.map(code => `<option value="${safeEscape(code)}" ${code === selected ? "selected" : ""}>${safeEscape(code)}</option>`).join("");
}

function getEditorActiveCurrenciesPreview() {
  if (!activeCurrencyGroup || !activeCurrencyGroup.querySelector("[data-active-currency]")) return null;

  const configured = getAllConfiguredCurrencies();
  const selected = uniqueStrings(
    Array.from(activeCurrencyGroup.querySelectorAll("[data-active-currency]:checked"))
      .map(input => input.dataset.activeCurrency)
  );

  const base = baseCurrencyInput?.value || tripSettings.baseCurrency || selected[0] || "HKD";
  return uniqueStrings([base, ...selected]).filter(code => configured.includes(code));
}

function getActiveCurrenciesForUi() {
  return getEditorActiveCurrenciesPreview() || getActiveCurrencies();
}

function syncCurrencyEditorPreview() {
  if (!activeCurrencyGroup) return;

  const active = new Set(getEditorActiveCurrenciesPreview() || getActiveCurrencies());
  const base = baseCurrencyInput?.value || tripSettings.baseCurrency;

  activeCurrencyGroup.querySelectorAll(".currency-check-chip").forEach(label => {
    const input = label.querySelector("[data-active-currency]");
    if (!input) return;

    if (input.dataset.activeCurrency === base) {
      input.checked = true;
      input.disabled = true;
      label.classList.add("is-base");
    } else {
      input.disabled = false;
      label.classList.remove("is-base");
    }

    label.classList.toggle("is-selected", input.checked);
  });

  ratesContainer?.querySelectorAll("[data-rate-row-code]").forEach(row => {
    const code = row.dataset.rateRowCode;
    const isActive = active.has(code);
    const isBase = code === base;
    row.classList.toggle("is-active-currency", isActive);
    row.classList.toggle("is-inactive-currency", !isActive);

    const labelText = row.querySelector("[data-rate-label]");
    if (labelText) {
      labelText.textContent = `${code} ${isBase ? "(base=1)" : isActive ? "" : "(未使用)"}`.trim();
    }
  });
}

function updateCurrencySelectOptions() {
  const active = getActiveCurrenciesForUi();
  const allConfigured = getAllConfiguredCurrencies();
  const fullFormCurrent = currencyInput?.value || tripSettings.baseCurrency || active[0] || "HKD";
  const quickCurrent = quickCurrencyInput?.value || tripSettings.baseCurrency || active[0] || "HKD";
  const aiCurrent = aiCurrencyInput?.value || quickCurrent;
  const baseCurrent = baseCurrencyInput?.value || tripSettings.baseCurrency || active[0] || "HKD";

  if (currencyInput) currencyInput.innerHTML = buildCurrencyOptions(active, active.includes(fullFormCurrent) ? fullFormCurrent : active[0]);
  if (quickCurrencyInput) quickCurrencyInput.innerHTML = buildCurrencyOptions(active, active.includes(quickCurrent) ? quickCurrent : active[0]);
  if (aiCurrencyInput) aiCurrencyInput.innerHTML = buildCurrencyOptions(active, active.includes(aiCurrent) ? aiCurrent : active[0]);
  if (baseCurrencyInput) baseCurrencyInput.innerHTML = buildCurrencyOptions(allConfigured, allConfigured.includes(baseCurrent) ? baseCurrent : tripSettings.baseCurrency);
}

function getCleanModuleStatus(message) {
  const raw = String(message || "Ready");
  const cleaned = (tripId ? raw.replace(new RegExp(`\\s*\\(${escapeRegExp(tripId)}\\)`, "g"), "") : raw).replace(/\s+$/g, "");
  if (/[\u3400-\u9FFF]/.test(cleaned)) return cleaned;
  if (/Preparing|Connecting|Confirming/i.test(cleaned)) return "正在處理支出資料…";
  if (/error|failed|denied|Rules/i.test(cleaned)) return "支出功能暫時未能完成，請稍後再試";
  return "支出資料正在處理…";
}
function getCurrentUserDisplayName() {
  if (!currentUser) return "未知用戶";
  return currentUser.displayName || currentUser.email || "未命名成員";
}

const categoryRules = {
  Food: [
    "food", "lunch", "dinner", "breakfast", "brunch", "coffee", "tea", "ramen", "sushi", "bbq", "restaurant", "cafe", "meal", "snack", "dessert", "izakaya", "bar", "drink", "bakery", "noodle", "rice",
    "飯", "餐", "早餐", "午餐", "晚餐", "咖啡", "茶", "拉麵", "壽司", "燒肉", "餐廳", "居酒屋", "甜品", "小食", "飲品", "麵", "飯店", "食"
  ],
  Transport: [
    "taxi", "uber", "train", "bus", "mtr", "jr", "metro", "subway", "airport express", "flight", "ferry", "parking", "tram", "rail", "shinkansen", "ic card", "suica", "pasmo", "octopus",
    "的士", "地鐵", "巴士", "電車", "火車", "機場快線", "船", "渡輪", "交通", "新幹線", "車票", "八達通"
  ],
  Hotel: [
    "hotel", "airbnb", "hostel", "inn", "ryokan", "onsen", "resort", "accommodation", "lodging", "stay",
    "酒店", "旅館", "住宿", "溫泉", "民宿", "旅舍"
  ],
  Ticket: [
    "ticket", "museum", "disney", "usj", "temple", "shrine", "zoo", "aquarium", "tour", "show", "park", "admission", "entry", "pass",
    "門票", "博物館", "迪士尼", "環球影城", "寺", "神社", "動物園", "水族館", "景點", "入場", "展覽", "表演"
  ],
  Shopping: [
    "shopping", "souvenir", "donki", "uniqlo", "gu", "muji", "drugstore", "cosme", "mall", "outlet", "market", "convenience", "lawson", "familymart", "7-eleven", "seven", "supermarket", "gift",
    "購物", "手信", "藥妝", "商場", "百貨", "超市", "便利店", "紀念品", "禮物", "堂吉訶德"
  ]
};

const categoryPriority = ["Transport", "Hotel", "Food", "Ticket", "Shopping"];
const quickPrefsKey = () => `travel-expenses-quick-prefs:${tripId}`;

function inferCategoryFromTitle(title) {
  const text = String(title || "").trim().toLowerCase();
  if (!text) return "Other";

  const scores = {};
  Object.entries(categoryRules).forEach(([category, keywords]) => {
    scores[category] = 0;
    keywords.forEach(keyword => {
      const key = String(keyword).toLowerCase();
      if (!key) return;
      if (text.includes(key)) scores[category] += key.length > 3 ? 2 : 1;
    });
  });

  let bestCategory = "Other";
  let bestScore = 0;

  categoryPriority.forEach(category => {
    const score = scores[category] || 0;
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  });

  return bestScore > 0 ? bestCategory : "Other";
}

function loadQuickPrefs() {
  try {
    return JSON.parse(localStorage.getItem(quickPrefsKey()) || "{}");
  } catch (error) {
    return {};
  }
}

function saveQuickPrefs() {
  if (!quickCurrencyInput || !quickPaidByInput || !quickCategoryInput) return;
  const prefs = {
    currency: quickCurrencyInput.value,
    paidBy: quickPaidByInput.value,
    category: quickCategoryInput.value
  };
  localStorage.setItem(quickPrefsKey(), JSON.stringify(prefs));
}

function applyQuickPrefs() {
  if (!quickCurrencyInput || !quickPaidByInput || !quickCategoryInput) return;
  const prefs = loadQuickPrefs();

  quickCurrencyInput.value = prefs.currency || tripSettings.baseCurrency || "HKD";

  if (prefs.paidBy && members.includes(prefs.paidBy)) {
    quickPaidByInput.value = prefs.paidBy;
  } else if (members.length > 0) {
    quickPaidByInput.value = members[0];
  }

  quickCategoryInput.value = prefs.category || "Food";
}

function updateCategoryFromTitle(titleEl, categoryEl, sourceLabel = "") {
  if (!titleEl || !categoryEl) return;
  const inferred = inferCategoryFromTitle(titleEl.value);
  if (inferred !== "Other") {
    categoryEl.value = inferred;
    if (sourceLabel && quickAddHint) {
      quickAddHint.textContent = `已根據「${titleEl.value.trim()}」估算分類：${inferred}。如不正確，可手動修改。`;
    }
  }
}

function isTripLocked() {
  return tripStatus === "locked";
}
function isGlobalTripLocked(){ return globalTripLocked === true; }
function assertGlobalTripOpen(message = "此旅程已全域鎖定，目前只可查看資料。") {
  if (isGlobalTripLocked()) { alert(message); return false; }
  return true;
}
function assertTripOpen(message = "支出已鎖定，不能再修改支出或支出設定。") {
  if (!assertGlobalTripOpen()) return false;
  if (isTripLocked()) {
    alert(message);
    return false;
  }
  return true;
}
function applyExpenseLockState(data = {}, { explicit = true } = {}) {
  expenseLockExplicit = explicit && typeof data.expenseLocked === "boolean";
  const locked = expenseLockExplicit ? data.expenseLocked === true : legacyExpenseLock.locked === true;
  tripStatus = locked ? "locked" : "open";
  tripLockedAt = expenseLockExplicit ? (data.expenseLockedAt || null) : legacyExpenseLock.lockedAt;
  tripLockedBy = expenseLockExplicit ? (data.expenseLockedBy || null) : legacyExpenseLock.lockedBy;
  tripLockedByName = expenseLockExplicit ? (data.expenseLockedByName || "") : legacyExpenseLock.lockedByName;
  updateTripStatusUi();
}

function getActiveExpenses() {
  return sortExpensesForDisplay(allExpenses.filter(expense => expense.isDeleted !== true));
}

function getDeletedExpenses() {
  return sortExpensesForDisplay(allExpenses.filter(expense => expense.isDeleted === true));
}

function setFormDisabled(disabled, reason = "") {
  Array.from(form.elements).forEach(el => {
    el.disabled = disabled;
  });
  if (disabled) {
    submitBtn.textContent = reason === "locked"
      ? "支出已鎖定"
      : (reason === "access-pending" ? "正在確認權限…" : "只讀");
    cancelEditBtn.classList.add("hidden");
  } else if (!editingExpenseId) {
    submitBtn.textContent = "新增";
  }
}

function expenseAccessState() {
  const live = window.__appTripAccess || {};
  const accessTripId = String(live.tripId || phase2TripAccessTripId || "");
  // A signed-out or not-yet-initialised access snapshot may legitimately have
  // ready:true. It is not authoritative for a signed-in Expense workspace.
  // Require both the exact active Trip and a signed-in access snapshot before
  // interpreting role:null as genuine no-access.
  const matchesTrip = accessTripId === tripId;
  const signedInMatches = !currentUser || live.signedIn === true;
  const ready = matchesTrip && signedInMatches && (live.ready === true || phase2TripAccessReady === true);
  const role = ready ? (live.role || phase2TripRole || null) : null;
  return { ready, role, accessTripId, matchesTrip };
}

function clearExpenseAccessRecoveryTimer() {
  if (expenseAccessRecoveryTimer) clearTimeout(expenseAccessRecoveryTimer);
  expenseAccessRecoveryTimer = null;
}

function scheduleExpenseAccessRecovery() {
  clearExpenseAccessRecoveryTimer();
  if (!currentUser || expenseAccessState().ready) return;
  const delays = [700, 2200, 5000];
  const delay = delays[Math.min(expenseAccessRecoveryAttempt, delays.length - 1)];
  expenseAccessRecoveryTimer = setTimeout(() => {
    expenseAccessRecoveryTimer = null;
    if (!currentUser || expenseAccessState().ready) return;
    expenseAccessRecoveryAttempt += 1;
    window.dispatchEvent(new CustomEvent("expense-trip-access-refresh-request", { detail: { tripId } }));
    if (!expenseAccessState().ready && expenseAccessRecoveryAttempt < delays.length) scheduleExpenseAccessRecovery();
  }, delay);
}

function updateTripStatusUi() {
  const locked = isTripLocked();
  const globallyLocked = isGlobalTripLocked();
  const lockInfo = locked
    ? `已鎖定${tripLockedByName ? ` · ${tripLockedByName}` : ""}${tripLockedAt ? ` · ${formatTimestamp(tripLockedAt)}` : ""}`
    : "仍可新增及修改支出";

  if (tripStatusText) {
    tripStatusText.innerHTML = globallyLocked
      ? `<span class="locked-badge">全旅程唯讀</span> 支出鎖定設定暫不可變更`
      : (locked
        ? `<span class="locked-badge">已鎖定</span> ${safeEscape(lockInfo)}`
        : `<span class="open-badge">可編輯</span> ${safeEscape(lockInfo)}`);
  }

  if (tripControlPanel) {
    tripControlPanel.classList.toggle("hidden", !isAdmin());
  }
  if (lockNoAdminHint) lockNoAdminHint.classList.toggle("hidden", isAdmin());

  if (lockTripBtn) { lockTripBtn.classList.toggle("hidden", locked || !isAdmin()); lockTripBtn.disabled = globallyLocked; }
  if (unlockTripBtn) { unlockTripBtn.classList.toggle("hidden", !locked || !isAdmin()); unlockTripBtn.disabled = globallyLocked; }
  const lockActionFooter = lockTripBtn?.closest(".modal-footer-actions");
  if (lockActionFooter) lockActionFooter.classList.toggle("expense-actions-unavailable", !isAdmin());

  const access = expenseAccessState();
  const accessPending = Boolean(currentUser && !access.ready);
  const readOnly = access.ready ? !canWriteExpenses() : true;
  setFormDisabled(globallyLocked || locked || readOnly || accessPending, (globallyLocked || locked) ? "locked" : (accessPending ? "access-pending" : (readOnly ? "read-only" : "")));

  if (addMemberBtn) addMemberBtn.disabled = globallyLocked || locked || readOnly || accessPending || !isAdmin();
  if (memberNameInput) memberNameInput.disabled = globallyLocked || locked || readOnly || accessPending || !isAdmin();
  if (saveRatesBtn) saveRatesBtn.disabled = globallyLocked || locked || !isAdmin();
  if (baseCurrencyInput) baseCurrencyInput.disabled = globallyLocked || locked || !isAdmin();
  if (ratesContainer) {
    ratesContainer.querySelectorAll("input").forEach(input => {
      input.disabled = globallyLocked || locked || !isAdmin() || input.dataset.rateCode === tripSettings.baseCurrency;
    });
  }
  if (ocrBtn) ocrBtn.disabled = globallyLocked || locked || readOnly;
  if (ocrFileInput) ocrFileInput.disabled = globallyLocked || locked || readOnly;

  [quickTitleInput, quickAmountInput, quickCurrencyInput, quickPaidByInput, quickCategoryInput, quickAddBtn].forEach(el => {
    if (el) el.disabled = globallyLocked || locked || readOnly || quickAddTapGuard;
  });
  document.querySelectorAll("[data-admin-only]").forEach(btn => {
    btn.classList.toggle("hidden", !isAdmin());
  });
  if (quickAddFab) quickAddFab.disabled = globallyLocked || locked || readOnly;
}

function expenseActivityDescriptor(action, message = "") {
  const map = {
    expense_created: ["新增支出", "expense"],
    expense_updated: ["修改支出", "expense"],
    expense_deleted: ["刪除支出", "expense"],
    expense_restored: ["還原已刪除支出", "expense"],
    settings_updated: ["更新支出設定", "expense"],
    settlement_recorded: ["記錄找數", "expense"],
    settlement_cancelled: ["取消找數紀錄", "expense"],
    member_added: ["新增分帳成員", "expense"],
    member_removed: ["移除分帳成員", "expense"],
    trip_locked: ["鎖定支出", "expense"],
    trip_unlocked: ["解鎖支出", "expense"]
  };
  const [title, category] = map[action] || [String(action || "支出操作"), "expense"];
  return { title, category, summary: String(message || title) };
}

function buildActivityLogPayload(action, message, targetType = "trip", targetId = tripId, details = {}) {
  if (!currentUser) return null;
  const descriptor = expenseActivityDescriptor(action, message);
  return {
    action,
    actionType: action,
    category: descriptor.category,
    title: descriptor.title,
    summary: descriptor.summary,
    message,
    actorUid: currentUser.uid,
    actorName: getCurrentUserDisplayName(),
    targetType,
    targetId: String(targetId || ""),
    details,
    createdAt: serverTimestamp()
  };
}

async function logActivity(action, message, targetType = "trip", targetId = tripId, details = {}) {
  const payload = buildActivityLogPayload(action, message, targetType, targetId, details);
  if (!payload) return;
  try {
    await addDoc(getActivityLogsCollection(), payload);
  } catch (error) {
    console.warn("Activity log failed:", error);
  }
}


function getSettlementKey(item) {
  return `${item.from}|${item.to}|${item.currency}|${Number(item.amount).toFixed(2)}`;
}

function getSettlementPairKey(item) {
  return `${item.from}|${item.to}|${item.currency}`;
}

function getSettlementPaymentAmountInCurrency(record, targetCurrency, options = {}) {
  const paidAmount = Number(record.paidAmount ?? record.amount ?? 0);
  const recordCurrency = record.currency || tripSettings.baseCurrency || "HKD";
  const target = targetCurrency || tripSettings.baseCurrency || "HKD";

  if (!Number.isFinite(paidAmount) || paidAmount <= 0) return null;

  if (recordCurrency === target) {
    return paidAmount;
  }

  // Base currency view means all settlement cash flows should also be translated into base currency.
  // Otherwise a JPY/HKD payment recorded under 原幣分開 would be ignored after switching back to 基準幣別.
  if (options.convertToTarget && target === (tripSettings.baseCurrency || "HKD")) {
    const converted = convertToBase(paidAmount, recordCurrency);
    return Number.isFinite(Number(converted)) ? Number(converted) : null;
  }

  return null;
}

function getTotalRecordedPayments(currency, options = {}) {
  return round2(settlements.reduce((sum, record) => {
    const amount = getSettlementPaymentAmountInCurrency(record, currency, options);
    return amount == null ? sum : sum + amount;
  }, 0));
}

function applyRecordedPaymentsToNet(net, currency, options = {}) {
  settlements.forEach(record => {
    const from = record.from;
    const to = record.to;
    const paidAmount = getSettlementPaymentAmountInCurrency(record, currency, options);

    if (!from || !to || !Number.isFinite(paidAmount) || paidAmount <= 0) return;

    if (!Object.prototype.hasOwnProperty.call(net, from)) net[from] = 0;
    if (!Object.prototype.hasOwnProperty.call(net, to)) net[to] = 0;

    // A settlement payment is a cash transfer.
    // Payer's payable position reduces, receiver's receivable position reduces.
    // If someone overpays, the net position will naturally flip and the next settlement will ask the receiver to pay back the excess.
    net[from] += paidAmount;
    net[to] -= paidAmount;
  });

  Object.keys(net).forEach(person => {
    net[person] = round2(net[person]);
  });

  return net;
}

function getExportFileName() {
  const date = localDateISO().replaceAll("-", "");
  return `trip-expenses-${tripId}-${date}.xlsx`;
}

function getJsonBackupFileName() {
  const date = localDateISO().replaceAll("-", "");
  return `trip-expenses-backup-${tripId}-${date}.json`;
}

function timestampToIso(ts) {
  if (!ts) return "";
  const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function toPlainValue(value) {
  if (value == null) return value;

  if (typeof value?.toDate === "function") {
    return timestampToIso(value);
  }

  if (Array.isArray(value)) {
    return value.map(item => toPlainValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, toPlainValue(val)])
    );
  }

  return value;
}


function toFullBackupValue(value) {
  if (value == null) return value;
  try {
    if (typeof value?.toDate === "function") {
      const date = value.toDate();
      return { __travelBackupType: "timestamp", iso: date.toISOString() };
    }
  } catch (error) {}
  if (value instanceof Date) return { __travelBackupType: "timestamp", iso: value.toISOString() };
  if (Array.isArray(value)) return value.map(item => toFullBackupValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, toFullBackupValue(val)]));
  }
  return value;
}

function localBackupEntries(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const source = row && typeof row === "object" ? row : {};
    const id = String(source.id || `row-${index + 1}`);
    const data = { ...source };
    delete data.id;
    return { id, data: toFullBackupValue(data) };
  });
}

window.__getExpenseLocalExportSnapshot = () => ({
  tripId,
  ready: Boolean(cloudExpenseStarted && expenseSettingsLiveReady && recentExpensesLiveReady && settlementsLiveReady && activityLogsLiveReady),
  role: phase2TripRole || null,
  settings: toFullBackupValue(tripSettings),
  expenses: localBackupEntries(allExpenses),
  settlements: localBackupEntries(settlements),
  activityLogs: localBackupEntries(activityLogs),
  freshness: currentExpenseBackupFreshness(),
  capturedAt: new Date().toISOString()
});
function downloadBlobFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

function downloadTextFile(filename, text, mimeType) {
  downloadBlobFile(filename, new Blob([text], { type: mimeType }));
}

function setToday() { dateInput.value = localDateISO(); }
function getSelectedParticipants() { return Array.from(sharedByGroup.querySelectorAll("input:checked")).map(i => i.value); }
function getRateFor(currency) { const r = tripSettings.exchangeRates?.[currency]; return Number.isFinite(Number(r)) && Number(r) > 0 ? Number(r) : null; }
function convertToBase(amount, currency) { const rate = getRateFor(currency); return rate ? round2(Number(amount) * rate) : null; }

function rebuildSplitsForCurrentRates(expense, convertedAmount) {
  const originalAmount = Number(expense.originalAmount ?? expense.amount ?? 0);
  const originalCurrency = expense.originalCurrency ?? expense.currency ?? tripSettings.baseCurrency;
  const fxRate = getRateFor(originalCurrency);
  const method = expense.splitMethod || "equal";
  const existingSplits = Array.isArray(expense.splits) ? expense.splits : [];
  const participants = existingSplits.length
    ? existingSplits.map(row => row.member).filter(Boolean)
    : (Array.isArray(expense.sharedBy) ? expense.sharedBy : []);

  if (!participants.length || !fxRate || !Number.isFinite(originalAmount) || originalAmount <= 0) {
    return { sharedBy: Array.isArray(expense.sharedBy) ? expense.sharedBy : [], splits: Array.isArray(expense.splits) ? expense.splits : [] };
  }

  if (method === "amount" && existingSplits.length) {
    const originalRows = allocateRoundingDifference(existingSplits.map(row => ({
      member: row.member,
      amount: Number(row.originalAmount ?? 0)
    })), originalAmount);

    const baseRows = allocateRoundingDifference(originalRows.map(row => ({
      member: row.member,
      amount: row.amount * fxRate
    })), convertedAmount);

    return {
      sharedBy: originalRows.map(row => row.member),
      splits: baseRows.map((row, index) => ({
        member: row.member,
        amount: row.amount,
        originalAmount: originalRows[index].amount,
        percentage: convertedAmount ? round2(row.amount / convertedAmount * 100) : 0
      }))
    };
  }

  if (method === "percentage" && existingSplits.length) {
    const pctRows = existingSplits.map(row => ({
      member: row.member,
      percentage: Number(row.percentage ?? 0)
    }));
    const baseRows = allocateRoundingDifference(pctRows.map(row => ({
      member: row.member,
      amount: convertedAmount * row.percentage / 100
    })), convertedAmount);
    const originalRows = allocateRoundingDifference(pctRows.map(row => ({
      member: row.member,
      amount: originalAmount * row.percentage / 100
    })), originalAmount);

    return {
      sharedBy: pctRows.map(row => row.member),
      splits: baseRows.map((row, index) => ({
        member: row.member,
        amount: row.amount,
        originalAmount: originalRows[index].amount,
        percentage: round2(pctRows[index].percentage)
      }))
    };
  }

  const originalShareRaw = originalAmount / participants.length;
  const originalRows = allocateRoundingDifference(participants.map(member => ({ member, amount: originalShareRaw })), originalAmount);
  const baseRows = allocateRoundingDifference(participants.map(member => ({ member, amount: convertedAmount / participants.length })), convertedAmount);

  return {
    sharedBy: participants,
    splits: baseRows.map((row, index) => ({
      member: row.member,
      amount: row.amount,
      originalAmount: originalRows[index].amount,
      percentage: convertedAmount ? round2(row.amount / convertedAmount * 100) : 0
    }))
  };
}

async function refreshAllExpenseFxAmounts() {
  if (!currentUser) return { updated: 0, skipped: 0 };

  let updated = 0;
  let skipped = 0;

  for (const expense of allExpenses) {
    const originalAmount = Number(expense.originalAmount ?? expense.amount ?? 0);
    const originalCurrency = expense.originalCurrency ?? expense.currency ?? tripSettings.baseCurrency;
    const convertedAmount = convertToBase(originalAmount, originalCurrency);

    if (!Number.isFinite(originalAmount) || originalAmount <= 0 || convertedAmount === null) {
      skipped += 1;
      continue;
    }

    const splitUpdate = rebuildSplitsForCurrentRates(expense, convertedAmount);

    await updateDoc(doc(db, "trips", tripId, "expenses", expense.id), {
      convertedAmount,
      baseCurrency: tripSettings.baseCurrency,
      fxRateUsed: getRateFor(originalCurrency),
      sharedBy: splitUpdate.sharedBy,
      splits: splitUpdate.splits,
      updatedBy: currentUser.uid,
      updatedByName: getCurrentUserDisplayName(),
      updatedAt: serverTimestamp()
    });

    updated += 1;
  }

  return { updated, skipped };
}

function getSplitMethodLabel(method) {
  const labels = {
    equal: "平均分",
    amount: "指定金額",
    percentage: "指定百分比"
  };
  return labels[method] || "平均分";
}

function getCurrentSplitMethod() {
  return splitMethodInput?.value || "equal";
}

function getSelectedSplitMembers() {
  const selected = getSelectedParticipants();
  return selected.length ? selected : [];
}

function allocateRoundingDifference(rows, expectedTotal) {
  const roundedRows = rows.map(row => ({ ...row, amount: round2(row.amount) }));
  const roundedTotal = round2(roundedRows.reduce((sum, row) => sum + row.amount, 0));
  const diff = round2(Number(expectedTotal) - roundedTotal);
  if (roundedRows.length && diff !== 0) {
    roundedRows[roundedRows.length - 1].amount = round2(roundedRows[roundedRows.length - 1].amount + diff);
  }
  return roundedRows;
}

function renderSplitConfig() {
  if (!splitConfig || !splitMethodInput) return;
  const method = getCurrentSplitMethod();
  const selectedMembers = getSelectedSplitMembers();

  if (splitValidationMessage) {
    splitValidationMessage.textContent = "";
  }

  if (!selectedMembers.length || method === "equal") {
    splitConfig.innerHTML = "";
    return;
  }

  const inputLabel = method === "amount" ? "分攤金額" : "分攤百分比";
  const suffix = method === "amount" ? (currencyInput?.value || "") : "%";
  const step = method === "amount" ? "0.01" : "0.01";
  const placeholder = method === "amount" ? "0.00" : "0.00";

  splitConfig.innerHTML = `
    <div class="split-grid">
      ${selectedMembers.map(member => `
        <label class="split-row">
          <span>${safeEscape(member)}</span>
          <div class="split-input-wrap">
            <input
              type="number"
              step="${step}"
              min="0"
              inputmode="decimal"
              placeholder="${placeholder}"
              data-split-member="${safeEscape(member)}"
            />
            <small>${safeEscape(suffix)}</small>
          </div>
        </label>
      `).join("")}
    </div>
  `;
}

function validateAndBuildSplits(originalAmount, originalCurrency, convertedAmount) {
  const method = getCurrentSplitMethod();
  const participants = getSelectedSplitMembers();

  if (!participants.length) {
    return { ok: false, message: "請至少選擇一位參與人。" };
  }

  const fxRate = getRateFor(originalCurrency);
  if (!fxRate) {
    return { ok: false, message: `未有 ${originalCurrency} 匯率。` };
  }

  if (method === "equal") {
    const originalShareRaw = originalAmount / participants.length;
    const baseRows = participants.map(member => ({
      member,
      amount: convertedAmount / participants.length,
      originalAmount: originalShareRaw,
      percentage: round2(100 / participants.length)
    }));
    const adjustedBaseRows = allocateRoundingDifference(baseRows, convertedAmount);
    const adjustedOriginalRows = allocateRoundingDifference(
      participants.map(member => ({ member, amount: originalShareRaw })),
      originalAmount
    );

    const splits = adjustedBaseRows.map((row, index) => ({
      member: row.member,
      amount: row.amount,
      originalAmount: adjustedOriginalRows[index].amount,
      percentage: participants.length ? round2(row.amount / convertedAmount * 100) : 0
    }));

    return { ok: true, splitMethod: "equal", sharedBy: participants, splits };
  }

  const inputs = Array.from(splitConfig?.querySelectorAll("[data-split-member]") || []);
  const values = inputs.map(input => ({
    member: input.dataset.splitMember,
    value: Number(input.value)
  }));

  if (values.some(row => !Number.isFinite(row.value) || row.value < 0)) {
    return { ok: false, message: "請輸入有效分攤數字。" };
  }

  if (values.every(row => row.value === 0)) {
    return { ok: false, message: "分攤數字不能全為 0。" };
  }

  if (method === "amount") {
    const totalOriginalSplit = round2(values.reduce((sum, row) => sum + row.value, 0));
    const diff = round2(totalOriginalSplit - originalAmount);

    if (Math.abs(diff) > 0.01) {
      return {
        ok: false,
        message: `指定金額總和 ${originalCurrency} ${totalOriginalSplit.toFixed(2)}，與支出金額相差 ${originalCurrency} ${Math.abs(diff).toFixed(2)}。`
      };
    }

    const originalRows = allocateRoundingDifference(values.map(row => ({ member: row.member, amount: row.value })), originalAmount);
    const baseRows = allocateRoundingDifference(originalRows.map(row => ({
      member: row.member,
      amount: row.amount * fxRate
    })), convertedAmount);

    const splits = baseRows.map((row, index) => ({
      member: row.member,
      amount: row.amount,
      originalAmount: originalRows[index].amount,
      percentage: convertedAmount ? round2(row.amount / convertedAmount * 100) : 0
    }));

    return { ok: true, splitMethod: "amount", sharedBy: values.map(row => row.member), splits };
  }

  if (method === "percentage") {
    const totalPct = round2(values.reduce((sum, row) => sum + row.value, 0));
    const diff = round2(totalPct - 100);

    if (Math.abs(diff) > 0.01) {
      return {
        ok: false,
        message: `指定百分比總和 ${totalPct.toFixed(2)}%，與 100% 相差 ${Math.abs(diff).toFixed(2)}%。`
      };
    }

    const pctRows = values.map(row => ({ member: row.member, percentage: row.value }));
    const baseRows = allocateRoundingDifference(pctRows.map(row => ({
      member: row.member,
      amount: convertedAmount * row.percentage / 100
    })), convertedAmount);
    const originalRows = allocateRoundingDifference(pctRows.map(row => ({
      member: row.member,
      amount: originalAmount * row.percentage / 100
    })), originalAmount);

    const splits = baseRows.map((row, index) => ({
      member: row.member,
      amount: row.amount,
      originalAmount: originalRows[index].amount,
      percentage: round2(pctRows[index].percentage)
    }));

    return { ok: true, splitMethod: "percentage", sharedBy: values.map(row => row.member), splits };
  }

  return { ok: false, message: "未知分帳方式。" };
}

function getExpenseSplitRows(expense, convertedAmount) {
  if (Array.isArray(expense.splits) && expense.splits.length > 0) {
    const rows = expense.splits
      .filter(row => row && row.member && Number.isFinite(Number(row.amount)))
      .map(row => ({
        member: String(row.member),
        amount: Number(row.amount),
        originalAmount: Number(row.originalAmount ?? 0),
        percentage: Number(row.percentage ?? 0)
      }));

    if (rows.length) {
      return allocateRoundingDifference(rows, convertedAmount);
    }
  }

  const participants = Array.isArray(expense.sharedBy) && expense.sharedBy.length ? expense.sharedBy : [];
  if (!participants.length) return [];

  const fallbackRows = participants.map(member => ({
    member,
    amount: Number(convertedAmount) / participants.length,
    originalAmount: Number(expense.originalAmount ?? expense.amount ?? 0) / participants.length,
    percentage: round2(100 / participants.length)
  }));

  return allocateRoundingDifference(fallbackRows, convertedAmount);
}

function describeSplit(expense) {
  const method = expense.splitMethod || "equal";
  const label = getSplitMethodLabel(method);
  const converted = Number(expense.convertedAmount ?? 0);
  const rows = getExpenseSplitRows(expense, converted);
  if (!rows.length) return label;
  return `${label} · ${rows.map(row => `${row.member}: ${tripSettings.baseCurrency} ${Number(row.amount).toFixed(2)}`).join(" / ")}`;
}


function lockExpenseBackgroundScroll() {
  const shell = document.getElementById("scroll-shell");

  if (expenseModalLockCount === 0) {
    expenseModalLockedScrollTop = shell ? shell.scrollTop : window.scrollY || 0;

    if (shell) {
      shell.dataset.expensePreviousOverflowY = shell.style.overflowY || "";
      shell.dataset.expensePreviousOverscroll = shell.style.overscrollBehavior || "";
      shell.style.overflowY = "hidden";
      shell.style.overscrollBehavior = "none";
    }

    document.documentElement.classList.add("expenses-modal-open");
    document.body.classList.add("expenses-modal-open");
  }

  expenseModalLockCount += 1;
}

function unlockExpenseBackgroundScroll() {
  const shell = document.getElementById("scroll-shell");

  expenseModalLockCount = Math.max(0, expenseModalLockCount - 1);

  if (expenseModalLockCount === 0) {
    if (shell) {
      shell.style.overflowY = shell.dataset.expensePreviousOverflowY || "auto";
      shell.style.overscrollBehavior = shell.dataset.expensePreviousOverscroll || "";
      shell.scrollTop = expenseModalLockedScrollTop;
      delete shell.dataset.expensePreviousOverflowY;
      delete shell.dataset.expensePreviousOverscroll;
    }

    document.documentElement.classList.remove("expenses-modal-open");
    document.body.classList.remove("expenses-modal-open");
  }
}

function harmonizeExpenseSheetActions(modal) {
  if (!modal || modal.dataset.actionHarmonyReady === "true") return;
  modal.dataset.actionHarmonyReady = "true";

  const card = modal.querySelector(":scope > .modal-card");
  const footer = card?.querySelector(":scope > .modal-footer-actions, :scope > form > .modal-footer-actions");
  if (!card || !footer) return;

  const moveToFooter = (id) => {
    const button = card.querySelector(`#${id}`);
    if (button && button.parentElement !== footer) footer.prepend(button);
    return button;
  };
  const mark = (id, kind) => {
    const button = card.querySelector(`#${id}`);
    if (!button) return;
    button.classList.remove("expense-sheet-action-primary", "expense-sheet-action-secondary", "expense-sheet-action-danger");
    button.classList.add(`expense-sheet-action-${kind}`);
  };

  if (modal.id === "backupSettingsModal") {
    moveToFooter("exportExcelReportBtn");
    moveToFooter("exportJsonBackupBtn");
    footer.classList.add("expense-action-stack");
    mark("exportJsonBackupBtn", "secondary");
    mark("exportExcelReportBtn", "secondary");
    card.querySelectorAll(".backup-actions:empty").forEach(node => node.remove());
  }

  if (modal.id === "lockSettingsModal") {
    moveToFooter("unlockTripBtn");
    moveToFooter("lockTripBtn");
    mark("lockTripBtn", "danger");
    mark("unlockTripBtn", "primary");
    card.querySelectorAll(".form-actions:empty").forEach(node => node.remove());
  }

  mark("submitBtn", "primary");
  mark("closeExpenseFormModalBtn", "secondary");
  mark("cancelEditBtn", "secondary");
  mark("ocrScanBtn", "primary");
  mark("saveRatesBtn", "primary");
  mark("confirmAiFillBtn", "primary");
}

function prepareExpenseModal(modal) {
  if (!modal || modal.dataset.presentationReady === "true") return;
  modal.dataset.presentationReady = "true";
  const card = modal.querySelector(":scope > .modal-card");
  const heading = card?.querySelector(":scope > .modal-heading-row");
  const presentation = modal.dataset.presentation || (modal.classList.contains("expense-presentation-push") ? "push" : "sheet");

  if (presentation === "sheet") {
    harmonizeExpenseSheetActions(modal);
    if (card && !card.querySelector(":scope > .expense-sheet-grabber-zone")) {
      const grabber = document.createElement("div");
      grabber.className = "expense-sheet-grabber-zone";
      grabber.setAttribute("aria-hidden", "true");
      grabber.innerHTML = '<span class="expense-sheet-grabber"></span>';
      card.prepend(grabber);
    }
    if (heading && modal.id !== "expenseFormModal" && !heading.querySelector(".expense-sheet-close")) {
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "expense-sheet-close";
      closeButton.setAttribute("aria-label", "關閉");
      closeButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.2 5.2l9.6 9.6M14.8 5.2l-9.6 9.6"/></svg>';
      closeButton.addEventListener("click", () => closeExpenseModal(modal));
      heading.appendChild(closeButton);
    }
    setupExpenseSheetDrag(modal);
  } else {
    if (heading && !heading.querySelector(".expense-nav-back")) {
      const backButton = document.createElement("button");
      backButton.type = "button";
      backButton.className = "expense-nav-back";
      const backLabel = modal.dataset.backLabel || (modal.id === "expenseSettingsPage" ? "支出" : "設定");
      backButton.innerHTML = `<svg viewBox="0 0 18 28" aria-hidden="true"><path d="M15 2L3 14l12 12"/></svg><span>${backLabel}</span>`;
      backButton.addEventListener("click", () => closeExpenseModal(modal));
      heading.prepend(backButton);
    }
  }
}

function configureExpensePresentations() {
  document.querySelectorAll(".expenses-module .modal").forEach(prepareExpenseModal);
}

function openExpenseModal(modal) {
  if (!modal || !modal.classList.contains("hidden")) return;
  prepareExpenseModal(modal);
  lockExpenseBackgroundScroll();
  if (modal._expenseCloseTimer) {
    clearTimeout(modal._expenseCloseTimer);
    modal._expenseCloseTimer = null;
  }
  modal.classList.remove("hidden", "is-closing");
  modal.style.removeProperty("--expense-sheet-y");
  modal.style.removeProperty("--expense-backdrop-progress");
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add("is-open")));
}

function closeExpenseModal(modal, { immediate = false, fromGesture = false } = {}) {
  if (!modal || modal.classList.contains("hidden") || modal.classList.contains("is-closing")) return;
  modal.classList.add("is-closing");
  modal.classList.remove("is-open", "is-dragging");
  if (!fromGesture) {
    modal.style.removeProperty("--expense-sheet-y");
    modal.style.removeProperty("--expense-backdrop-progress");
  }
  const finish = () => {
    modal.classList.add("hidden");
    modal.classList.remove("is-closing");
    modal.style.removeProperty("--expense-sheet-y");
    modal.style.removeProperty("--expense-backdrop-progress");
    unlockExpenseBackgroundScroll();
  };
  if (immediate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  modal._expenseCloseTimer = window.setTimeout(() => {
    modal._expenseCloseTimer = null;
    finish();
  }, modal.dataset.presentation === "push" ? 330 : 300);
}

function setupExpenseSheetDrag(modal) {
  if (!modal || modal.dataset.dragReady === "true") return;
  modal.dataset.dragReady = "true";
  const card = modal.querySelector(":scope > .modal-card");
  const grabber = card?.querySelector(":scope > .expense-sheet-grabber-zone");
  const body = card?.querySelector(".modal-body-scroll");
  if (!card || !grabber) return;

  let startY = 0;
  let lastY = 0;
  let startAt = 0;
  let pointerId = null;
  let dragging = false;

  const begin = (event) => {
    const point = event.touches?.[0] || event;
    const startedOnGrabber = grabber.contains(event.target);
    const bodyAtTop = !body || body.scrollTop <= 0;
    if (!startedOnGrabber && !bodyAtTop) return;
    startY = lastY = point.clientY;
    startAt = performance.now();
    pointerId = event.pointerId ?? null;
    dragging = false;
    activeExpenseDrag = modal;
    if (pointerId != null && card.setPointerCapture) {
      try { card.setPointerCapture(pointerId); } catch (_) {}
    }
  };

  const move = (event) => {
    if (activeExpenseDrag !== modal || !startAt) return;
    const point = event.touches?.[0] || event;
    const dy = Math.max(0, point.clientY - startY);
    if (!dragging && dy < 4) return;
    dragging = true;
    lastY = point.clientY;
    modal.classList.add("is-dragging");
    const resisted = dy <= 220 ? dy : 220 + (dy - 220) * 0.32;
    const progress = Math.min(1, resisted / Math.max(260, card.offsetHeight * 0.55));
    modal.style.setProperty("--expense-sheet-y", `${resisted}px`);
    modal.style.setProperty("--expense-backdrop-progress", String(1 - progress * 0.82));
    if (event.cancelable) event.preventDefault();
  };

  const end = (event) => {
    if (activeExpenseDrag !== modal || !startAt) return;
    const elapsed = Math.max(1, performance.now() - startAt);
    const dy = Math.max(0, lastY - startY);
    const velocity = dy / elapsed;
    const shouldClose = dragging && (dy > Math.min(150, card.offsetHeight * 0.28) || velocity > 0.62);
    activeExpenseDrag = null;
    startAt = 0;
    pointerId = null;
    if (shouldClose) {
      modal.style.setProperty("--expense-sheet-y", `${Math.max(dy, card.offsetHeight + 60)}px`);
      modal.style.setProperty("--expense-backdrop-progress", "0");
      closeExpenseModal(modal, { fromGesture: true });
    } else {
      modal.classList.remove("is-dragging");
      modal.style.removeProperty("--expense-sheet-y");
      modal.style.removeProperty("--expense-backdrop-progress");
    }
  };

  card.addEventListener("pointerdown", begin, { passive: true });
  card.addEventListener("pointermove", move, { passive: false });
  card.addEventListener("pointerup", end, { passive: true });
  card.addEventListener("pointercancel", end, { passive: true });
  grabber.addEventListener("touchstart", begin, { passive: true });
  grabber.addEventListener("touchmove", move, { passive: false });
  grabber.addEventListener("touchend", end, { passive: true });
}

function openExpenseFormModal(title = "完整新增支出") {
  if (expenseFormModalTitle) expenseFormModalTitle.textContent = title;
  openExpenseModal(expenseFormModal);
  setTimeout(() => titleInput?.focus(), 80);
}

function closeExpenseFormModal() {
  closeExpenseModal(expenseFormModal);
}

function openOcrEntryModal() {
  if (!assertTripOpen()) return;
  openExpenseModal(ocrEntryModal);
}

function closeOcrEntryModal() {
  closeExpenseModal(ocrEntryModal);
}

function openSettlementActionModal() {
  openExpenseModal(settlementActionModal);
}

function closeSettlementActionModal() {
  closeExpenseModal(settlementActionModal);
}

function showExpenseSettingsInline() {
  if (!expensePrimaryContent || !expenseSettingsInline) return;
  expensePrimaryContent.classList.add("hidden");
  expenseSettingsInline.classList.remove("hidden");
  const shell = document.getElementById("scroll-shell");
  if (shell) shell.scrollTo({ top: 0, behavior: "smooth" });
}

function hideExpenseSettingsInline() {
  if (!expensePrimaryContent || !expenseSettingsInline) return;
  expenseSettingsInline.classList.add("hidden");
  expensePrimaryContent.classList.remove("hidden");
  const shell = document.getElementById("scroll-shell");
  if (shell) shell.scrollTo({ top: 0, behavior: "smooth" });
}

function getSettingModalId(key) {
  return {
    account: "accountSettingsModal",
    members: "membersSettingsModal",
    rates: "ratesSettingsModal",
    backup: "backupSettingsModal",
    access: "accessSettingsModal",
    lock: "lockSettingsModal",
    deleted: "deletedItemsModal",
    logs: "activityLogModal",
    about: "aboutAppModal"
  }[key];
}

function openSettingModal(key) {
  if (key === "root") {
    showExpenseSettingsInline();
    return;
  }
  const id = getSettingModalId(key);
  if (!id) return;
  if (key === "deleted") renderDeletedExpenses();
  if (key === "logs") renderActivityLogs();
  openExpenseModal(document.getElementById(id));
}

function assignExpensePresentationMetadata() {
  const largeSheetIds = [
    "expenseFormModal",
    "ocrPreviewModal",
    "ratesSettingsModal",
    "membersSettingsModal",
    "accessSettingsModal",
    "deletedItemsModal",
    "activityLogModal"
  ];
  document.querySelectorAll(".expenses-module .modal").forEach(modal => {
    modal.dataset.presentation = "sheet";
    modal.classList.remove("expense-presentation-push");
    modal.classList.add("expense-presentation-sheet");
    modal.dataset.sheetSize = largeSheetIds.includes(modal.id) ? "large" : (modal.dataset.sheetSize || "medium");
  });
}

function closeAllOpenModals() {
  document.querySelectorAll(".expenses-module .modal").forEach(modal => {
    if (!modal.classList.contains("hidden")) closeExpenseModal(modal);
  });
}

function getExpenseById(expenseId) {
  return allExpenses.find(item => item.id === expenseId) || expenses.find(item => item.id === expenseId);
}


function activateExpensesTab(tabName) {
  activeExpensesTab = tabName || "add";
  const tabs = Array.from(document.querySelectorAll('.expenses-module [data-expenses-tab]'));
  const panels = Array.from(document.querySelectorAll('.expenses-module [data-expenses-panel]'));
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.expensesTab === tabName));
  panels.forEach(panel => panel.classList.toggle('active', panel.dataset.expensesPanel === tabName));

  if (tabName === 'analytics') renderAnalytics();
  if (tabName === 'settlement') renderSummary();
  if (tabName === 'details') renderExpenses();
}

function setupExpenseInnerTabs() {
  const tabs = Array.from(document.querySelectorAll('.expenses-module [data-expenses-tab]'));
  tabs.forEach(tab => {
    tab.addEventListener('click', () => activateExpensesTab(tab.dataset.expensesTab));
  });
}

function setAuthUI(user) {
  if (user) {
    googleSignInBtn.classList.add("hidden");
    signOutBtn.classList.remove("hidden");
    authUserText.textContent = `已登入：${user.email || user.displayName || user.uid}`;
  } else {
    googleSignInBtn.classList.remove("hidden");
    signOutBtn.classList.add("hidden");
    authUserText.textContent = "未登入";
  }
  setModuleStatus(lastModuleStatus);
}

async function handleGoogleSignIn() {
  try {
    await signInWithGoogle();
  } catch (error) {
    console.error("Google login error:", error?.code, error?.message, error);
    if (error?.code !== "auth/popup-closed-by-user") {
      alert(`Google 登入失敗：${error?.code || "unknown"}`);
    }
  }
}

async function handleSignOut() {
  try {
    await signOutCurrentUser();
  } catch (error) {
    console.error(error);
    alert("登出失敗。");
  }
}

function renderMemberManager() {
  const canManage = isAdmin();
  memberList.innerHTML = members.map(member => `
    <div class="member-chip">
      <span>${safeEscape(member)}</span>
      <button type="button" data-remove-member="${safeEscape(member)}" ${canManage ? "" : "disabled"}>移除</button>
    </div>
  `).join("");

  memberList.querySelectorAll("[data-remove-member]").forEach(button => {
    button.addEventListener("click", () => removeMember(button.dataset.removeMember));
  });
}

function normalizeExpenseMembers(value) {
  const result = [], seen = new Set();
  (Array.isArray(value) ? value : []).forEach(row => {
    const member = String(row || "").trim();
    if (!member) return;
    const key = member.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key); result.push(member);
  });
  return result;
}
function expenseMembersEqual(a, b) {
  return JSON.stringify(normalizeExpenseMembers(a)) === JSON.stringify(normalizeExpenseMembers(b));
}
function applyExpenseMembers(nextMembers, { source = "cloud" } = {}) {
  const next = normalizeExpenseMembers(nextMembers);
  if (!next.length) return false;
  const changed = !expenseMembersEqual(next, members);
  expenseMembersSource = source;
  if (!changed) return false;
  members = next;
  initMembers();
  return true;
}
async function writeExpenseMembersCanonical(nextMembers, { targetTripId = tripId, user = currentUser } = {}) {
  const next = normalizeExpenseMembers(nextMembers);
  if (!targetTripId || !user?.uid || !next.length) {
    const error = new Error("Expense members are not ready");
    error.code = "expense-members-invalid";
    throw error;
  }
  const batch = writeBatch(db);
  batch.set(doc(db, "trips", targetTripId), { members: next }, { merge: true });
  batch.set(doc(db, "trips", targetTripId, "settings", "expenses"), {
    defaultMembers: next,
    membersCanonicalVersion: 1,
    updatedAt: serverTimestamp(),
    updatedBy: user.uid
  }, { merge: true });
  await batch.commit();
  expenseMembersSettingsResolved = true;
  expenseMembersSettingsCanonical = true;
  expenseMembersSettingsFallback = [...next];
  expenseMembersCanonicalVersion = 1;
  expenseMembersRootResolved = true;
  expenseMembersRootFallback = [...next];
  expenseMembersSource = "settings/expenses";
  return next;
}
function initMembers() {
  const previousPaidBy = paidByInput?.value || "";
  paidByInput.innerHTML = members.map(member => `<option value="${safeEscape(member)}">${safeEscape(member)}</option>`).join("");
  if (previousPaidBy && members.includes(previousPaidBy)) paidByInput.value = previousPaidBy;

  if (quickPaidByInput) {
    const previousQuickPaidBy = quickPaidByInput.value;
    quickPaidByInput.innerHTML = members.map(member => `<option value="${safeEscape(member)}">${safeEscape(member)}</option>`).join("");
    if (members.includes(previousQuickPaidBy)) quickPaidByInput.value = previousQuickPaidBy;
  }

  sharedByGroup.innerHTML = members.map(member => `
    <label class="checkbox-item">
      <input class="expense-participant-checkbox" type="checkbox" value="${safeEscape(member)}" checked />
      <span class="expense-participant-check" aria-hidden="true"></span>
      <span class="expense-participant-name">${safeEscape(member)}</span>
    </label>
  `).join("");
  renderMemberManager();
  updateCurrencySelectOptions();
  applyQuickPrefs();
}

function renderRateEditor() {
  if (!baseCurrencyInput || !ratesContainer) return;
  updateCurrencySelectOptions();
  baseCurrencyInput.value = tripSettings.baseCurrency || "HKD";

  const currencyOptions = getAllConfiguredCurrencies();
  const active = new Set(getActiveCurrencies());

  if (activeCurrencyGroup) {
    activeCurrencyGroup.innerHTML = currencyOptions.map(code => {
      const isBase = code === tripSettings.baseCurrency;
      const checked = active.has(code) || isBase;
      return `
        <label class="currency-check-chip ${checked ? "is-selected" : ""} ${isBase ? "is-base" : ""}">
          <input type="checkbox" data-active-currency="${safeEscape(code)}" ${checked ? "checked" : ""} ${isBase ? "disabled" : ""}/>
          <span class="analytics-check">✓</span>
          <span>${safeEscape(code)}</span>
          ${isBase ? `<small>base</small>` : ""}
        </label>
      `;
    }).join("");

    activeCurrencyGroup.querySelectorAll("[data-active-currency]").forEach(input => {
      input.addEventListener("change", () => {
        syncCurrencyEditorPreview();
        updateCurrencySelectOptions();
      });
    });
  }

  ratesContainer.innerHTML = currencyOptions.map(code => {
    const value = tripSettings.exchangeRates?.[code] ?? "";
    const disabled = code === tripSettings.baseCurrency ? "disabled" : "";
    const hint = code === tripSettings.baseCurrency ? "(base=1)" : active.has(code) ? "" : "(未使用)";
    return `<label class="rate-row ${active.has(code) ? "is-active-currency" : "is-inactive-currency"}" data-rate-row-code="${safeEscape(code)}"><span data-rate-label>${code} ${hint}</span><input type="number" step="0.0001" min="0" data-rate-code="${safeEscape(code)}" value="${value}" ${disabled}/></label>`;
  }).join("");

  syncCurrencyEditorPreview();
}

async function saveTripSettings() {
  if (!assertTripOpen()) return;
  const newBase = baseCurrencyInput.value;
  const selectedCurrencies = uniqueStrings(Array.from(activeCurrencyGroup?.querySelectorAll("[data-active-currency]:checked") || []).map(input => input.dataset.activeCurrency));
  const nextActiveCurrencies = uniqueStrings([newBase, ...selectedCurrencies]);
  const nextRates = {};
  ratesContainer.querySelectorAll("[data-rate-code]").forEach(input => {
    const code = input.dataset.rateCode;
    const n = Number(input.value);
    if (code === newBase) nextRates[code] = 1;
    else if (Number.isFinite(n) && n > 0) nextRates[code] = n;
  });
  if (!nextRates[newBase]) nextRates[newBase] = 1;
  tripSettings = { ...tripSettings, baseCurrency: newBase, exchangeRates: nextRates, activeCurrencies: nextActiveCurrencies };

  await setDoc(doc(db, "trips", tripId, "settings", "expenses"), { ...tripSettings, updatedAt: serverTimestamp(), updatedBy: currentUser.uid }, { merge: true });
  updateCurrencySelectOptions();
  const refreshResult = await refreshAllExpenseFxAmounts();
  alert(`匯率設定已儲存，已重新換算 ${refreshResult.updated} 筆支出。${refreshResult.skipped ? ` 未能換算 ${refreshResult.skipped} 筆，請檢查匯率。` : ""}`);
  await logActivity("settings_updated", `修改匯率設定，基準貨幣為 ${newBase}，重新換算 ${refreshResult.updated} 筆支出`, "trip", tripId, { baseCurrency: newBase, updatedExpenses: refreshResult.updated, skippedExpenses: refreshResult.skipped });
  renderRateEditor(); updateTripStatusUi(); renderSummary(); renderAnalytics(); renderExpenses();
}

async function ensureTripMembersAndSettings() {
  const bindingTripId = tripId;
  const bindingEpoch = expenseBindingEpoch;
  const stillCurrent = () => bindingEpoch === expenseBindingEpoch && bindingTripId === tripId && !expensesModuleSuspendedForTripSwitch;
  const tripRef = doc(db, "trips", bindingTripId);
  const tripDoc = await getDoc(tripRef);
  if (!stillCurrent()) return false;

  if (!tripDoc.exists()) {
    members = Array.isArray(expensesConfig.defaultMembers) && expensesConfig.defaultMembers.length ? expensesConfig.defaultMembers : [currentUser.displayName || "Me"];
    tripAllowedUids = [currentUser.uid];
    tripCreatorUid = currentUser.uid;
    const myEmail = normalizeEmail(currentUser.email);
    allowedEmailsCache = myEmail ? [myEmail] : [];

    if (!stillCurrent()) return false;
    await setDoc(tripRef, {
      members,
      allowedUids: tripAllowedUids,
      allowedEmails: allowedEmailsCache,
      adminUids: [currentUser.uid],
      adminEmails: myEmail ? [myEmail] : [],
      settings: tripSettings,
      createdAt: serverTimestamp(),
      createdBy: currentUser.uid,
      status: "open"
    }, { merge: true });
    return stillCurrent();
  }

  const data = tripDoc.data();

  // Phase 2B clean schema: role lives in trips/{tripId}/members/{uid}.
  // Expense-specific settings live in trips/{tripId}/settings/expenses.
  // v8.0.12 makes defaultMembers there the single canonical split-member list.
  if (Number(data.schemaVersion) >= 2) {
    expenseMembersSchemaVersion = Number(data.schemaVersion) || 2;
    tripCreatorUid = data.createdBy || null;
    tripAllowedUids = Array.isArray(data.memberUids) ? uniqueStrings(data.memberUids) : [];
    tripAdminUids = [];
    adminEmailsCache = [];
    allowedEmailsCache = [];
    expenseMembersRootResolved = true;
    expenseMembersRootFallback = normalizeExpenseMembers(data.members);
    const portableMembers = normalizeExpenseMembers(expensesConfig.defaultMembers);
    let cloudSettings = {};
    let settingsMembers = [];
    try {
      const settingsSnap = await getDoc(doc(db, "trips", bindingTripId, "settings", "expenses"));
      if (!stillCurrent()) return false;
      expenseMembersSettingsResolved = true;
      if (settingsSnap.exists()) {
        cloudSettings = settingsSnap.data() || {};
        settingsMembers = normalizeExpenseMembers(cloudSettings.defaultMembers);
        expenseMembersSettingsFallback = [...settingsMembers];
        expenseMembersCanonicalVersion = Math.max(0, Number(cloudSettings.membersCanonicalVersion) || 0);
        expenseMembersSettingsCanonical = expenseMembersCanonicalVersion >= 1 && settingsMembers.length > 0;
        tripSettings = {
          ...tripSettings,
          ...cloudSettings,
          exchangeRates: { ...tripSettings.exchangeRates, ...(cloudSettings.exchangeRates || cloudSettings.defaultExchangeRates || {}) }
        };
        if (typeof cloudSettings.expenseLocked === "boolean") applyExpenseLockState(cloudSettings, { explicit:true });
      } else { expenseMembersSettingsCanonical = false; expenseMembersSettingsFallback = []; expenseMembersCanonicalVersion = 0; }
    } catch (error) {
      expenseMembersSettingsResolved = false;
      if (error?.code !== "permission-denied") console.warn("Expense settings read failed", error);
    }

    const role = String(phase2TripRole || window.__appTripAccess?.role || "");
    const canManage = role === "owner" || role === "admin";
    // Upgrade rule: old v8.0.11 member-manager edits were written to Trip root
    // only. Until membersCanonicalVersion=1 exists, preserve that user-edited
    // root list over an older imported settings.defaultMembers value. Once the
    // marker exists, settings/expenses is authoritative across every device.
    const settingsMarkedCanonical = expenseMembersCanonicalVersion >= 1 && settingsMembers.length > 0;
    let chosenMembers = settingsMarkedCanonical ? settingsMembers
      : (expenseMembersRootFallback.length ? expenseMembersRootFallback : (settingsMembers.length ? settingsMembers : portableMembers));
    let source = settingsMarkedCanonical ? "settings/expenses"
      : (expenseMembersRootFallback.length ? "trip-root-legacy" : (settingsMembers.length ? "settings/expenses-legacy" : (portableMembers.length ? "portable-default" : "none")));

    // Only a verified manager may seed a genuinely empty shared list. A second
    // device must never invent [current Google displayName] while cloud state is
    // still hydrating, because that creates device-specific participant lists.
    if (!chosenMembers.length && canManage) {
      const seedName = String(currentUser.displayName || currentUser.email || "Member").trim();
      if (seedName) { chosenMembers = [seedName]; source = "manager-bootstrap"; }
    }
    if (chosenMembers.length) applyExpenseMembers(chosenMembers, { source });

    // Heal old schema-2 divergence only when writes are permitted. Keep both
    // documents synchronized atomically; settings/expenses remains canonical.
    const locked = data.globalLocked === true || cloudSettings.expenseLocked === true;
    const rootMatches = expenseMembersEqual(expenseMembersRootFallback, chosenMembers);
    const settingsMatch = expenseMembersEqual(settingsMembers, chosenMembers);
    if (canManage && expenseMembersSettingsResolved && !locked && chosenMembers.length && (!rootMatches || !settingsMatch || expenseMembersCanonicalVersion < 1)) {
      try {
        await writeExpenseMembersCanonical(chosenMembers, { targetTripId: bindingTripId, user: currentUser });
        if (!stillCurrent()) return false;
      } catch (error) {
        if (error?.code !== "permission-denied") console.warn("Expense member mirror migration", error);
      }
    }
    return stillCurrent();
  }

  if (!stillCurrent()) return false;
  tripAllowedUids = Array.isArray(data.allowedUids) ? uniqueStrings(data.allowedUids) : [];
  tripCreatorUid = data.createdBy || null;
  tripAdminUids = Array.isArray(data.adminUids) ? uniqueStrings(data.adminUids) : [];
  adminEmailsCache = Array.isArray(data.adminEmails) ? data.adminEmails.map(normalizeEmail).filter(Boolean) : [];
  const allowedEmails = Array.isArray(data.allowedEmails)
    ? data.allowedEmails.map(normalizeEmail).filter(Boolean)
    : [];
  allowedEmailsCache = allowedEmails;

  const myEmail = normalizeEmail(currentUser.email);
  const uidAllowed = tripAllowedUids.includes(currentUser.uid);
  const emailAllowed = !!myEmail && allowedEmails.includes(myEmail);
  const adminEmailAllowed = !!myEmail && adminEmailsCache.includes(myEmail);
  const isCreator = data.createdBy === currentUser.uid;

  if (isCreator) {
    const migrate = {};
    if (!data.status) migrate.status = "open";
    if (!Array.isArray(data.adminUids)) {
      migrate.adminUids = uniqueStrings([currentUser.uid, ...tripAdminUids]);
      tripAdminUids = migrate.adminUids;
    }
    if (!Array.isArray(data.adminEmails)) {
      migrate.adminEmails = myEmail ? uniqueStrings([myEmail, ...adminEmailsCache]) : adminEmailsCache;
      adminEmailsCache = migrate.adminEmails || [];
    }
    if (Object.keys(migrate).length) {
      if (!stillCurrent()) return false;
      await setDoc(tripRef, migrate, { merge: true });
      if (!stillCurrent()) return false;
    }
  }

  // 自動 claim：email 已白名單 or 係 trip 創建者 -> 自動加 uid
  if (!uidAllowed && (emailAllowed || adminEmailAllowed || isCreator)) {
    const nextUids = uniqueStrings([...tripAllowedUids, currentUser.uid]);
    const updateData = { allowedUids: nextUids };
    if (adminEmailAllowed || isCreator) {
      updateData.adminUids = uniqueStrings([...tripAdminUids, currentUser.uid]);
    }
    if (!stillCurrent()) return false;
    await setDoc(tripRef, updateData, { merge: true });
    if (!stillCurrent()) return false;
    tripAllowedUids = nextUids;
    if (updateData.adminUids) tripAdminUids = updateData.adminUids;
  }

  // 最終判斷
  if (!tripAllowedUids.includes(currentUser.uid)) {
    throw Object.assign(new Error("not_allowed"), { code: "permission-denied" });
  }

  members = Array.isArray(data.members) && data.members.length > 0 ? data.members : [currentUser.displayName || "Me"];
  if (!Array.isArray(data.members) || data.members.length === 0) {
    if (!stillCurrent()) return false;
    await setDoc(tripRef, { members }, { merge: true });
    if (!stillCurrent()) return false;
  }

  if (data.settings) {
    tripSettings = {
      ...tripSettings,
      ...data.settings,
      exchangeRates: { ...tripSettings.exchangeRates, ...(data.settings.exchangeRates || {}) }
    };
  } else {
    if (!stillCurrent()) return false;
    await setDoc(tripRef, { settings: tripSettings }, { merge: true });
    if (!stillCurrent()) return false;
  }
  return stillCurrent();
}

function startExpenseSettingsListener() {
  if (stopExpenseSettingsListener) stopExpenseSettingsListener();
  const bindingEpoch = expenseBindingEpoch;
  const ref = doc(db, "trips", tripId, "settings", "expenses");
  stopExpenseSettingsListener = onSnapshot(ref, { includeMetadataChanges:true }, snap => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    expenseSettingsLiveReady = true;
    updateBackupSyncMeta("settings", snap);
    const data = snap.exists() ? snapshotDataWithServerEstimate(snap) : {};
    const signature = semanticRecordSignature(data, ["updatedAt", "updatedBy"]);
    if (signature === lastExpenseSettingsSignature) return;
    lastExpenseSettingsSignature = signature;
    if (typeof data.expenseLocked === "boolean") applyExpenseLockState(data, { explicit:true });
    else applyExpenseLockState({}, { explicit:false });
    expenseMembersSettingsResolved = true;
    if (snap.exists()) {
      const settingsMembers = normalizeExpenseMembers(data.defaultMembers);
      expenseMembersSettingsFallback = [...settingsMembers];
      expenseMembersCanonicalVersion = Math.max(0, Number(data.membersCanonicalVersion) || 0);
      expenseMembersSettingsCanonical = expenseMembersCanonicalVersion >= 1 && settingsMembers.length > 0;
      if (expenseMembersSettingsCanonical) applyExpenseMembers(settingsMembers, { source:"settings/expenses" });
      else if (expenseMembersSchemaVersion < 2 && settingsMembers.length) applyExpenseMembers(settingsMembers, { source:"settings/expenses-legacy" });
      else if (expenseMembersRootResolved) {
        if (expenseMembersRootFallback.length) applyExpenseMembers(expenseMembersRootFallback, { source:"trip-root-legacy" });
        else if (settingsMembers.length) applyExpenseMembers(settingsMembers, { source:"settings/expenses-legacy" });
      }
      tripSettings = {
        ...tripSettings,
        ...data,
        exchangeRates: { ...tripSettings.exchangeRates, ...(data.exchangeRates || data.defaultExchangeRates || {}) }
      };
      updateCurrencySelectOptions();
      renderRateEditor();
      renderExpenses();
      renderActiveExpensePanel();
    } else {
      expenseMembersSettingsCanonical = false;
      expenseMembersSettingsFallback = [];
      expenseMembersCanonicalVersion = 0;
      if (expenseMembersSchemaVersion >= 2 && expenseMembersRootResolved && expenseMembersRootFallback.length) applyExpenseMembers(expenseMembersRootFallback, { source:"trip-root-legacy" });
    }
  }, error => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    expenseMembersSettingsResolved = false;
    markExpenseFreshnessUnavailable("settings");
    if (error?.code !== "permission-denied") {
      scheduleExpenseRealtimeRetry(bindingEpoch);
      console.warn("Expense settings listener", error);
    }
  });
}

function startTripListener() {
  if (stopTripListener) stopTripListener();
  const bindingEpoch = expenseBindingEpoch;

  stopTripListener = onSnapshot(getTripDocRef(), snap => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    if (!snap.exists()) return;
    const data = snap.data();

    globalTripLocked = data.globalLocked === true;
    legacyExpenseLock = {
      locked: data.status === "locked",
      lockedAt: data.lockedAt || null,
      lockedBy: data.lockedBy || null,
      lockedByName: data.lockedByName || ""
    };
    if (!expenseLockExplicit) applyExpenseLockState({}, { explicit:false });
    else updateTripStatusUi();

    expenseMembersSchemaVersion = Number(data.schemaVersion) || expenseMembersSchemaVersion || 1;
    expenseMembersRootResolved = true;
    expenseMembersRootFallback = normalizeExpenseMembers(data.members);
    if (expenseMembersSchemaVersion < 2) {
      if (expenseMembersRootFallback.length) applyExpenseMembers(expenseMembersRootFallback, { source:"trip-root-legacy" });
    } else if (expenseMembersSettingsResolved && !expenseMembersSettingsCanonical) {
      // Before the v8.0.12 canonical marker exists, Trip-root members preserves
      // user edits made by older clients. If root is empty, fall back to the
      // legacy settings value only after both sources have resolved.
      if (expenseMembersRootFallback.length) applyExpenseMembers(expenseMembersRootFallback, { source:"trip-root-legacy" });
      else if (expenseMembersSettingsFallback.length) applyExpenseMembers(expenseMembersSettingsFallback, { source:"settings/expenses-legacy" });
    }

    if (Array.isArray(data.allowedUids)) tripAllowedUids = uniqueStrings(data.allowedUids);
    if (Array.isArray(data.adminUids)) tripAdminUids = uniqueStrings(data.adminUids);
    if (Array.isArray(data.adminEmails)) adminEmailsCache = data.adminEmails.map(normalizeEmail).filter(Boolean);
    if (data.createdBy) tripCreatorUid = data.createdBy;
    if (Array.isArray(data.allowedEmails)) {
      allowedEmailsCache = data.allowedEmails.map(normalizeEmail).filter(Boolean);
      renderAllowedEmails();
      renderAdminEmails();
      updateTripStatusUi();
    }

    if (data.settings) {
      const legacySettingsSignature = semanticRecordSignature(data.settings, ["updatedAt", "updatedBy"]);
      if (legacySettingsSignature !== lastLegacyTripSettingsSignature) {
        lastLegacyTripSettingsSignature = legacySettingsSignature;
        tripSettings = {
          ...tripSettings,
          ...data.settings,
          exchangeRates: { ...tripSettings.exchangeRates, ...(data.settings.exchangeRates || {}) }
        };
        updateCurrencySelectOptions();
        renderRateEditor();
        updateTripStatusUi();
        renderExpenses();
        renderActiveExpensePanel();
      }
    }
  }, err => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    console.error(err);
    if (err?.code === "permission-denied") {
      tripStatus = "unknown";
      setModuleStatus("Waiting for Firestore Rules");
    }
  });
}

function setRecentExpensesPending(pending) {
  if (!recentExpenseList) return;
  recentExpenseList.classList.toggle("is-pending", Boolean(pending));
  recentExpenseList.setAttribute("aria-busy", pending ? "true" : "false");
}

function renderWarmRecentExpenseRows(list) {
  if (!recentExpenseList || recentExpensesLiveReady || !Array.isArray(list) || !list.length) return;
  const base = tripSettings.baseCurrency || "HKD";
  const rows = sortExpensesForDisplay(list).filter(item => item?.isDeleted !== true).slice(0, 5);
  if (!rows.length) return;

  recentExpenseList.innerHTML = rows.map(expense => {
    const originalAmount = Number(expense.originalAmount ?? expense.amount ?? 0);
    const originalCurrency = expense.originalCurrency ?? expense.currency ?? base;
    const convertedAmount = Number(expense.convertedAmount ?? convertToBase(originalAmount, originalCurrency) ?? 0);
    const splitLabel = getSplitMethodLabel(expense.splitMethod || "equal");
    return `
      <div class="expense-list-row recent-expense-warm-row" data-category="${safeEscape(expense.category || 'Other')}">
        <span class="expense-row-main">
          <strong>${safeEscape(expense.title)}</strong>
          <small>${safeEscape(expense.date)} · ${safeEscape(expense.category || "Other")} · Paid by ${safeEscape(expense.paidBy || "-")}</small>
        </span>
        <span class="expense-row-side">
          <strong>${safeEscape(originalCurrency)} ${originalAmount.toFixed(2)}</strong>
          <small>${safeEscape(base)} ${convertedAmount.toFixed(2)}</small>
        </span>
        <span class="expense-row-badge">${safeEscape(splitLabel)}</span>
      </div>`;
  }).join("");
  recentExpenseList.classList.add("is-warm-cache");
  setRecentExpensesPending(true);
}

async function hydrateRecentExpensesFromLocalFirestoreCache() {
  if (recentExpenseCacheHydrationStarted || recentExpensesLiveReady || !currentUser || !phase2TripRole) return;
  recentExpenseCacheHydrationStarted = true;
  try {
    const q = query(getExpensesCollection(), orderBy("date", "desc"), limit(5));
    const snap = await getDocsFromCache(q);
    if (recentExpensesLiveReady) return;
    const cachedRows = snap.docs.map(d => ({ id: d.id, ...snapshotDataWithServerEstimate(d) }));
    renderWarmRecentExpenseRows(cachedRows);
  } catch (error) {
    // Cache-only hydration is best-effort. The live listener below remains the source of truth.
  }
}

function listenToExpenses() {
  if (stopExpensesListener) stopExpensesListener();
  const bindingEpoch = expenseBindingEpoch;
  const q = query(getExpensesCollection(), orderBy("date", "desc"));
  stopExpensesListener = onSnapshot(q, { includeMetadataChanges:true }, snap => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    recentExpensesLiveReady = true;
    updateBackupSyncMeta("expenses", snap);
    if (recentExpenseList) recentExpenseList.classList.remove("is-warm-cache");
    setRecentExpensesPending(false);

    // Use the local estimate for pending serverTimestamp() values. Firestore
    // listeners then place a newly-created Quick Add row correctly on the
    // first latency-compensated snapshot instead of waiting for server ACK.
    const nextAllExpenses = sortExpensesForDisplay(
      snap.docs.map(d => ({ id: d.id, ...snapshotDataWithServerEstimate(d) }))
    );
    const nextSignature = expenseRenderSignature(nextAllExpenses);
    const meaningfulContentChanged = nextSignature !== lastExpenseRenderSignature;

    // Keep the in-memory objects fresh even on an ACK-only timestamp change,
    // but avoid rebuilding visible DOM when the semantic expense content did
    // not change. Metadata freshness still updates above for Backup gating.
    allExpenses = nextAllExpenses;
    expenses = getActiveExpenses();
    if (meaningfulContentChanged) {
      lastExpenseRenderSignature = nextSignature;
      renderExpenses();
      renderActiveExpensePanel();
      if (expenseModalVisible("deletedItemsModal")) renderDeletedExpenses();
    }
    setModuleStatus(`Synced (${tripId})`);
    tryRunPendingExcelExport();
  }, err => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    markExpenseFreshnessUnavailable("expenses");
    if (err?.code !== "permission-denied") scheduleExpenseRealtimeRetry(bindingEpoch);
    console.error(err);
    setModuleStatus(err?.code === "permission-denied" ? "No access to expenses" : "Sync error");
  });
}

function listenToSettlements() {
  if (stopSettlementsListener) stopSettlementsListener();
  const bindingEpoch = expenseBindingEpoch;
  const q = query(getSettlementsCollection(), orderBy("paidAt", "desc"));
  stopSettlementsListener = onSnapshot(q, { includeMetadataChanges:true }, snap => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    settlementsLiveReady = true;
    updateBackupSyncMeta("settlements", snap);
    settlements = snap.docs.map(d => ({ id: d.id, ...snapshotDataWithServerEstimate(d) }));
    const settlementSignature = semanticRecordSignature(
      [...settlements].sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || ""))),
      ["paidAt"]
    );
    if (settlementSignature !== lastSettlementRenderSignature) {
      lastSettlementRenderSignature = settlementSignature;
      if(activeExpensesTab === "settlement") renderSummary();
      if(activeExpensesTab === "analytics") renderAnalytics();
    }
    tryRunPendingExcelExport();
  }, err => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    markExpenseFreshnessUnavailable("settlements");
    if (err?.code !== "permission-denied") scheduleExpenseRealtimeRetry(bindingEpoch);
    console.error(err);
    setModuleStatus(err?.code === "permission-denied" ? "No access to settlements" : "Settlement sync error");
  });
}

function listenToActivityLogs() {
  if (stopActivityLogsListener) stopActivityLogsListener();
  const bindingEpoch = expenseBindingEpoch;
  const q = query(getActivityLogsCollection(), orderBy("createdAt", "desc"));
  stopActivityLogsListener = onSnapshot(q, { includeMetadataChanges:true }, snap => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    activityLogsLiveReady = true;
    updateBackupSyncMeta("activityLogs", snap);
    activityLogs = snap.docs.map(d => ({ id: d.id, ...snapshotDataWithServerEstimate(d) }));
    const activitySignature = semanticRecordSignature(
      [...activityLogs].sort((a, b) => String(a?.id || "").localeCompare(String(b?.id || ""))),
      ["createdAt"]
    );
    if (activitySignature !== lastActivityLogRenderSignature) {
      lastActivityLogRenderSignature = activitySignature;
      if(expenseModalVisible("activityLogModal")) renderActivityLogs();
    }
    tryRunPendingExcelExport();
  }, err => {
    if (bindingEpoch !== expenseBindingEpoch) return;
    markExpenseFreshnessUnavailable("activityLogs");
    if (err?.code !== "permission-denied") scheduleExpenseRealtimeRetry(bindingEpoch);
    console.error(err);
    setModuleStatus(err?.code === "permission-denied" ? "No access to activity logs" : "Activity log sync error");
  });
}


function resetExpenseForm() {
  form.reset(); setToday();
  Array.from(sharedByGroup.querySelectorAll("input")).forEach(i => i.checked = true);
  editingExpenseId = null;
  if (splitMethodInput) splitMethodInput.value = "equal";
  renderSplitConfig();
  submitBtn.textContent = "新增";
  cancelEditBtn.classList.add("hidden");
  document.getElementById("editingNotice")?.remove();
}

function enterEditMode(expenseId) {
  if (!assertTripOpen()) return;
  const expense = expenses.find(item => item.id === expenseId);
  if (!expense) return alert("搵唔到呢筆支出。");
  activateExpensesTab("add");
  openExpenseFormModal("編輯支出");
  editingExpenseId = expense.id;
  dateInput.value = expense.date || "";
  titleInput.value = expense.title || "";
  amountInput.value = expense.originalAmount || expense.amount || "";
  currencyInput.value = expense.originalCurrency || expense.currency || "HKD";
  paidByInput.value = expense.paidBy || members[0];
  categoryInput.value = expense.category || "Other";
  noteInput.value = expense.note || "";

  const splitMembers = Array.isArray(expense.splits) && expense.splits.length
    ? expense.splits.map(row => row.member)
    : (Array.isArray(expense.sharedBy) ? expense.sharedBy : []);

  Array.from(sharedByGroup.querySelectorAll("input")).forEach(input => {
    input.checked = splitMembers.includes(input.value);
  });

  if (splitMethodInput) {
    splitMethodInput.value = expense.splitMethod || "equal";
    renderSplitConfig();

    if (Array.isArray(expense.splits)) {
      expense.splits.forEach(row => {
        const input = splitConfig?.querySelector(`[data-split-member="${CSS.escape(row.member)}"]`);
        if (!input) return;
        if (splitMethodInput.value === "amount") input.value = Number(row.originalAmount ?? 0).toFixed(2);
        if (splitMethodInput.value === "percentage") input.value = Number(row.percentage ?? 0).toFixed(2);
      });
    }
  }

  submitBtn.textContent = "儲存修改";
  cancelEditBtn.classList.add("hidden");
  document.getElementById("editingNotice")?.remove();

  const notice = document.createElement("div");
  notice.id = "editingNotice";
  notice.className = "editing-notice";
  notice.textContent = `正在編輯：${expense.title}`;
  form.prepend(notice);
  setTimeout(() => { titleInput?.focus(); }, 80);
}


function releaseQuickAddKeyboardFocus() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !quickAddCard?.contains(active)) return;
  const isEditable = active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active instanceof HTMLSelectElement
    || active.isContentEditable;
  if (!isEditable) return;
  active.blur();
}

async function saveQuickExpense() {
  if (quickAddTapGuard) return;
  if (!currentUser) return alert("請先登入。");
  if (!assertTripOpen()) return;

  if (!members.length) return alert("請先新增至少一位成員。");

  const originalAmount = Number(quickAmountInput?.value);
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) {
    return alert("請輸入有效金額。");
  }

  const originalCurrency = quickCurrencyInput?.value || tripSettings.baseCurrency || "HKD";
  const convertedAmount = convertToBase(originalAmount, originalCurrency);
  if (convertedAmount === null) return alert(`未有 ${originalCurrency} 匯率。`);

  const displayName = getCurrentUserDisplayName();
  const category = quickCategoryInput?.value || "Other";
  const title = quickTitleInput?.value.trim() || category;
  const paidBy = quickPaidByInput?.value || members[0];
  const participants = [...members];

  const quickSplitRows = allocateRoundingDifference(participants.map(member => ({
    member,
    amount: convertedAmount / participants.length,
    originalAmount: originalAmount / participants.length,
    percentage: round2(100 / participants.length)
  })), convertedAmount);
  const quickOriginalRows = allocateRoundingDifference(participants.map(member => ({
    member,
    amount: originalAmount / participants.length
  })), originalAmount);
  const quickSplits = quickSplitRows.map((row, index) => ({
    member: row.member,
    amount: row.amount,
    originalAmount: quickOriginalRows[index].amount,
    percentage: participants.length ? round2(row.amount / convertedAmount * 100) : 0
  }));

  const payload = {
    date: localDateISO(),
    title,
    amount: originalAmount,
    currency: originalCurrency,
    originalAmount,
    originalCurrency,
    convertedAmount,
    baseCurrency: tripSettings.baseCurrency,
    fxRateUsed: getRateFor(originalCurrency),
    paidBy,
    sharedBy: participants,
    splitMethod: "equal",
    splits: quickSplits,
    category,
    note: "Quick Add",
    updatedBy: currentUser.uid,
    updatedByName: displayName,
    updatedAt: serverTimestamp(),
    isDeleted: false,
    createdBy: currentUser.uid,
    createdByName: displayName,
    createdAt: serverTimestamp()
  };

  const pendingTitle = quickTitleInput?.value ?? "";
  const pendingAmount = quickAmountInput?.value ?? "";

  try {
    saveQuickPrefs();
  } catch (error) {
    console.warn("Quick Add preferences save failed:", error);
  }

  // Quick Add is an optimistic interaction. Lock only the physical tap handoff,
  // clear the consumed draft synchronously, then let Firebase complete in the
  // background. Network latency must not block entry of the next expense.
  setQuickAddTapGuard(true);
  // iOS may visually dismiss the keyboard after tapping the Quick Add button
  // while keeping the originating input as document.activeElement. The shared
  // keyboard-aware bottom navigation then remains hidden even though no
  // keyboard is visible. Release only Quick Add field focus at the successful
  // handoff so the existing focusout/visualViewport manager restores the bar.
  releaseQuickAddKeyboardFocus();
  if (quickTitleInput) quickTitleInput.value = "";
  if (quickAmountInput) quickAmountInput.value = "";
  if (quickAddHint) quickAddHint.textContent = "已加入。下一筆可直接輸入。";
  releaseQuickAddTapGuardSoon();

  void (async () => {
    try {
      // Pre-allocate both IDs and commit Expense + Activity Log atomically.
      // This removes the old serial addDoc -> logActivity network chain while
      // preserving Firestore latency compensation for both realtime listeners.
      const expenseRef = doc(getExpensesCollection());
      const activityRef = doc(getActivityLogsCollection());
      const activityPayload = buildActivityLogPayload(
        "expense_created",
        `${displayName} 快速新增 ${payload.title} ${payload.originalCurrency} ${payload.originalAmount.toFixed(2)}`,
        "expense",
        expenseRef.id,
        {
          title: payload.title,
          amount: payload.originalAmount,
          currency: payload.originalCurrency,
          quickAdd: true
        }
      );
      const batch = writeBatch(db);
      batch.set(expenseRef, payload);
      if (activityPayload) batch.set(activityRef, activityPayload);
      await batch.commit();
    } catch (error) {
      console.error("Quick Add failed:", error);

      // Do not overwrite a newer draft the user may already be typing. Restore
      // the failed entry only when the Quick Add fields are still untouched.
      const currentTitle = quickTitleInput?.value ?? "";
      const currentAmount = quickAmountInput?.value ?? "";
      const canRestoreFailedDraft = !currentTitle.trim() && !currentAmount.trim();
      if (canRestoreFailedDraft) {
        if (quickTitleInput) quickTitleInput.value = pendingTitle;
        if (quickAmountInput) quickAmountInput.value = pendingAmount;
        if (quickAddHint) quickAddHint.textContent = "上一筆新增失敗，已還原原本資料。";
      } else if (quickAddHint) {
        quickAddHint.textContent = `上一筆「${title}」新增失敗，請稍後重試。`;
      }
      alert(`快速新增「${title}」失敗，請再試。`);
    }
  })();
}

async function saveExpense(event) {
  event.preventDefault();
  if (!currentUser) return alert("請先登入。");
  if (!assertTripOpen()) return;

  const participants = getSelectedParticipants();
  if (participants.length === 0) return alert("請至少選擇一位參與人。");

  const originalAmount = Number(amountInput.value);
  if (!Number.isFinite(originalAmount) || originalAmount <= 0) return alert("請輸入有效金額。");

  const originalCurrency = currencyInput.value;
  const convertedAmount = convertToBase(originalAmount, originalCurrency);
  if (convertedAmount === null) return alert(`未有 ${originalCurrency} 匯率。`);

  const splitResult = validateAndBuildSplits(originalAmount, originalCurrency, convertedAmount);
  if (!splitResult.ok) {
    if (splitValidationMessage) splitValidationMessage.textContent = splitResult.message;
    return alert(splitResult.message);
  }
  if (splitValidationMessage) splitValidationMessage.textContent = "";

  const displayName = getCurrentUserDisplayName();

  const payload = {
    date: dateInput.value,
    title: titleInput.value.trim(),
    amount: originalAmount,
    currency: originalCurrency,
    originalAmount,
    originalCurrency,
    convertedAmount,
    baseCurrency: tripSettings.baseCurrency,
    fxRateUsed: getRateFor(originalCurrency),
    paidBy: paidByInput.value,
    sharedBy: splitResult.sharedBy,
    splitMethod: splitResult.splitMethod,
    splits: splitResult.splits,
    category: categoryInput.value,
    note: noteInput.value.trim(),
    updatedBy: currentUser.uid,
    updatedByName: displayName,
    updatedAt: serverTimestamp()
  };

  if (!payload.title) return alert("請輸入項目名稱。");

  if (editingExpenseId) {
    await updateDoc(doc(db, "trips", tripId, "expenses", editingExpenseId), payload);
    await logActivity("expense_updated", `${displayName} 修改 ${payload.title} ${payload.originalCurrency} ${payload.originalAmount.toFixed(2)}`, "expense", editingExpenseId, {
      title: payload.title,
      amount: payload.originalAmount,
      currency: payload.originalCurrency
    });
  } else {
    const docRef = await addDoc(getExpensesCollection(), {
      ...payload,
      isDeleted: false,
      createdBy: currentUser.uid,
      createdByName: displayName,
      createdAt: serverTimestamp()
    });
    await logActivity("expense_created", `${displayName} 新增 ${payload.title} ${payload.originalCurrency} ${payload.originalAmount.toFixed(2)}`, "expense", docRef.id, {
      title: payload.title,
      amount: payload.originalAmount,
      currency: payload.originalCurrency
    });
  }

  resetExpenseForm();
  closeExpenseFormModal();
}

async function removeExpense(expenseId) {
  if (!assertTripOpen()) return;

  const expense = expenses.find(item => item.id === expenseId);
  const title = expense?.title || "支出";

  if (!confirm(`確定刪除「${title}」？資料會保留在 Deleted Items，可供審計追蹤。`)) return;

  if (editingExpenseId === expenseId) resetExpenseForm();

  await updateDoc(doc(db, "trips", tripId, "expenses", expenseId), {
    isDeleted: true,
    deletedAt: serverTimestamp(),
    deletedBy: currentUser.uid,
    deletedByName: getCurrentUserDisplayName(),
    updatedBy: currentUser.uid,
    updatedByName: getCurrentUserDisplayName(),
    updatedAt: serverTimestamp()
  });

  await logActivity("expense_deleted", `${getCurrentUserDisplayName()} 刪除 ${title}`, "expense", expenseId, {
    title,
    softDelete: true
  });
}

async function restoreExpense(expenseId) {
  if (!assertTripOpen()) return;

  const expense = allExpenses.find(item => item.id === expenseId);
  const title = expense?.title || "支出";

  if (!confirm(`還原「${title}」？`)) return;

  await updateDoc(doc(db, "trips", tripId, "expenses", expenseId), {
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    deletedByName: "",
    updatedBy: currentUser.uid,
    updatedByName: getCurrentUserDisplayName(),
    updatedAt: serverTimestamp()
  });

  await logActivity("expense_restored", `${getCurrentUserDisplayName()} 還原 ${title}`, "expense", expenseId, {
    title
  });
}

async function addMember() {
  if (!assertTripOpen()) return;
  if (!isAdmin()) return alert("只有 Owner 或 Admin 可以管理分帳成員。");
  const name = memberNameInput.value.trim();
  if (!name) return alert("請輸入成員名稱。");
  if (members.some(m => m.toLowerCase() === name.toLowerCase())) return alert("成員名稱已存在。");
  const next = normalizeExpenseMembers([...members, name]);
  await writeExpenseMembersCanonical(next);
  applyExpenseMembers(next, { source:"settings/expenses" }); memberNameInput.value = "";
  await logActivity("member_added", `${getCurrentUserDisplayName()} 新增成員 ${name}`, "member", name, { member: name });
}

async function removeMember(name) {
  if (!assertTripOpen()) return;
  if (!isAdmin()) return alert("只有 Owner 或 Admin 可以管理分帳成員。");
  if (members.length <= 1) return alert("至少要保留一位成員。");
  const used = expenses.some(e => e.paidBy === name || (Array.isArray(e.sharedBy) && e.sharedBy.includes(name)));
  if (used) return alert("此成員已出現在歷史支出，不能移除。");
  const next = members.filter(m => m !== name);
  await writeExpenseMembersCanonical(next);
  applyExpenseMembers(next, { source:"settings/expenses" });
  await logActivity("member_removed", `${getCurrentUserDisplayName()} 移除成員 ${name}`, "member", name, { member: name });
}

function formatAuditUid(uid) {
  if (!uid) return "未知";
  if (currentUser && uid === currentUser.uid) return "你";
  return uid.slice(0, 7) + "…";
}

function formatTimestamp(ts) {
  if (!ts) return "時間未記錄";
  const d = typeof ts.toDate === "function" ? ts.toDate() : new Date(ts);
  if (isNaN(d)) return "時間未記錄";
  return d.toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderExpenseRows(targetEl, list, options = {}) {
  if (!targetEl) return;
  if (!list.length) {
    targetEl.innerHTML = emptyStateHtml("🧾", "暫時未有支出");
    return;
  }

  const base = tripSettings.baseCurrency;
  const rows = options.limit ? list.slice(0, options.limit) : list;

  targetEl.innerHTML = rows.map(expense => {
    const oAmt = Number(expense.originalAmount ?? expense.amount ?? 0);
    const oCur = expense.originalCurrency ?? expense.currency ?? base;
    const cAmt = Number(expense.convertedAmount ?? convertToBase(oAmt, oCur) ?? 0);
    const splitLabel = getSplitMethodLabel(expense.splitMethod || "equal");

    return `
      <button type="button" class="expense-list-row" data-expense-id="${safeEscape(expense.id)}" data-category="${safeEscape(expense.category || 'Other')}">
        <span class="expense-row-main">
          <strong>${safeEscape(expense.title)}</strong>
          <small>${safeEscape(expense.date)} · ${safeEscape(expense.category || "Other")} · Paid by ${safeEscape(expense.paidBy || "-")}</small>
        </span>
        <span class="expense-row-side">
          <strong>${safeEscape(oCur)} ${oAmt.toFixed(2)}</strong>
          <small>${safeEscape(base)} ${cAmt.toFixed(2)}</small>
        </span>
        <span class="expense-row-badge">${safeEscape(splitLabel)}</span>
      </button>
    `;
  }).join("");

  targetEl.querySelectorAll("[data-expense-id]").forEach(row => {
    row.addEventListener("click", () => openExpenseDetail(row.dataset.expenseId));
  });
}

function renderExpenses() {
  // Recent rows and the snapshot are always visible. The full Details list is
  // rebuilt only while that panel is active, avoiding hidden-DOM churn on each
  // Firestore metadata tick.
  renderExpenseRows(recentExpenseList, expenses, { limit: 5 });
  if (activeExpensesTab === "details") renderExpenseRows(expenseList, expenses);
  renderExpenseSnapshot();
  if (recentExpensesLiveReady) setRecentExpensesPending(false);
}
function expenseModalVisible(id){
  const modal=document.getElementById(id);
  return Boolean(modal && !modal.classList.contains("hidden"));
}
function renderActiveExpensePanel(){
  if(activeExpensesTab === "settlement") renderSummary();
  else if(activeExpensesTab === "analytics") renderAnalytics();
}

function openExpenseDetail(expenseId) {
  const expense = getExpenseById(expenseId);
  if (!expense || !expenseDetailContent) return;

  const base = tripSettings.baseCurrency;
  const oAmt = Number(expense.originalAmount ?? expense.amount ?? 0);
  const oCur = expense.originalCurrency ?? expense.currency ?? base;
  const cAmt = Number(expense.convertedAmount ?? convertToBase(oAmt, oCur) ?? 0);
  const shareText = Array.isArray(expense.sharedBy) ? expense.sharedBy.map(safeEscape).join(" / ") : "-";
  const createdName = expense.createdByName || formatAuditUid(expense.createdBy);
  const updatedName = expense.updatedByName || formatAuditUid(expense.updatedBy);
  const splitRows = getExpenseSplitRows(expense, cAmt);
  const splitRowsHtml = splitRows.length
    ? splitRows.map(row => `<div class="detail-split-row"><span>${safeEscape(row.member)}</span><strong>${safeEscape(base)} ${Number(row.amount).toFixed(2)}</strong></div>`).join("")
    : `<p class="neutral">沒有分帳資料</p>`;

  expenseDetailContent.innerHTML = `
    <div class="detail-title-block">
      <h4>${safeEscape(expense.title)}</h4>
      <span class="expense-row-badge">${safeEscape(getSplitMethodLabel(expense.splitMethod || "equal"))}</span>
    </div>

    <div class="detail-grid">
      <div><span>日期</span><strong>${safeEscape(expense.date || "-")}</strong></div>
      <div><span>分類</span><strong>${safeEscape(expense.category || "Other")}</strong></div>
      <div><span>原幣金額</span><strong>${safeEscape(oCur)} ${oAmt.toFixed(2)}</strong></div>
      <div><span>換算金額</span><strong>${safeEscape(base)} ${cAmt.toFixed(2)}</strong></div>
      <div><span>付款人</span><strong>${safeEscape(expense.paidBy || "-")}</strong></div>
      <div><span>參與人</span><strong>${shareText}</strong></div>
    </div>

    <div class="detail-section">
      <h5>分帳明細</h5>
      ${splitRowsHtml}
    </div>

    ${expense.note ? `<div class="detail-section"><h5>備註</h5><p>${safeEscape(expense.note)}</p></div>` : ""}

    <div class="detail-section detail-audit-section">
      <h5>操作資料</h5>
      <p>建立：${safeEscape(createdName)} · ${formatTimestamp(expense.createdAt)}</p>
      <p>更新：${safeEscape(updatedName)} · ${formatTimestamp(expense.updatedAt)}</p>
    </div>

  `;

  if (expenseDetailFooterActions) {
    expenseDetailFooterActions.innerHTML = `
      <button type="button" class="edit-btn expense-sheet-action-secondary" data-detail-edit-id="${safeEscape(expense.id)}" ${isTripLocked() ? "disabled" : ""}>編輯</button>
      <button type="button" class="delete-btn expense-sheet-action-danger" data-detail-delete-id="${safeEscape(expense.id)}" ${isTripLocked() ? "disabled" : ""}>刪除</button>
      <button type="button" class="modal-close-btn" id="closeExpenseDetailModalBtn">關閉</button>
    `;

    expenseDetailFooterActions.querySelector("[data-detail-edit-id]")?.addEventListener("click", () => {
      closeExpenseModal(expenseDetailModal);
      enterEditMode(expense.id);
    });

    expenseDetailFooterActions.querySelector("[data-detail-delete-id]")?.addEventListener("click", async () => {
      closeExpenseModal(expenseDetailModal);
      await removeExpense(expense.id);
    });

    expenseDetailFooterActions.querySelector("#closeExpenseDetailModalBtn")?.addEventListener("click", () => closeExpenseModal(expenseDetailModal));
  }

  openExpenseModal(expenseDetailModal);
}

function renderDeletedExpenses() {
  if (!deletedExpenseList) return;

  const deleted = getDeletedExpenses();

  if (!deleted.length) {
    deletedExpenseList.innerHTML = emptyStateHtml("🗑️", "暫時未有已刪除支出");
    return;
  }

  const base = tripSettings.baseCurrency;

  deletedExpenseList.innerHTML = deleted.map(expense => {
    const oAmt = Number(expense.originalAmount ?? expense.amount ?? 0);
    const oCur = expense.originalCurrency ?? expense.currency ?? base;
    return `
      <div class="expense-list-row deleted-expense-row" data-category="${safeEscape(expense.category || 'Other')}">
        <span class="expense-row-main deleted-expense-main">
          <strong>${safeEscape(expense.title)}</strong>
          <small>${safeEscape(expense.date)} · ${safeEscape(expense.category || "Other")} · Paid by ${safeEscape(expense.paidBy || "-")}</small>
          <small class="deleted-expense-audit">刪除：${safeEscape(expense.deletedByName || formatAuditUid(expense.deletedBy))} · ${formatTimestamp(expense.deletedAt)}</small>
        </span>
        <span class="expense-row-side deleted-expense-side">
          <strong>${safeEscape(oCur)} ${oAmt.toFixed(2)}</strong>
          <button type="button" class="deleted-expense-restore-btn" data-restore-id="${safeEscape(expense.id)}" ${isTripLocked() ? "disabled" : ""}>還原</button>
        </span>
      </div>
    `;
  }).join("");

  deletedExpenseList.querySelectorAll("[data-restore-id]").forEach(btn => {
    btn.addEventListener("click", () => restoreExpense(btn.dataset.restoreId));
  });
}


function buildSettlement(net) {
  const debtors = [], creditors = [];
  Object.entries(net).forEach(([person, amount]) => {
    const r = round2(amount);
    if (r < 0) debtors.push({ person, amount: Math.abs(r) });
    if (r > 0) creditors.push({ person, amount: r });
  });
  const settlement = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amount, creditors[j].amount);
    const rpay = round2(pay);
    if (rpay > 0) settlement.push({ from: debtors[i].person, to: creditors[j].person, amount: rpay });
    debtors[i].amount = round2(debtors[i].amount - pay);
    creditors[j].amount = round2(creditors[j].amount - pay);
    if (debtors[i].amount === 0) i++;
    if (creditors[j].amount === 0) j++;
  }
  return settlement;
}

function calculateExpenseNetOnly() {
  const base = tripSettings.baseCurrency;
  const net = {};
  members.forEach(m => { net[m] = 0; });

  expenses.forEach(expense => {
    const converted = Number(
      expense.convertedAmount ??
      convertToBase(
        expense.originalAmount ?? expense.amount ?? 0,
        expense.originalCurrency ?? expense.currency ?? base
      ) ??
      0
    );

    const splitRows = getExpenseSplitRows(expense, converted);
    if (!splitRows.length) return;

    if (!Object.prototype.hasOwnProperty.call(net, expense.paidBy)) net[expense.paidBy] = 0;
    net[expense.paidBy] += converted;

    splitRows.forEach(row => {
      if (!Object.prototype.hasOwnProperty.call(net, row.member)) net[row.member] = 0;
      net[row.member] -= Number(row.amount);
    });
  });

  Object.keys(net).forEach(person => {
    net[person] = round2(net[person]);
  });

  return { net, currency: base };
}

function calculateSummary() {
  const { net: expenseNet, currency } = calculateExpenseNetOnly();
  const netAfterPayments = applyRecordedPaymentsToNet({ ...expenseNet }, currency, { convertToTarget: true });

  return {
    expenseNet,
    net: netAfterPayments,
    settlement: buildSettlement(netAfterPayments),
    currency,
    recordedPaymentsTotal: getTotalRecordedPayments(currency, { convertToTarget: true })
  };
}

function getExpenseOriginalSplitRows(expense) {
  const originalAmount = Number(expense.originalAmount ?? expense.amount ?? 0);
  const originalCurrency = expense.originalCurrency ?? expense.currency ?? tripSettings.baseCurrency;
  const converted = Number(
    expense.convertedAmount ??
    convertToBase(originalAmount, originalCurrency) ??
    originalAmount
  );

  const rows = getExpenseSplitRows(expense, converted);
  if (rows.length) {
    const originalRows = rows.map(row => {
      const explicitOriginal = Number(row.originalAmount);
      let amount = Number.isFinite(explicitOriginal) && explicitOriginal > 0
        ? explicitOriginal
        : (converted ? originalAmount * Number(row.amount || 0) / converted : 0);

      return {
        member: row.member,
        amount
      };
    });

    return allocateRoundingDifference(originalRows, originalAmount);
  }

  const participants = Array.isArray(expense.sharedBy) && expense.sharedBy.length ? expense.sharedBy : [];
  if (!participants.length) return [];

  return allocateRoundingDifference(participants.map(member => ({
    member,
    amount: originalAmount / participants.length
  })), originalAmount);
}

function calculateExpenseNetByOriginalCurrencyOnly() {
  const groups = new Map();

  function ensureCurrency(currency) {
    const cur = currency || tripSettings.baseCurrency || "HKD";
    if (!groups.has(cur)) {
      const net = {};
      members.forEach(m => { net[m] = 0; });
      groups.set(cur, { currency: cur, net });
    }
    return groups.get(cur);
  }

  expenses.forEach(expense => {
    const currency = expense.originalCurrency ?? expense.currency ?? tripSettings.baseCurrency ?? "HKD";
    const amount = Number(expense.originalAmount ?? expense.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const group = ensureCurrency(currency);
    const splitRows = getExpenseOriginalSplitRows(expense);
    if (!splitRows.length) return;

    if (!Object.prototype.hasOwnProperty.call(group.net, expense.paidBy)) group.net[expense.paidBy] = 0;
    group.net[expense.paidBy] += amount;

    splitRows.forEach(row => {
      if (!Object.prototype.hasOwnProperty.call(group.net, row.member)) group.net[row.member] = 0;
      group.net[row.member] -= Number(row.amount || 0);
    });
  });

  return Array.from(groups.values()).map(group => {
    Object.keys(group.net).forEach(person => {
      group.net[person] = round2(group.net[person]);
    });
    return group;
  }).sort((a, b) => {
    const order = getActiveCurrencies();
    return order.indexOf(a.currency) - order.indexOf(b.currency);
  });
}

function calculateSummaryByOriginalCurrency() {
  const groups = calculateExpenseNetByOriginalCurrencyOnly();

  settlements.forEach(record => {
    const currency = record.currency || tripSettings.baseCurrency || "HKD";
    if (!groups.some(group => group.currency === currency)) {
      const net = {};
      members.forEach(m => { net[m] = 0; });
      groups.push({ currency, net });
    }
  });

  return groups.map(group => {
    const netAfterPayments = applyRecordedPaymentsToNet({ ...group.net }, group.currency);
    const settlement = buildSettlement(netAfterPayments);
    return {
      currency: group.currency,
      expenseNet: group.net,
      net: netAfterPayments,
      settlement,
      recordedPaymentsTotal: getTotalRecordedPayments(group.currency)
    };
  }).filter(group => {
    const hasNet = Object.values(group.net).some(amount => Math.abs(Number(amount || 0)) >= 0.01);
    return hasNet || group.recordedPaymentsTotal > 0 || group.settlement.length > 0;
  });
}


function sumBy(rows, keyFn, amountFn) {
  const map = new Map();
  rows.forEach(row => {
    const key = keyFn(row) || "未分類";
    const amount = Number(amountFn(row) || 0);
    map.set(key, round2((map.get(key) || 0) + amount));
  });
  return Array.from(map.entries())
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
}

function getOriginalCurrencyTotals(activeExpenses = expenses) {
  const totals = {};
  (activeExpenses || []).forEach(expense => {
    const cur = expense.originalCurrency || expense.currency || tripSettings.baseCurrency || "HKD";
    const amount = Number(expense.originalAmount ?? expense.amount ?? 0);
    if (!Number.isFinite(amount)) return;
    totals[cur] = round2((totals[cur] || 0) + amount);
  });
  return Object.entries(totals)
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b));
}

function renderCurrencyTotalsHtml(activeExpenses = expenses, compact = false) {
  const rows = getOriginalCurrencyTotals(activeExpenses);
  if (!rows.length) return "";
  return rows.map(([cur, amount]) => `
    <div class="snapshot-currency-total ${compact ? "is-compact" : ""}">
      <span>${safeEscape(cur)}</span>
      <strong>${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}</strong>
    </div>
  `).join("");
}

function renderExpenseSnapshot() {
  if (!expenseSnapshotCard || !expenseSnapshotTotal) return;

  const base = tripSettings.baseCurrency || "HKD";
  const activeExpenses = expenses || [];
  const baseTotal = round2(activeExpenses.reduce((sum, expense) => {
    return sum + Number(expense.convertedAmount ?? convertToBase(expense.originalAmount ?? expense.amount ?? 0, expense.originalCurrency ?? expense.currency ?? base) ?? 0);
  }, 0));

  const currencyTotals = renderCurrencyTotalsHtml(activeExpenses);
  if (currencyTotals) {
    expenseSnapshotTotal.innerHTML = `<div class="snapshot-currency-list">${currencyTotals}</div>`;
  } else {
    expenseSnapshotTotal.innerHTML = `--`;
  }

  if (expenseSnapshotCats) {
    const count = activeExpenses.length;
    expenseSnapshotCats.textContent = count > 0 ? `${count} 筆支出 · 基準換算 ${safeEscape(base)} ${baseTotal.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : "";
  }

  if (expenseSnapshotPersons) {
    if (!activeExpenses.length || !members.length) {
      expenseSnapshotPersons.innerHTML = "";
    } else {
      const spendMap = {};
      members.forEach(m => { spendMap[m] = 0; });
      activeExpenses.forEach(expense => {
        const converted = Number(expense.convertedAmount ?? convertToBase(expense.originalAmount ?? expense.amount ?? 0, expense.originalCurrency ?? expense.currency ?? base) ?? 0);
        const splitRows = getExpenseSplitRows(expense, converted);
        splitRows.forEach(row => {
          if (!(row.member in spendMap)) spendMap[row.member] = 0;
          spendMap[row.member] = round2(spendMap[row.member] + Number(row.amount));
        });
      });
      expenseSnapshotPersons.innerHTML = Object.entries(spendMap)
        .filter(([, amt]) => amt > 0)
        .map(([person, amt]) => `
          <div class="snapshot-person-row">
            <span class="snapshot-person-name">${safeEscape(person)}</span>
            <span class="snapshot-person-amt">${safeEscape(base)} ${Math.floor(amt).toLocaleString()}</span>
          </div>
        `).join("");
    }
  }
}

function getAnalyticsCategoryRows(activeExpenses, base) {
  const byCategory = sumBy(
    activeExpenses,
    e => e.category || "Other",
    e => e.convertedAmount ?? convertToBase(
      e.originalAmount ?? e.amount ?? 0,
      e.originalCurrency ?? e.currency ?? base
    )
  );

  const ordered = [];
  analyticsCategoryOrder.forEach(category => {
    const found = byCategory.find(row => row.label === category);
    if (found) ordered.push(found);
  });

  byCategory
    .filter(row => !analyticsCategoryOrder.includes(row.label))
    .forEach(row => ordered.push(row));

  return ordered;
}

function ensureAnalyticsSelection(categories) {
  if (!analyticsSelectedCategories || !(analyticsSelectedCategories instanceof Set)) {
    analyticsSelectedCategories = new Set(categories);
    return;
  }

  const available = new Set(categories);
  analyticsSelectedCategories = new Set(
    Array.from(analyticsSelectedCategories).filter(category => available.has(category))
  );

  if (analyticsSelectedCategories.size === 0 && categories.length > 0) {
    analyticsSelectedCategories = new Set(categories);
  }
}

function getCategoryColor(category, index = 0) {
  if (analyticsCategoryColors[category]) return analyticsCategoryColors[category];
  const fallback = ["#34c759", "#5856d6", "#ffcc00", "#ff3b30", "#00c7be", "#af52de"];
  return fallback[index % fallback.length];
}

function buildPieChartSvg(rows, total) {
  if (!rows.length || !total) {
    return `
      <div class="analytics-pie-empty">
        <span>未有可顯示分類</span>
      </div>
    `;
  }

  let offset = 25;
  const segments = rows.map((row, index) => {
    const pct = Math.max(0, Number(row.amount) / total * 100);
    const strokeOffset = offset;
    offset -= pct;
    return `
      <circle
        class="analytics-pie-segment"
        cx="21" cy="21" r="15.9155"
        fill="transparent"
        stroke="${getCategoryColor(row.label, index)}"
        stroke-width="8"
        stroke-dasharray="${pct.toFixed(4)} ${(100 - pct).toFixed(4)}"
        stroke-dashoffset="${strokeOffset.toFixed(4)}"
      />
    `;
  }).join("");

  return `
    <div class="analytics-pie-wrap">
      <svg class="analytics-pie-svg" viewBox="0 0 42 42" role="img" aria-label="按分類支出比例圖">
        <circle cx="21" cy="21" r="15.9155" fill="transparent" stroke="rgba(142,142,147,0.16)" stroke-width="8"></circle>
        ${segments}
      </svg>
      <div class="analytics-pie-center">
        <span>已選分類</span>
        <strong>${rows.length}</strong>
      </div>
    </div>
  `;
}

function bindAnalyticsFilterEvents(availableCategories) {
  const allCheckbox = analyticsSummary.querySelector('[data-analytics-filter="all"]');
  const categoryCheckboxes = Array.from(analyticsSummary.querySelectorAll('[data-analytics-category]'));

  if (allCheckbox) {
    allCheckbox.addEventListener("change", () => {
      analyticsSelectedCategories = allCheckbox.checked
        ? new Set(availableCategories)
        : new Set();
      renderAnalytics();
    });
  }

  categoryCheckboxes.forEach(input => {
    input.addEventListener("change", () => {
      const category = input.dataset.analyticsCategory;
      if (!analyticsSelectedCategories) analyticsSelectedCategories = new Set(availableCategories);

      if (input.checked) analyticsSelectedCategories.add(category);
      else analyticsSelectedCategories.delete(category);

      renderAnalytics();
    });
  });
}

function renderAnalytics() {
  renderExpenseSnapshot();
  if (!analyticsSummary) return;

  const base = tripSettings.baseCurrency || "HKD";
  const activeExpenses = expenses || [];
  const allTotal = round2(activeExpenses.reduce((sum, expense) => {
    return sum + Number(expense.convertedAmount ?? convertToBase(expense.originalAmount ?? expense.amount ?? 0, expense.originalCurrency ?? expense.currency ?? base) ?? 0);
  }, 0));

  if (!activeExpenses.length) {
    analyticsSummary.innerHTML = emptyStateHtml("📊", "暫時未有支出可供分析");
    return;
  }

  const allCategoryRows = getAnalyticsCategoryRows(activeExpenses, base);
  const availableCategories = allCategoryRows.map(row => row.label);
  ensureAnalyticsSelection(availableCategories);

  const selectedRows = allCategoryRows.filter(row => analyticsSelectedCategories.has(row.label));
  const selectedTotal = round2(selectedRows.reduce((sum, row) => sum + Number(row.amount || 0), 0));

  const byDate = sumBy(activeExpenses, e => e.date || "未填日期", e => e.convertedAmount ?? convertToBase(e.originalAmount ?? e.amount ?? 0, e.originalCurrency ?? e.currency ?? base));
  const byPayer = sumBy(activeExpenses, e => e.paidBy || "未知付款人", e => e.convertedAmount ?? convertToBase(e.originalAmount ?? e.amount ?? 0, e.originalCurrency ?? e.currency ?? base));

  function block(title, rows) {
    const max = Math.max(...rows.map(r => Math.abs(r.amount)), 1);
    return `
      <div class="analytics-block">
        <h3>${safeEscape(title)}</h3>
        ${rows.map(row => {
          const pct = Math.max(2, Math.round(Math.abs(row.amount) / max * 100));
          return `
            <div class="analytics-row">
              <div class="analytics-row-top">
                <span>${safeEscape(row.label)}</span>
                <strong>${safeEscape(base)} ${Number(row.amount).toFixed(2)}</strong>
              </div>
              <div class="analytics-bar"><span style="width:${pct}%"></span></div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  const allChecked = availableCategories.length > 0 && availableCategories.every(category => analyticsSelectedCategories.has(category));
  const filterHtml = `
    <div class="analytics-filter-card">
      <div class="analytics-filter-title">
        <strong>分類篩選</strong>
      </div>
      <div class="analytics-filter-grid">
        <label class="analytics-filter-chip analytics-filter-all ${allChecked ? "is-selected" : ""}">
          <input type="checkbox" data-analytics-filter="all" ${allChecked ? "checked" : ""} />
          <span class="analytics-check">✓</span>
          <span>All</span>
        </label>
        ${availableCategories.map((category, index) => {
          const selected = analyticsSelectedCategories.has(category);
          return `
            <label class="analytics-filter-chip ${selected ? "is-selected" : ""}">
              <input type="checkbox" data-analytics-category="${safeEscape(category)}" ${selected ? "checked" : ""} />
              <span class="analytics-check">✓</span>
              <i style="background:${getCategoryColor(category, index)}"></i>
              <span>${safeEscape(category)}</span>
            </label>
          `;
        }).join("")}
      </div>
    </div>
  `;

  const pieLegend = selectedRows.length
    ? `<div class="analytics-pie-legend">
        ${selectedRows.map((row, index) => {
          const pct = selectedTotal ? row.amount / selectedTotal * 100 : 0;
          return `
            <div class="analytics-pie-legend-row">
              <span><i style="background:${getCategoryColor(row.label, index)}"></i>${safeEscape(row.label)}</span>
              <strong>${pct.toFixed(1)}%</strong>
            </div>
          `;
        }).join("")}
      </div>`
    : `<p class="neutral">未選擇分類。請勾選 All 或至少一個分類。</p>`;

  const originalTotalsHtml = renderCurrencyTotalsHtml(activeExpenses, true);

  analyticsSummary.innerHTML = `
    <div class="analytics-total-card">
      <span>總支出</span>
      <strong>${originalTotalsHtml || `${safeEscape(base)} ${allTotal.toFixed(2)}`}</strong>
      <small>共 ${activeExpenses.length} 筆支出，不包括 Deleted Items；基準換算 ${safeEscape(base)} ${allTotal.toFixed(2)}</small>
    </div>

    <div class="analytics-pie-card">
      <div class="analytics-pie-heading">
        <div>
          <span>按分類 Pie Chart</span>
          <strong>${safeEscape(base)} ${selectedTotal.toFixed(2)}</strong>
        </div>
        <small>${selectedRows.length ? `已選 ${selectedRows.length} 類` : "未選擇分類"}</small>
      </div>
      ${buildPieChartSvg(selectedRows, selectedTotal)}
      ${pieLegend}
    </div>

    ${filterHtml}
    ${block("按分類", selectedRows)}
    ${block("按日期", byDate)}
    ${block("按付款人", byPayer)}
  `;

  bindAnalyticsFilterEvents(availableCategories);
}

function renderSettlementModeControl() {
  const active = settlementViewMode === "original" ? "original" : "base";
  return `
    <div class="settlement-mode-card" role="group" aria-label="結算顯示方式">
      <button type="button" class="settlement-mode-btn ${active === "base" ? "active" : ""}" data-settlement-view="base">
        <span>基準幣別</span>
      </button>
      <button type="button" class="settlement-mode-btn ${active === "original" ? "active" : ""}" data-settlement-view="original">
        <span>原幣分開</span>
      </button>
    </div>
  `;
}

function renderNetRowsHtml(group) {
  const entries = Object.entries(group.net || {});
  if (!entries.length) return emptyStateHtml("✅", "暫時無需結算");

  return entries.map(([person, amount]) => {
    const r = round2(amount);
    const original = round2(group.expenseNet?.[person] ?? 0);
    const cls = r > 0 ? "positive" : r < 0 ? "negative" : "neutral";
    const label = r > 0 ? "應收" : r < 0 ? "應付" : "已平數";
    const originalText = original === r
      ? ""
      : `<div class="expense-meta">原本：${original > 0 ? "應收" : original < 0 ? "應付" : "已平數"} ${safeEscape(group.currency)} ${Math.abs(original).toFixed(2)}，已計入找數紀錄</div>`;

    return `
      <div class="summary-item">
        <strong>${safeEscape(person)}</strong>
        <span class="${cls}">${label} ${safeEscape(group.currency)} ${Math.abs(r).toFixed(2)}</span>
        ${originalText}
      </div>
    `;
  }).join("");
}

function renderSettlementCardsHtml(groups) {
  const visibleCurrencies = new Set(groups.map(group => group.currency));
  const settlementItems = groups.flatMap(group => (group.settlement || []).map(item => ({ ...item, currency: group.currency })));

  const settlementHtml = settlementItems.length
    ? settlementItems.map(item => {
        const key = getSettlementKey(item);
        const pairKey = getSettlementPairKey(item);

        return `
          <div class="settlement-item settlement-arrow-card">
            <div class="settlement-arrow-row">
              <strong class="settlement-person">${safeEscape(item.from)}</strong>
              <span class="settlement-arrow-icon">→</span>
              <strong class="settlement-person">${safeEscape(item.to)}</strong>
              <span class="negative settlement-arrow-amount">${safeEscape(item.currency)} ${Number(item.amount).toFixed(2)}</span>
            </div>
            <div class="settlement-status"><span class="unpaid-badge">尚欠，已扣除已找數紀錄</span></div>
            <div class="settlement-actions">
              <div class="settlement-payment-row">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="輸入今次找數金額"
                  data-payment-input="${safeEscape(pairKey)}"
                />
                <button
                  type="button"
                  class="settle-btn"
                  data-record-payment="${safeEscape(pairKey)}"
                  data-settlement-key="${safeEscape(key)}"
                  data-from="${safeEscape(item.from)}"
                  data-to="${safeEscape(item.to)}"
                  data-amount="${Number(item.amount).toFixed(2)}"
                  data-currency="${safeEscape(item.currency)}"
                  data-balance="${Number(item.amount).toFixed(2)}"
                >記錄找數</button>
              </div>
            </div>
          </div>
        `;
      }).join("")
    : emptyStateHtml("✅", "暫時無需結算，已計入找數紀錄");

  const visibleSettlements = settlementViewMode === "base"
    ? settlements
    : settlements.filter(item => visibleCurrencies.has(item.currency || tripSettings.baseCurrency || "HKD"));
  const paidHistoryHtml = visibleSettlements.length
    ? visibleSettlements.map(item => {
        const paidAmount = Number(item.paidAmount ?? item.amount ?? 0);
        return `
          <div class="settlement-item paid-history-item">
            <div><strong>${safeEscape(item.from)}</strong> paid <strong>${safeEscape(item.to)}</strong> ${safeEscape(item.currency)} ${paidAmount.toFixed(2)}</div>
            <div class="expense-meta">標記：${safeEscape(item.markedByName || formatAuditUid(item.markedBy))} · ${formatTimestamp(item.paidAt)}</div>
            ${item.note ? `<div class="expense-meta">備註：${safeEscape(item.note)}</div>` : ""}
            <button type="button" class="settle-btn secondary-btn" data-unpay-id="${safeEscape(item.id)}">取消此紀錄</button>
          </div>
        `;
      }).join("")
    : emptyStateHtml("💸", "暫時未有已找數紀錄");

  return { settlementHtml, paidHistoryHtml, settlementItems };
}

function bindSettlementSummaryEvents() {
  document.querySelectorAll('.expenses-module [data-settlement-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      settlementViewMode = btn.dataset.settlementView === "original" ? "original" : "base";
      try { localStorage.setItem("expense_settlement_view_mode", settlementViewMode); } catch(e) {}
      renderSummary();
    });
  });

  document.getElementById("openSettlementActionBtn")?.addEventListener("click", () => {
    openSettlementActionModal();
  });
}

function renderSummary() {
  const baseSummary = calculateSummary();
  const groups = settlementViewMode === "original"
    ? calculateSummaryByOriginalCurrency()
    : [baseSummary];

  const displayGroups = groups.length ? groups : [{
    currency: tripSettings.baseCurrency || "HKD",
    expenseNet: {},
    net: {},
    settlement: [],
    recordedPaymentsTotal: 0
  }];

  const summaryGroupsHtml = displayGroups.map(group => {
    const remaining = round2((group.settlement || []).reduce((sum, item) => sum + Number(item.amount || 0), 0));
    return `
      <section class="summary-currency-group">
        <div class="summary-currency-heading">
          <h3>${settlementViewMode === "original" ? `${safeEscape(group.currency)} 結算` : `每人淨額（${safeEscape(group.currency)}，已計入找數）`}</h3>
          <span>${safeEscape(group.currency)} ${remaining.toFixed(2)} 尚欠</span>
        </div>
        <p class="hint">已找數總額：${safeEscape(group.currency)} ${Number(group.recordedPaymentsTotal || 0).toFixed(2)}。</p>
        ${renderNetRowsHtml(group)}
      </section>
    `;
  }).join("");

  const remainingText = displayGroups
    .map(group => {
      const amount = round2((group.settlement || []).reduce((sum, item) => sum + Number(item.amount || 0), 0));
      return `${group.currency} ${amount.toFixed(2)}`;
    })
    .join(" / ");

  const totalSettlementCount = displayGroups.reduce((sum, group) => sum + (group.settlement || []).length, 0);

  summary.innerHTML = `
    ${renderSettlementModeControl()}
    ${summaryGroupsHtml}
    <button type="button" id="openSettlementActionBtn" class="secondary-btn settlement-popup-btn">找數 / 查看建議結算</button>
    <p class="hint">剩餘應找：${safeEscape(remainingText || "0.00")}，建議結算 ${totalSettlementCount} 項。</p>
  `;

  if (settlementActionContent) {
    const { settlementHtml, paidHistoryHtml } = renderSettlementCardsHtml(displayGroups);
    settlementActionContent.innerHTML = `
      <h3>建議結算（剩餘應找）</h3>
      ${settlementHtml}
      <h3>已找數紀錄</h3>
      ${paidHistoryHtml}
    `;
  }

  bindSettlementSummaryEvents();

  const settlementContainer = settlementActionContent || summary;

  settlementContainer.querySelectorAll("[data-record-payment]").forEach(btn => {
    btn.addEventListener("click", () => recordSettlementPayment({
      settlementKey: btn.dataset.settlementKey,
      settlementPairKey: btn.dataset.recordPayment,
      from: btn.dataset.from,
      to: btn.dataset.to,
      settlementAmount: Number(btn.dataset.amount),
      balanceAmount: Number(btn.dataset.balance),
      currency: btn.dataset.currency
    }));
  });

  settlementContainer.querySelectorAll("[data-unpay-id]").forEach(btn => {
    btn.addEventListener("click", () => cancelSettlementPaid(btn.dataset.unpayId));
  });
}

async function recordSettlementPayment(item) {
  if (!currentUser) return alert("請先登入。");
  if (!assertGlobalTripOpen()) return;

  const input = (settlementActionContent || summary).querySelector(`[data-payment-input="${CSS.escape(item.settlementPairKey)}"]`);
  const paidAmount = Number(input?.value);

  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return alert("請輸入有效找數金額。");
  }

  if (paidAmount > item.balanceAmount) {
    const confirmed = confirm(`輸入金額 ${item.currency} ${paidAmount.toFixed(2)} 大過尚欠 ${item.currency} ${item.balanceAmount.toFixed(2)}，仍然記錄？`);
    if (!confirmed) return;
  }

  const note = prompt("備註，例如 FPS / Cash / Alipay，可留空：", "") || "";

  const docRef = await addDoc(getSettlementsCollection(), {
    settlementKey: item.settlementKey,
    settlementPairKey: item.settlementPairKey,
    from: item.from,
    to: item.to,
    settlementAmount: Number(item.settlementAmount),
    balanceBeforePayment: Number(item.balanceAmount),
    paidAmount,
    amount: paidAmount,
    currency: item.currency,
    status: paidAmount >= item.balanceAmount ? "paid" : "partial",
    note: note.trim(),
    markedBy: currentUser.uid,
    markedByName: getCurrentUserDisplayName(),
    paidAt: serverTimestamp()
  });

  await logActivity("settlement_recorded", `${getCurrentUserDisplayName()} 記錄 ${item.from} paid ${item.to} ${item.currency} ${paidAmount.toFixed(2)}`, "settlement", docRef.id, {
    from: item.from,
    to: item.to,
    paidAmount,
    currency: item.currency
  });
}

async function cancelSettlementPaid(settlementId) {
  if (!assertGlobalTripOpen()) return;
  if (!confirm("取消此已找數標記？")) return;
  const record = settlements.find(item => item.id === settlementId);
  await deleteDoc(doc(db, "trips", tripId, "settlements", settlementId));
  await logActivity("settlement_cancelled", `${getCurrentUserDisplayName()} 取消找數紀錄 ${record?.from || ""} paid ${record?.to || ""}`, "settlement", settlementId, {
    from: record?.from || "",
    to: record?.to || "",
    paidAmount: Number(record?.paidAmount ?? record?.amount ?? 0),
    currency: record?.currency || ""
  });
}

async function ensureSheetJs() {
  if (window.XLSX) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

function worksheetFromRows(rows, headers) {
  const normalizedRows = rows.length
    ? rows
    : [Object.fromEntries(headers.map(header => [header, ""]))];

  const ws = window.XLSX.utils.json_to_sheet(normalizedRows, { header: headers });
  if (ws["!ref"]) {
    ws["!autofilter"] = { ref: ws["!ref"] };
  }
  ws["!cols"] = headers.map(header => ({ wch: Math.max(String(header).length + 2, 14) }));
  return ws;
}

function coverSheetFromSummary(metrics) {
  const rows = [
    ["Trip Expense Report"],
    [],
    ["Trip ID", tripId],
    ["Trip Status", tripStatus],
    ["Base Currency", metrics.currency],
    ["Exported At", new Date().toLocaleString("zh-HK")],
    ["Exported By", getCurrentUserDisplayName()],
    ["Active Expenses", expenses.length],
    ["Deleted Expenses", getDeletedExpenses().length],
    ["Payment Records", settlements.length],
    ["Activity Log Records", activityLogs.length],
    ["Total Active Expense Amount", metrics.totalActiveExpenses],
    ["Total Recorded Payments", metrics.recordedPaymentsTotal],
    ["Outstanding Settlement Count", metrics.outstandingCount],
    ["Outstanding Settlement Amount", metrics.outstandingAmount]
  ];

  const ws = window.XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 30 }, { wch: 28 }];
  return ws;
}

function exportWorkbook() {
  const { expenseNet, net, settlement, currency, recordedPaymentsTotal } = calculateSummary();
  const totalActiveExpenses = round2(expenses.reduce((sum, expense) => sum + Number(expense.convertedAmount ?? 0), 0));
  const outstandingAmount = round2(settlement.reduce((sum, item) => sum + Number(item.amount || 0), 0));

  const coverWs = coverSheetFromSummary({
    currency,
    totalActiveExpenses,
    recordedPaymentsTotal,
    outstandingCount: settlement.length,
    outstandingAmount
  });

  const expenseHeaders = [
    "Status",
    "Date",
    "Item",
    "Category",
    "OriginalCurrency",
    "OriginalAmount",
    "FxRateUsed",
    "BaseCurrency",
    "ConvertedAmount",
    "PaidBy",
    "SharedBy",
    "SplitMethod",
    "SplitDetail",
    "Note",
    "CreatedBy",
    "CreatedAt",
    "UpdatedBy",
    "UpdatedAt",
    "DeletedBy",
    "DeletedAt"
  ];

  const expensesRows = allExpenses.map(expense => ({
    Status: expense.isDeleted === true ? "Deleted" : "Active",
    Date: expense.date || "",
    Item: expense.title || "",
    Category: expense.category || "",
    OriginalCurrency: expense.originalCurrency || expense.currency || "",
    OriginalAmount: Number(expense.originalAmount ?? expense.amount ?? 0),
    FxRateUsed: Number(expense.fxRateUsed ?? getRateFor(expense.originalCurrency || expense.currency) ?? 0),
    BaseCurrency: expense.baseCurrency || tripSettings.baseCurrency,
    ConvertedAmount: Number(expense.convertedAmount ?? 0),
    PaidBy: expense.paidBy || "",
    SharedBy: Array.isArray(expense.sharedBy) ? expense.sharedBy.join(", ") : "",
    SplitMethod: getSplitMethodLabel(expense.splitMethod || "equal"),
    SplitDetail: describeSplit(expense),
    Note: expense.note || "",
    CreatedBy: expense.createdByName || formatAuditUid(expense.createdBy),
    CreatedAt: formatTimestamp(expense.createdAt),
    UpdatedBy: expense.updatedByName || formatAuditUid(expense.updatedBy),
    UpdatedAt: formatTimestamp(expense.updatedAt),
    DeletedBy: expense.deletedByName || formatAuditUid(expense.deletedBy),
    DeletedAt: formatTimestamp(expense.deletedAt)
  }));

  const summaryHeaders = [
    "Person",
    "OriginalStatusBeforePayments",
    "OriginalAmountBeforePayments",
    "PaymentEffect",
    "FinalStatusAfterPayments",
    "FinalAmountAfterPayments",
    "Currency"
  ];

  const summaryRows = Object.entries(net).map(([person, amount]) => {
    const rounded = round2(amount);
    const original = round2(expenseNet[person] ?? 0);
    const paymentEffect = round2(rounded - original);

    return {
      Person: person,
      OriginalStatusBeforePayments: original > 0 ? "Receivable" : original < 0 ? "Payable" : "Settled",
      OriginalAmountBeforePayments: Math.abs(original),
      PaymentEffect: paymentEffect,
      FinalStatusAfterPayments: rounded > 0 ? "Receivable" : rounded < 0 ? "Payable" : "Settled",
      FinalAmountAfterPayments: Math.abs(rounded),
      Currency: currency
    };
  });

  const settlementHeaders = [
    "From",
    "To",
    "Currency",
    "RemainingAmountToPay",
    "Status",
    "SettlementPairKey",
    "SettlementKey"
  ];

  const settlementRows = settlement.map(item => {
    const row = { ...item, currency };
    const key = getSettlementKey(row);
    const pairKey = getSettlementPairKey(row);

    return {
      From: item.from,
      To: item.to,
      Currency: currency,
      RemainingAmountToPay: Number(item.amount),
      Status: "Outstanding after recorded payments",
      SettlementPairKey: pairKey,
      SettlementKey: key
    };
  });

  const paidHeaders = [
    "From",
    "To",
    "Currency",
    "PaidAmount",
    "SettlementAmount",
    "BalanceBeforePayment",
    "Status",
    "Note",
    "MarkedBy",
    "PaidAt",
    "SettlementPairKey",
    "SettlementKey"
  ];

  const paidRows = settlements.map(item => ({
    From: item.from || "",
    To: item.to || "",
    Currency: item.currency || "",
    PaidAmount: Number(item.paidAmount ?? item.amount ?? 0),
    SettlementAmount: Number(item.settlementAmount ?? 0),
    BalanceBeforePayment: Number(item.balanceBeforePayment ?? 0),
    Status: item.status || "",
    Note: item.note || "",
    MarkedBy: item.markedByName || formatAuditUid(item.markedBy),
    PaidAt: formatTimestamp(item.paidAt),
    SettlementPairKey: item.settlementPairKey || "",
    SettlementKey: item.settlementKey || ""
  }));

  const activityHeaders = ["Action", "Message", "Actor", "TargetType", "TargetId", "CreatedAt"];
  const activityRows = activityLogs.map(item => ({
    Action: item.action || "",
    Message: item.message || "",
    Actor: item.actorName || formatAuditUid(item.actorUid),
    TargetType: item.targetType || "",
    TargetId: item.targetId || "",
    CreatedAt: formatTimestamp(item.createdAt)
  }));

  const deletedHeaders = ["Date", "Item", "OriginalCurrency", "OriginalAmount", "PaidBy", "SharedBy", "DeletedBy", "DeletedAt"];
  const deletedRows = getDeletedExpenses().map(expense => ({
    Date: expense.date || "",
    Item: expense.title || "",
    OriginalCurrency: expense.originalCurrency || expense.currency || "",
    OriginalAmount: Number(expense.originalAmount ?? expense.amount ?? 0),
    PaidBy: expense.paidBy || "",
    SharedBy: Array.isArray(expense.sharedBy) ? expense.sharedBy.join(", ") : "",
    DeletedBy: expense.deletedByName || formatAuditUid(expense.deletedBy),
    DeletedAt: formatTimestamp(expense.deletedAt)
  }));


  const splitHeaders = [
    "ExpenseId",
    "Date",
    "Item",
    "PaidBy",
    "OriginalCurrency",
    "OriginalAmount",
    "BaseCurrency",
    "ConvertedAmount",
    "SplitMethod",
    "Member",
    "MemberOriginalAmount",
    "MemberBaseAmount",
    "MemberPercentage",
    "Status"
  ];

  const splitRows = allExpenses.flatMap(expense => {
    const converted = Number(expense.convertedAmount ?? 0);
    const rows = getExpenseSplitRows(expense, converted);
    return rows.map(row => ({
      ExpenseId: expense.id || "",
      Date: expense.date || "",
      Item: expense.title || "",
      PaidBy: expense.paidBy || "",
      OriginalCurrency: expense.originalCurrency || expense.currency || "",
      OriginalAmount: Number(expense.originalAmount ?? expense.amount ?? 0),
      BaseCurrency: expense.baseCurrency || tripSettings.baseCurrency,
      ConvertedAmount: converted,
      SplitMethod: getSplitMethodLabel(expense.splitMethod || "equal"),
      Member: row.member,
      MemberOriginalAmount: Number(row.originalAmount ?? 0),
      MemberBaseAmount: Number(row.amount ?? 0),
      MemberPercentage: Number(row.percentage ?? 0),
      Status: expense.isDeleted === true ? "Deleted" : "Active"
    }));
  });

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, coverWs, "Cover");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(expensesRows, expenseHeaders), "Expenses");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(splitRows, splitHeaders), "Split Details");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(summaryRows, summaryHeaders), "Summary");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(settlementRows, settlementHeaders), "Settlement");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(paidRows, paidHeaders), "Paid Records");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(activityRows, activityHeaders), "Activity Log");
  window.XLSX.utils.book_append_sheet(wb, worksheetFromRows(deletedRows, deletedHeaders), "Deleted Items");

  const filename = getExportFileName();
  const bytes = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return { blob, filename };
}

function exportJsonBackup() {
  const { expenseNet, net, settlement, currency, recordedPaymentsTotal } = calculateSummary();

  const backup = {
    schemaVersion: 2,
    appName: "travel-expenses",
    exportedAt: new Date().toISOString(),
    exportedBy: {
      uid: currentUser?.uid || "",
      name: getCurrentUserDisplayName(),
      email: currentUser?.email || ""
    },
    trip: {
      tripId,
      status: tripStatus,
      lockedAt: timestampToIso(tripLockedAt),
      lockedBy: tripLockedBy || "",
      lockedByName: tripLockedByName || "",
      creatorUid: tripCreatorUid || "",
      members: [...members],
      settings: toPlainValue(tripSettings),
      allowedEmails: [...allowedEmailsCache],
      allowedUids: [...tripAllowedUids]
    },
    data: {
      expenses: toPlainValue(allExpenses),
      settlements: toPlainValue(settlements),
      activityLogs: toPlainValue(activityLogs)
    },
    computed: {
      currency,
      expenseNet: toPlainValue(expenseNet),
      finalNet: toPlainValue(net),
      settlement: toPlainValue(settlement),
      recordedPaymentsTotal
    }
  };

  downloadTextFile(
    getJsonBackupFileName(),
    JSON.stringify(backup, null, 2),
    "application/json;charset=utf-8"
  );
}

async function handleExportExcel({ deferDownload = false } = {}) {
  try {
    setModuleStatus("Preparing Excel...");
    await ensureSheetJs();
    const prepared = exportWorkbook();
    setModuleStatus(`Synced (${tripId})`);
    if (deferDownload) {
      // v7.7.7.0: Data Management owns the final iOS download handoff so its
      // busy state can be released before Safari suspends the PWA.
      window.dispatchEvent(new CustomEvent("expense-excel-export-result", {
        detail: { ok: true, tripId, blob: prepared.blob, filename: prepared.filename }
      }));
    } else {
      downloadBlobFile(prepared.filename, prepared.blob);
    }
    return true;
  } catch (error) {
    console.error(error);
    setModuleStatus("Export error");
    if (deferDownload) {
      window.dispatchEvent(new CustomEvent("expense-excel-export-result", { detail: { ok: false, tripId, message: error?.message || "Excel export failed" } }));
    }
    alert("匯出 Excel 失敗，請稍後再試。");
    return false;
  }
}

function clearPendingExcelExportTimer() {
  if (pendingExcelExportTimer) clearTimeout(pendingExcelExportTimer);
  pendingExcelExportTimer = null;
}
function schedulePendingExcelExportCheck(delay = 220) {
  clearPendingExcelExportTimer();
  pendingExcelExportTimer = setTimeout(() => tryRunPendingExcelExport(), delay);
}
async function tryRunPendingExcelExport() {
  if (!pendingExcelExportRequested) return;
  if (pendingExcelExportStartedAt && Date.now() - pendingExcelExportStartedAt > 10000) {
    pendingExcelExportRequested = false;
    clearPendingExcelExportTimer();
    window.dispatchEvent(new CustomEvent("expense-excel-export-result", { detail: { ok: false, tripId, message: "支出資料同步逾時，請稍後再試。" } }));
    return;
  }
  const access = expenseAccessState();
  if (!currentUser || !access.ready || !access.role) {
    setModuleStatus("Confirming Trip access");
    if (currentUser) startExpenseCloudIfAllowed();
    schedulePendingExcelExportCheck(260);
    return;
  }
  if (!cloudExpenseStarted) {
    startExpenseCloudIfAllowed();
    schedulePendingExcelExportCheck(260);
    return;
  }
  if (!(recentExpensesLiveReady && settlementsLiveReady && activityLogsLiveReady)) {
    setModuleStatus("Preparing Excel data...");
    schedulePendingExcelExportCheck(220);
    return;
  }
  pendingExcelExportRequested = false;
  clearPendingExcelExportTimer();
  await handleExportExcel({ deferDownload: true });
}
function requestExpenseExcelExport() {
  pendingExcelExportRequested = true;
  pendingExcelExportStartedAt = Date.now();
  tryRunPendingExcelExport();
}

async function handleExportJsonBackup() {
  try {
    setModuleStatus("Preparing JSON backup...");
    exportJsonBackup();
    setModuleStatus(`Synced (${tripId})`);
  } catch (error) {
    console.error(error);
    setModuleStatus("JSON export error");
    alert("匯出 JSON Backup 失敗，請稍後再試。");
  }
}

async function lockTrip() {
  if (!isAdmin()) return alert("只有 Owner / Admin 可以鎖定支出。");
  if (isTripLocked()) return;

  const confirmed = confirm("鎖定後不可再新增、修改、刪除支出，亦不可修改成員及匯率。仍可記錄找數及匯出 Excel。確定鎖定？");
  if (!confirmed) return;

  const displayName = getCurrentUserDisplayName();

  if (!assertGlobalTripOpen()) return;
  await setDoc(doc(db, "trips", tripId, "settings", "expenses"), {
    expenseLocked: true,
    expenseLockedAt: serverTimestamp(),
    expenseLockedBy: currentUser.uid,
    expenseLockedByName: displayName,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser.uid
  }, { merge: true });

  await logActivity("trip_locked", `${displayName} 啟用支出鎖定`, "trip", tripId, {});
}

async function unlockTrip() {
  if (!isAdmin()) return alert("只有 Owner / Admin 可以解除支出鎖定。");
  if (!isTripLocked()) return;

  const confirmed = confirm("解鎖後大家可以再次修改支出及設定。除非真係要改數，否則不建議解鎖。確定解鎖？");
  if (!confirmed) return;

  const displayName = getCurrentUserDisplayName();

  if (!assertGlobalTripOpen()) return;
  await setDoc(doc(db, "trips", tripId, "settings", "expenses"), {
    expenseLocked: false,
    expenseLockedAt: null,
    expenseLockedBy: "",
    expenseLockedByName: "",
    expenseUnlockedAt: serverTimestamp(),
    expenseUnlockedBy: currentUser.uid,
    expenseUnlockedByName: displayName,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser.uid
  }, { merge: true });

  await logActivity("trip_unlocked", `${displayName} 解除支出鎖定`, "trip", tripId, {});
}

function renderActivityLogs() {
  if (!activityLogList) return;

  if (!activityLogs.length) {
    activityLogList.innerHTML = emptyStateHtml("📋", "暫時未有活動紀錄");
    return;
  }

  activityLogList.innerHTML = activityLogs.slice(0, 80).map(item => `
    <div class="activity-item">
      <div><strong>${safeEscape(item.actorName || formatAuditUid(item.actorUid))}</strong> · ${safeEscape(item.message || item.action || "Activity")}</div>
      <div class="expense-meta">${safeEscape(item.action || "")} · ${safeEscape(item.targetType || "")} · ${formatTimestamp(item.createdAt)}</div>
    </div>
  `).join("");
}

/* admin panel */
function getPhase2TripRole() {
  return phase2TripRole || window.__appTripAccess?.role || null;
}

function canWriteExpenses() {
  return ["owner", "admin", "member"].includes(getPhase2TripRole());
}

function isAdmin() {
  const role = getPhase2TripRole();
  return role === "owner" || role === "admin";
}

function isCreator() {
  return getPhase2TripRole() === "owner";
}

function getCreatorEmail() {
  return adminEmailsCache[0] || normalizeEmail(currentUser?.email || "");
}

function renderAllowedEmails() {
  if (!adminPanel) return;
  if (!isAdmin()) {
    adminPanel.classList.add("hidden");
    if (accessNoAdminHint) accessNoAdminHint.classList.remove("hidden");
    return;
  }
  adminPanel.classList.remove("hidden");
  if (accessNoAdminHint) accessNoAdminHint.classList.add("hidden");

  allowedEmailList.innerHTML = allowedEmailsCache.length
    ? allowedEmailsCache.map(email => `
        <div class="member-chip">
          <span>${safeEscape(email)}</span>
          <button type="button" data-remove-email="${safeEscape(email)}">移除</button>
        </div>`).join("")
    : `<p class="hint" style="margin:0">暫無授權 email</p>`;

  allowedEmailList.querySelectorAll("[data-remove-email]").forEach(btn => {
    btn.addEventListener("click", () => removeAllowedEmail(btn.dataset.removeEmail));
  });
  renderAdminEmails();
}

async function addAllowedEmail() {
  const email = normalizeEmail(allowedEmailInput.value);
  if (!email || !email.includes("@")) return alert("請輸入有效 email。");
  if (allowedEmailsCache.includes(email)) return alert("此 email 已在名單中。");
  await setDoc(getTripDocRef(), { allowedEmails: [...allowedEmailsCache, email] }, { merge: true });
  allowedEmailInput.value = "";
}

async function removeAllowedEmail(email) {
  if (!confirm(`移除 ${email}？`)) return;
  await setDoc(getTripDocRef(), { allowedEmails: allowedEmailsCache.filter(e => e !== email) }, { merge: true });
}

function renderAdminEmails() {
  if (!adminEmailList) return;

  if (!isAdmin()) {
    adminEmailList.innerHTML = "";
    return;
  }

  const creatorEmail = getCreatorEmail();
  const emails = uniqueStrings([creatorEmail, ...adminEmailsCache].map(normalizeEmail).filter(Boolean));

  adminEmailList.innerHTML = emails.length
    ? emails.map(email => {
        const fixed = email === creatorEmail;
        return `
        <div class="member-chip">
          <span>${safeEscape(email)}${fixed ? " · Creator" : ""}</span>
          ${fixed ? "" : `<button type="button" data-remove-admin-email="${safeEscape(email)}">移除</button>`}
        </div>`;
      }).join("")
    : `<p class="hint" style="margin:0">暫無 Admin email</p>`;

  adminEmailList.querySelectorAll("[data-remove-admin-email]").forEach(btn => {
    btn.addEventListener("click", () => removeAdminEmail(btn.dataset.removeAdminEmail));
  });
}

async function addAdminEmail() {
  if (!isAdmin()) return alert("只有 Admin 可以管理 Admin 名單。");
  const email = normalizeEmail(adminEmailInput.value);
  if (!email || !email.includes("@")) return alert("請輸入有效 email。");
  const nextAdminEmails = uniqueStrings([...adminEmailsCache, email]);
  const nextAllowedEmails = uniqueStrings([...allowedEmailsCache, email]);
  await setDoc(getTripDocRef(), {
    adminEmails: nextAdminEmails,
    allowedEmails: nextAllowedEmails
  }, { merge: true });
  adminEmailsCache = nextAdminEmails;
  allowedEmailsCache = nextAllowedEmails;
  adminEmailInput.value = "";
  renderAdminEmails();
  renderAllowedEmails();
}

async function removeAdminEmail(email) {
  if (!isAdmin()) return alert("只有 Admin 可以管理 Admin 名單。");
  const creatorEmail = getCreatorEmail();
  if (normalizeEmail(email) === creatorEmail) return alert("Creator 不能移除。");
  if (!confirm(`移除 Admin ${email}？`)) return;
  const next = adminEmailsCache.filter(e => e !== email);
  await setDoc(getTripDocRef(), { adminEmails: next }, { merge: true });
  adminEmailsCache = next;
  renderAdminEmails();
}

/* OCR local free */
async function ensureTesseract() {
  if (window.Tesseract) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    script.onload = resolve; script.onerror = reject;
    document.body.appendChild(script);
  });
}

async function preprocessReceiptImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onerror = reject;
    img.onload = () => {
      URL.revokeObjectURL(url);

      const longer = Math.max(img.width, img.height);
      const scale = longer < 1800 ? 1800 / longer : 1;
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const d = imageData.data;

      for (let i = 0; i < d.length; i += 4) {
        const gray = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        d[i] = d[i + 1] = d[i + 2] = gray;
      }

      const pixels = [];
      for (let i = 0; i < d.length; i += 4) pixels.push(d[i]);
      pixels.sort((a, b) => a - b);
      const lo = pixels[Math.floor(pixels.length * 0.05)];
      const hi = pixels[Math.floor(pixels.length * 0.95)];
      const range = hi - lo || 1;

      for (let i = 0; i < d.length; i += 4) {
        const v = Math.round(Math.min(255, Math.max(0, (d[i] - lo) / range * 255)));
        d[i] = d[i + 1] = d[i + 2] = v;
      }

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(blob => resolve(blob), "image/png");
    };
    img.src = url;
  });
}
function normalizeOCRText(raw) { return String(raw || "").replace(/[|]/g, "1").replace(/[Ｏ]/g, "0").replace(/[，]/g, ",").replace(/[：]/g, ":").replace(/\r/g, "").replace(/[ \t]+/g, " ").trim(); }
function splitLines(text) { return text.split("\n").map(l => l.trim()).filter(Boolean); }
function parseMoneyFromLine(line) {
  const cleaned = line.replace(/([A-Z]{3}|HK\$|NT\$|US\$|RMB|JPY|KRW|TWD|CNY|USD|HKD)/gi, " ");
  const matches = [...cleaned.matchAll(/(?:\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,]\d{2})?/g)];
  const nums = matches.map(m => m[0].replace(/\s/g, "")).map(token => {
    if (token.includes(",") && token.includes(".")) {
      const lastComma = token.lastIndexOf(","), lastDot = token.lastIndexOf(".");
      const decimalSep = lastComma > lastDot ? "," : ".";
      token = decimalSep === "," ? token.replace(/\./g, "").replace(",", ".") : token.replace(/,/g, "");
    } else if (token.includes(",") && !token.includes(".")) {
      const parts = token.split(",");
      token = (parts.length === 2 && parts[1].length === 2) ? `${parts[0]}.${parts[1]}` : token.replace(/,/g, "");
    }
    return Number(token);
  }).filter(n => Number.isFinite(n) && n > 0);
  return nums.length ? Math.max(...nums) : null;
}
function detectCurrencyFromContext(text, fallback = "HKD") {
  const t = text.toUpperCase();
  if (/\bHKD\b|HK\$/.test(t)) return "HKD";
  if (/\bUSD\b|US\$/.test(t)) return "USD";
  if (/\bTWD\b|NT\$/.test(t)) return "TWD";
  if (/\bCNY\b|\bRMB\b/.test(t)) return "CNY";
  if (/\bJPY\b/.test(t)) return "JPY";
  if (/\bKRW\b/.test(t)) return "KRW";
  if (t.includes("₩")) return "KRW";
  if (t.includes("¥")) return /JAPAN|TOKYO|OSAKA/.test(t) ? "JPY" : fallback;
  if (t.includes("$")) return t.includes("HK") ? "HKD" : t.includes("US") ? "USD" : t.includes("NT") ? "TWD" : fallback;
  return fallback;
}
function extractDateAdvanced(lines) {
  const joined = lines.join(" ");
  const patterns = [
    /\b(20\d{2})[\/\-.](0?\d|1[0-2])[\/\-.](0?\d|[12]\d|3[01])\b/g,
    /\b(0?\d|[12]\d|3[01])[\/\-.](0?\d|1[0-2])[\/\-.](20\d{2})\b/g
  ];
  const candidates = [];
  for (const p of patterns) {
    let m; while ((m = p.exec(joined)) !== null) {
      let y, mo, d;
      if (m[1].startsWith("20")) { y = m[1]; mo = m[2]; d = m[3]; }
      else { d = m[1]; mo = m[2]; y = m[3]; }
      const ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dt = new Date(`${ymd}T00:00:00Z`);
      if (!Number.isNaN(dt.getTime())) candidates.push(ymd);
    }
  }
  return candidates[0] || "";
}
function scoreAmountLine(line) {
  const u = line.toUpperCase();
  let score = 0;
  if (/TOTAL|GRAND TOTAL|AMOUNT DUE|應付|合計|總計/.test(u)) score += 80;
  if (/SUBTOTAL|小計/.test(u)) score += 30;
  if (/TAX|VAT|GST|SERVICE|折扣|DISCOUNT|CHANGE|找續/.test(u)) score -= 35;
  const amount = parseMoneyFromLine(line);
  if (amount !== null) score += 20; else score -= 40;
  return { score, amount };
}
function extractTotalAmountAdvanced(lines) {
  const candidates = lines.map((line, idx) => ({ line, idx, ...scoreAmountLine(line) })).filter(c => c.amount !== null);
  if (!candidates.length) return { amount: null, line: "" };
  candidates.sort((a, b) => b.score - a.score || b.idx - a.idx);
  return { amount: candidates[0].amount, line: candidates[0].line };
}
function extractTitleAdvanced(lines) {
  const blacklist = /TEL|INVOICE|RECEIPT|DATE|TIME|THANK|WELCOME|WWW|HTTP|@/i;
  const c = lines.slice(0, 8).filter(l => l.length >= 3 && l.length <= 48 && !blacklist.test(l) && parseMoneyFromLine(l) === null);
  return c[0] || lines[0] || "Receipt";
}
function parseReceiptTextAdvanced(rawText, currentCurrency) {
  const normalized = normalizeOCRText(rawText);
  const lines = splitLines(normalized);
  const date = extractDateAdvanced(lines);
  const currency = detectCurrencyFromContext(normalized, currentCurrency);
  const { amount, line } = extractTotalAmountAdvanced(lines);
  const merchant = extractTitleAdvanced(lines);

  let confidence = 0.45;
  if (amount !== null) confidence += 0.2;
  if (date) confidence += 0.15;
  if (currency) confidence += 0.1;
  if (line && /TOTAL|合計|總計|應付|AMOUNT DUE/i.test(line)) confidence += 0.1;

  return {
    merchant,
    date,
    currency,
    total: amount,
    confidence: Math.min(0.95, round2(confidence)),
    reason: `rule-based OCR; amountLine="${line || "n/a"}"`
  };
}

function openAiPreviewModal(result) {
  aiMerchantInput.value = result.merchant || "";
  aiDateInput.value = result.date || "";
  aiCurrencyInput.value = result.currency || (currencyInput.value || "HKD");
  aiTotalInput.value = Number.isFinite(Number(result.total)) ? String(result.total) : "";
  aiConfidenceInput.value = typeof result.confidence === "number" ? `${Math.round(result.confidence * 100)}%` : "n/a";
  aiReasonInput.value = result.reason || "";
  openExpenseModal(ocrPreviewModal);
}
function closeAiPreviewModal() { closeExpenseModal(ocrPreviewModal); }
function applyAiResultToForm() {
  if (aiMerchantInput.value.trim() && !titleInput.value.trim()) titleInput.value = aiMerchantInput.value.trim();
  if (aiDateInput.value) dateInput.value = aiDateInput.value;
  if (aiCurrencyInput.value) currencyInput.value = aiCurrencyInput.value;
  if (aiTotalInput.value) amountInput.value = aiTotalInput.value;
  noteInput.value = [noteInput.value.trim(), `OCR:merchant=${aiMerchantInput.value || "n/a"},confidence=${aiConfidenceInput.value || "n/a"}`].filter(Boolean).join(" | ");
  closeAiPreviewModal();
  closeOcrEntryModal();
  openExpenseFormModal("確認 OCR 支出");
}
async function runReceiptOCR() {
  if (!assertTripOpen()) return;
  const file = ocrFileInput.files?.[0];
  if (!file) return alert("請先選擇收據圖片。");
  try {
    setModuleStatus("預處理圖片...");
    await ensureTesseract();
    const processed = await preprocessReceiptImage(file);
    setModuleStatus("OCR 辨識中...");
    const { data } = await window.Tesseract.recognize(processed, "eng+chi_tra", {
      tessedit_ocr_engine_mode: "1",
      tessedit_pageseg_mode: "6",
    });
    const parsed = parseReceiptTextAdvanced(data?.text || "", currencyInput.value || "HKD");
    openAiPreviewModal(parsed);
    setModuleStatus(`OCR ready (${tripId})`);
  } catch (e) {
    console.error(e);
    setModuleStatus("OCR error");
    alert("OCR 失敗，請試另一張清晰圖片。");
  }
}

/* boot */
assignExpensePresentationMetadata();
configureExpensePresentations();
setupExpenseInnerTabs();
expenseSettingsBack?.addEventListener("click", hideExpenseSettingsInline);
document.getElementById("expenseManagementEntry")?.addEventListener("click",()=>openSettingModal("root"));

function handleExpenseUiAction(action) {
  if (!action) return;
  window.__pendingExpenseUiAction = null;
  if (action === "add") {
    if (!assertTripOpen()) return;
    resetExpenseForm();
    openExpenseFormModal("完整新增支出");
  }
  if (action === "settings") openSettingModal("root");
  if (action === "export:excel") { requestExpenseExcelExport(); return; }
  if (action.startsWith("setting:")) openSettingModal(action.slice(8));
}
window.addEventListener("expense-ui-action", event => handleExpenseUiAction(event?.detail?.action));
if (window.__pendingExpenseUiAction) {
  const pendingAction = window.__pendingExpenseUiAction;
  setTimeout(() => handleExpenseUiAction(pendingAction), 0);
}

if (openFullAddBtn) openFullAddBtn.addEventListener("click", () => {
  if (!assertTripOpen()) return;
  resetExpenseForm();
  openExpenseFormModal("完整新增支出");
});
if (openOcrEntryBtn) openOcrEntryBtn.addEventListener("click", openOcrEntryModal);
if (closeExpenseFormModalBtn) closeExpenseFormModalBtn.addEventListener("click", () => {
  resetExpenseForm();
  closeExpenseFormModal();
});
if (closeOcrEntryModalBtn) closeOcrEntryModalBtn.addEventListener("click", closeOcrEntryModal);
if (closeExpenseDetailModalBtn) closeExpenseDetailModalBtn.addEventListener("click", () => closeExpenseModal(expenseDetailModal));
if (closeSettlementActionModalBtn) closeSettlementActionModalBtn.addEventListener("click", closeSettlementActionModal);

document.querySelectorAll(".expenses-module [data-settings-open]").forEach(button => {
  button.addEventListener("click", () => openSettingModal(button.dataset.settingsOpen));
});

document.querySelectorAll(".expenses-module [data-modal-close]").forEach(button => {
  button.addEventListener("click", () => closeExpenseModal(document.getElementById(button.dataset.modalClose)));
});

document.querySelectorAll(".expenses-module .modal").forEach(modal => {
  modal.addEventListener("click", event => {
    if (event.target === modal && modal.dataset.presentation !== "push") closeExpenseModal(modal);
  });
  modal.addEventListener("touchmove", event => {
    event.stopPropagation();
  }, { passive: true });
});


updateCurrencySelectOptions();
setToday();
form.addEventListener("submit", saveExpense);
cancelEditBtn.addEventListener("click", () => { resetExpenseForm(); closeExpenseFormModal(); });
if (splitMethodInput) splitMethodInput.addEventListener("change", renderSplitConfig);
if (sharedByGroup) sharedByGroup.addEventListener("change", renderSplitConfig);
if (currencyInput) currencyInput.addEventListener("change", renderSplitConfig);
if (amountInput) amountInput.addEventListener("input", () => {
  if (splitValidationMessage) splitValidationMessage.textContent = "";
});

if (quickAddBtn) quickAddBtn.addEventListener("click", saveQuickExpense);
if (quickTitleInput) quickTitleInput.addEventListener("input", () => updateCategoryFromTitle(quickTitleInput, quickCategoryInput, "quick"));
if (titleInput) titleInput.addEventListener("input", () => updateCategoryFromTitle(titleInput, categoryInput));
[quickCurrencyInput, quickPaidByInput, quickCategoryInput].forEach(el => {
  if (el) el.addEventListener("change", saveQuickPrefs);
});
if (quickAddFab) {
  quickAddFab.addEventListener("click", () => {
    if (isTripLocked()) return assertTripOpen();
    activateExpensesTab("add");
    quickAddCard?.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => {
      if (quickTitleInput && !quickTitleInput.value) quickTitleInput.focus();
      else quickAmountInput?.focus();
    }, 250);
  });
}
addMemberBtn.addEventListener("click", addMember);
if (saveRatesBtn) saveRatesBtn.addEventListener("click", saveTripSettings);
if (baseCurrencyInput) baseCurrencyInput.addEventListener("change", () => {
  tripSettings.baseCurrency = baseCurrencyInput.value;
  renderRateEditor();
  updateCurrencySelectOptions();
});

if (ocrBtn) ocrBtn.addEventListener("click", runReceiptOCR);
if (confirmAiFillBtn) confirmAiFillBtn.addEventListener("click", applyAiResultToForm);
if (cancelAiFillBtn) cancelAiFillBtn.addEventListener("click", closeAiPreviewModal);

googleSignInBtn.addEventListener("click", handleGoogleSignIn);
signOutBtn.addEventListener("click", handleSignOut);
if (addAllowedEmailBtn) addAllowedEmailBtn.addEventListener("click", addAllowedEmail);
if (addAdminEmailBtn) addAdminEmailBtn.addEventListener("click", addAdminEmail);

[exportExcelBtn, exportExcelReportBtn].forEach(button => {
  if (button) button.dataset.action = "export-excel";
});

[exportJsonBtn, exportJsonBackupBtn].forEach(button => {
  if (button) button.dataset.action = "export-json";
});

// Export buttons can appear in more than one desktop/mobile section.
// Use data-action delegation instead of binding a single ID, so every matching button works.
document.addEventListener("click", (event) => {
  const exportJsonButton = event.target.closest('[data-action="export-json"]');
  if (exportJsonButton) {
    event.preventDefault();
    handleExportJsonBackup();
    return;
  }

  const exportExcelButton = event.target.closest('[data-action="export-excel"]');
  if (exportExcelButton) {
    event.preventDefault();
    handleExportExcel();
  }
});
if (lockTripBtn) lockTripBtn.addEventListener("click", lockTrip);
if (unlockTripBtn) unlockTripBtn.addEventListener("click", unlockTrip);

async function startExpenseCloudIfAllowed() {
  if (expensesModuleSuspendedForTripSwitch) return;
  if (!currentUser) return;
  const access = expenseAccessState();
  phase2TripAccessTripId = access.accessTripId || phase2TripAccessTripId;
  phase2TripAccessReady = access.ready;
  phase2TripRole = access.role || null;

  if (!access.ready) {
    cloudExpenseStarted = false;
    setModuleStatus("Confirming Trip access");
    updateTripStatusUi();
    scheduleExpenseAccessRecovery();
    return;
  }

  clearExpenseAccessRecoveryTimer();
  expenseAccessRecoveryAttempt = 0;

  if (!phase2TripRole) {
    cloudExpenseStarted = false;
    // access.ready + role:null is now an authoritative no-membership state.
    // Do not expose or invent a participant list for an unauthorised account.
    members = []; expenseMembersSource = "none"; initMembers();
    renderRateEditor();
    renderAllowedEmails();
    renderAdminEmails();
    tripStatus = "unknown";
    setModuleStatus("No Trip access");
    updateTripStatusUi();
    return;
  }

  if (cloudExpenseStarted) {
    updateTripStatusUi();
    return;
  }

  // v7.9.2.9 · Attach the canonical realtime listeners immediately after
  // verified Trip access. The legacy members/settings preparation may involve
  // one or two getDoc() calls and must never sit in front of Backup freshness.
  // This also removes the old permanent-hang state where cloudExpenseStarted
  // was set before an await and every later retry silently returned.
  const bindingEpoch = expenseBindingEpoch;
  const bindingTripId = tripId;
  setModuleStatus(`Connected · ${phase2TripRole}`);
  void hydrateRecentExpensesFromLocalFirestoreCache();
  initMembers();
  renderRateEditor();
  renderAllowedEmails();
  renderAdminEmails();
  startTripListener();
  startExpenseSettingsListener();
  listenToExpenses();
  listenToSettlements();
  listenToActivityLogs();
  cloudExpenseStarted = true;
  updateTripStatusUi();

  try {
    await ensureTripMembersAndSettings();
    if (bindingEpoch !== expenseBindingEpoch || bindingTripId !== tripId || expensesModuleSuspendedForTripSwitch) return;
    initMembers();
    renderRateEditor();
    renderAllowedEmails();
    renderAdminEmails();
    updateTripStatusUi();
  } catch (error) {
    if (bindingEpoch !== expenseBindingEpoch || bindingTripId !== tripId) return;
    console.error(error);
    // Realtime listeners remain authoritative and retryable even if this legacy
    // preparation step fails. Access enforcement continues to come from the
    // canonical Trip access service and Firestore Rules.
    setModuleStatus(error?.code === "permission-denied" ? "Waiting for Firestore Rules" : "Init error");
    updateTripStatusUi();
  }
}


window.addEventListener("app-trip-access", event => {
  const detail = event.detail || {};
  const eventTripId = String(detail.tripId || "");
  if (eventTripId !== tripId) return;

  phase2TripAccessTripId = eventTripId;
  phase2TripAccessReady = detail.ready === true;
  phase2TripRole = detail.role || null;
  if (phase2TripAccessReady) {
    clearExpenseAccessRecoveryTimer();
    expenseAccessRecoveryAttempt = 0;
  }
  updateTripStatusUi();
  if (currentUser) startExpenseCloudIfAllowed();
});

subscribeAuthState(async (user) => {
  currentUser = user;
  setAuthUI(user);

  if (!user) {
    phase2TripRole = null;
    phase2TripAccessReady = Boolean(window.__appTripAccess?.ready);
    phase2TripAccessTripId = String(window.__appTripAccess?.tripId || "");
    clearExpenseAccessRecoveryTimer();
    expenseAccessRecoveryAttempt = 0;
    clearExpenseRealtimeRetry();
    expenseRealtimeRetryAttempt = 0;
    cloudExpenseStarted = false;
    setModuleStatus("Please sign in");
    if (stopTripListener) stopTripListener();
    if (stopExpenseSettingsListener) stopExpenseSettingsListener();
    if (stopExpensesListener) stopExpensesListener();
    if (stopSettlementsListener) stopSettlementsListener();
    if (stopActivityLogsListener) stopActivityLogsListener();
    allExpenses = [];
    expenses = [];
    lastExpenseRenderSignature = "";
    recentExpenseCacheHydrationStarted = false;
    recentExpensesLiveReady = false;
    settlementsLiveReady = false;
    activityLogsLiveReady = false;
    resetBackupSyncMeta();
    pendingExcelExportRequested = false;
    pendingExcelExportStartedAt = 0;
    clearPendingExcelExportTimer();
    settlements = [];
    activityLogs = [];
    tripStatus = "open";
    tripLockedAt = null;
    tripLockedBy = null;
    tripLockedByName = "";
    tripCreatorUid = null;
    tripAdminUids = [];
    adminEmailsCache = [];
    allowedEmailsCache = [];
    renderExpenses();
    renderDeletedExpenses();
    renderAllowedEmails();
    renderActivityLogs();
    updateTripStatusUi();
    summary.innerHTML = "";
    if (analyticsSummary) analyticsSummary.innerHTML = "";
    return;
  }

  phase2TripAccessReady = window.__appTripAccess?.ready === true;
  phase2TripAccessTripId = String(window.__appTripAccess?.tripId || "");
  phase2TripRole = window.__appTripAccess?.role || null;
  await startExpenseCloudIfAllowed();
});

window.__rebindExpensesForTrip = async function rebindExpensesModuleForTrip(nextTripData){
  const nextTripId = resolveTripId(nextTripData);
  if (!nextTripId) return false;
  if (nextTripId === tripId) {
    expensesModuleSuspendedForTripSwitch = false;
    window.__expensesModuleSuspended = false;
    if (currentUser) await startExpenseCloudIfAllowed();
    return true;
  }

  // Phase 3A.3.1: Trip switches intentionally suspend the old Expense listeners
  // before the new Trip is painted. Rebind that already-loaded module in place so
  // Data Management can continue observing the same canonical autosync sources
  // without a page reload or Backup-only Firestore reads.
  expenseBindingEpoch += 1;
  expensesModuleSuspendedForTripSwitch = true;
  cloudExpenseStarted = false;
  clearExpenseAccessRecoveryTimer();
  expenseAccessRecoveryAttempt = 0;
  clearExpenseRealtimeRetry();
  expenseRealtimeRetryAttempt = 0;
  for (const stop of [stopTripListener, stopExpenseSettingsListener, stopExpensesListener, stopSettlementsListener, stopActivityLogsListener]) {
    try { stop?.(); } catch (error) {}
  }
  stopTripListener = null;
  stopExpenseSettingsListener = null;
  stopExpensesListener = null;
  stopSettlementsListener = null;
  stopActivityLogsListener = null;

  tripId = nextTripId;
  expensesConfig = nextTripData?.meta?.expenses || {};
  tripSettings = settingsFromExpensesConfig(expensesConfig);
  window.__expensesModuleTripId = tripId;
  if (aboutTripIdText) aboutTripIdText.textContent = tripId;

  members = [];
  expenseMembersSettingsResolved = false;
  expenseMembersSettingsCanonical = false;
  expenseMembersSettingsFallback = [];
  expenseMembersCanonicalVersion = 0;
  expenseMembersRootResolved = false;
  expenseMembersRootFallback = [];
  expenseMembersSchemaVersion = Number(nextTripData?.schemaVersion || nextTripData?.meta?.schemaVersion || 2) || 2;
  expenseMembersSource = "none";
  allExpenses = [];
  expenses = [];
  lastExpenseRenderSignature = "";
  settlements = [];
  activityLogs = [];
  recentExpenseCacheHydrationStarted = false;
  recentExpensesLiveReady = false;
  settlementsLiveReady = false;
  activityLogsLiveReady = false;
  resetBackupSyncMeta();
  pendingExcelExportRequested = false;
  pendingExcelExportStartedAt = 0;
  clearPendingExcelExportTimer();
  tripStatus = "open";
  tripLockedAt = null;
  tripLockedBy = null;
  tripLockedByName = "";
  expenseLockExplicit = false;
  legacyExpenseLock = { locked:false, lockedAt:null, lockedBy:null, lockedByName:"" };
  globalTripLocked = nextTripData?.meta?.globalLocked === true;
  editingExpenseId = null;
  tripAllowedUids = [];
  tripCreatorUid = null;
  tripAdminUids = [];
  adminEmailsCache = [];
  allowedEmailsCache = [];
  analyticsSelectedCategories = null;

  phase2TripAccessReady = window.__appTripAccess?.ready === true;
  phase2TripAccessTripId = String(window.__appTripAccess?.tripId || "");
  phase2TripRole = window.__appTripAccess?.role || null;
  expensesModuleSuspendedForTripSwitch = false;
  window.__expensesModuleSuspended = false;

  renderExpenses();
  renderDeletedExpenses();
  renderAllowedEmails();
  renderAdminEmails();
  renderActivityLogs();
  renderSummary();
  renderAnalytics();
  updateTripStatusUi();

  if (currentUser) await startExpenseCloudIfAllowed();
  return true;
};

window.__suspendExpensesForTripSwitch = function suspendExpensesModuleForTripSwitch(){
  expenseBindingEpoch += 1;
  expensesModuleSuspendedForTripSwitch = true;
  cloudExpenseStarted = false;
  clearExpenseAccessRecoveryTimer();
  expenseAccessRecoveryAttempt = 0;
  clearExpenseRealtimeRetry();
  expenseRealtimeRetryAttempt = 0;
  for (const stop of [stopTripListener, stopExpenseSettingsListener, stopExpensesListener, stopSettlementsListener, stopActivityLogsListener]) {
    try { stop?.(); } catch (error) {}
  }
  stopTripListener = null;
  stopExpenseSettingsListener = null;
  stopExpensesListener = null;
  stopSettlementsListener = null;
  stopActivityLogsListener = null;
  recentExpensesLiveReady = false;
  settlementsLiveReady = false;
  activityLogsLiveReady = false;
  resetBackupSyncMeta();
  window.__expensesModuleSuspended = true;
  return true;
};

}

window.initExpensesModule = initExpensesModule;
if (document.body.classList.contains("expenses-view-active") && window.tripData?.meta?.expenses?.enabled) {
  initExpensesModule(window.tripData);
}
