window.APP_CONFIG = {
  modeDefault: "vc", // "kraken" oder "vc"

  kraken: {
    maxConcurrentRequests: 4,
    dailyInterval: 1440,
    watchlist: [
      { symbol: "BTC", pair: "XXBTZUSD" },
      { symbol: "ETH", pair: "XETHZUSD" },
      { symbol: "SOL", pair: "SOLUSD" },
      { symbol: "LINK", pair: "LINKUSD" },
      { symbol: "AVAX", pair: "AVAXUSD" },
      { symbol: "INJ", pair: "INJUSD" }
    ]
  },

  // VC Microcap Scanner (FREE) via CoinPaprika tickers
  vc: {
    paprikaBase: "https://api.coinpaprika.com/v1",

    // Universe: CoinPaprika liefert viele; wir schneiden danach runter
    // (Keep the first N by market cap)
    universeTopN: 1200,

    // Default Microcap Filter
    marketCapMin: 5_000_000,
    marketCapMax: 300_000_000,
    volume24hMin: 500_000,
    minScore: 60,

    weights: {
      asym: 0.40,    // MarketCap + Supply clarity
      liq: 0.30,     // Vol/MC + absolute volume
      timing: 0.20,  // 7d/30d momentum
      risk: 0.10     // penalty
    }
  }
};