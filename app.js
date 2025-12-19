(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg || !cfg.vc) throw new Error("APP_CONFIG fehlt oder ist unvollständig");

  // ---------------- DOM safe getter ----------------
  const $ = (id) => document.getElementById(id);

  const el = {
    // optional nav
    btnModeKraken: $("btnModeKraken"),
    btnModeVC: $("btnModeVC"),
    btnRefresh: $("btnRefresh"),

    // optional views
    viewKraken: $("viewKraken"),
    viewVC: $("viewVC"),

    // optional kraken table
    krakenRows: $("krakenRows"),
    krakenErrors: $("krakenErrors"),

    // vc table + filters
    vcRows: $("vcRows"),
    vcErrors: $("vcErrors"),
    vcMcMin: $("vcMcMin"),
    vcMcMax: $("vcMcMax"),
    vcVolMin: $("vcVolMin"),
    vcMinScore: $("vcMinScore"),
    vcSearch: $("vcSearch"),
    vcSort: $("vcSort")
  };

  // ---------------- helpers ----------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isNum = (x) => Number.isFinite(x);

  const fmtUsd = (x) => isNum(x) ? "$" + Math.round(x).toLocaleString() : "—";
  const fmt = (x, d = 2) => isNum(x) ? Number(x).toLocaleString(undefined, { maximumFractionDigits: d }) : "—";
  const fmtPct = (x) => isNum(x) ? ((x >= 0 ? "+" : "") + x.toFixed(2) + "%") : "—";
  const clsSigned = (x) => (x >= 0 ? "pos" : "neg");

  const score01 = (x, lo, hi) => {
    if (!isNum(x)) return 0;
    if (hi === lo) return 0;
    return clamp((x - lo) / (hi - lo), 0, 1);
  };

  const bell01 = (x, center, width) => {
    // 1.0 at center; linearly decays to 0 at +/- width
    if (!isNum(x)) return 0;
    const d = Math.abs(x - center);
    return clamp(1 - d / Math.max(1e-9, width), 0, 1);
  };

  // ---------------- mode handling (optional) ----------------
  const LS_MODE = "cryptoapp.mode";
  let mode = localStorage.getItem(LS_MODE) || cfg.modeDefault || "vc";

  function setMode(next) {
    mode = next;
    localStorage.setItem(LS_MODE, mode);

    if (el.viewKraken) el.viewKraken.style.display = (mode === "kraken") ? "" : "none";
    if (el.viewVC) el.viewVC.style.display = (mode === "vc") ? "" : "none";
  }

  // ---------------- Narrative layer ----------------
  const NARR_CACHE_KEY = "cryptoapp.narratives.cache.v1";
  let narratives = { heat: {}, coins: {} };
  let narrativeLoaded = false;

  function normalizeTag(tag) {
    return String(tag || "").trim();
  }

  async function loadNarratives() {
    const url = cfg.vc.narrative?.url || "./narratives.json";

    // Try cache first for speed
    try {
      const cached = JSON.parse(localStorage.getItem(NARR_CACHE_KEY) || "null");
      if (cached && cached.heat && cached.coins) {
        narratives = cached;
        narrativeLoaded = true;
      }
    } catch {}

    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Narratives HTTP ${res.status}`);
      const data = await res.json();

      const heat = (data && typeof data.heat === "object" && data.heat) ? data.heat : {};
      const coins = (data && typeof data.coins === "object" && data.coins) ? data.coins : {};

      // sanitize: ensure arrays
      const cleanCoins = {};
      for (const [k, v] of Object.entries(coins)) {
        const arr = Array.isArray(v) ? v.map(normalizeTag).filter(Boolean) : [];
        cleanCoins[String(k)] = arr;
      }

      narratives = { heat, coins: cleanCoins };
      localStorage.setItem(NARR_CACHE_KEY, JSON.stringify(narratives));
      narrativeLoaded = true;
    } catch (e) {
      // Keep cached or empty; just mark loaded to prevent blocking
      narrativeLoaded = true;
      // only show error if vcErrors exists
      if (el.vcErrors) {
        const msg = `Narratives nicht geladen (${String(e?.message || e)}). Fallback: leer.`;
        el.vcErrors.textContent = msg;
      }
    }
  }

  function getNarrativeTagsForCoin(paprikaId) {
    const maxTags = cfg.vc.narrative?.tagsPerCoinMax ?? 2;
    const tags = narratives?.coins?.[paprikaId] || [];
    return tags.slice(0, maxTags);
  }

  function getHeatForTags(tags) {
    if (!tags || !tags.length) return 0;
    let best = 0;
    for (const t of tags) {
      const h = Number(narratives?.heat?.[t]);
      if (Number.isFinite(h)) best = Math.max(best, clamp(h, 0, 100));
    }
    return best; // best-tag heat
  }

  function narrativeBoostPoints(heat) {
    const maxPts = cfg.vc.narrative?.boostMaxPoints ?? 12;
    const h = clamp(Number(heat) || 0, 0, 100);
    return (h / 100) * maxPts; // 0..maxPts
  }

  // ---------------- VC Microcap (CoinPaprika) ----------------
  const VC_CACHE = "cryptoapp.vc.cache.v3";
  let vcUniverse = [];
  let vcDebounceTimer = null;

  async function paprikaGet(path) {
    const res = await fetch(`${cfg.vc.paprikaBase}${path}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`CoinPaprika HTTP ${res.status}`);
    return await res.json();
  }

  function computeVolMc(vol, mc) {
    if (!isNum(vol) || !isNum(mc) || mc <= 0) return NaN;
    return vol / mc;
  }

  function computeCircPct(circ, max) {
    if (!isNum(circ) || !isNum(max) || max <= 0) return NaN;
    return circ / max;
  }

  function vcComputeBase(row) {
    const mc = row.market_cap;
    const vol = row.volume_24h;

    const rank = row.rank;
    const maxSupply = row.max_supply;
    const circ = row.circulating_supply;

    const pct7 = row.pct7;
    const pct30 = row.pct30;

    const circPct = computeCircPct(circ, maxSupply);
    const volMc = computeVolMc(vol, mc);

    // QUALITY: rank + absolute vol sanity
    const rankScore = 1 - score01(rank, 50, cfg.vc.qualityRankMax);
    const absVolScore = score01(Math.log10(Math.max(1, vol)), 6.0, 8.0); // ~1M..100M
    const quality = clamp((0.70 * rankScore + 0.30 * absVolScore) * 100, 0, 100);

    // ASYMMETRY: smaller MC + supply clarity + circ%
    const mcScore = 1 - score01(mc, cfg.vc.marketCapMin, cfg.vc.marketCapMax);
    const supplyBonus = (isNum(maxSupply) && maxSupply > 0) ? 1 : 0;
    const circScore = score01(circPct, 0.30, 0.85);
    const asym = clamp((0.55 * mcScore + 0.25 * supplyBonus + 0.20 * circScore) * 100, 0, 100);

    // LIQUIDITY: vol/mc + absolute vol
    const volMcScore = score01(Math.log10(Math.max(1e-9, volMc)), -4.0, -1.0);
    const liq = clamp((0.70 * volMcScore + 0.30 * absVolScore) * 100, 0, 100);

    // SETUP: base (30d near 0) + mild turn (7d) + volMc confirmation
    const base30 = bell01(pct30, 0, 35);
    const turn7 = score01(pct7, -5, 25);
    const setup = clamp((0.45 * base30 + 0.35 * turn7 + 0.20 * volMcScore) * 100, 0, 100);

    // RISK penalty: pump/dump
    const p = cfg.vc.penalty;
    const pump7 = score01(pct7, p.pump7d, p.pump7d + 60) * 100;
    const pump30 = score01(pct30, p.pump30d, p.pump30d + 200) * 100;
    const dump30 = score01(p.dump30d - pct30, 0, 60) * 100;

    const supplyPenalty = (!isNum(maxSupply) || maxSupply <= 0) ? 15 : 0;
    const risk = clamp(0.45 * pump7 + 0.35 * pump30 + 0.20 * dump30 + supplyPenalty, 0, 100);

    return {
      quality, asym, liq, setup, risk,
      circ_pct: circPct,
      vol_mc: volMc,
      volmc_score: volMcScore
    };
  }

  function vcFinalScore(base, heat) {
    const w = cfg.vc.weights;

    // Weighted base score (0..100-ish)
    const weighted =
      (w.quality * base.quality) +
      (w.asym * base.asym) +
      (w.liq * base.liq) +
      (w.setup * base.setup);

    // Narrative: use heat to add points (bounded)
    const boostPts = narrativeBoostPoints(heat); // 0..boostMaxPoints
    const narrativeTerm = (w.narrative * 100) * (clamp(heat, 0, 100) / 100); // for transparency

    // Risk penalty (subtract)
    const penalty = (w.risk * base.risk);

    // Final score: weighted + boostPts - penalty
    const score = clamp(weighted + boostPts - penalty, 0, 100);

    return { score, boostPts, narrativeTerm };
  }

  function ensureVCInputsDefault() {
    if (el.vcMcMin && !el.vcMcMin.value) el.vcMcMin.value = cfg.vc.marketCapMin;
    if (el.vcMcMax && !el.vcMcMax.value) el.vcMcMax.value = cfg.vc.marketCapMax;
    if (el.vcVolMin && !el.vcVolMin.value) el.vcVolMin.value = cfg.vc.volume24hMin;
    if (el.vcMinScore && !el.vcMinScore.value) el.vcMinScore.value = cfg.vc.minScore;
  }

  function applyVCFilters(list) {
    const mcMin = el.vcMcMin ? Number(el.vcMcMin.value || cfg.vc.marketCapMin) : cfg.vc.marketCapMin;
    const mcMax = el.vcMcMax ? Number(el.vcMcMax.value || cfg.vc.marketCapMax) : cfg.vc.marketCapMax;
    const volMin = el.vcVolMin ? Number(el.vcVolMin.value || cfg.vc.volume24hMin) : cfg.vc.volume24hMin;
    const minScore = el.vcMinScore ? Number(el.vcMinScore.value || cfg.vc.minScore) : cfg.vc.minScore;
    const q = el.vcSearch ? (el.vcSearch.value || "").trim().toLowerCase() : "";
    const rankMax = cfg.vc.qualityRankMax;

    return list.filter(r => {
      if (!isNum(r.market_cap) || r.market_cap < mcMin || r.market_cap > mcMax) return false;
      if (!isNum(r.volume_24h) || r.volume_24h < volMin) return false;
      if (!isNum(r.score) || r.score < minScore) return false;
      if (isNum(rankMax) && isNum(r.rank) && r.rank > rankMax) return false;

      if (cfg.vc.requireSomeSupplyClarity) {
        const hasSupply = (isNum(r.max_supply) && r.max_supply > 0) || (isNum(r.circulating_supply) && r.circulating_supply > 0);
        if (!hasSupply) return false;
      }

      if (!q) return true;
      return (r.name || "").toLowerCase().includes(q) || (r.symbol || "").toLowerCase().includes(q) || (r.id || "").toLowerCase().includes(q);
    });
  }

  function sortVC(list) {
    const sort = el.vcSort ? (el.vcSort.value || "score") : "score";
    const sorters = {
      score: (a,b)=>b.score-a.score,
      mc: (a,b)=>(a.market_cap||0)-(b.market_cap||0),
      volmc: (a,b)=>(b.vol_mc||0)-(a.vol_mc||0),
      chg7: (a,b)=>(b.pct7||0)-(a.pct7||0),
      chg30: (a,b)=>(b.pct30||0)-(a.pct30||0),
      heat: (a,b)=>(b.heat||0)-(a.heat||0),
      boost: (a,b)=>(b.boost||0)-(a.boost||0),
    };
    const fn = sorters[sort] || sorters.score;
    return list.slice().sort(fn);
  }

  function renderVCRows(list) {
    if (!el.vcRows) return;

    if (!list.length) {
      el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">Keine Treffer (Filter zu hart?)</td></tr>`;
      return;
    }

    // We try to keep compatible with your existing table:
    // If your index has fewer columns, HTML will still render, but might look odd.
    // In practice, your current VC table likely has 14-16 columns.
    el.vcRows.innerHTML = list.map((r, i) => {
      const scoreCls = r.score >= 75 ? "good" : (r.score <= 55 ? "bad" : "neutral");
      const aCls = r.asym >= 70 ? "good" : (r.asym <= 45 ? "bad" : "neutral");
      const lCls = r.liq >= 70 ? "good" : (r.liq <= 45 ? "bad" : "neutral");
      const sCls = r.setup >= 70 ? "good" : (r.setup <= 45 ? "bad" : "neutral");
      const rCls = r.risk <= 30 ? "good" : (r.risk >= 60 ? "bad" : "neutral");

      const circTxt = isNum(r.circ_pct) ? (r.circ_pct * 100).toFixed(0) + "%" : "—";
      const volmcTxt = isNum(r.vol_mc) ? (r.vol_mc * 100).toFixed(2) + "%" : "—";
      const tagsTxt = (r.tags && r.tags.length) ? r.tags.join(", ") : "—";

      // Use a conservative column set (14+). Extra cells are fine if your header has them;
      // if not, you can later add header columns – the logic stays.
      return `
        <tr>
          <td class="muted">${i + 1}</td>

          <td>
            <b>${String(r.symbol || "").toUpperCase()}</b>
            <span class="muted">(${r.name || ""})</span>
            <div class="muted" style="font-size:12px;margin-top:2px">
              Rank: ${isNum(r.rank) ? r.rank : "—"} • ID: ${r.id || "—"}
            </div>
          </td>

          <td><span class="badge ${scoreCls}">${r.score.toFixed(0)}</span></td>
          <td><span class="badge ${aCls}">${r.asym.toFixed(0)}</span></td>
          <td><span class="badge ${lCls}">${r.liq.toFixed(0)}</span></td>
          <td><span class="badge ${sCls}">${r.setup.toFixed(0)}</span></td>
          <td><span class="badge ${rCls}">${r.risk.toFixed(0)}</span></td>

          <td>${fmtUsd(r.market_cap)}</td>
          <td>${fmtUsd(r.volume_24h)}</td>
          <td>${isNum(r.max_supply) ? fmt(r.max_supply, 0) : "—"}</td>
          <td>${circTxt}</td>
          <td>${volmcTxt}</td>

          <td class="${clsSigned(r.pct7)}">${fmtPct(r.pct7)}</td>
          <td class="${clsSigned(r.pct30)}">${fmtPct(r.pct30)}</td>

          <td>
            <div><b>Heat:</b> ${isNum(r.heat) ? r.heat.toFixed(0) : "0"} • <b>Boost:</b> ${isNum(r.boost) ? r.boost.toFixed(1) : "0.0"}</div>
            <div class="muted" style="font-size:12px;margin-top:2px"><b>Narrative:</b> ${tagsTxt}</div>
          </td>

          <td>${fmt(r.price, 8)}</td>
        </tr>
      `;
    }).join("");
  }

  async function runVC(fullFetch = true) {
    if (el.vcErrors) el.vcErrors.textContent = "";

    ensureVCInputsDefault();

    // Show cached VC data immediately if present
    if (fullFetch && el.vcRows) {
      try {
        const cached = JSON.parse(localStorage.getItem(VC_CACHE) || "null");
        if (cached && Array.isArray(cached.rows) && cached.rows.length) {
          vcUniverse = cached.rows;
          const filtered = sortVC(applyVCFilters(vcUniverse));
          renderVCRows(filtered);
        }
      } catch {}
      el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">Loading Microcap Universe…</td></tr>`;
    }

    if (!fullFetch) {
      const filtered = sortVC(applyVCFilters(vcUniverse));
      renderVCRows(filtered);
      return;
    }

    try {
      // Ensure narratives loaded before scoring
      if (!narrativeLoaded) {
        await loadNarratives();
      }

      const raw = await paprikaGet(`/tickers?quotes=USD`);

      const top = raw
        .map(x => {
          const q = x.quotes?.USD || {};
          return {
            id: x.id,
            symbol: x.symbol,
            name: x.name,
            rank: x.rank,

            market_cap: q.market_cap,
            volume_24h: q.volume_24h,
            price: q.price,

            pct7: q.percent_change_7d,
            pct30: q.percent_change_30d,

            circulating_supply: x.circulating_supply,
            max_supply: x.max_supply
          };
        })
        .filter(x => isNum(x.market_cap))
        .sort((a,b)=>b.market_cap-a.market_cap)
        .slice(0, cfg.vc.universeTopN);

      vcUniverse = top.map(r => {
        const base = vcComputeBase(r);

        const tags = getNarrativeTagsForCoin(r.id);
        const heat = getHeatForTags(tags);

        const final = vcFinalScore(base, heat);

        return {
          ...r,
          ...base,
          score: final.score,
          boost: final.boostPts,
          narrative_term: final.narrativeTerm,
          tags,
          heat
        };
      });

      localStorage.setItem(VC_CACHE, JSON.stringify({ t: Date.now(), rows: vcUniverse }));

      const filtered = sortVC(applyVCFilters(vcUniverse));
      renderVCRows(filtered);

    } catch (e) {
      if (el.vcErrors) el.vcErrors.textContent = String(e?.message || e);
      if (el.vcRows) el.vcRows.innerHTML = `<tr><td colspan="16" class="loadingRow">API-Fehler. Refresh nochmal.</td></tr>`;
    }
  }

  // ---------------- events ----------------
  function debounceVC() {
    clearTimeout(vcDebounceTimer);
    vcDebounceTimer = setTimeout(() => runVC(false), 180);
  }

  // mode buttons (optional)
  if (el.btnModeKraken) el.btnModeKraken.addEventListener("click", () => setMode("kraken"));
  if (el.btnModeVC) el.btnModeVC.addEventListener("click", () => setMode("vc"));

  if (el.btnRefresh) el.btnRefresh.addEventListener("click", () => {
    if (mode === "vc") runVC(true);
    // Kraken refresh omitted here intentionally to avoid breaking your current app if Kraken view is absent.
  });

  // filters (if exist)
  const filterEls = [el.vcMcMin, el.vcMcMax, el.vcVolMin, el.vcMinScore, el.vcSearch, el.vcSort].filter(Boolean);
  for (const inp of filterEls) {
    inp.addEventListener("input", debounceVC);
    inp.addEventListener("change", debounceVC);
  }

  // ---------------- boot ----------------
  setMode(mode);

  // Always load narratives early (does not block VC if it fails; uses cache/empty)
  loadNarratives().finally(() => {
    // Start VC if that view exists; otherwise do nothing.
    if (el.viewVC || el.vcRows) runVC(true);
  });

})();