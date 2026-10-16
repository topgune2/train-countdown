/**
 * つぎ何分？ - 電車カウントダウン Web App
 * - 端末ごとに localStorage + Cookie の二重保存で駅・時刻表を記憶
 * - Yahoo!路線情報 (__NEXT_DATA__) から平日・土曜・日祝ダイヤを自動取得
 * - ダイヤ改正時期（または一定期間経過後）にバックグラウンドで自動更新
 */

const STORAGE_KEY = 'train_countdown_data_v1';
const COOKIE_META_KEY = 'train_countdown_meta_v1';
const AUTO_UPDATE_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000; // 14日ごとに自動チェック

// 状態管理
const state = {
  entries: [],          // 登録済み駅・路線リスト
  activeEntryId: null,  // 現在表示中のエントリーID
  manualDiaType: null,  // nullなら曜日・祝日から自動判定 ('weekday' | 'saturday' | 'holiday')
  isUpdating: false,
};

// ==========================================
// 1. 日本の祝日・ダイヤ種別（平日/土曜/日祝）自動判定
// ==========================================
function isJapaneseHoliday(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const w = date.getDay(); // 0:Sun, 1:Mon ...

  // 固定祝日
  const fixed = {
    '1-1': true,   // 元日
    '2-11': true,  // 建国記念の日
    '2-23': true,  // 天皇誕生日
    '4-29': true,  // 昭和の日
    '5-3': true,   // 憲法記念日
    '5-4': true,   // みどりの日
    '5-5': true,   // こどもの日
    '8-11': true,  // 山の日
    '11-3': true,  // 文化の日
    '11-23': true, // 勤労感謝の日
  };
  if (fixed[`${m}-${d}`]) return true;

  // 春分の日・秋分の日（近似式 2000-2099）
  const vernal = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  const autumnal = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
  if (m === 3 && d === vernal) return true;
  if (m === 9 && d === autumnal) return true;

  // ハッピーマンデー（第n月曜日）
  const nthMonday = Math.ceil(d / 7);
  if (w === 1) {
    if (m === 1 && nthMonday === 2) return true;  // 成人の日
    if (m === 7 && nthMonday === 3) return true;  // 海の日
    if (m === 9 && nthMonday === 3) return true;  // 敬老の日
    if (m === 10 && nthMonday === 2) return true; // スポーツの日
  }

  return false;
}

function getServiceDate(now) {
  // 鉄道の営業日は午前3時切り替え（0:00〜2:59は前日ダイヤの24時〜26時扱い）
  const serviceDate = new Date(now);
  if (now.getHours() < 3) {
    serviceDate.setDate(serviceDate.getDate() - 1);
  }
  return serviceDate;
}

function detectDiaType(date) {
  const serviceDate = getServiceDate(date);
  const day = serviceDate.getDay();
  if (day === 0 || isJapaneseHoliday(serviceDate)) return 'holiday';
  // 振替休日チェック（前日が日曜かつ祝日の場合）
  if (day === 1) {
    const yesterday = new Date(serviceDate);
    yesterday.setDate(yesterday.getDate() - 1);
    if (isJapaneseHoliday(yesterday)) return 'holiday';
  }
  if (day === 6) return 'saturday';
  return 'weekday';
}

function getActiveDiaType(now = new Date()) {
  return state.manualDiaType || detectDiaType(now);
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
        directions: e.directions.map((d) => ({
          groupId: d.groupId,
          directionName: d.directionName,
        })),
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

    // localStorageが空でもCookieにメタ情報が残っていれば自動復元
    const cookieRaw = getCookie(COOKIE_META_KEY);
    if (cookieRaw) {
      const meta = JSON.parse(cookieRaw);
      if (Array.isArray(meta.entries) && meta.entries.length > 0) {
        showToast('Cookieから登録駅を復元し、時刻表を再取得しています...');
        for (const item of meta.entries) {
          if (item.stationId && item.directions?.length) {
            try {
              const entry = await fetchCompleteStationEntry(
                item.stationId,
                item.stationName,
                item.railName,
                item.directions
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
  // 高速な Jina Reader (direct HTML mode) を第一優先、フォールバックも用意
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

  // 1駅に絞られて直接 `/timetable/[stationId]` が返ってきた場合
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

  // 複数駅の候補がある場合
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
 * 路線一覧の正規化（山手線外回り・内回りなど同名路線を1つにまとめる）
 */
function normalizeRouteInfos(routeInfos) {
  const groupedMap = new Map();

  for (const info of routeInfos) {
    const rawName = info.railName || '';
    // 「外回り」「内回り」が路線名末尾についている場合は統合して両方向を1路線として扱う
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
 * 1つの方面 (stationId + groupId) の平日(1)・土曜(2)・日祝(4) の全時刻表を取得
 */
async function fetchDirectionTimetables(stationId, groupId, fallbackDirName) {
  const kinds = [
    { key: 'weekday', code: 1 },
    { key: 'saturday', code: 2 },
    { key: 'holiday', code: 4 },
  ];

  // 並列で平日・土曜・日祝の時刻表を取得
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
            h: hour, // 4〜25 (24時以降は 24, 25 として格納されている)
            m: minute,
            type: mObj.trainName || '普通',
            first: mObj.firstStation === 'true',
          });
        }
      }

      // 発車順にソート（4時〜25時）
      trains.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));

      return {
        key,
        trains,
        directionName: item?.directionName ? `${item.directionName}方面` : fallbackDirName,
        kousyou,
      };
    })
  );

  const timetables = {
    weekday: [],
    saturday: [],
    holiday: [],
  };
  let resolvedDirName = fallbackDirName;
  let kousyouText = '';

  for (const r of results) {
    timetables[r.key] = r.trains;
    if (r.directionName) resolvedDirName = r.directionName;
    if (r.kousyou) kousyouText = r.kousyou;
  }

  return {
    groupId,
    directionName: fallbackDirName || resolvedDirName,
    timetables,
    kousyouText,
  };
}

/**
 * 駅＋路線の全方向の時刻表を取得してエントリーオブジェクトを生成
 */
async function fetchCompleteStationEntry(stationId, stationName, railName, directionsMeta) {
  const dirResults = [];
  let diaVersion = '';

  for (const dir of directionsMeta) {
    const dData = await fetchDirectionTimetables(stationId, dir.groupId, dir.directionName);
    if (dData.kousyouText) diaVersion = dData.kousyouText;
    dirResults.push({
      groupId: dData.groupId,
      directionName: dir.directionName || dData.directionName,
      timetables: dData.timetables,
    });
  }

  return {
    id: `${stationId}_${directionsMeta.map((d) => d.groupId).join('-')}`,
    stationId,
    stationName,
    railName,
    directions: dirResults,
    updatedAt: Date.now(),
    diaVersion: diaVersion || `${new Date().getFullYear()}年${new Date().getMonth() + 1}月取得`,
  };
}

// ==========================================
// 4. ダイヤ改正の自動追従チェック
// ==========================================
function needsDiaAutoUpdate(entry) {
  if (!entry || !entry.updatedAt) return true;
  const now = new Date();
  const last = new Date(entry.updatedAt);

  // 14日以上経過していたら自動更新
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
  if (!isSilent) showToast(`「${entry.stationName}駅（${entry.railName}）」の最新ダイヤを取得中...`);

  try {
    const updated = await fetchCompleteStationEntry(
      entry.stationId,
      entry.stationName,
      entry.railName,
      entry.directions.map((d) => ({ groupId: d.groupId, directionName: d.directionName }))
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
function getUpcomingTrains(directionObj, now = new Date()) {
  const diaType = getActiveDiaType(now);
  const list = directionObj.timetables?.[diaType] || [];
  if (list.length === 0) return [];

  const curH = now.getHours();
  const curM = now.getMinutes();
  const curS = now.getSeconds();

  // 鉄道時刻換算（0:00〜2:59は 24:00〜26:59 として計算）
  const serviceHour = curH < 3 ? curH + 24 : curH;
  const nowTotalSeconds = (serviceHour * 60 + curM) * 60 + curS;

  const upcoming = [];

  for (const t of list) {
    const depTotalSeconds = (t.h * 60 + t.m) * 60;
    const diffSeconds = depTotalSeconds - nowTotalSeconds;

    if (diffSeconds >= -15) {
      // 発車直後15秒以内〜これからの電車
      upcoming.push({
        ...t,
        diffSeconds: Math.max(0, diffSeconds),
        diffMinutes: Math.ceil(Math.max(0, diffSeconds) / 60),
        isTomorrowFirst: false,
      });
      if (upcoming.length >= 3) break;
    }
  }

  // 終電後の場合、翌朝の始発・2番電車を表示する
  if (upcoming.length < 2 && list.length > 0) {
    // 翌日のダイヤ種別を判定
    const tomorrow = new Date(now);
    if (curH >= 3) tomorrow.setDate(tomorrow.getDate() + 1);
    const nextDiaType = state.manualDiaType || detectDiaType(tomorrow);
    const nextList = directionObj.timetables?.[nextDiaType] || list;

    for (const t of nextList) {
      if (upcoming.length >= 3) break;
      // 翌朝の時刻は +24時間 (または curH < 3 なら当日朝の時刻)
      const targetHour = curH < 3 ? t.h : t.h + 24;
      const depTotalSeconds = (targetHour * 60 + t.m) * 60;
      const diffSeconds = depTotalSeconds - nowTotalSeconds;
      if (diffSeconds > 0) {
        upcoming.push({
          ...t,
          diffSeconds,
          diffMinutes: Math.ceil(diffSeconds / 60),
          isTomorrowFirst: true,
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

  const activeDia = getActiveDiaType(now);
  document.querySelectorAll('.dia-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dia === activeDia);
  });
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
        ${escapeHtml(entry.stationName)}（${escapeHtml(entry.railName)}）
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
        <h2>この端末で表示する駅を登録してください</h2>
        <p>
          一度登録するとブラウザ（キャッシュ＆Cookie）に記憶され、次回からはリンクを開くだけで<strong>「どっち方向か」「次の電車・その次の電車まであと何分か」</strong>が即座に表示されます。
        </p>
        <button type="button" class="cta-btn" id="btnEmptyAddStation">＋ 駅を検索して登録する</button>
      </div>
    `;
    document.getElementById('btnEmptyAddStation')?.addEventListener('click', openSettingsDialog);
    if (footerText) footerText.textContent = '未登録 — 端末ごとに異なる駅を登録できます';
    return;
  }

  const cardsHtml = entry.directions
    .map((dir, idx) => {
      const upcoming = getUpcomingTrains(dir, now);
      const first = upcoming[0];
      const second = upcoming[1];
      const third = upcoming[2];

      const altClass = idx % 2 === 1 ? 'dir-alt' : '';
      const cleanDirName = dir.directionName.replace(/方面$/, '');

      // 1本目（次の電車）
      let firstHtml = '';
      if (!first) {
        firstHtml = `
          <div class="next-train-box">
            <div class="train-step-label">
              <span class="badge-next">次の電車</span>
              <span class="train-dep-meta">本日の運転は終了しました</span>
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
        const tomorrowLabel = first.isTomorrowFirst ? '（翌朝始発）' : '';

        firstHtml = `
          <div class="next-train-box">
            <div class="train-step-label">
              <span class="badge-next">次の電車 ${tomorrowLabel}</span>
              <div class="train-dep-meta">
                ${formatDisplayTime(first.h, first.m)}発
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
        const tomorrowLabel2 = second.isTomorrowFirst ? '（翌朝）' : '';
        secondHtml = `
          <div class="after-next-box">
            <div class="after-next-left">
              <span class="badge-after">その次${tomorrowLabel2}</span>
              <span class="train-dep-meta">
                ${formatDisplayTime(second.h, second.m)}発
                <span class="train-type-tag">${escapeHtml(second.type)}</span>
              </span>
            </div>
            <div class="after-next-right">
              <span class="countdown-prefix">あと</span>
              <span class="after-countdown-number">${second.diffMinutes}</span>
              <span class="countdown-unit">分</span>
            </div>
          </div>
        `;
      }

      // 3本目（控えめな補足表示）
      let thirdHtml = '';
      if (third) {
        thirdHtml = `
          <div class="later-trains-row">
            <span>さらに次: ${formatDisplayTime(third.h, third.m)}発（${third.diffMinutes}分後 / ${escapeHtml(third.type)}）</span>
          </div>
        `;
      }

      return `
        <article class="direction-card ${altClass}">
          <div class="direction-header">
            <div class="direction-label">
              <span class="direction-arrow">➔</span>
              <span class="direction-name">${escapeHtml(cleanDirName)}</span>
              <span class="direction-suffix">方面</span>
            </div>
          </div>
          ${firstHtml}
          ${secondHtml}
          ${thirdHtml}
        </article>
      `;
    })
    .join('');

  container.innerHTML = `
    <div class="station-banner">
      <h1 class="station-title">
        <span>${escapeHtml(entry.stationName)}駅</span>
        <span class="rail-badge">${escapeHtml(entry.railName)}</span>
      </h1>
    </div>
    ${cardsHtml}
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
    listEl.innerHTML = `<p class="sub-label">まだ登録されている駅はありません。</p>`;
    return;
  }

  listEl.innerHTML = state.entries
    .map((entry) => {
      const dirsText = entry.directions.map((d) => d.directionName).join(' / ');
      return `
        <div class="registered-item">
          <div>
            <div class="registered-item-title">${escapeHtml(entry.stationName)}駅 — ${escapeHtml(entry.railName)}</div>
            <div class="registered-item-sub">${escapeHtml(dirsText)}</div>
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
// 7. 駅検索・登録モーダル操作
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

function renderRouteSelection(stationId, stationName, routes) {
  const area = document.getElementById('routeCandidatesArea');
  const label = document.getElementById('selectedStationLabel');
  const list = document.getElementById('routeCandidatesList');
  if (!area || !list) return;

  if (label) {
    label.textContent = `2. 「${stationName}駅」の路線を選択してください（両方向の時刻表を自動取得します）：`;
  }

  if (!routes.length) {
    list.innerHTML = `<p class="sub-label">路線が見つかりませんでした。</p>`;
    area.hidden = false;
    return;
  }

  list.innerHTML = routes
    .map((r, idx) => {
      const dirNames = r.directions.map((d) => d.directionName).join(' ／ ');
      return `
        <div class="route-item">
          <div class="route-info">
            <span class="route-name">${escapeHtml(r.railName)}</span>
            <span class="route-dirs">${escapeHtml(dirNames)}</span>
          </div>
          <button type="button" class="register-route-btn" data-route-idx="${idx}">
            この路線を登録
          </button>
        </div>
      `;
    })
    .join('');

  area.hidden = false;

  list.querySelectorAll('.register-route-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const route = routes[Number(btn.dataset.routeIdx)];
      if (!route) return;

      btn.disabled = true;
      btn.textContent = '取得中...';
      setSearchStatus(`「${stationName}駅（${route.railName}）」の平日・土曜・日祝ダイヤを取得しています（約2〜4秒）...`);

      try {
        const newEntry = await fetchCompleteStationEntry(
          stationId,
          stationName,
          route.railName,
          route.directions
        );

        // 既存エントリーがあれば上書き、なければ追加
        const existingIdx = state.entries.findIndex((e) => e.id === newEntry.id);
        if (existingIdx !== -1) {
          state.entries[existingIdx] = newEntry;
        } else {
          state.entries.push(newEntry);
        }

        state.activeEntryId = newEntry.id;
        saveState();
        renderAll();
        renderRegisteredListInDialog();
        setSearchStatus('');
        showToast(`「${stationName}駅（${route.railName}）」をこの端末に登録しました！`);
        closeSettingsDialog();
      } catch (err) {
        console.error(err);
        setSearchStatus('時刻表の取得に失敗しました。もう一度お試しください。', true);
        btn.disabled = false;
        btn.textContent = 'この路線を登録';
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
  // ダイヤ切り替えボタン
  document.querySelectorAll('.dia-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const selected = btn.dataset.dia;
      const autoDetected = detectDiaType(new Date());
      state.manualDiaType = selected === autoDetected ? null : selected;
      renderAll();
    });
  });

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
              setSearchStatus(`「${stName}駅」の路線一覧を取得中...`);
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

  // スマホのスリープ復帰時やタブ切り替え時に即座に再計算
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

  // 初回アクセスで未登録なら自動で設定モーダルを開く
  if (state.entries.length === 0) {
    openSettingsDialog();
  } else {
    // ダイヤ改正時期または前回取得から14日経過していれば裏側で自動更新
    const active = getActiveEntry();
    if (needsDiaAutoUpdate(active)) {
      refreshActiveEntryTimetable(true);
    }
  }

  // 毎秒カウントダウンを更新
  setInterval(() => {
    const now = new Date();
    renderHeader(now);
    if (state.entries.length > 0) {
      renderMainCountdown(now);
    }
  }, 1000);
}

document.addEventListener('DOMContentLoaded', initApp);
