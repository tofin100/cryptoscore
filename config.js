window.APP_CONFIG = {
  modeDefault: "vc",

  // Optional/legacy: Nur genutzt, wenn deine UI-Elemente dafür existieren
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

  vc: {
    paprikaBase: "https://api.coinpaprika.com/v1",
    universeTopN: 2000,

    // Quality Gate
    qualityRankMax: 800,
    requireSomeSupplyClarity: false,

    // Default Microcap Filter
    marketCapMin: 5_000_000,
    marketCapMax: 120_000_000,
    volume24hMin: 1_000_000,

    // Default score threshold UI
    minScore: 70,

    // Score Weights
    weights: {
      quality: 0.22,
      asym: 0.18,
      liq: 0.22,
      setup: 0.26,
      narrative: 0.12, // NEW
      risk: 0.20       // penalty weight
    },

    // Narrative layer config (NEW)
    narrative: {
      url: "./narratives.json",
      boostMaxPoints: 12,  // max Punkte, die Narrative adden darf (0..12)
      tagsPerCoinMax: 2    // sanity limit
    },

    // Pump / Dump penalties
    penalty: {
      pump7d: 40,
      pump30d: 120,
      dump30d: -55
    }
  }
};