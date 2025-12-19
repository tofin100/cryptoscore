window.VC_CONFIG = {
  api: {
    coingeckoBase: "https://api.coingecko.com/api/v3",
    vsCurrency: "usd",
  },

  scan: {
    // Universe Size: je größer, desto eher Rate Limit.
    pages: 2,          // 2 Seiten * perPage Coins
    perPage: 100,      // max 250 (CoinGecko), aber RateLimit beachten

    // Default Filter (Microcap Fokus)
    marketCapMin: 5_000_000,     // 5M
    marketCapMax: 300_000_000,   // 300M
    volume24hMin: 500_000,       // 500k
    fdvMcMax: 6.0,               // FDV/MC max

    minScore: 60,
  },

  // Weighting (VC Score)
  weights: {
    asym: 0.40,
    liq: 0.30,
    timing: 0.20,
    risk: 0.10, // risk is penalty internally
  }
};