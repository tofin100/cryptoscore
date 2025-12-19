/* CryptoScore — Kraken Breakout Radar (ROOT ONLY)
 * Data:
 * - OHLC Daily (interval=1440)
 * - OHLC 4H   (interval=240)
 * - Ticker    (live last + 24h volume)
 *
 * Outputs:
 * - Score (Market Strength): RS vs BTC + 7D/30D Momentum + Volume Impulse
 * - BRS (Breakout Readiness): CHOCH/BOS (4H) + Compression (ATR drop) + optional VOL confirmation
 */

(() => {
  const cfg = window.CRYPTOSCORE_CONFIG;
  if (!cfg) throw new Error("Missing config.js / window.CRYPTOSCORE_CONFIG");

  // ---------- DOM ----------
  const els = {
    rows: document.getElementById("rows"),
    btnRefresh: document.getElementById("btnRefresh"),
    btnEditWatchlist: document.getElementById("btnEditWatchlist"),
    sortSelect: document.getElementById("sortSelect"),
    minScore: document.getElementById("minScore"),
    minBRS: document.getElementById("minBRS"),
    search: document.getElementById("search"),
    statusPill: document.getElementById("statusPill"),
    errors: document.getElementById("errors"),

    kpiBtc30: document.getElementById("kpiBtc30"),
    kpiRegime: document.getElementById("kpiRegime"),
    kpiUpdated: document.getElementById("kpiUpdated"),
    kpiRegimeHint: document.getElementById("kpiRegimeHint"),
    topCandidate: document.getElementById("topCandidate"),
    topCandidateHint: document.getElementById("topCandidateHint"),

    autoRefresh: document.getElementById("autoRefresh"),
    autoRefreshMins: document.getElementById("autoRefreshMins"),

    watchlistModal: document.getElementById("watchlistModal"),
    watchlistTextarea: document.getElementById("watchlistTextarea"),
    btnSaveWatchlist: document.getElementById("btnSaveWatchlist"),
    btnResetWatchlist: document.getElementById("btnResetWatchlist"),
  };

  // ---------- Helpers ----------
  const fmtPct = (x) => {
    if (!Number.isFinite(x)) return "—";
    const s = (x >= 0 ? "+" : "") + (x * 100).toFixed(2) + "%";
    return s;
  };

  const fmtNum = (x, digits = 2) => {
    if (!Number.isFinite(x)) return "—";
    return Number(x).toLocaleString(undefined, { maximumFractionDigits: digits });
  };

  const fmtUsd = (x) => {
    if (!Number.isFinite(x)) return "—";
    return "$" + Number(x).toLocaleString(undefined, { maximumFractionDigits: 0 });
  };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const classForSigned = (x) => (x >= 0 ? "pos" : "neg");

  // mapping -> 0..100
  const scoreFromRange = (x, lo, hi) => {
    if (!Number.isFinite(x)) return 0;
    return clamp((x - lo) / (hi - lo), 0, 1) * 100;
  };

  // ---------- Storage: Watchlist override ----------
  const LS_KEY = "cryptoscore.watchlist.v1";

  function getWatchlist() {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return cfg.WATCHLIST.slice();
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || arr.length === 0) return cfg.WATCHLIST.slice();
      return arr
        .filter(x => x && typeof x.symbol === "string" && typeof x.pair === "string")
        .map(x => ({ symbol: x.symbol.toUpperCase().trim(), pair: x.pair.trim() }));
    } catch {
      return cfg.WATCHLIST.slice();
    }
  }

  function setWatchlist(arr) { localStorage.setItem(LS_KEY, JSON.stringify(arr)); }
  function resetWatchlist() { localStorage.removeItem(LS_KEY); }

  // ---------- Kraken API ----------
  const KRAKEN = "https://api.kraken.com/0/public";

  async function krakenGet(path) {
    const res = await fetch(`${KRAKEN}/${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const json = await res.json();
    if (json.error && json.error.length) throw new Error(`Kraken error: ${json.error.join(", ")}`);
    return json.result;
  }

  async function fetchOHLC(pair, interval) {
    const result = await krakenGet(`OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`);
    const pairKey = Object.keys(result).find(k => k !== "last");
    const rows = result[pairKey];
    // row: [time, open, high, low, close, vwap, volume, count]
    return rows.map(r => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[6]),
    }));
  }

  async function fetchTicker(pair) {
    const result = await krakenGet(`Ticker?pair=${encodeURIComponent(pair)}`);
    const pairKey = Object.keys(result)[0];
    const t = result[pairKey];
    const last = Number(t.c[0]);     // last trade price
    const vol24hBase = Number(t.v[1]); // 24h volume in base units
    return { last, vol24hBase };
  }

  // ---------- Concurrency limiter ----------
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let idx = 0;
    const workers = new Array(limit).fill(0).map(async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    return out;
  }

  // ---------- Market metrics ----------
  function computeReturnsDaily(candlesDaily) {
    const arr = candlesDaily.slice().sort((a,b)=>a.t-b.t);
    if (arr.length < 8) return { ret7: NaN, ret30: NaN, avgVol30: NaN, lastClose: NaN };

    const lastClose = arr[arr.length - 1].c;

    const c7  = arr.length >= 8  ? arr[arr.length - 8].c  : NaN;
    const c30 = arr.length >= 31 ? arr[arr.length - 31].c : NaN;

    const ret7  = Number.isFinite(c7)  ? (lastClose / c7  - 1) : NaN;
    const ret30 = Number.isFinite(c30) ? (lastClose / c30 - 1) : NaN;

    const last30 = arr.slice(Math.max(0, arr.length - 30));
    const avgVol30 = last30.reduce((s,x)=>s+(Number.isFinite(x.v)?x.v:0),0) / (last30.length || 1);

    return { ret7, ret30, avgVol30, lastClose };
  }

  function computeMarketScore(row, btc) {
    // Market behavior: RS vs BTC + momentum + volume impulse
    const rs = row.rs30;
    const m30 = row.ret30;
    const m7 = row.ret7;
    const vi = row.volImpulse;

    const sRS  = scoreFromRange(rs,  -0.35, 0.35);
    const sM30 = scoreFromRange(m30, -0.30, 0.60);
    const sM7  = scoreFromRange(m7,  -0.15, 0.25);
    const sVI  = scoreFromRange(Math.log10(Math.max(0.001, vi)), -0.25, 0.55);

    const score = (0.35*sRS + 0.30*sM30 + 0.20*sM7 + 0.15*sVI);

    const conf = Number.isFinite(row.ret30) ? 1 : 0.65;
    return clamp(score * conf, 0, 100);
  }

  function regimeFromBtc(btcRet30) {
    if (!Number.isFinite(btcRet30)) return { name: "Unknown", pill: "neutral", hint: "BTC Daten fehlen." };
    if (btcRet30 > 0.08) return { name: "Risk-On", pill: "good", hint: "BTC Momentum positiv → Alts eher begünstigt." };
    if (btcRet30 < -0.08) return { name: "Risk-Off", pill: "bad", hint: "BTC Momentum negativ → defensiv bleiben." };
    return { name: "Neutral", pill: "neutral", hint: "Seitwärts-Regime → selektiv, RS zählt." };
  }

  // ---------- Structure (BOS/CHOCH) ----------
  function pivots(candles, left = 2, right = 2) {
    const arr = candles.slice().sort((a,b)=>a.t-b.t);
    const highs = [];
    const lows = [];

    for (let i = left; i < arr.length - right; i++) {
      const h = arr[i].h;
      const l = arr[i].l;

      let isHigh = true;
      let isLow = true;

      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (arr[j].h >= h) isHigh = false;
        if (arr[j].l <= l) isLow = false;
        if (!isHigh && !isLow) break;
      }

      if (isHigh) highs.push({ i, t: arr[i].t, v: h });
      if (isLow)  lows.push({ i, t: arr[i].t, v: l });
    }
    return { highs, lows, arr };
  }

  function atr14(candles) {
    const arr = candles.slice().sort((a,b)=>a.t-b.t);
    if (arr.length < 16) return NaN;

    const tr = [];
    for (let i = 1; i < arr.length; i++) {
      const hi = arr[i].h;
      const lo = arr[i].l;
      const prevClose = arr[i-1].c;
      const trueRange = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
      tr.push(trueRange);
    }
    const last14 = tr.slice(-14);
    return last14.reduce((s,x)=>s+x,0) / last14.length;
  }

  function breakoutReadiness4H(candles4h, row, cfg) {
    // Returns: { brs, signals[] }
    const a = candles4h.slice().sort((x,y)=>x.t-y.t);
    if (a.length < 80) return { brs: 0, signals: [] };

    const { pivotLeft, pivotRight, compressionAtrDrop } = cfg.APP;
    const { highs, lows, arr } = pivots(a, pivotLeft, pivotRight);
    if (highs.length < 2 || lows.length < 2) return { brs: 0, signals: [] };

    const last = arr[arr.length - 1];
    const lastClose = last.c;

    // last two swings
    const h1 = highs[highs.length - 1].v;
    const h0 = highs[highs.length - 2].v;
    const l1 = lows[lows.length - 1].v;
    const l0 = lows[lows.length - 2].v;

    const downTrend = (h1 < h0) && (l1 < l0);
    const upTrend   = (h1 > h0) && (l1 > l0);

    // CHOCH/BOS logic (using close beyond structure, not wick)
    const chochBull = downTrend && (lastClose > h1);
    const bosBull   = chochBull && (lastClose > h0);

    const chochBear = upTrend && (lastClose < l1);
    const bosBear   = chochBear && (lastClose < l0);

    // Compression via ATR drop
    const recent = arr.slice(-60);        // ~10 days 4H
    const earlier = arr.slice(-120, -60); // previous ~10 days 4H
    const atrRecent = atr14(recent);
    const atrEarlier = atr14(earlier);
    const comp = Number.isFinite(atrRecent) && Number.isFinite(atrEarlier)
      ? (atrRecent < atrEarlier * (1 - compressionAtrDrop))
      : false;

    // Vol confirmation (using our existing volImpulse proxy)
    const volOk = Number.isFinite(row.volImpulse) ? (row.volImpulse >= 1.2) : false;

    // Score
    const signals = [];
    let brs = 0;

    // bullish focus (your use-case: best coins for upside)
    if (chochBull) { signals.push({ t:"CHOCH↑", cls:"up" }); brs += 35; }
    if (bosBull)   { signals.push({ t:"BOS↑", cls:"up" });   brs += 30; }

    // we still show bearish signals (info), but they don't add much to the bullish readiness
    if (chochBear) { signals.push({ t:"CHOCH↓", cls:"down" }); brs += 8; }
    if (bosBear)   { signals.push({ t:"BOS↓", cls:"down" });   brs += 6; }

    if (comp)  { signals.push({ t:"COMP", cls:"comp" }); brs += 15; }
    if (volOk) { signals.push({ t:"VOL", cls:"vol" });   brs += 10; }

    brs = clamp(brs, 0, 100);
    return { brs, signals };
  }

  // ---------- Render ----------
  function render(rows, btc) {
    const sortBy = els.sortSelect.value;
    const minScore = Number(els.minScore.value || 0);
    const minBRS = Number(els.minBRS.value || 0);
    const q = (els.search.value || "").trim().toUpperCase();

    let filtered = rows.filter(r =>
      (Number.isFinite(r.score) ? r.score : 0) >= minScore &&
      (Number.isFinite(r.brs) ? r.brs : 0) >= minBRS &&
      (q === "" || r.symbol.includes(q))
    );

    const sorters = {
      brs: (a,b) => (b.brs - a.brs),
      score: (a,b) => (b.score - a.score),
      rs30: (a,b) => (b.rs30 - a.rs30),
      ret30: (a,b) => (b.ret30 - a.ret30),
      ret7: (a,b) => (b.ret7 - a.ret7),
      volImpulse: (a,b) => (b.volImpulse - a.volImpulse),
      symbol: (a,b) => a.symbol.localeCompare(b.symbol),
    };
    filtered.sort(sorters[sortBy] || sorters.brs);

    // KPIs
    const btc30 = btc ? btc.ret30 : NaN;
    els.kpiBtc30.textContent = fmtPct(btc30);
    els.kpiBtc30.className = "kpiValue " + (Number.isFinite(btc30) ? classForSigned(btc30) : "");

    const reg = regimeFromBtc(btc30);
    els.kpiRegime.textContent = reg.name;
    els.kpiRegimeHint.textContent = reg.hint;

    els.statusPill.textContent = reg.name;
    els.statusPill.className = `pill ${reg.pill}`;

    els.kpiUpdated.textContent = new Date().toISOString().replace("T"," ").slice(0,19);

    // Top candidate (based on BRS primarily, then Score)
    const best = filtered[0];
    if (best) {
      els.topCandidate.textContent = best.symbol;
      els.topCandidateHint.textContent = `BRS ${best.brs.toFixed(0)} • Score ${best.score.toFixed(0)} • RS30 ${fmtPct(best.rs30)}`;
    } else {
      els.topCandidate.textContent = "—";
      els.topCandidateHint.textContent = "—";
    }

    // Table
    if (!filtered.length) {
      els.rows.innerHTML = `<tr><td colspan="11" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    const body = filtered.map((r, i) => {
      const scoreClass = r.score >= 70 ? "good" : (r.score <= 35 ? "bad" : "neutral");
      const brsClass = r.brs >= 70 ? "good" : (r.brs <= 25 ? "bad" : "neutral");

      const rsClass = Number.isFinite(r.rs30) ? classForSigned(r.rs30) : "";
      const r7Class = Number.isFinite(r.ret7) ? classForSigned(r.ret7) : "";
      const r30Class = Number.isFinite(r.ret30) ? classForSigned(r.ret30) : "";

      const sigHtml = (r.signals && r.signals.length)
        ? r.signals.map(s => `<span class="signalPill ${s.cls}">${s.t}</span>`).join("")
        : "—";

      return `
        <tr>
          <td class="muted">${i + 1}</td>
          <td><b>${r.symbol}</b><div class="muted" style="font-size:12px;margin-top:2px">${r.pair}</div></td>

          <td><span class="badge ${scoreClass}">${r.score.toFixed(0)}</span></td>
          <td><span class="badge ${brsClass}">${r.brs.toFixed(0)}</span></td>
          <td class="muted" style="font-size:12px;">${sigHtml}</td>

          <td class="${rsClass}">${fmtPct(r.rs30)}</td>
          <td class="${r7Class}">${fmtPct(r.ret7)}</td>
          <td class="${r30Class}">${fmtPct(r.ret30)}</td>
          <td>${fmtNum(r.volImpulse, 2)}×</td>
          <td>${fmtNum(r.last, 6)}</td>
          <td>${fmtUsd(r.vol24hUsd)}</td>
        </tr>
      `;
    }).join("");

    els.rows.innerHTML = body;
  }

  // ---------- Watchlist Modal ----------
  function openWatchlistModal() {
    const wl = getWatchlist();
    els.watchlistTextarea.value = wl.map(x => `${x.symbol}=${x.pair}`).join("\n");
    els.watchlistModal.showModal();
  }

  function parseWatchlistText(text) {
    const lines = String(text || "")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);

    const items = [];
    for (const line of lines) {
      const [left, right] = line.split("=").map(s => (s || "").trim());
      if (!left) continue;
      const symbol = left.toUpperCase();
      const pair = (right && right.length) ? right : (symbol + "USD");
      items.push({ symbol, pair });
    }

    // Ensure BTC exists for RS baseline
    const hasBTC = items.some(x => x.symbol === "BTC");
    if (!hasBTC) items.unshift({ symbol: "BTC", pair: "XXBTZUSD" });

    // unique by symbol
    const out = [];
    const seen = new Set();
    for (const it of items) {
      if (seen.has(it.symbol)) continue;
      seen.add(it.symbol);
      out.push(it);
    }
    return out;
  }

  // ---------- Load & compute ----------
  let autoTimer = null;

  async function load() {
    els.errors.textContent = "";
    els.statusPill.textContent = "Loading…";
    els.statusPill.className = "pill";
    els.rows.innerHTML = `<tr><td colspan="11" class="loadingRow">Loading…</td></tr>`;

    const wl = getWatchlist();

    try {
      const dailyInterval = cfg.APP.dailyInterval;
      const breakoutInterval = cfg.APP.breakoutInterval;
      const lookback4H = cfg.APP.lookbackCandles4H;

      const data = await mapLimit(
        wl,
        cfg.APP.maxConcurrentRequests,
        async (asset) => {
          // fetch: daily + 4H + ticker
          const [daily, h4, ticker] = await Promise.all([
            fetchOHLC(asset.pair, dailyInterval),
            fetchOHLC(asset.pair, breakoutInterval),
            fetchTicker(asset.pair),
          ]);

          const dailySlice = daily.slice(-Math.max(40, cfg.APP.lookbackDaysDaily + 5));
          const h4Slice = h4.slice(-Math.max(lookback4H, 140));

          const r = computeReturnsDaily(dailySlice);

          const vol24hUsd = ticker.last * ticker.vol24hBase;
          const avgVol30 = r.avgVol30;

          const volImpulse = (Number.isFinite(avgVol30) && avgVol30 > 0)
            ? (ticker.vol24hBase / avgVol30)
            : NaN;

          // placeholder row (needed for volOk within BRS)
          const row = {
            symbol: asset.symbol,
            pair: asset.pair,
            last: ticker.last,
            vol24hUsd,
            vol24hBase: ticker.vol24hBase,
            avgVol30,
            ret7: r.ret7,
            ret30: r.ret30,
            volImpulse,
            rs30: NaN,
            score: 0,
            brs: 0,
            signals: [],
          };

          // BRS from 4H structure + compression
          const br = breakoutReadiness4H(h4Slice, row, cfg);
          row.brs = br.brs;
          row.signals = br.signals;

          return row;
        }
      );

      const btc = data.find(x => x.symbol === "BTC") || data.find(x => x.pair === "XXBTZUSD");
      if (!btc) throw new Error("BTC baseline missing (add BTC=XXBTZUSD to watchlist).");

      // compute RS and Market Score
      for (const row of data) {
        row.rs30 = Number.isFinite(row.ret30) && Number.isFinite(btc.ret30)
          ? (row.ret30 - btc.ret30)
          : NaN;
        row.score = computeMarketScore(row, btc);
      }

      render(data, btc);

    } catch (e) {
      els.errors.textContent = String(e?.message || e);
      els.rows.innerHTML = `<tr><td colspan="11" class="loadingRow">Fehler beim Laden. Details oben rechts.</td></tr>`;
      els.statusPill.textContent = "Error";
      els.statusPill.className = "pill bad";
    }
  }

  function setupAutoRefresh() {
    const mins = cfg.APP.autoRefreshMinutes || 10;
    els.autoRefreshMins.textContent = String(mins);

    const clear = () => {
      if (autoTimer) {
        clearInterval(autoTimer);
        autoTimer = null;
      }
    };

    els.autoRefresh.addEventListener("change", () => {
      clear();
      if (els.autoRefresh.checked) {
        autoTimer = setInterval(load, mins * 60 * 1000);
      }
    });
  }

  // ---------- Events ----------
  els.btnRefresh.addEventListener("click", load);
  els.sortSelect.addEventListener("change", load);

  // For MVP: re-load on filter changes (simple + consistent)
  els.minScore.addEventListener("input", load);
  els.minBRS.addEventListener("input", load);
  els.search.addEventListener("input", load);

  els.btnEditWatchlist.addEventListener("click", openWatchlistModal);

  els.btnSaveWatchlist.addEventListener("click", () => {
    const items = parseWatchlistText(els.watchlistTextarea.value);
    setWatchlist(items);
    els.watchlistModal.close();
    load();
  });

  els.btnResetWatchlist.addEventListener("click", () => {
    resetWatchlist();
    els.watchlistModal.close();
    load();
  });

  setupAutoRefresh();
  load();
})();