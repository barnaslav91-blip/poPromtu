require('dotenv').config();

const { DerivClient } = require('./derivClient');
const { resolveSymbol } = require('./symbols');
const { simulate } = require('./simulate');
const { getSymbolDisplayName, strategyOptsFromEnv, riskOptsFromEnv } = require('./config');

const START_BALANCE = 1000;

async function runBacktest() {
  const appId = process.env.DERIV_APP_ID;
  if (!appId) throw new Error('DERIV_APP_ID не задан в .env');

  // ticks_history — публичный эндпоинт, токен авторизации не нужен
  const client = new DerivClient({ appId, token: null });
  await client.connect();

  const displayName = getSymbolDisplayName();
  const symbol = await resolveSymbol(client, displayName);
  const count = Number(process.env.BACKTEST_TICKS) || 5000;
  const history = await client.getTicksHistory(symbol, { count });
  client.close();

  const result = simulate({
    prices: history.prices,
    times: history.times,
    startBalance: START_BALANCE,
    strategyOpts: strategyOptsFromEnv(),
    riskOpts: riskOptsFromEnv(),
  });

  console.log(`=== Бэктест: ${displayName} ===`);
  console.log(`Символ: ${symbol}`);
  console.log(`Тиков обработано: ${history.prices.length}`);
  console.log(
    `Сделок: ${result.trades.length} (побед: ${result.wins}, поражений: ${result.losses}, win rate: ${result.winRatePct.toFixed(1)}%)`
  );
  console.log(
    `P&L: ${result.pnl.toFixed(2)} (старт ${START_BALANCE.toFixed(2)} -> финиш ${result.finalBalance.toFixed(2)})`
  );
  console.log(`Максимальная просадка: ${result.maxDrawdownPct.toFixed(2)}%`);
  if (result.haltedReason) {
    console.log(`Внимание: сработал дневной лимит убытка (${result.haltedReason})`);
  }
}

if (require.main === module) {
  runBacktest().catch((err) => {
    console.error('Ошибка бэктеста:', err.message);
    process.exit(1);
  });
}

module.exports = { runBacktest };
