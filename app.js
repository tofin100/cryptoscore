(() => {
  const cfg = window.VC_CONFIG;
  const base = cfg.api.coingeckoBase;
  const vs = cfg.api.vsCurrency;

  // DOM
  const els = {
    rows: document.getElementById("rows"),
    btnReload: document.getElementById("btnReload"),
    statusPill: document.getElementById("statusPill"),
    errors: document.getElementById("errors"),
    kpiUniverse: document.getElementById("kpiUniverse"),
    kpiFilters: document.getElementById("kpiFilters"),
    kpiUpdated: document.getElementById("kpiUpdated"),

    mcMax: document.getElementById("mcMax"),
    mcMin: document.getElementById("mcMin"),
    volMin: document.getElementById("volMin"),
    fdvMcMax: document.getElementById("fdvMcMax"),
    minScore: document.getElementById("minScore"),
    search: document.getElementById("search"),
    sort: document.getElementById("sort"),
  };

  // Helpers
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = (x) => Number.isFinite(x);
  const fmtUsd = (x) => isNum(x) ? "$" + Math.round(x).toLocaleString() : "—";
  const fmt = (x, d=2) => isNum(x) ? Number(x).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  const fmtPct = (x) => isNum(x) ? ((x>=0?"+":"") + x.toFixed(2) + "%") : "—";
  const clsSigned = (x) => (x >= 0 ? "pos" : "neg");

  function score01(x, lo, hi) {
    if (!isNum(x)) return 0;
    return clamp((x - lo) / (hi - lo), 0, 1);
  }

  // Load optional narratives
  let narrativeTags = {};
  async function loadNarratives() {
    try {
      const res = await fetch("./narratives.json", { cache: "no-store" });
      if (!res.ok) return {};
      const json = await res.json();
      return json?.tags || {};
    } catch {
      return {};
    }
  }

  async function cgGet(path) {
    const res = await fetch(`${base}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchMarketsPage(page, perPage) {
    // includes: market_cap, fully_diluted_valuation, total_supply, max_supply, circulating_supply,
    // price_change_percentage_7d_in_currency, price_change_percentage_30d_in_currency (if supported)
    const params = new URLSearchParams({
      vs_currency: vs,
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
    // Prefer max if available, else total
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
    return (price / ath - 1) * 100; // negative if below ATH
  }

  function vcScore(row) {
    // --- ASYMMETRY (0..100) ---
    // Low market cap is good (within microcap range)
    const mc = row.market_cap;
    const fdvmc = row.fdv_mc;
    const circPct = row.circ_pct;

    const mcScore = 1 - score01(mc, 5_000_000, 300_000_000); // lower MC better
    const fdvScore = 1 - score01(fdvmc, 1.2, 6.0);          // lower FDV/MC better
    const circScore = score01(circPct, 0.30, 0.85);         // higher circ better
    const maxSupplyBonus = isNum(row.max_supply) && row.max_supply > 0 ? 1 : 0;

    const asym = clamp(
      (0.40*mcScore + 0.40*fdvScore + 0.15*circScore + 0.05*maxSupplyBonus) * 100,
      0, 100
    );

    // --- LIQUIDITY (0..100) ---
    const volmc = row.vol_mc;
    const vol = row.total_volume;

    const volmcScore = score01(Math.log10(Math.max(1e-9, volmc)), -4.0, -1.0); // 0.0001..0.1 typical
    const absVolScore = score01(Math.log10(Math.max(1, vol)), 5.5, 7.5);       // ~300k .. 30M
    const liq = clamp((0.70*volmcScore + 0.30*absVolScore) * 100, 0, 100);

    // --- TIMING (0..100) ---
    // Not “chasing”: moderate positive better than extreme
    const chg7 = row.chg7;
    const chg30 = row.chg30;

    const t7 = score01(chg7, -10, 35);    // -10%..+35%
    const t30 = score01(chg30, -20, 80);  // -20%..+80%
    const timing = clamp((0.55*t30 + 0.45*t7) * 100, 0, 100);

    // --- RISK penalty (0..100) ---
    // too close to ATH => late; too dead => maybe broken
    const athDelta = row.ath_delta_pct; // negative
    const nearAthPenalty = score01(athDelta, -25, 0) * 100;   // within -25% of ATH => higher penalty
    const deadPenalty = score01(-chg30, 25, 70) * 100;        // if 30d is -25%..-70% => penalty rises
    const riskPenalty = clamp(0.60*nearAthPenalty + 0.40*deadPenalty, 0, 100);

    // FINAL
    const w = cfg.weights;
    const final = clamp(
      (w.asym*asym + w.liq*liq + w.timing*timing) - (w.risk*riskPenalty),
      0, 100
    );

    return { final, asym, liq, timing, risk: riskPenalty };
  }

  function render(rows) {
    const q = (els.search.value || "").trim().toLowerCase();
    const minScore = Number(els.minScore.value || 0);
    const sort = els.sort.value;

    let out = rows.filter(r => {
      if (r.score < minScore) return false;
      if (!q) return true;
      const name = (r.name || "").toLowerCase();
      const sym = (r.symbol || "").toLowerCase();
      const id = (r.id || "").toLowerCase();
      return name.includes(q) || sym.includes(q) || id.includes(q);
    });

    const sorters = {
      score: (a,b) => b.score - a.score,
      mc: (a,b) => (a.market_cap||0) - (b.market_cap||0),
      volmc: (a,b) => (b.vol_mc||0) - (a.vol_mc||0),
      fdvmc: (a,b) => (a.fdv_mc||999) - (b.fdv_mc||999),
      chg7: (a,b) => (b.chg7||0) - (a.chg7||0),
      chg30: (a,b) => (b.chg30||0) - (a.chg30||0),
    };
    out.sort(sorters[sort] || sorters.score);

    if (!out.length) {
      els.rows.innerHTML = `<tr><td colspan="16" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    els.rows.innerHTML = out.map((r, i) => {
      const scoreCls = r.score >= 75 ? "good" : (r.score <= 55 ? "bad" : "neutral");
      const aCls = r.asym >= 70 ? "good" : (r.asym <= 45 ? "bad" : "neutral");
      const lCls = r.liq >= 70 ? "good" : (r.liq <= 45 ? "bad" : "neutral");
      const tCls = r.timing >= 70 ? "good" : (r.timing <= 45 ? "bad" : "neutral");
      const rCls = r.risk <= 30 ? "good" : (r.risk >= 60 ? "bad" : "neutral");

      const fdvmcTxt = isNum(r.fdv_mc) ? r.fdv_mc.toFixed(2) : "—";
      const circTxt = isNum(r.circ_pct) ? (r.circ_pct*100).toFixed(0) + "%" : "—";
      const volmcTxt = isNum(r.vol_mc) ? (r.vol_mc*100).toFixed(2) + "%" : "—"; // show as % of MC

      const tags = (narrativeTags[r.id] || []).join(", ");
      const tagHtml = tags ? `<div class="muted" style="font-size:12px;margin-top:2px">${tags}</div>` : "";

      return `
        <tr>
          <td class="muted">${i+1}</td>
          <td><b>${r.symbol.toUpperCase()}</b> <span class="muted">(${r.name})</span>${tagHtml}</td>

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

          <td class="${clsSigned(r.chg7)}">${fmtPct(r.chg7)}</td>
          <td class="${clsSigned(r.chg30)}">${fmtPct(r.chg30)}</td>
          <td class="${clsSigned(r.ath_delta_pct)}">${fmtPct(r.ath_delta_pct)}</td>
          <td>${fmt(r.current_price, 8)}</td>
        </tr>
      `;
    }).join("");
  }

  async function scan() {
    els.errors.textContent = "";
    els.statusPill.textContent = "Scanning…";
    els.rows.innerHTML = `<tr><td colspan="16" class="loadingRow">Daten werden geladen…</td></tr>`;

    try {
      narrativeTags = await loadNarratives();

      const mcMin = Number(els.mcMin.value || cfg.scan.marketCapMin);
      const mcMax = Number(els.mcMax.value || cfg.scan.marketCapMax);
      const volMin = Number(els.volMin.value || cfg.scan.volume24hMin);
      const fdvMcMax = Number(els.fdvMcMax.value || cfg.scan.fdvMcMax);

      els.kpiFilters.textContent = `MC ${fmtUsd(mcMin)}–${fmtUsd(mcMax)} | Vol ≥ ${fmtUsd(volMin)} | FDV/MC ≤ ${fdvMcMax}`;

      const pages = cfg.scan.pages;
      const perPage = cfg.scan.perPage;

      let universe = [];
      for (let p = 1; p <= pages; p++) {
        const arr = await fetchMarketsPage(p, perPage);
        universe = universe.concat(arr);
        // tiny delay to be friendly with rate limits
        await new Promise(r => setTimeout(r, 250));
      }

      els.kpiUniverse.textContent = String(universe.length);
      els.kpiUpdated.textContent = new Date().toISOString().replace("T"," ").slice(0,19);

      // Normalize rows
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

        return {
          id: x.id,
          symbol: x.symbol,
          name: x.name,
          current_price: x.current_price,

          market_cap: mc,
          total_volume: vol,

          fdv: fdv,
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
      });

      // Apply filters (microcap + investable)
      const filtered = rows.filter(r => {
        if (!isNum(r.market_cap)) return false;
        if (r.market_cap < mcMin || r.market_cap > mcMax) return false;

        if (!isNum(r.total_volume) || r.total_volume < volMin) return false;

        // FDV/MC filter only if we have fdv data; if missing, keep but lower score later
        if (isNum(r.fdv_mc) && r.fdv_mc > fdvMcMax) return false;

        return true;
      });

      // Score
      const scored = filtered.map(r => {
        const s = vcScore(r);
        return { ...r, score: s.final, asym: s.asym, liq: s.liq, timing: s.timing, risk: s.risk };
      });

      // If fdv missing: small penalty (soft)
      for (const r of scored) {
        if (!isNum(r.fdv)) r.score = clamp(r.score - 6, 0, 100);
      }

      render(scored);
      els.statusPill.textContent = "Done";
    } catch (e) {
      els.errors.textContent = String(e?.message || e);
      els.statusPill.textContent = "Error";
      els.rows.innerHTML = `<tr><td colspan="16" class="loadingRow">Fehler beim Scan. Details oben.</td></tr>`;
    }
  }

  // Init defaults in UI
  function initInputs() {
    els.mcMax.value = cfg.scan.marketCapMax;
    els.mcMin.value = cfg.scan.marketCapMin;
    els.volMin.value = cfg.scan.volume24hMin;
    els.fdvMcMax.value = cfg.scan.fdvMcMax;
    els.minScore.value = cfg.scan.minScore;
  }

  // Events
  els.btnReload.addEventListener("click", scan);
  ["change","input"].forEach(evt => {
    els.mcMax.addEventListener(evt, () => scan());
    els.mcMin.addEventListener(evt, () => scan());
    els.volMin.addEventListener(evt, () => scan());
    els.fdvMcMax.addEventListener(evt, () => scan());
    els.minScore.addEventListener(evt, () => scan());
    els.search.addEventListener(evt, () => scan());
    els.sort.addEventListener(evt, () => scan());
  });

  initInputs();
})();