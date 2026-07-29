const { DEFAULT_DISPLAY_NAME } = require('./symbols');

function numOrUndefined(value) {
  if (!value) return undefined;
  return Number(value);
}

function getSymbolDisplayName() {
  return process.env.SYMBOL_DISPLAY_NAME || DEFAULT_DISPLAY_NAME;
}

function strategyOptsFromEnv() {
  return {
    cooldownTicks: numOrUndefined(process.env.COOLDOWN_TICKS_AFTER_CRASH),
    stochPeriod: numOrUndefined(process.env.STOCH_PERIOD),
    stochSmoothK: numOrUndefined(process.env.STOCH_SMOOTH_K),
    stochSmoothD: numOrUndefined(process.env.STOCH_SMOOTH_D),
    stochOverbought: numOrUndefined(process.env.STOCH_OVERBOUGHT),
  };
}

function riskOptsFromEnv() {
  return {
    riskPerTradePct: numOrUndefined(process.env.RISK_PER_TRADE_PCT),
    maxDailyLossPct: numOrUndefined(process.env.MAX_DAILY_LOSS_PCT),
  };
}

module.exports = { getSymbolDisplayName, strategyOptsFromEnv, riskOptsFromEnv };
