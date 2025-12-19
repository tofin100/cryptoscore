/**
 * CryptoScore Config (ROOT ONLY)
 * - WATCHLIST: Liste der Assets, die gerankt werden
 * - Du kannst die Watchlist später im UI ändern (localStorage)
 */

window.CRYPTOSCORE_CONFIG = {
  APP: {
    autoRefreshMinutes: 10,
    quote: "USD",

    // OHLC intervals in minutes
    dailyInterval: 1440,     // 1D (Regime + Returns)
    breakoutInterval: 240,   // 4H (CHOCH/BOS)

    // Lookbacks
    lookbackDaysDaily: 31,   // min für 30D Return
    lookbackCandles4H: 180,  // ~30 Tage 4H (180*4h=720h)

    // Pivot / Structure detection
    pivotLeft: 2,
    pivotRight: 2,

    // Compression (ATR drop)
    compressionAtrDrop: 0.25, // ATR recent < ATR earlier*(1-0.25)

    // Rate limiting
    maxConcurrentRequests: 4,
  },

  WATCHLIST: [
    { symbol: "BTC", pair: "XXBTZUSD" },
    { symbol: "ETH", pair: "XETHZUSD" },

    { symbol: "SOL", pair: "SOLUSD" },
    { symbol: "LINK", pair: "LINKUSD" },
    { symbol: "AVAX", pair: "AVAXUSD" },
    { symbol: "INJ", pair: "INJUSD" },

    { symbol: "ADA", pair: "ADAUSD" },
    { symbol: "DOT", pair: "DOTUSD" },
  ],
};