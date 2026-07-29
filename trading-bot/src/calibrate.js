require('dotenv').config();

const { DerivClient } = require('./derivClient');
const { resolveSymbol } = require('./symbols');
const { simulate } = require('./simulate');
const { getSymbolDisplayName, strategyOptsFromEnv, riskOptsFromEnv } = require('./config');

const START_BALANCE = 1000;
const MIN_TRADES = 10; // отсекаем комбинации, где статистика слишком мала, чтобы что-то значить

const STOCH_PERIOD_GRID = [5, 9, 14, 21, 34];
const STOCH_SMOOTH_K_GRID = [1, 3, 5];
const STOCH_SMOOTH_D_GRID = [3, 5, 7];
const STOCH_OVERBOUGHT_GRID = [70, 80, 90];

// Перебирает параметры стохастика на исторических тиках выбранного индекса
// и печатает лучшие комбинации по P&L. Частота крахов и характер "шума"
// разные у Crash 900 и Crash 1000, поэтому калибровать нужно отдельно под
// каждый инструмент (SYMBOL_DISPLAY_NAME в .env), а не переиспользовать одни
// и те же числа.
async function runCalibration() {
  const appId = process.env.DERIV_APP_ID;
  if (!appId) throw new Error('DERIV_APP_ID не задан в .env');

  const client = new DerivClient({ appId, token: null });
  await client.connect();

  const displayName = getSymbolDisplayName();
  const symbol = await resolveSymbol(client, displayName);
  const count = Number(process.env.BACKTEST_TICKS) || 5000;
  const history = await client.getTicksHistory(symbol, { count });
  client.close();

  const baseStrategyOpts = strategyOptsFromEnv();
  const riskOpts = riskOptsFromEnv();
  const results = [];

  for (const stochPeriod of STOCH_PERIOD_GRID) {
    for (const stochSmoothK of STOCH_SMOOTH_K_GRID) {
      for (const stochSmoothD of STOCH_SMOOTH_D_GRID) {
        for (const stochOverbought of STOCH_OVERBOUGHT_GRID) {
          const result = simulate({
            prices: history.prices,
            times: history.times,
            startBalance: START_BALANCE,
            strategyOpts: {
              ...baseStrategyOpts,
              stochPeriod,
              stochSmoothK,
              stochSmoothD,
              stochOverbought,
            },
            riskOpts,
          });

          if (result.trades.length < MIN_TRADES) continue;
          results.push({ stochPeriod, stochSmoothK, stochSmoothD, stochOverbought, ...result });
        }
      }
    }
  }

  results.sort((a, b) => b.pnl - a.pnl);

  console.log(`=== Калибровка стохастика: ${displayName} (${symbol}) ===`);
  console.log(`Тиков истории: ${history.prices.length}, комбинаций с достаточной статистикой: ${results.length}`);
  console.log('');

  const top = results.slice(0, 10);
  if (!top.length) {
    console.log(
      `Ни одна комбинация не набрала минимум ${MIN_TRADES} сделок — увеличьте BACKTEST_TICKS и повторите.`
    );
    return;
  }

  for (const r of top) {
    console.log(
      `period=${r.stochPeriod} smoothK=${r.stochSmoothK} smoothD=${r.stochSmoothD} overbought=${r.stochOverbought}` +
        ` | P&L=${r.pnl.toFixed(2)} сделок=${r.trades.length} winRate=${r.winRatePct.toFixed(1)}%` +
        ` maxDD=${r.maxDrawdownPct.toFixed(2)}%`
    );
  }

  console.log('');
  console.log(
    'Впишите выбранную комбинацию в .env (STOCH_PERIOD, STOCH_SMOOTH_K, STOCH_SMOOTH_D, ' +
      'STOCH_OVERBOUGHT) и перепроверьте npm run backtest.'
  );
}

if (require.main === module) {
  runCalibration().catch((err) => {
    console.error('Ошибка калибровки:', err.message);
    process.exit(1);
  });
}

module.exports = { runCalibration };
