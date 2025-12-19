/* CryptoScore — Kraken Radar (Root-only)
 * Public Kraken REST API:
 * - OHLC:   https://api.kraken.com/0/public/OHLC?pair=XXBTZUSD&interval=1440
 * - Ticker: https://api.kraken.com/0/public/Ticker?pair=XXBTZUSD
 *
 * MVP Score:
 * - RS30 vs BTC (coin 30D - BTC 30D)
 * - Momentum (7D + 30D)
 * - Volume impulse: 24h vol proxy / avg daily volume (last 30 daily candles)
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

  // Simple z-score-ish mapping for “score” components
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

  function setWatchlist(arr) {
    localStorage.setItem(LS_KEY, JSON.stringify(arr));
  }

  function resetWatchlist() {
    localStorage.removeItem(LS_KEY);
  }

  // ---------- Kraken API ----------
  const KRAKEN = "https://api.kraken.com/0/public";

  async function krakenGet(path) {
    const res = await fetch(`${KRAKEN}/${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
    const json = await res.json();
    if (json.error && json.error.length) {
      throw new Error(`Kraken error: ${json.error.join(", ")}`);
    }
    return json.result;
  }

  async function fetchOHLC(pair, interval) {
    const result = await krakenGet(`OHLC?pair=${encodeURIComponent(pair)}&interval=${interval}`);
    // result contains { <pairKey>: [...], last: <id> }
    const pairKey = Object.keys(result).find(k => k !== "last");
    const rows = result[pairKey];
    // OHLC row format: [time, open, high, low, close, vwap, volume, count]
    const candles = rows.map(r => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[6]),
    }));
    return candles;
  }

  async function fetchTicker(pair) {
    const result = await krakenGet(`Ticker?pair=${encodeURIComponent(pair)}`);
    const pairKey = Object.keys(result)[0];
    const t = result[pairKey];
    // last trade price = c[0], volume today = v[1] (24h) — base volume
    const last = Number(t.c[0]);
    const vol24hBase = Number(t.v[1]);
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

  // ---------- Metrics ----------
  function computeReturns(candles) {
    // Need at least 31 daily closes for 30D return.
    if (!candles || candles.length < 8) return { ret7: NaN, ret30: NaN, avgVol30: NaN, lastClose: NaN };

    const sorted = candles.slice().sort((a,b) => a.t - b.t);
    const last = sorted[sorted.length - 1];
    const lastClose = last.c;

    const c7 = sorted.length >= 8 ? sorted[sorted.length - 8].c : NaN;   // 7d ago close ~ 7 candles back
    const c30 = sorted.length >= 31 ? sorted[sorted.length - 31].c : NaN;

    const ret7 = Number.isFinite(c7) ? (lastClose / c7 - 1) : NaN;
    const ret30 = Number.isFinite(c30) ? (lastClose / c30 - 1) : NaN;

    const last30 = sorted.slice(Math.max(0, sorted.length - 30));
    const avgVol30 = last30.reduce((s,x) => s + (Number.isFinite(x.v) ? x.v : 0), 0) / (last30.length || 1);

    return { ret7, ret30, avgVol30, lastClose };
  }

  function computeScore(row, btc) {
    // Inputs:
    // - row.ret7, row.ret30
    // - row.rs30 = ret30 - btc.ret30
    // - volImpulse = (row.vol24hBase / row.avgVol30)
    // Score design (MVP): keep bounded and interpretable.
    const rs = row.rs30;                 // -? to +?
    const m30 = row.ret30;
    const m7 = row.ret7;
    const vi = row.volImpulse;           // around ~0.5..3 typical

    // Map to 0..100 via ranges that “feel right” for crypto:
    const sRS  = scoreFromRange(rs,  -0.35, 0.35);    // +/-35% vs BTC over 30D
    const sM30 = scoreFromRange(m30, -0.30, 0.60);    // -30%..+60% in 30D
    const sM7  = scoreFromRange(m7,  -0.15, 0.25);    // -15%..+25% in 7D
    const sVI  = scoreFromRange(Math.log10(Math.max(0.001, vi)), -0.25, 0.55); // log scale

    // Weighted blend (tweakable later)
    const score = (
      0.35 * sRS +
      0.30 * sM30 +
      0.20 * sM7 +
      0.15 * sVI
    );

    // Confidence: if missing 30D, downweight
    const conf = Number.isFinite(row.ret30) ? 1 : 0.65;
    return clamp(score * conf, 0, 100);
  }

  function regimeFromBtc(btcRet30) {
    if (!Number.isFinite(btcRet30)) return { name: "Unknown", pill: "neutral", hint: "BTC Daten fehlen." };
    if (btcRet30 > 0.08) return { name: "Risk-On", pill: "good", hint: "BTC Momentum positiv → Alts eher begünstigt." };
    if (btcRet30 < -0.08) return { name: "Risk-Off", pill: "bad", hint: "BTC Momentum negativ → defensiv bleiben." };
    return { name: "Neutral", pill: "neutral", hint: "Seitwärts-Regime → selektiv, RS zählt." };
  }

  // ---------- Render ----------
  function render(rows, btc) {
    const sortBy = els.sortSelect.value;
    const minScore = Number(els.minScore.value || 0);
    const q = (els.search.value || "").trim().toUpperCase();

    let filtered = rows.filter(r =>
      (Number.isFinite(r.score) ? r.score : 0) >= minScore &&
      (q === "" || r.symbol.includes(q))
    );

    const sorters = {
      score: (a,b) => (b.score - a.score),
      rs30: (a,b) => (b.rs30 - a.rs30),
      ret30: (a,b) => (b.ret30 - a.ret30),
      ret7: (a,b) => (b.ret7 - a.ret7),
      volImpulse: (a,b) => (b.volImpulse - a.volImpulse),
      symbol: (a,b) => a.symbol.localeCompare(b.symbol),
    };
    filtered.sort(sorters[sortBy] || sorters.score);

    // KPIs
    const btc30 = btc ? btc.ret30 : NaN;
    els.kpiBtc30.textContent = fmtPct(btc30);
    els.kpiBtc30.className = "kpiValue " + (Number.isFinite(btc30) ? classForSigned(btc30) : "");
    const reg = regimeFromBtc(btc30);
    els.kpiRegime.textContent = reg.name;
    els.kpiRegimeHint.textContent = reg.hint;

    els.statusPill.textContent = reg.name;
    els.statusPill.className = `pill ${reg.pill}`;

    const now = new Date();
    els.kpiUpdated.textContent = now.toISOString().replace("T"," ").slice(0,19);

    // Top candidate
    const best = filtered[0];
    if (best) {
      els.topCandidate.textContent = best.symbol;
      els.topCandidateHint.textContent = `Score ${best.score.toFixed(0)} • RS30 ${fmtPct(best.rs30)} • 30D ${fmtPct(best.ret30)}`;
    } else {
      els.topCandidate.textContent = "—";
      els.topCandidateHint.textContent = "—";
    }

    // Table
    if (!filtered.length) {
      els.rows.innerHTML = `<tr><td colspan="9" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    const body = filtered.map((r, i) => {
      const scoreClass = r.score >= 70 ? "good" : (r.score <= 35 ? "bad" : "neutral");
      const rsClass = Number.isFinite(r.rs30) ? classForSigned(r.rs30) : "";
      const r7Class = Number.isFinite(r.ret7) ? classForSigned(r.ret7) : "";
      const r30Class = Number.isFinite(r.ret30) ? classForSigned(r.ret30) : "";

      return `
        <tr>
          <td class="muted">${i + 1}</td>
          <td><b>${r.symbol}</b><div class="muted" style="font-size:12px;margin-top:2px">${r.pair}</div></td>
          <td><span class="badge ${scoreClass}">${r.score.toFixed(0)}</span></td>
          <td class="${rsClass}">${fmtPct(r.rs30)}</td>
          <td class="${r7Class}">${fmtPct(r.ret7)}</td>
          <td class="${r30Class}">${fmtPct(r.ret30)}</td>
          <td>${fmtNum(r.volImpulse, 2)}×</td>
          <td>${fmtNum(r.last, 4)}</td>
          <td>${fmtUsd(r.vol24hUsd)}</td>
        </tr>
      `;
    }).join("");

    els.rows.innerHTML = body;
  }

  // ---------- Watchlist Modal ----------
  function openWatchlistModal() {
    const wl = getWatchlist();
    const lines = wl.map(x => `${x.symbol}=${x.pair}`).join("\n");
    els.watchlistTextarea.value = lines;
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
      const pair = (right && right.length) ? right : left.toUpperCase() + "USD";
      items.push({ symbol, pair });
    }
    // Ensure BTC exists for RS baseline
    const hasBTC = items.some(x => x.symbol === "BTC");
    if (!hasBTC) items.unshift({ symbol: "BTC", pair: "XXBTZUSD" });
    return items;
  }

  // ---------- Load & compute ----------
  let autoTimer = null;

  async function load() {
    els.errors.textContent = "";
    els.statusPill.textContent = "Loading…";
    els.statusPill.className = "pill";

    const wl = getWatchlist();
    // ensure unique by symbol
    const uniq = [];
    const seen = new Set();
    for (const x of wl) {
      if (seen.has(x.symbol)) continue;
      seen.add(x.symbol);
      uniq.push(x);
    }

    els.rows.innerHTML = `<tr><td colspan="9" class="loadingRow">Loading…</td></tr>`;

    try {
      // Fetch OHLC + Ticker per asset with concurrency limit
      const interval = cfg.APP.ohlcInterval;

      const data = await mapLimit(
        uniq,
        cfg.APP.maxConcurrentRequests,
        async (asset) => {
          const [candles, ticker] = await Promise.all([
            fetchOHLC(asset.pair, interval),
            fetchTicker(asset.pair),
          ]);

          const r = computeReturns(candles);
          const vol24hUsd = ticker.last * ticker.vol24hBase;
          const avgVol30 = r.avgVol30;
          const volImpulse = (Number.isFinite(avgVol30) && avgVol30 > 0)
            ? (ticker.vol24hBase / avgVol30)
            : NaN;

          return {
            symbol: asset.symbol,
            pair: asset.pair,
            last: ticker.last,
            vol24hUsd,
            vol24hBase: ticker.vol24hBase,
            avgVol30,
            ret7: r.ret7,
            ret30: r.ret30,
            volImpulse,
          };
        }
      );

      const btc = data.find(x => x.symbol === "BTC") || data.find(x => x.pair === "XXBTZUSD");
      if (!btc) throw new Error("BTC baseline missing (add BTC=XXBTZUSD to watchlist).");

      // compute RS and score
      for (const row of data) {
        row.rs30 = Number.isFinite(row.ret30) && Number.isFinite(btc.ret30)
          ? (row.ret30 - btc.ret30)
          : NaN;
        row.score = computeScore(row, btc);
      }

      render(data, btc);

    } catch (e) {
      els.errors.textContent = String(e?.message || e);
      els.rows.innerHTML = `<tr><td colspan="9" class="loadingRow">Fehler beim Laden. Details oben rechts.</td></tr>`;
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
  els.minScore.addEventListener("input", () => {
    // re-render without refetch: simplest = reload for now (keeps MVP simple)
    load();
  });
  els.search.addEventListener("input", () => {
    // same: reload for now; later we can cache rows and filter client-side only
    load();
  });

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