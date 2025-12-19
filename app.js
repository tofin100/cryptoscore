(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg) throw new Error("Missing config.js (window.APP_CONFIG)");

  // ---------------- DOM ----------------
  const el = {
    // mode
    btnModeKraken: document.getElementById("btnModeKraken"),
    btnModeVC: document.getElementById("btnModeVC"),
    btnRefresh: document.getElementById("btnRefresh"),
    viewKraken: document.getElementById("viewKraken"),
    viewVC: document.getElementById("viewVC"),

    // kraken
    krakenRows: document.getElementById("krakenRows"),
    krakenErrors: document.getElementById("krakenErrors"),

    // vc
    vcRows: document.getElementById("vcRows"),
    vcErrors: document.getElementById("vcErrors"),
    vcMcMin: document.getElementById("vcMcMin"),
    vcMcMax: document.getElementById("vcMcMax"),
    vcVolMin: document.getElementById("vcVolMin"),
    vcFdvMcMax: document.getElementById("vcFdvMcMax"),
    vcMinScore: document.getElementById("vcMinScore"),
    vcSearch: document.getElementById("vcSearch"),
    vcSort: document.getElementById("vcSort"),
  };

  // ---------------- Helpers ----------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = (x) => Number.isFinite(x);
  const fmtUsd = (x) => isNum(x) ? "$" + Math.round(x).toLocaleString() : "—";
  const fmt = (x, d=2) => isNum(x) ? Number(x).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  const fmtPct = (x) => isNum(x) ? ((x>=0?"+":"") + (x*100).toFixed(2) + "%") : "—";
  const fmtPct100 = (x) => isNum(x) ? ((x>=0?"+":"") + x.toFixed(2) + "%") : "—";
  const clsSigned = (x) => (x >= 0 ? "pos" : "neg");

  // ---------------- Mode ----------------
  const LS_MODE = "app.mode.v1";
  let mode = localStorage.getItem(LS_MODE) || cfg.modeDefault || "vc";

  function setMode(next) {
    mode = next;
    localStorage.setItem(LS_MODE, mode);
    el.viewKraken.style.display = (mode === "kraken") ? "" : "none";
    el.viewVC.style.display = (mode === "vc") ? "" : "none";
  }

  // ---------------- Kraken API ----------------
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
    return rows.map(r => ({
      t: Number(r[0]),
      c: Number(r[4]),
      v: Number(r[6]),
    }));
  }

  async function fetchTicker(pair) {
    const result = await krakenGet(`Ticker?pair=${encodeURIComponent(pair)}`);
    const pairKey = Object.keys(result)[0];
    const t = result[pairKey];
    const last = Number(t.c[0]);
    const vol24hBase = Number(t.v[1]);
    return { last, vol24hBase };
  }

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

  function computeReturnsDaily(candles) {
    const arr = candles.slice().sort((a,b)=>a.t-b.t);
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

  function score01(x, lo, hi) {
    if (!isNum(x)) return 0;
    return clamp((x - lo) / (hi - lo), 0, 1);
  }

  function marketScore(row, btc) {
    const rs30 = isNum(row.ret30) && isNum(btc.ret30) ? (row.ret30 - btc.ret30) : NaN;
    row.rs30 = rs30;

    const sRS  = score01(rs30, -0.35, 0.35) * 100;
    const sM30 = score01(row.ret30, -0.30, 0.60) * 100;
    const sM7  = score01(row.ret7, -0.15, 0.25) * 100;
    const sVI  = score01(Math.log10(Math.max(0.001, row.volImpulse)), -0.25, 0.55) * 100;

    return clamp(0.35*sRS + 0.30*sM30 + 0.20*sM7 + 0.15*sVI, 0, 100);
  }

  async function runKraken() {
    el.krakenErrors.textContent = "";
    el.krakenRows.innerHTML = `<tr><td colspan="8" class="loadingRow">Loading Kraken…</td></tr>`;

    try {
      const wl = cfg.kraken.watchlist;
      const dailyInterval = cfg.kraken.dailyInterval;

      const data = await mapLimit(
        wl,
        cfg.kraken.maxConcurrentRequests,
        async (asset) => {
          const [daily, ticker] = await Promise.all([
            fetchOHLC(asset.pair, dailyInterval),
            fetchTicker(asset.pair),
          ]);

          const r = computeReturnsDaily(daily.slice(-50));
          const vol24hUsd = ticker.last * ticker.vol24hBase;
          const volImpulse = (isNum(r.avgVol30) && r.avgVol30 > 0) ? (ticker.vol24hBase / r.avgVol30) : NaN;

          return {
            symbol: asset.symbol,
            pair: asset.pair,
            last: ticker.last,
            vol24hUsd,
            ret7: r.ret7,
            ret30: r.ret30,
            volImpulse,
            score: 0,
            rs30: NaN,
          };
        }
      );

      const btc = data.find(x => x.symbol === "BTC") || data[0];
      for (const row of data) row.score = marketScore(row, btc);

      data.sort((a,b)=>b.score-a.score);

      el.krakenRows.innerHTML = data.map((r, i) => {
        const scoreCls = r.score >= 70 ? "good" : (r.score <= 35 ? "bad" : "neutral");
        return `
          <tr>
            <td class="muted">${i+1}</td>
            <td><b>${r.symbol}</b><div class="muted" style="font-size:12px;margin-top:2px">${r.pair}</div></td>
            <td><span class="badge ${scoreCls}">${r.score.toFixed(0)}</span></td>
            <td class="${clsSigned(r.ret7)}">${fmtPct(r.ret7)}</td>
            <td class="${clsSigned(r.ret30)}">${fmtPct(r.ret30)}</td>
            <td>${fmt(r.volImpulse, 2)}×</td>
            <td>${fmt(r.last, 6)}</td>
            <td>${fmtUsd(r.vol24hUsd)}</td>
          </tr>
        `;
      }).join("");

    } catch (e) {
      el.krakenErrors.textContent = String(e?.message || e);
      el.krakenRows.innerHTML = `<tr><td colspan="8" class="loadingRow">Fehler beim Laden.</td></tr>`;
    }
  }

  // ---------------- VC Microcap (CoinGecko) ----------------
  const VC_CACHE = "vc.cache.v1";
  let vcUniverse = []; // raw scored list (cached in memory)
  let vcDebounceTimer = null;

  async function cgGet(path) {
    const res = await fetch(`${cfg.vc.coingeckoBase}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchMarketsPage(page, perPage) {
    const params = new URLSearchParams({
      vs_currency: cfg.vc.vsCurrency,
      order: "market_cap_desc",
      per_page: String(perPage),
      page: String(page),
      sparkline: "false",
      price_change_percentage: "7d,30d"
    });
    return cgGet(`/coins/markets?${params.toString()}`);
  }

  function computeFdvMc(fdv, mc) {
    if (!isNum(fdv) || !isNum(mc) || mc <= 0) return NaN;
    return fdv / mc;
  }
  function computeCircPct(circ, total, max) {
    const denom = isNum(max) && max > 0 ? max : (isNum(total) && total > 0 ? total : NaN);
    if (!isNum(circ) || !isNum(denom) || denom <= 0) return NaN;
    return circ / denom;
  }
  function computeVolMc(vol, mc) {
    if (!isNum(vol) || !isNum(mc) || mc <= 0) return NaN;
    return vol / mc;
  }
  function computeAthDeltaPct(ath, price) {
    if (!isNum(ath) || !isNum(price) || ath <= 0) return NaN;
    return (price / ath - 1) * 100; // negative
  }

  function vcScore(row) {
    const mc = row.market_cap;
    const fdvmc = row.fdv_mc;
    const circPct = row.circ_pct;

    const mcScore = 1 - score01(mc, 5_000_000, 300_000_000);
    const fdvScore = 1 - score01(fdvmc, 1.2, 6.0);
    const circScore = score01(circPct, 0.30, 0.85);
    const maxSupplyBonus = isNum(row.max_supply) && row.max_supply > 0 ? 1 : 0;

    const asym = clamp((0.40*mcScore + 0.40*fdvScore + 0.15*circScore + 0.05*maxSupplyBonus) * 100, 0, 100);

    const volmc = row.vol_mc;
    const vol = row.total_volume;

    const volmcScore = score01(Math.log10(Math.max(1e-9, volmc)), -4.0, -1.0);
    const absVolScore = score01(Math.log10(Math.max(1, vol)), 5.5, 7.5);
    const liq = clamp((0.70*volmcScore + 0.30*absVolScore) * 100, 0, 100);

    const chg7 = row.chg7;
    const chg30 = row.chg30;
    const t7 = score01(chg7, -10, 35);
    const t30 = score01(chg30, -20, 80);
    const timing = clamp((0.55*t30 + 0.45*t7) * 100, 0, 100);

    const athDelta = row.ath_delta_pct;
    const nearAthPenalty = score01(athDelta, -25, 0) * 100;
    const deadPenalty = score01(-chg30, 25, 70) * 100;
    const riskPenalty = clamp(0.60*nearAthPenalty + 0.40*deadPenalty, 0, 100);

    const w = cfg.vc.weights;
    const final = clamp((w.asym*asym + w.liq*liq + w.timing*timing) - (w.risk*riskPenalty), 0, 100);

    return { final, asym, liq, timing, risk: riskPenalty };
  }

  function applyVCFiltersAndRender() {
    const mcMin = Number(el.vcMcMin.value || cfg.vc.marketCapMin);
    const mcMax = Number(el.vcMcMax.value || cfg.vc.marketCapMax);
    const volMin = Number(el.vcVolMin.value || cfg.vc.volume24hMin);
    const fdvMcMax = Number(el.vcFdvMcMax.value || cfg.vc.fdvMcMax);
    const minScore = Number(el.vcMinScore.value || cfg.vc.minScore);
    const q = (el.vcSearch.value || "").trim().toLowerCase();
    const sort = el.vcSort.value;

    let out = vcUniverse.filter(r => {
      if (!isNum(r.market_cap)) return false;
      if (r.market_cap < mcMin || r.market_cap > mcMax) return false;
      if (!isNum(r.total_volume) || r.total_volume < volMin) return false;
      if (isNum(r.fdv_mc) && r.fdv_mc > fdvMcMax) return false;
      if (r.score < minScore) return false;

      if (!q) return true;
      return (r.name||"").toLowerCase().includes(q) || (r.symbol||"").toLowerCase().includes(q) || (r.id||"").toLowerCase().includes(q);
    });

    const sorters = {
      score: (a,b)=>b.score-a.score,
      mc: (a,b)=>(a.market_cap||0)-(b.market_cap||0),
      volmc: (a,b)=>(b.vol_mc||0)-(a.vol_mc||0),
      fdvmc: (a,b)=>(a.fdv_mc??999)-(b.fdv_mc??999),
      chg7: (a,b)=>(b.chg7||0)-(a.chg7||0),
      chg30: (a,b)=>(b.chg30||0)-(a.chg30||0),
    };
    out.sort(sorters[sort] || sorters.score);

    if (!out.length) {
      el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    el.vcRows.innerHTML = out.map((r, i) => {
      const scoreCls = r.score >= 75 ? "good" : (r.score <= 55 ? "bad" : "neutral");
      const aCls = r.asym >= 70 ? "good" : (r.asym <= 45 ? "bad" : "neutral");
      const lCls = r.liq >= 70 ? "good" : (r.liq <= 45 ? "bad" : "neutral");
      const tCls = r.timing >= 70 ? "good" : (r.timing <= 45 ? "bad" : "neutral");
      const rCls = r.risk <= 30 ? "good" : (r.risk >= 60 ? "bad" : "neutral");

      const fdvmcTxt = isNum(r.fdv_mc) ? r.fdv_mc.toFixed(2) : "—";
      const circTxt = isNum(r.circ_pct) ? (r.circ_pct*100).toFixed(0) + "%" : "—";
      const volmcTxt = isNum(r.vol_mc) ? (r.vol_mc*100).toFixed(2) + "%" : "—";

      return `
        <tr>
          <td class="muted">${i+1}</td>
          <td><b>${(r.symbol||"").toUpperCase()}</b> <span class="muted">(${r.name||""})</span></td>

          <td><span class="badge ${scoreCls}">${r.score.toFixed(0)}</span></td>
          <td><span class="badge ${aCls}">${r.asym.toFixed(0)}</span></td>
          <td><span class="badge ${lCls}">${r.liq.toFixed(0)}</span></td>
          <td><span class="badge ${tCls}">${r.timing.toFixed(0)}</span></td>
          <td><span class="badge ${rCls}">${r.risk.toFixed(0)}</span></td>

          <td>${fmtUsd(r.market_cap)}</td>
          <td>${fmtUsd(r.fdv)}</td>
          <td>${fdvmcTxt}</td>
          <td>${circTxt}</td>
          <td>${volmcTxt}</td>

          <td class="${clsSigned(r.chg7)}">${fmtPct100(r.chg7)}</td>
          <td class="${clsSigned(r.chg30)}">${fmtPct100(r.chg30)}</td>
          <td class="${clsSigned(r.ath_delta_pct)}">${fmtPct100(r.ath_delta_pct)}</td>
          <td>${fmt(r.current_price, 8)}</td>
        </tr>
      `;
    }).join("");
  }

  async function runVC(fullFetch = true) {
    el.vcErrors.textContent = "";
    if (fullFetch) el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">Scanning CoinGecko…</td></tr>`;

    // Cache sofort anzeigen
    if (fullFetch) {
      try {
        const cached = JSON.parse(localStorage.getItem(VC_CACHE) || "null");
        if (cached && Array.isArray(cached.rows) && cached.rows.length) {
          vcUniverse = cached.rows;
          applyVCFiltersAndRender();
        }
      } catch {}
    }

    if (!fullFetch) {
      applyVCFiltersAndRender();
      return;
    }

    try {
      let universe = [];
      for (let p = 1; p <= cfg.vc.pages; p++) {
        const arr = await fetchMarketsPage(p, cfg.vc.perPage);
        universe = universe.concat(arr);
        await new Promise(r => setTimeout(r, 220));
      }

      const rows = universe.map(x => {
        const mc = x.market_cap;
        const fdv = x.fully_diluted_valuation;
        const fdvmc = computeFdvMc(fdv, mc);

        const circ = x.circulating_supply;
        const total = x.total_supply;
        const max = x.max_supply;
        const circPct = computeCircPct(circ, total, max);

        const vol = x.total_volume;
        const volmc = computeVolMc(vol, mc);

        const chg7 = x.price_change_percentage_7d_in_currency;
        const chg30 = x.price_change_percentage_30d_in_currency;

        const athDelta = computeAthDeltaPct(x.ath, x.current_price);

        const baseRow = {
          id: x.id,
          symbol: x.symbol,
          name: x.name,
          current_price: x.current_price,
          market_cap: mc,
          total_volume: vol,
          fdv,
          fdv_mc: fdvmc,
          circulating_supply: circ,
          total_supply: total,
          max_supply: max,
          circ_pct: circPct,
          vol_mc: volmc,
          chg7: isNum(chg7) ? chg7 : NaN,
          chg30: isNum(chg30) ? chg30 : NaN,
          ath_delta_pct: isNum(athDelta) ? athDelta : NaN,
        };

        const s = vcScore(baseRow);
        return { ...baseRow, score: s.final, asym: s.asym, liq: s.liq, timing: s.timing, risk: s.risk };
      });

      vcUniverse = rows;
      localStorage.setItem(VC_CACHE, JSON.stringify({ t: Date.now(), rows }));
      applyVCFiltersAndRender();

    } catch (e) {
      el.vcErrors.textContent = String(e?.message || e);
      if (!vcUniverse.length) el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">Fehler beim Scan. Refresh nochmal.</td></tr>`;
    }
  }

  // ---------------- UI wiring ----------------
  function debounceVC() {
    clearTimeout(vcDebounceTimer);
    vcDebounceTimer = setTimeout(() => runVC(false), 200);
  }

  function initVCInputs() {
    el.vcMcMin.value = cfg.vc.marketCapMin;
    el.vcMcMax.value = cfg.vc.marketCapMax;
    el.vcVolMin.value = cfg.vc.volume24hMin;
    el.vcFdvMcMax.value = cfg.vc.fdvMcMax;
    el.vcMinScore.value = cfg.vc.minScore;
  }

  el.btnModeKraken.addEventListener("click", () => { setMode("kraken"); });
  el.btnModeVC.addEventListener("click", () => { setMode("vc"); });

  el.btnRefresh.addEventListener("click", () => {
    if (mode === "kraken") runKraken();
    else runVC(true);
  });

  // VC filters (debounced, no refetch)
  ["input","change"].forEach(evt => {
    el.vcMcMin.addEventListener(evt, debounceVC);
    el.vcMcMax.addEventListener(evt, debounceVC);
    el.vcVolMin.addEventListener(evt, debounceVC);
    el.vcFdvMcMax.addEventListener(evt, debounceVC);
    el.vcMinScore.addEventListener(evt, debounceVC);
    el.vcSearch.addEventListener(evt, debounceVC);
    el.vcSort.addEventListener(evt, debounceVC);
  });

  // ---------------- Boot ----------------
  initVCInputs();
  setMode(mode);

  // sofort Ergebnisse:
  if (mode === "kraken") runKraken();
  else runVC(true);

})();