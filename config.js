/**
 * CryptoScore Config (Root-only)
 * - WATCHLIST: Liste der Assets, die gerankt werden
 * - KRAKEN_PAIRS: Kraken Pair-Codes (USD)
 *
 * Du kannst Watchlist später im UI bearbeiten (localStorage Override).
 */

window.CRYPTOSCORE_CONFIG = {
  APP: {
    autoRefreshMinutes: 10,
    quote: "USD",
    // Kraken OHLC interval in minutes. 1440 = Daily
    ohlcInterval: 1440,
    // Lookback days: 31 gives you 30D return and a volume baseline
    lookbackDays: 31,
    // If you have too many coins, Kraken rate-limits you. Start with 10–25.
    maxConcurrentRequests: 4,
  },

  WATCHLIST: [
    // Base
    { symbol: "BTC", pair: "XXBTZUSD" },
    { symbol: "ETH", pair: "XETHZUSD" },

    // Example alts (edit as needed)
    { symbol: "SOL", pair: "SOLUSD" },
    { symbol: "LINK", pair: "LINKUSD" },
    { symbol: "AVAX", pair: "AVAXUSD" },
    { symbol: "INJ", pair: "INJUSD" },
    { symbol: "ADA", pair: "ADAUSD" },
    { symbol: "DOT", pair: "DOTUSD" },
  ],
};