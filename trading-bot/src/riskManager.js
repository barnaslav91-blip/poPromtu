const DEFAULTS = {
  riskPerTradePct: 1, // % от баланса, которым рискуем в одной сделке
  maxDailyLossPct: 5, // % от стартового баланса дня — дневной стоп
  maxConcurrentPositions: 1,
  multiplier: 100, // плечо мультипликатора Deriv (MULTUP/MULTDOWN)
  minStakeUsd: 1,
};

// Считает stake и stop_loss (в валюте счёта) так, чтобы движение цены на
// stopDistancePct (адаптивное значение из strategy.js, завязанное на ATR)
// приводило ровно к потере riskPerTradePct% от баланса — без мартингейла,
// размер не растёт после проигрышей.
class RiskManager {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.dayStartBalance = null;
    this.dailyPnl = 0;
    this.halted = false;
    this.haltReason = null;
  }

  startDay(balance) {
    this.dayStartBalance = balance;
    this.dailyPnl = 0;
    if (!this.halted) this.haltReason = null;
  }

  isHalted() {
    return this.halted;
  }

  halt(reason) {
    this.halted = true;
    this.haltReason = reason;
  }

  resume() {
    this.halted = false;
    this.haltReason = null;
  }

  canOpenPosition(openPositionsCount) {
    if (this.halted) return { allowed: false, reason: this.haltReason };
    if (openPositionsCount >= this.opts.maxConcurrentPositions) {
      return { allowed: false, reason: 'max-concurrent-positions' };
    }
    return { allowed: true };
  }

  sizeTrade({ balance, stopDistancePct }) {
    const riskAmount = balance * (this.opts.riskPerTradePct / 100);
    const notional = riskAmount / stopDistancePct;
    const stake = Math.max(notional / this.opts.multiplier, this.opts.minStakeUsd);

    return {
      stake: Number(stake.toFixed(2)),
      stopLossUsd: Number(riskAmount.toFixed(2)),
      multiplier: this.opts.multiplier,
    };
  }

  recordClosedTrade(pnlUsd) {
    this.dailyPnl += pnlUsd;

    if (this.dayStartBalance !== null) {
      const lossPct = (-this.dailyPnl / this.dayStartBalance) * 100;
      if (lossPct >= this.opts.maxDailyLossPct) {
        this.halt('daily-loss-limit');
      }
    }
  }
}

module.exports = { RiskManager, DEFAULTS };
