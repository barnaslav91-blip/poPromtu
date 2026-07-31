const { StrategyEngine } = require('./strategy');
const { RiskManager } = require('./riskManager');

// Прогоняет стратегию по массиву тиков без сети — используется и обычным
// бэктестом (backtest.js), и перебором параметров (calibrate.js).
function simulate({ prices, times, startBalance = 1000, strategyOpts = {}, riskOpts = {} }) {
  const strategy = new StrategyEngine(strategyOpts);
  const riskManager = new RiskManager(riskOpts);

  let balance = startBalance;
  riskManager.startDay(balance);

  let position = null;
  let peakBalance = balance;
  let maxDrawdownPct = 0;
  const trades = [];

  function closePosition(pnl, reason) {
    balance += pnl;
    riskManager.recordClosedTrade(pnl);
    trades.push({ pnl, reason });
    position = null;
    peakBalance = Math.max(peakBalance, balance);
    const drawdownPct = ((peakBalance - balance) / peakBalance) * 100;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
  }

  for (let i = 0; i < prices.length; i += 1) {
    const tick = { epoch: times[i], quote: prices[i] };
    strategy.ingestTick(tick);

    if (position) {
      const directionSign = position.direction === 'up' ? 1 : -1;
      const priceChangePct = (tick.quote - position.entryPrice) / position.entryPrice;
      const unrealizedPnl = position.stake * position.multiplier * priceChangePct * directionSign;
      if (unrealizedPnl <= -position.stopLossUsd) {
        closePosition(-position.stopLossUsd, 'stop-loss');
        continue;
      }
    }

    const signal = strategy.evaluate({
      inPosition: !!position,
      positionDirection: position ? position.direction : null,
    });

    if (signal.action === 'close' && position) {
      const directionSign = position.direction === 'up' ? 1 : -1;
      const priceChangePct = (tick.quote - position.entryPrice) / position.entryPrice;
      const pnl = position.stake * position.multiplier * priceChangePct * directionSign;
      closePosition(pnl, signal.reason);
    } else if (signal.action === 'open' && !position) {
      const { allowed } = riskManager.canOpenPosition(0);
      if (allowed) {
        const sizing = riskManager.sizeTrade({ balance, stopDistancePct: signal.stopDistancePct });
        position = {
          entryPrice: tick.quote,
          direction: signal.direction,
          stake: sizing.stake,
          multiplier: sizing.multiplier,
          stopLossUsd: sizing.stopLossUsd,
        };
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.length - wins;

  return {
    trades,
    wins,
    losses,
    winRatePct: trades.length ? (wins / trades.length) * 100 : 0,
    finalBalance: balance,
    pnl: balance - startBalance,
    maxDrawdownPct,
    haltedReason: riskManager.isHalted() ? riskManager.haltReason : null,
  };
}

module.exports = { simulate };
