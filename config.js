window.APP_CONFIG = {
  modeDefault: "vc", // "kraken" oder "vc"

  // --------- Kraken (dein bisheriger Watchlist-Scanner) ---------
  kraken: {
    maxConcurrentRequests: 4,
    dailyInterval: 1440,
    lookbackDays: 31,
    watchlist: [
      { symbol: "BTC", pair: "XXBTZUSD" },
      { symbol: "ETH", pair: "XETHZUSD" },
      { symbol: "SOL", pair: "SOLUSD" },
      { symbol: "LINK", pair: "LINKUSD" },
      { symbol: "AVAX", pair: "AVAXUSD" },
      { symbol: "INJ", pair: "INJUSD" }
    ]
  },

  // --------- VC Microcap Scanner (CoinGecko Universe) ---------
  vc: {
    coingeckoBase: "https://api.coingecko.com/api/v3",
    vsCurrency: "usd",

    // Universe-Größe (klein halten → weniger Rate-Limits)
    pages: 2,
    perPage: 100,

    // Default Microcap Filter (investierbar, nicht nur “toter Pump”)
    marketCapMin: 5_000_000,
    marketCapMax: 300_000_000,
    volume24hMin: 500_000,
    fdvMcMax: 6.0,

    minScore: 60,

    weights: {
      asym: 0.40,
      liq: 0.30,
      timing: 0.20,
      risk: 0.10 // penalty
    }
  }
};