/**
 * つぎ何分？ - 電車カウントダウン Web App
 * - 今が平日か土日祝かを自動認識して明示表示
 * - 登録のタイミングで「1つの方面」を選択して登録し、登録した方面のみを表示
 * - 次の電車・その次の電車まであと何分かを大きく表示
 * - 端末ごとに localStorage + Cookie の二重保存で記憶＆ダイヤ改正自動追従
 */

const APP_VERSION = 'Ver 1.3';
const STORAGE_KEY = 'train_countdown_single_dir_v2';
const LEGACY_STORAGE_KEY = 'train_countdown_data_v1';
const COOKIE_META_KEY = 'train_countdown_meta_v2';
const AUTO_UPDATE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14日ごとに自動チェック

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// 状態管理
const state = {
  entries: [],          // 登録済み「駅＋路線＋1方面」リスト
  activeEntryId: null,  // 現在表示中のエントリーID
  isUpdating: false,
};

// ==========================================
// 1. 平日 / 土日祝 の自動認識ロジック
// ==========================================
function isJapaneseHoliday(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = date.getDay(); // 0:Sun, 1:Mon ...

  // 固定祝日
  const fixed = {
    '1-1': '元日',
    '2-11': '建国記念の日',
    '2-23': '天皇誕生日',
    '4-29': '昭和の日',
    '5-3': '憲法記念日',
    '5-4': 'みどりの日',
    '5-5': 'こどもの日',
    '8-11': '山の日',
    '11-3': '文化の日',
    '11-23': '勤労感謝の日',
  };
  if (fixed[`${m}-${d}`]) return true;

  // 春分の日・秋分の日（2000-2099）
  const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  if (m === 3 && d === vernal) return true;
  if (m === 9 && d === autumnal) return true;

  // ハッピーマンデー
  const nthMonday = Math.ceil(d / 7);
  if (w === 1) {
    if (m === 1 && nthMonday === 2) return true;  // 成人の日
    if (m === 7 && nthMonday === 3) return true;  // 海の日
    if (m === 9 && nthMonday === 3) return true;  // 敬老の日
    if (m === 10 && nthMonday === 2) return true; // スポーツの日
  }

  return false;
}

/**
 * 指定された日付が 'weekday' | 'saturday' | 'holiday' のどれかを自動判定
 */
function detectCalendarDiaInfo(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const day = date.getDay();
  const dayStr = DAY_NAMES[day];

  // 日曜または祝日・振替休日
  let isHoliday = day === 0 || isJapaneseHoliday(date);
  if (!isHoliday && day === 1) {
    const yesterday = new Date(date);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isJapaneseHoliday(yesterday)) isHoliday = true;
  }

  if (isHoliday) {
    return {
      diaKey: 'holiday',
      isWeekend: true,
      shortLabel: '土日祝（休日ダイヤ）',
      fullBadgeText: `${m}/${d}(${dayStr}) 土日祝ダイヤ`,
    };
  }
  if (day === 6) {
    return {
      diaKey: 'saturday',
      isWeekend: true,
      shortLabel: '土日（土曜ダイヤ）',
      fullBadgeText: `${m}/${d}(${dayStr}) 土日ダイヤ`,
    };
  }
  return {
    diaKey: 'weekday',
    isWeekend: false,
    shortLabel: '平日ダイヤ',
    fullBadgeText: `${m}/${d}(${dayStr}) 平日ダイヤ`,
  };
}

// ==========================================
// 2. ストレージ保存・復元 (localStorage + Cookie 二重化)
// ==========================================
function setCookie(name, value, days = 400) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function saveState() {
  try {
    const payload = {
      activeEntryId: state.activeEntryId,
      entries: state.entries,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

    // Cookieには軽量メタ情報（万一キャッシュクリアされた際の自動再取得用）を保存
    const meta = {
      activeEntryId: state.activeEntryId,
      entries: state.entries.map((e) => ({
        id: e.id,
        stationId: e.stationId,
        stationName: e.stationName,
        railName: e.railName,
        groupId: e.groupId,
        directionName: e.directionName,
      })),
    };
    setCookie(COOKIE_META_KEY, JSON.stringify(meta));
  } catch (err) {
    console.warn('Storage save warning:', err);
  }
}

async function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
        state.entries = parsed.entries;
        state.activeEntryId = parsed.activeEntryId || state.entries[0].id;
        return;
      }
    }

    // 旧バージョン(両方向保存)のデータがあれば、1方面ずつのエントリーに自動変換
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      if (Array.isArray(legacy.entries) && legacy.entries.length > 0) {
        const migrated = [];
        for (const oldEntry of legacy.entries) {
          for (const dir of oldEntry.directions || []) {
            migrated.push({
              id: `${oldEntry.stationId}_${dir.groupId}`,
              stationId: oldEntry.stationId,
              stationName: oldEntry.stationName,
              railName: oldEntry.railName,
              groupId: dir.groupId,
              directionName: dir.directionName,
              timetables: dir.timetables,
              updatedAt: oldEntry.updatedAt || Date.now(),
              diaVersion: oldEntry.diaVersion || '',
            });
          }
        }
        if (migrated.length > 0) {
          state.entries = [migrated[0]]; // 最初の1方面のみを有効化
          state.activeEntryId = migrated[0].id;
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          saveState();
          return;
        }
      }
    }

    // localStorageが空でもCookieにメタ情報が残っていれば自動復元
    const cookieRaw = getCookie(COOKIE_META_KEY);
    if (cookieRaw) {
      const meta = JSON.parse(cookieRaw);
      if (Array.isArray(meta.entries) && meta.entries.length > 0) {
        showToast('Cookieから登録済みの駅・方面を復元しています...');
        for (const item of meta.entries) {
          if (item.stationId && item.groupId) {
            try {
              const entry = await fetchSingleDirectionEntry(
                item.stationId,
                item.stationName,
                item.railName,
                item.groupId,
                item.directionName
              );
              state.entries.push(entry);
            } catch (e) {
              console.warn('Restore failed for', item, e);
            }
          }
        }
        if (state.entries.length > 0) {
          state.activeEntryId = meta.activeEntryId || state.entries[0].id;
          saveState();
        }
      }
    }
  } catch (err) {
    console.warn('Storage load error:', err);
  }
}

// ==========================================
// 3. ネットからの時刻表取得 (Yahoo!路線情報 __NEXT_DATA__)
// ==========================================
async function fetchYahooNextData(targetUrl) {
  const attempts = [
    async () => {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: {
          'X-Return-Format': 'html',
          'X-Engine': 'direct',
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    },
    async () => {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'X-Return-Format': 'html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    },
    async () => {
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      const html = await attempt();
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (match && match[1]) {
        return JSON.parse(match[1]);
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('時刻表データの取得に失敗しました');
}

/**
 * 駅名で検索し、候補駅リストまたは直接路線リストを返す
 */
async function searchStationByName(query) {
  const url = `https://transit.yahoo.co.jp/timetable/search?q=${encodeURIComponent(query.trim())}`;
  const nextData = await fetchYahooNextData(url);

  if (nextData.page === '/timetable/[stationId]') {
    const stationId = nextData.query?.stationId;
    const detail = nextData.props?.pageProps?.directionDetail;
    return {
      directStation: {
        stationId,
        stationName: detail?.stationName || query.trim(),
        routes: normalizeRouteInfos(detail?.directionItem?.routeInfos || []),
      },
      candidates: [],
    };
  }

  const features = nextData.props?.pageProps?.stationFeatures || [];
  const seen = new Set();
  const candidates = [];

  for (const f of features) {
    const stationId =
      f?.Internal?.Detail?.StationId ||
      f?.Property?.Detail?.StationId ||
      JSON.stringify(f).match(/"StationId":"(\d+)"/)?.[1];
    if (!stationId || seen.has(stationId)) continue;
    seen.add(stationId);
    candidates.push({
      stationId,
      stationName: f.Name || '不明',
      yomi: f.Yomi || '',
      address: f.Address || '',
    });
  }

  return { directStation: null, candidates };
}

/**
 * 路線一覧の正規化（各路線の方面リストを整理）
 */
function normalizeRouteInfos(routeInfos) {
  const groupedMap = new Map();

  for (const info of routeInfos) {
    const rawName = info.railName || '';
    const baseName = rawName.replace(/(外回り|内回り)$/, '');
    if (!groupedMap.has(baseName)) {
      groupedMap.set(baseName, {
        railName: baseName,
        directions: [],
      });
    }
    const group = groupedMap.get(baseName);
    for (const rg of info.railGroup || []) {
      const suffix = rawName !== baseName ? `（${rawName.replace(baseName, '')}）` : '';
      group.directions.push({
        groupId: rg.groupId,
        directionName: `${rg.direction}方面${suffix}`,
      });
    }
  }

  return Array.from(groupedMap.values());
}

/**
 * 指定した stationId の路線・方面一覧を取得
 */
async function fetchStationRoutes(stationId) {
  const url = `https://transit.yahoo.co.jp/timetable/${stationId}`;
  const nextData = await fetchYahooNextData(url);
  const detail = nextData.props?.pageProps?.directionDetail;
  return {
    stationId,
    stationName: detail?.stationName || '',
    routes: normalizeRouteInfos(detail?.directionItem?.routeInfos || []),
  };
}

/**
 * 選択された「1つの方面 (stationId + groupId)」のみの平日(1)・土曜(2)・日祝(4) の時刻表を取得
 */
async function fetchSingleDirectionEntry(stationId, stationName, railName, groupId, directionName) {
  const kinds = [
    { key: 'weekday', code: 1 },
    { key: 'saturday', code: 2 },
    { key: 'holiday', code: 4 },
  ];

  const results = await Promise.all(
    kinds.map(async ({ key, code }) => {
      const url = `https://transit.yahoo.co.jp/timetable/${stationId}/${groupId}?kind=${code}`;
      const nextData = await fetchYahooNextData(url);
      const item = nextData.props?.pageProps?.timetableItem;
      const kousyou = nextData.props?.pageProps?.kousyouResult?.detail?.jr || '';
      const trains = [];

      for (const hObj of item?.hourTimeTable || []) {
        const hour = parseInt(hObj.hour, 10);
        if (isNaN(hour)) continue;
        for (const mObj of hObj.minTimeTable || []) {
          const minute = parseInt(mObj.minute, 10);
          if (isNaN(minute)) continue;
          trains.push({
            h: hour,
            m: minute,
            type: mObj.trainName || '普通',
          });
        }
      }

      trains.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));

      return {
        key,
        trains,
        directionName: item?.directionName ? `${item.directionName}方面` : directionName,
        kousyou,
      };
    })
  );

  const timetables = {
    weekday: [],
    saturday: [],
    holiday: [],
  };
  let resolvedDirName = directionName;
  let kousyouText = '';

  for (const r of results) {
    timetables[r.key] = r.trains;
    if (!resolvedDirName && r.directionName) resolvedDirName = r.directionName;
    if (r.kousyou) kousyouText = r.kousyou;
  }

  return {
    id: `${stationId}_${groupId}`,
    stationId,
    stationName,
    railName,
    groupId,
    directionName: resolvedDirName,
    timetables,
    updatedAt: Date.now(),
    diaVersion: kousyouText || `${new Date().getFullYear()}年${new Date().getMonth() + 1}月取得`,
  };
}

// ==========================================
// 4. ダイヤ改正の自動追従チェック
// ==========================================
function needsDiaAutoUpdate(entry) {
  if (!entry || !entry.updatedAt) return true;
  const now = new Date();
  const last = new Date(entry.updatedAt);

  if (now.getTime() - last.getTime() > AUTO_UPDATE_INTERVAL_MS) {
    return true;
  }

  // 日本の鉄道ダイヤ改正月（3月・10月）を跨いだ場合も自動更新
  if (
    (now.getMonth() === 2 || now.getMonth() === 9) &&
    (now.getMonth() !== last.getMonth() || now.getFullYear() !== last.getFullYear())
  ) {
    return true;
  }

  return false;
}

async function refreshActiveEntryTimetable(isSilent = false) {
  const entry = getActiveEntry();
  if (!entry || state.isUpdating) return;

  state.isUpdating = true;
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.classList.add('spinning');
  if (!isSilent) {
    showToast(`「${entry.stationName}駅（${entry.directionName}）」の最新ダイヤを取得中...`);
  }

  try {
    const updated = await fetchSingleDirectionEntry(
      entry.stationId,
      entry.stationName,
      entry.railName,
      entry.groupId,
      entry.directionName
    );

    const idx = state.entries.findIndex((e) => e.id === entry.id);
    if (idx !== -1) {
      state.entries[idx] = updated;
      saveState();
      renderAll();
      showToast('最新の時刻表データに更新しました ✨', 3000);
    }
  } catch (err) {
    console.warn('Auto update error:', err);
    if (!isSilent) {
      showToast('更新に失敗しました（保存済みキャッシュを引き続き使用します）', 4000);
    }
  } finally {
    state.isUpdating = false;
    if (icon) icon.classList.remove('spinning');
  }
}

// ==========================================
// 5. 次の電車・その次の電車のカウントダウン計算
// ==========================================
function getNextTwoTrains(entry, now = new Date()) {
  const curH = now.getHours();
  const curM = now.getMinutes();
  const curS = now.getSeconds();
  const upcoming = [];

  // 深夜 0:00〜2:59 の場合、まず前日深夜枠(24時〜26時)の残りの電車をチェック
  if (curH < 3) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yDia = detectCalendarDiaInfo(yesterday);
    const yList = entry.timetables?.[yDia.diaKey] || [];
    const lateNowSeconds = ((curH + 24) * 60 + curM) * 60 + curS;

    for (const t of yList) {
      if (t.h < 24) continue;
      const depSeconds = (t.h * 60 + t.m) * 60;
      const diffSeconds = depSeconds - lateNowSeconds;
      if (diffSeconds >= -15) {
        upcoming.push({
          ...t,
          diffSeconds: Math.max(0, diffSeconds),
          diffMinutes: Math.ceil(Math.max(0, diffSeconds) / 60),
          labelNote: '',
        });
        if (upcoming.length >= 2) return upcoming;
      }
    }
  }

  // 当日（0:00〜2:59で深夜便が終わった後は当日の朝始発以降）のダイヤをチェック
  const todayDia = detectCalendarDiaInfo(now);
  const todayList = entry.timetables?.[todayDia.diaKey] || [];
  const todayNowSeconds = (curH * 60 + curM) * 60 + curS;

  for (const t of todayList) {
    const depSeconds = (t.h * 60 + t.m) * 60;
    const diffSeconds = depSeconds - todayNowSeconds;
    if (diffSeconds >= -15) {
      upcoming.push({
        ...t,
        diffSeconds: Math.max(0, diffSeconds),
        diffMinutes: Math.ceil(Math.max(0, diffSeconds) / 60),
        labelNote: curH < 3 && t.h < 12 ? '（始発）' : '',
      });
      if (upcoming.length >= 2) return upcoming;
    }
  }

  // 23時以降などで当日分が残り1本以下なら、翌朝の始発以降を補完
  if (upcoming.length < 2) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomDia = detectCalendarDiaInfo(tomorrow);
    const tomList = entry.timetables?.[tomDia.diaKey] || [];

    for (const t of tomList) {
      if (upcoming.length >= 2) break;
      const depSeconds = ((t.h + 24) * 60 + t.m) * 60;
      const diffSeconds = depSeconds - todayNowSeconds;
      if (diffSeconds > 0) {
        upcoming.push({
          ...t,
          diffSeconds,
          diffMinutes: Math.ceil(diffSeconds / 60),
          labelNote: '（翌朝）',
        });
      }
    }
  }

  return upcoming;
}

function formatDisplayTime(h, m) {
  const normH = h >= 24 ? h - 24 : h;
  return `${String(normH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ==========================================
// 6. UI レンダリング
// ==========================================
function getActiveEntry() {
  if (!state.entries.length) return null;
  return state.entries.find((e) => e.id === state.activeEntryId) || state.entries[0];
}

function renderHeader(now = new Date()) {
  const clockEl = document.getElementById('currentClock');
  if (clockEl) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${hh}:${mm}:${ss}`;
  }

  // 今日が平日か土日祝かを自動認識してバッジ表示
  const diaBadge = document.getElementById('autoDiaBadge');
  if (diaBadge) {
    const diaInfo = detectCalendarDiaInfo(now);
    diaBadge.textContent = `📅 ${diaInfo.fullBadgeText}`;
    diaBadge.classList.toggle('is-weekend', diaInfo.isWeekend);
    diaBadge.classList.toggle('is-weekday', !diaInfo.isWeekend);
  }
}

function renderTabs() {
  const nav = document.getElementById('stationTabs');
  if (!nav) return;

  if (state.entries.length <= 1) {
    nav.hidden = true;
    nav.innerHTML = '';
    return;
  }

  nav.hidden = false;
  nav.innerHTML = state.entries
    .map((entry) => {
      const isActive = entry.id === state.activeEntryId;
      return `<button type="button" class="station-tab ${isActive ? 'active' : ''}" data-entry-id="${escapeHtml(entry.id)}">
        ${escapeHtml(entry.stationName)}（${escapeHtml(entry.directionName)}）
      </button>`;
    })
    .join('');

  nav.querySelectorAll('.station-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeEntryId = btn.dataset.entryId;
      saveState();
      renderAll();
    });
  });
}

function renderMainCountdown(now = new Date()) {
  const container = document.getElementById('mainContent');
  const footerText = document.getElementById('diaVersionText');
  if (!container) return;

  const entry = getActiveEntry();
  if (!entry) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🚉</div>
        <h2>この端末で表示する「駅」と「方面」を登録してください</h2>
        <p>
          登録時に<strong>駅と乗る方面（方向）</strong>を選ぶだけでブラウザに記憶され、次回からはリンクを開いた瞬間に<strong>登録した方面の「次の電車」「その次の電車」まであと何分か</strong>だけが表示されます。
        </p>
        <button type="button" class="cta-btn" id="btnEmptyAddStation">＋ 駅・方面を登録する</button>
      </div>
    `;
    document.getElementById('btnEmptyAddStation')?.addEventListener('click', openSettingsDialog);
    if (footerText) footerText.textContent = '未登録 — 端末ごとに異なる駅・方面を登録できます';
    return;
  }

  const diaInfo = detectCalendarDiaInfo(now);
  const upcoming = getNextTwoTrains(entry, now);
  const first = upcoming[0];
  const second = upcoming[1];
  const cleanDirName = (entry.directionName || '').replace(/方面$/, '');

  // 1本目（次の電車）
  let firstHtml = '';
  if (!first) {
    firstHtml = `
      <div class="next-train-box">
        <div class="train-box-top">
          <span class="badge-next">次の電車</span>
          <span class="train-dep-meta">時刻表データがありません</span>
        </div>
        <div class="countdown-display">
          <span class="countdown-number">--</span>
        </div>
      </div>
    `;
  } else {
    const isImminent = first.diffSeconds < 60;
    const isUrgent = first.diffMinutes <= 3 && !isImminent;
    const remSec = first.diffSeconds % 60;

    firstHtml = `
      <div class="next-train-box">
        <div class="train-box-top">
          <span class="badge-next">次の電車${escapeHtml(first.labelNote || '')}</span>
          <div class="train-dep-meta">
            <span>${formatDisplayTime(first.h, first.m)}発</span>
            <span class="train-type-tag">${escapeHtml(first.type)}</span>
          </div>
        </div>
        <div class="countdown-display">
          ${
            isImminent
              ? `<span class="countdown-number imminent">まもなく</span>
                 <span class="countdown-sec">(${first.diffSeconds}秒)</span>`
              : `<span class="countdown-prefix">あと</span>
                 <span class="countdown-number ${isUrgent ? 'urgent' : ''}">${first.diffMinutes}</span>
                 <span class="countdown-unit">分</span>
                 <span class="countdown-sec">${String(remSec).padStart(2, '0')}秒</span>`
          }
        </div>
      </div>
    `;
  }

  // 2本目（その次の電車）
  let secondHtml = '';
  if (second) {
    secondHtml = `
      <div class="after-next-box">
        <div class="train-box-top">
          <span class="badge-after">その次の電車${escapeHtml(second.labelNote || '')}</span>
          <div class="train-dep-meta">
            <span>${formatDisplayTime(second.h, second.m)}発</span>
            <span class="train-type-tag">${escapeHtml(second.type)}</span>
          </div>
        </div>
        <div class="countdown-display">
          <span class="countdown-prefix">あと</span>
          <span class="after-countdown-number">${second.diffMinutes}</span>
          <span class="countdown-unit">分</span>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="station-banner">
      <h1 class="station-title">
        <span>${escapeHtml(entry.stationName)}駅</span>
        <span class="rail-badge">${escapeHtml(entry.railName)}</span>
      </h1>
    </div>

    <article class="direction-card">
      <div class="direction-header">
        <div class="direction-label">
          <span class="direction-arrow">➔</span>
          <span class="direction-name">${escapeHtml(cleanDirName)}</span>
          <span class="direction-suffix">方面</span>
        </div>
      </div>
      ${firstHtml}
      ${secondHtml}
    </article>
  `;

  if (footerText) {
    const updatedDate = entry.updatedAt
      ? new Date(entry.updatedAt).toLocaleDateString('ja-JP')
      : '';
    footerText.textContent = `${entry.diaVersion || '時刻表キャッシュ済'}（最終同期: ${updatedDate}・ダイヤ改正自動追従）`;
  }
}

function renderRegisteredListInDialog() {
  const listEl = document.getElementById('registeredStationsList');
  if (!listEl) return;

  if (state.entries.length === 0) {
    listEl.innerHTML = `<p class="sub-label">まだ登録されている駅・方面はありません。</p>`;
    return;
  }

  listEl.innerHTML = state.entries
    .map((entry) => {
      return `
        <div class="registered-item">
          <div>
            <div class="registered-item-title">${escapeHtml(entry.stationName)}駅 — ${escapeHtml(entry.railName)}</div>
            <div class="registered-item-sub">➔ ${escapeHtml(entry.directionName)}</div>
          </div>
          <button type="button" class="delete-btn" data-delete-id="${escapeHtml(entry.id)}">削除</button>
        </div>
      `;
    })
    .join('');

  listEl.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteId;
      state.entries = state.entries.filter((e) => e.id !== id);
      if (state.activeEntryId === id) {
        state.activeEntryId = state.entries[0]?.id || null;
      }
      saveState();
      renderAll();
      renderRegisteredListInDialog();
    });
  });
}

function renderAll() {
  const now = new Date();
  renderHeader(now);
  renderTabs();
  renderMainCountdown(now);
}

// ==========================================
// 7. 駅検索・方面選択モーダル操作
// ==========================================
function openSettingsDialog() {
  const dialog = document.getElementById('settingsDialog');
  if (!dialog) return;
  renderRegisteredListInDialog();
  dialog.showModal();
  document.getElementById('stationSearchInput')?.focus();
}

function closeSettingsDialog() {
  const dialog = document.getElementById('settingsDialog');
  if (dialog?.open) dialog.close();
}

function setSearchStatus(message, isError = false) {
  const el = document.getElementById('searchStatus');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle('error', isError);
}

/**
 * 登録タイミングで「どの方面か」を1つ選んで登録するUI
 */
function renderRouteSelection(stationId, stationName, routes) {
  const area = document.getElementById('routeCandidatesArea');
  const label = document.getElementById('selectedStationLabel');
  const list = document.getElementById('routeCandidatesList');
  if (!area || !list) return;

  if (label) {
    label.textContent = `2. 「${stationName}駅」で表示したい方面を選んで登録してください：`;
  }

  if (!routes.length) {
    list.innerHTML = `<p class="sub-label">路線が見つかりませんでした。</p>`;
    area.hidden = false;
    return;
  }

  list.innerHTML = routes
    .map((r, rIdx) => {
      const dirBtnsHtml = r.directions
        .map(
          (d, dIdx) => `
          <button
            type="button"
            class="register-dir-btn"
            data-route-idx="${rIdx}"
            data-dir-idx="${dIdx}"
          >
            <span>➔ ${escapeHtml(d.directionName)}</span>
            <span class="action-tag">この方面を登録</span>
          </button>
        `
        )
        .join('');

      return `
        <div class="route-group-card">
          <div class="route-name">${escapeHtml(r.railName)}</div>
          <div class="direction-select-buttons">
            ${dirBtnsHtml}
          </div>
        </div>
      `;
    })
    .join('');

  area.hidden = false;

  list.querySelectorAll('.register-dir-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const route = routes[Number(btn.dataset.routeIdx)];
      const dir = route?.directions?.[Number(btn.dataset.dirIdx)];
      if (!route || !dir) return;

      btn.disabled = true;
      const tagEl = btn.querySelector('.action-tag');
      if (tagEl) tagEl.textContent = '取得中...';
      setSearchStatus(
        `「${stationName}駅（${route.railName}・${dir.directionName}）」の時刻表を取得しています（約2秒）...`
      );

      try {
        const newEntry = await fetchSingleDirectionEntry(
          stationId,
          stationName,
          route.railName,
          dir.groupId,
          dir.directionName
        );

        // この端末で1駅1方面をシンプルに表示するため、同じIDがあれば上書き、または先頭に設定
        const existingIdx = state.entries.findIndex((e) => e.id === newEntry.id);
        if (existingIdx !== -1) {
          state.entries[existingIdx] = newEntry;
        } else {
          // 既に登録がある場合は上書き登録（複数タブを増やさず選んだ1方面のみを即表示）
          state.entries = [newEntry];
        }

        state.activeEntryId = newEntry.id;
        saveState();
        renderAll();
        renderRegisteredListInDialog();
        setSearchStatus('');
        showToast(`「${stationName}駅（${dir.directionName}）」を登録しました！`);
        closeSettingsDialog();
      } catch (err) {
        console.error(err);
        setSearchStatus('時刻表の取得に失敗しました。もう一度お試しください。', true);
        btn.disabled = false;
        if (tagEl) tagEl.textContent = 'この方面を登録';
      }
    });
  });
}

// ==========================================
// 8. ユーティリティ & 初期化
// ==========================================
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(msg, duration = 3200) {
  const toast = document.getElementById('statusToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

function setupEventListeners() {
  // ダイヤ手動更新ボタン
  document.getElementById('btnRefreshDia')?.addEventListener('click', () => {
    if (!state.entries.length) {
      openSettingsDialog();
      return;
    }
    refreshActiveEntryTimetable(false);
  });

  // 設定モーダル開閉
  document.getElementById('btnOpenSettings')?.addEventListener('click', openSettingsDialog);
  document.getElementById('btnCloseSettings')?.addEventListener('click', closeSettingsDialog);
  document.getElementById('settingsDialog')?.addEventListener('click', (e) => {
    if (e.target.id === 'settingsDialog') closeSettingsDialog();
  });

  // 駅検索フォーム送信
  document.getElementById('stationSearchForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('stationSearchInput');
    const query = input?.value?.trim();
    if (!query) return;

    const btn = document.getElementById('btnSearchStation');
    const stArea = document.getElementById('stationCandidatesArea');
    const rtArea = document.getElementById('routeCandidatesArea');
    if (stArea) stArea.hidden = true;
    if (rtArea) rtArea.hidden = true;

    if (btn) btn.disabled = true;
    setSearchStatus(`「${query}」を検索しています...`);

    try {
      const result = await searchStationByName(query);
      setSearchStatus('');

      if (result.directStation) {
        renderRouteSelection(
          result.directStation.stationId,
          result.directStation.stationName,
          result.directStation.routes
        );
      } else if (result.candidates.length > 0) {
        const listEl = document.getElementById('stationCandidatesList');
        if (listEl && stArea) {
          listEl.innerHTML = result.candidates
            .slice(0, 12)
            .map(
              (c) => `
              <button type="button" class="candidate-chip" data-st-id="${escapeHtml(c.stationId)}" data-st-name="${escapeHtml(c.stationName)}">
                ${escapeHtml(c.stationName)} <small style="color:#94a3b8">(${escapeHtml(c.address)})</small>
              </button>
            `
            )
            .join('');
          stArea.hidden = false;

          listEl.querySelectorAll('.candidate-chip').forEach((chip) => {
            chip.addEventListener('click', async () => {
              const stId = chip.dataset.stId;
              const stName = chip.dataset.stName;
              setSearchStatus(`「${stName}駅」の路線・方面一覧を取得中...`);
              try {
                const stRoutes = await fetchStationRoutes(stId);
                setSearchStatus('');
                renderRouteSelection(stId, stRoutes.stationName || stName, stRoutes.routes);
              } catch (err) {
                setSearchStatus('路線一覧の取得に失敗しました。', true);
              }
            });
          });
        }
      } else {
        setSearchStatus(`「${query}」に一致する駅が見つかりませんでした。`, true);
      }
    } catch (err) {
      console.error(err);
      setSearchStatus('検索中に通信エラーが発生しました。もう一度お試しください。', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 設定のJSON書き出し・読み込み
  document.getElementById('btnExportData')?.addEventListener('click', () => {
    const dataStr = JSON.stringify({ entries: state.entries, activeEntryId: state.activeEntryId }, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'train-timetable-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('btnImportData')?.addEventListener('click', () => {
    document.getElementById('importFileInput')?.click();
  });

  document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.entries)) {
        state.entries = parsed.entries;
        state.activeEntryId = parsed.activeEntryId || state.entries[0]?.id || null;
        saveState();
        renderAll();
        renderRegisteredListInDialog();
        showToast('設定ファイルを読み込みました！');
      }
    } catch (err) {
      alert('JSONファイルの形式が正しくありません。');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderAll();
    }
  });
}

// ==========================================
// 9. アプリ起動フロー
// ==========================================
async function initApp() {
  setupEventListeners();
  await loadState();
  renderAll();

  if (state.entries.length === 0) {
    openSettingsDialog();
  } else {
    const active = getActiveEntry();
    if (needsDiaAutoUpdate(active)) {
      refreshActiveEntryTimetable(true);
    }
  }

  setInterval(() => {
    const now = new Date();
    renderHeader(now);
    if (state.entries.length > 0) {
      renderMainCountdown(now);
    }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', initApp);
