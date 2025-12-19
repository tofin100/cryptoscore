(() => {
  const cfg = window.APP_CONFIG;
  if (!cfg) throw new Error("APP_CONFIG fehlt");

  // ========= DOM =========
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

  // ========= Helpers =========
  const clamp = (v,l,h)=>Math.max(l,Math.min(h,v));
  const isNum = x => Number.isFinite(x);
  const fmtUsd = x => isNum(x) ? "$"+Math.round(x).toLocaleString() : "—";
  const fmtPct = x => isNum(x) ? ((x>=0?"+":"")+x.toFixed(2)+"%") : "—";

  const score01 = (x,lo,hi)=>{
    if(!isNum(x)) return 0;
    return clamp((x-lo)/(hi-lo),0,1);
  };

  const bell01 = (x,c,w)=>{
    if(!isNum(x)) return 0;
    return clamp(1-(Math.abs(x-c)/w),0,1);
  };

  // ========= MODE =========
  const LS_MODE="crypto.mode";
  let mode = localStorage.getItem(LS_MODE) || cfg.modeDefault;

  function setMode(m){
    mode=m;
    localStorage.setItem(LS_MODE,m);
    el.viewKraken.style.display = m==="kraken"?"":"none";
    el.viewVC.style.display = m==="vc"?"":"none";
  }

  // ========= VC SCANNER =========
  const CACHE="vc.cache.v1";
  let universe=[];

  async function paprika(path){
    const r = await fetch(cfg.vc.paprikaBase+path,{cache:"no-store"});
    if(!r.ok) throw new Error("Paprika API "+r.status);
    return r.json();
  }

  function computeVC(row){
    const mc=row.market_cap, vol=row.volume_24h;
    const rank=row.rank, max=row.max_supply, circ=row.circulating_supply;
    const pct7=row.pct7, pct30=row.pct30;

    const circPct = isNum(circ)&&isNum(max)&&max>0 ? circ/max : NaN;
    const volMc = isNum(vol)&&isNum(mc)&&mc>0 ? vol/mc : NaN;

    const quality = clamp(
      (1-score01(rank,50,cfg.vc.qualityRankMax))*70 +
      score01(Math.log10(vol),6,8)*30
    ,0,100);

    const asym = clamp(
      (1-score01(mc,cfg.vc.marketCapMin,cfg.vc.marketCapMax))*60 +
      score01(circPct,0.3,0.85)*40
    ,0,100);

    const liq = clamp(
      score01(Math.log10(volMc),-4,-1)*100
    ,0,100);

    const setup = clamp(
      (bell01(pct30,0,35)*50) +
      (score01(pct7,-5,25)*30) +
      (score01(Math.log10(volMc),-4,-1)*20)
    ,0,100);

    const p=cfg.vc.penalty;
    const risk = clamp(
      score01(pct7,p.pump7d,p.pump7d+60)*40 +
      score01(pct30,p.pump30d,p.pump30d+200)*40 +
      score01(p.dump30d-pct30,0,60)*20
    ,0,100);

    const w=cfg.vc.weights;
    const score = clamp(
      (w.quality*quality + w.asym*asym + w.liq*liq + w.setup*setup) -
      (w.risk*risk)
    ,0,100);

    return {score,quality,asym,liq,setup,risk,circPct,volMc};
  }

  async function runVC(){
    el.vcErrors.textContent="";
    el.vcRows.innerHTML=`<tr><td colspan="14">Loading VC Microcaps…</td></tr>`;

    try{
      const raw = await paprika("/tickers?quotes=USD");
      universe = raw
        .map(x=>{
          const q=x.quotes.USD;
          return {
            id:x.id,symbol:x.symbol,name:x.name,rank:x.rank,
            market_cap:q.market_cap,volume_24h:q.volume_24h,
            price:q.price,pct7:q.percent_change_7d,
            pct30:q.percent_change_30d,
            circulating_supply:x.circulating_supply,
            max_supply:x.max_supply
          };
        })
        .filter(x=>isNum(x.market_cap))
        .sort((a,b)=>b.market_cap-a.market_cap)
        .slice(0,cfg.vc.universeTopN)
        .map(x=>({...x,...computeVC(x)}));

      localStorage.setItem(CACHE,JSON.stringify(universe));
      renderVC();
    }catch(e){
      el.vcErrors.textContent=e.message;
    }
  }

  function renderVC(){
    const mcMin=+el.vcMcMin.value||cfg.vc.marketCapMin;
    const mcMax=+el.vcMcMax.value||cfg.vc.marketCapMax;
    const volMin=+el.vcVolMin.value||cfg.vc.volume24hMin;
    const minScore=+el.vcMinScore.value||cfg.vc.minScore;
    const q=(el.vcSearch.value||"").toLowerCase();
    const sort=el.vcSort.value;

    let out=universe.filter(r=>{
      if(r.market_cap<mcMin||r.market_cap>mcMax) return false;
      if(r.volume_24h<volMin) return false;
      if(r.score<minScore) return false;
      if(cfg.vc.qualityRankMax && r.rank>cfg.vc.qualityRankMax) return false;
      if(!q) return true;
      return r.symbol.toLowerCase().includes(q)||r.name.toLowerCase().includes(q);
    });

    const sorters={
      score:(a,b)=>b.score-a.score,
      mc:(a,b)=>a.market_cap-b.market_cap,
      volmc:(a,b)=>(b.volMc||0)-(a.volMc||0),
      chg7:(a,b)=>(b.pct7||0)-(a.pct7||0),
      chg30:(a,b)=>(b.pct30||0)-(a.pct30||0),
    };
    out.sort(sorters[sort]||sorters.score);

    el.vcRows.innerHTML = out.map((r,i)=>`
      <tr>
        <td>${i+1}</td>
        <td><b>${r.symbol}</b><div class="muted">${r.name}</div></td>
        <td><b>${r.score.toFixed(0)}</b></td>
        <td>${r.asym.toFixed(0)}</td>
        <td>${r.liq.toFixed(0)}</td>
        <td>${r.setup.toFixed(0)}</td>
        <td>${r.risk.toFixed(0)}</td>
        <td>${fmtUsd(r.market_cap)}</td>
        <td>${fmtPct(r.pct7)}</td>
        <td>${fmtPct(r.pct30)}</td>
      </tr>
    `).join("");
  }

  // ========= EVENTS =========
  el.btnModeKraken.onclick=()=>setMode("kraken");
  el.btnModeVC.onclick=()=>setMode("vc");
  el.btnRefresh.onclick=()=>mode==="vc"?runVC():null;

  ["input","change"].forEach(e=>{
    el.vcMcMin.addEventListener(e,renderVC);
    el.vcMcMax.addEventListener(e,renderVC);
    el.vcVolMin.addEventListener(e,renderVC);
    el.vcMinScore.addEventListener(e,renderVC);
    el.vcSearch.addEventListener(e,renderVC);
    el.vcSort.addEventListener(e,renderVC);
  });

  // ========= BOOT =========
  setMode(mode);
  if(mode==="vc") runVC();
})();