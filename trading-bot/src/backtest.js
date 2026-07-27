require('dotenv').config();

const { DerivClient } = require('./derivClient');
const { resolveSymbol } = require('./symbols');
const { StrategyEngine } = require('./strategy');
const { RiskManager } = require('./riskManager');

const START_BALANCE = 1000;

async function runBacktest() {
  const appId = process.env.DERIV_APP_ID;
  if (!appId) throw new Error('DERIV_APP_ID не задан в .env');

  // ticks_history — публичный эндпоинт, токен авторизации не нужен
  const client = new DerivClient({ appId, token: null });
  await client.connect();

  const symbol = await resolveSymbol(client);
  const count = Number(process.env.BACKTEST_TICKS) || 5000;
  const history = await client.getTicksHistory(symbol, { count });
  client.close();

  const strategy = new StrategyEngine({
    cooldownTicks: Number(process.env.COOLDOWN_TICKS_AFTER_CRASH) || undefined,
  });
  const riskManager = new RiskManager({
    riskPerTradePct: Number(process.env.RISK_PER_TRADE_PCT) || undefined,
    maxDailyLossPct: Number(process.env.MAX_DAILY_LOSS_PCT) || undefined,
  });

  let balance = START_BALANCE;
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

  const { prices, times } = history;

  for (let i = 0; i < prices.length; i += 1) {
    const tick = { epoch: times[i], quote: prices[i] };
    strategy.ingestTick(tick);

    if (position) {
      const priceChangePct = (tick.quote - position.entryPrice) / position.entryPrice;
      const unrealizedPnl = position.stake * position.multiplier * priceChangePct;
      if (unrealizedPnl <= -position.stopLossUsd) {
        closePosition(-position.stopLossUsd, 'stop-loss');
        continue;
      }
    }

    const signal = strategy.evaluate({ inPosition: !!position });

    if (signal.action === 'close' && position) {
      const priceChangePct = (tick.quote - position.entryPrice) / position.entryPrice;
      const pnl = position.stake * position.multiplier * priceChangePct;
      closePosition(pnl, signal.reason);
    } else if (signal.action === 'open' && !position) {
      const { allowed } = riskManager.canOpenPosition(0);
      if (allowed) {
        const sizing = riskManager.sizeTrade({ balance, stopDistancePct: signal.stopDistancePct });
        position = {
          entryPrice: tick.quote,
          stake: sizing.stake,
          multiplier: sizing.multiplier,
          stopLossUsd: sizing.stopLossUsd,
        };
      }
    }
  }

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.length - wins;
  const winRate = trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0';

  console.log('=== Бэктест: Crash 900 Index ===');
  console.log(`Символ: ${symbol}`);
  console.log(`Тиков обработано: ${prices.length}`);
  console.log(`Сделок: ${trades.length} (побед: ${wins}, поражений: ${losses}, win rate: ${winRate}%)`);
  console.log(
    `P&L: ${(balance - START_BALANCE).toFixed(2)} (старт ${START_BALANCE.toFixed(2)} -> финиш ${balance.toFixed(2)})`
  );
  console.log(`Максимальная просадка: ${maxDrawdownPct.toFixed(2)}%`);
  if (riskManager.isHalted()) {
    console.log(`Внимание: сработал дневной лимит убытка (${riskManager.haltReason})`);
  }
}

if (require.main === module) {
  runBacktest().catch((err) => {
    console.error('Ошибка бэктеста:', err.message);
    process.exit(1);
  });
}

module.exports = { runBacktest };
