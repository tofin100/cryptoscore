(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg) throw new Error("Missing config.js (window.APP_CONFIG)");

  // ---------------- DOM ----------------
  const el = {
    btnModeKraken: document.getElementById("btnModeKraken"),
    btnModeVC: document.getElementById("btnModeVC"),
    btnRefresh: document.getElementById("btnRefresh"),

    viewKraken: document.getElementById("viewKraken"),
    viewVC: document.getElementById("viewVC"),

    krakenRows: document.getElementById("krakenRows"),
    krakenErrors: document.getElementById("krakenErrors"),

    vcRows: document.getElementById("vcRows"),
    vcErrors: document.getElementById("vcErrors"),
    vcMcMin: document.getElementById("vcMcMin"),
    vcMcMax: document.getElementById("vcMcMax"),
    vcVolMin: document.getElementById("vcVolMin"),
    vcMinScore: document.getElementById("vcMinScore"),
    vcSearch: document.getElementById("vcSearch"),
    vcSort: document.getElementById("vcSort"),
  };

  // ---------------- Helpers ----------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = (x) => Number.isFinite(x);

  const fmtUsd = (x) => isNum(x) ? "$" + Math.round(x).toLocaleString() : "—";
  const fmt = (x, d=2) => isNum(x) ? Number(x).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  const fmtPct = (x) => isNum(x) ? ((x >= 0 ? "+" : "") + x.toFixed(2) + "%") : "—";
  const clsSigned = (x) => (x >= 0 ? "pos" : "neg");

  function score01(x, lo, hi) {
    if (!isNum(x)) return 0;
    return clamp((x - lo) / (hi - lo), 0, 1);
  }

  // ---------------- Mode ----------------
  const LS_MODE = "cryptoapp.mode.v1";
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
    if (arr.length < 31) return { ret7: NaN, ret30: NaN, avgVol30: NaN, lastClose: NaN };
    const lastClose = arr[arr.length - 1].c;
    const c7  = arr[arr.length - 8].c;
    const c30 = arr[arr.length - 31].c;
    const ret7  = (lastClose / c7  - 1);
    const ret30 = (lastClose / c30 - 1);

    const last30 = arr.slice(-30);
    const avgVol30 = last30.reduce((s,x)=>s+(Number.isFinite(x.v)?x.v:0),0) / last30.length;
    return { ret7, ret30, avgVol30, lastClose };
  }

  function krakenScore(row, btc) {
    const rs30 = isNum(row.ret30) && isNum(btc.ret30) ? (row.ret30 - btc.ret30) : NaN;
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

          const r = computeReturnsDaily(daily.slice(-60));
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
          };
        }
      );

      const btc = data.find(x => x.symbol === "BTC") || data[0];
      for (const row of data) row.score = krakenScore(row, btc);

      data.sort((a,b)=>b.score-a.score);

      el.krakenRows.innerHTML = data.map((r, i) => {
        const scoreCls = r.score >= 70 ? "good" : (r.score <= 35 ? "bad" : "neutral");
        return `
          <tr>
            <td class="muted">${i+1}</td>
            <td><b>${r.symbol}</b><div class="muted" style="font-size:12px;margin-top:2px">${r.pair}</div></td>
            <td><span class="badge ${scoreCls}">${r.score.toFixed(0)}</span></td>
            <td class="${clsSigned(r.ret7)}">${fmtPct(r.ret7 * 100)}</td>
            <td class="${clsSigned(r.ret30)}">${fmtPct(r.ret30 * 100)}</td>
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

  // ---------------- VC Microcap (CoinPaprika) ----------------
  const VC_CACHE = "cryptoapp.vc.cache.v1";
  let vcUniverse = [];
  let vcDebounceTimer = null;

  async function paprikaGet(path) {
    const res = await fetch(`${cfg.vc.paprikaBase}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`CoinPaprika HTTP ${res.status}`);
    return await res.json();
  }

  function vcCompute(row) {
    // Inputs (USD):
    const mc = row.market_cap;
    const vol = row.volume_24h;
    const price = row.price;

    // Supply clarity:
    const maxSupply = row.max_supply;      // may be null
    const circ = row.circulating_supply;   // number
    const circPct = (isNum(circ) && isNum(maxSupply) && maxSupply > 0) ? (circ / maxSupply) : NaN;

    // Liquidity proxies:
    const volMc = (isNum(vol) && isNum(mc) && mc > 0) ? (vol / mc) : NaN;

    // Timing:
    const chg7 = row.pct7;   // percent (e.g. 12.3)
    const chg30 = row.pct30; // percent

    // --- Scores ---
    // ASYM: low mc + max supply present + decent circ%
    const mcScore = 1 - score01(mc, cfg.vc.marketCapMin, cfg.vc.marketCapMax); // lower is better
    const maxSupplyBonus = isNum(maxSupply) && maxSupply > 0 ? 1 : 0;
    const circScore = score01(circPct, 0.30, 0.85); // unknown -> 0

    const asym = clamp((0.55*mcScore + 0.20*circScore + 0.25*maxSupplyBonus) * 100, 0, 100);

    // LIQ: vol/mc + absolute vol
    const volMcScore = score01(Math.log10(Math.max(1e-9, volMc)), -4.0, -1.0); // 0.0001..0.1
    const absVolScore = score01(Math.log10(Math.max(1, vol)), 5.5, 7.5);       // ~300k..30M
    const liq = clamp((0.70*volMcScore + 0.30*absVolScore) * 100, 0, 100);

    // TIMING: moderate positive favored
    const t7 = score01(chg7, -10, 35);
    const t30 = score01(chg30, -20, 80);
    const timing = clamp((0.55*t30 + 0.45*t7) * 100, 0, 100);

    // RISK penalty: “dead” penalty if very negative 30d; no ATH here (Paprika tickers lacks ATH)
    const deadPenalty = score01(-chg30, 25, 70) * 100; // -25..-70 => penalty up
    const risk = clamp(deadPenalty, 0, 100);

    const w = cfg.vc.weights;
    const final = clamp((w.asym*asym + w.liq*liq + w.timing*timing) - (w.risk*risk), 0, 100);

    return {
      score: final, asym, liq, timing, risk,
      circ_pct: circPct,
      vol_mc: volMc,
      price
    };
  }

  function applyVCFiltersAndRender() {
    const mcMin = Number(el.vcMcMin.value || cfg.vc.marketCapMin);
    const mcMax = Number(el.vcMcMax.value || cfg.vc.marketCapMax);
    const volMin = Number(el.vcVolMin.value || cfg.vc.volume24hMin);
    const minScore = Number(el.vcMinScore.value || cfg.vc.minScore);
    const q = (el.vcSearch.value || "").trim().toLowerCase();
    const sort = el.vcSort.value;

    let out = vcUniverse.filter(r => {
      if (!isNum(r.market_cap)) return false;
      if (r.market_cap < mcMin || r.market_cap > mcMax) return false;
      if (!isNum(r.volume_24h) || r.volume_24h < volMin) return false;
      if (!isNum(r.score) || r.score < minScore) return false;

      if (!q) return true;
      return (r.name||"").toLowerCase().includes(q) || (r.symbol||"").toLowerCase().includes(q) || (r.id||"").toLowerCase().includes(q);
    });

    const sorters = {
      score: (a,b)=>b.score-a.score,
      mc: (a,b)=>(a.market_cap||0)-(b.market_cap||0),
      volmc: (a,b)=>(b.vol_mc||0)-(a.vol_mc||0),
      chg7: (a,b)=>(b.pct7||0)-(a.pct7||0),
      chg30: (a,b)=>(b.pct30||0)-(a.pct30||0),
      liquidity: (a,b)=>b.liq-a.liq,
      asym: (a,b)=>b.asym-a.asym,
    };
    out.sort(sorters[sort] || sorters.score);

    if (!out.length) {
      el.vcRows.innerHTML = `<tr><td colspan="14" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    el.vcRows.innerHTML = out.map((r, i) => {
      const scoreCls = r.score >= 75 ? "good" : (r.score <= 55 ? "bad" : "neutral");
      const aCls = r.asym >= 70 ? "good" : (r.asym <= 45 ? "bad" : "neutral");
      const lCls = r.liq >= 70 ? "good" : (r.liq <= 45 ? "bad" : "neutral");
      const tCls = r.timing >= 70 ? "good" : (r.timing <= 45 ? "bad" : "neutral");
      const rCls = r.risk <= 30 ? "good" : (r.risk >= 60 ? "bad" : "neutral");

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
          <td>${isNum(r.max_supply) ? fmt(r.max_supply, 0) : "—"}</td>
          <td>${circTxt}</td>
          <td>${volmcTxt}</td>

          <td class="${clsSigned(r.pct7)}">${fmtPct(r.pct7)}</td>
          <td class="${clsSigned(r.pct30)}">${fmtPct(r.pct30)}</td>
          <td>${fmt(r.price, 8)}</td>
        </tr>
      `;
    }).join("");
  }

  async function runVC(fullFetch = true) {
    el.vcErrors.textContent = "";

    // Sofort Cache anzeigen, damit du "immer" was siehst
    if (fullFetch) {
      try {
        const cached = JSON.parse(localStorage.getItem(VC_CACHE) || "null");
        if (cached && Array.isArray(cached.rows) && cached.rows.length) {
          vcUniverse = cached.rows;
          applyVCFiltersAndRender();
        }
      } catch {}
      el.vcRows.innerHTML = `<tr><td colspan="14" class="loadingRow">Loading Microcap Universe…</td></tr>`;
    }

    if (!fullFetch) {
      applyVCFiltersAndRender();
      return;
    }

    try {
      const all = await paprikaGet(`/tickers?quotes=USD`);
      // sort by market cap desc and keep TopN (performance + relevance)
      const top = all
        .map(x => {
          const q = x.quotes?.USD || {};
          return {
            id: x.id,
            symbol: x.symbol,
            name: x.name,
            market_cap: q.market_cap,
            volume_24h: q.volume_24h,
            price: q.price,
            pct7: q.percent_change_7d,
            pct30: q.percent_change_30d,
            circulating_supply: x.circulating_supply,
            max_supply: x.max_supply,
          };
        })
        .filter(x => isNum(x.market_cap))
        .sort((a,b)=>b.market_cap-a.market_cap)
        .slice(0, cfg.vc.universeTopN);

      // compute scores
      vcUniverse = top.map(r => {
        const s = vcCompute(r);
        return { ...r, ...s };
      });

      localStorage.setItem(VC_CACHE, JSON.stringify({ t: Date.now(), rows: vcUniverse }));
      applyVCFiltersAndRender();

    } catch (e) {
      el.vcErrors.textContent = String(e?.message || e);
      if (!vcUniverse.length) {
        el.vcRows.innerHTML = `<tr><td colspan="14" class="loadingRow">API-Fehler. Refresh nochmal.</td></tr>`;
      }
    }
  }

  // ---------------- UI wiring ----------------
  function initVCInputs() {
    el.vcMcMin.value = cfg.vc.marketCapMin;
    el.vcMcMax.value = cfg.vc.marketCapMax;
    el.vcVolMin.value = cfg.vc.volume24hMin;
    el.vcMinScore.value = cfg.vc.minScore;
  }

  function debounceVC() {
    clearTimeout(vcDebounceTimer);
    vcDebounceTimer = setTimeout(() => runVC(false), 150);
  }

  el.btnModeKraken.addEventListener("click", () => setMode("kraken"));
  el.btnModeVC.addEventListener("click", () => setMode("vc"));

  el.btnRefresh.addEventListener("click", () => {
    if (mode === "kraken") runKraken();
    else runVC(true);
  });

  ["input","change"].forEach(evt => {
    el.vcMcMin.addEventListener(evt, debounceVC);
    el.vcMcMax.addEventListener(evt, debounceVC);
    el.vcVolMin.addEventListener(evt, debounceVC);
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