require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { DerivClient } = require('./derivClient');
const { resolveSymbol } = require('./symbols');
const { StrategyEngine } = require('./strategy');
const { RiskManager } = require('./riskManager');
const { getSymbolDisplayName, strategyOptsFromEnv, riskOptsFromEnv } = require('./config');

const TRADES_LOG_PATH = path.join(__dirname, '..', 'trades.log');

function logTrade(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line);
  fs.appendFileSync(TRADES_LOG_PATH, `${line}\n`);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function main() {
  const appId = process.env.DERIV_APP_ID;
  const token = process.env.DERIV_API_TOKEN;
  if (!appId) throw new Error('DERIV_APP_ID не задан в .env');
  if (!token) throw new Error('DERIV_API_TOKEN не задан в .env (используйте демо-токен)');

  const client = new DerivClient({ appId, token });
  await client.connect();

  const accountBalance = await client.getBalance();
  console.log(
    `Подключено к Deriv (${accountBalance.currency}), баланс: ${accountBalance.balance}, loginid: ${accountBalance.loginid}`
  );

  const displayName = getSymbolDisplayName();
  const symbol = await resolveSymbol(client, displayName);
  console.log(`Торгуем инструментом: ${displayName} (${symbol})`);

  const strategy = new StrategyEngine(strategyOptsFromEnv());
  const riskManager = new RiskManager(riskOptsFromEnv());

  let balance = accountBalance.balance;
  let currentDay = todayKey();
  riskManager.startDay(balance);

  let openContractId = null;
  let opening = false;

  client.on('error', (err) => {
    console.error('Ошибка соединения:', err.message);
  });

  client.on('disconnected', () => {
    console.warn('Соединение с Deriv потеряно, будет переподключение...');
  });

  client.on('contract-update', (contract) => {
    if (Number(contract.contract_id) !== Number(openContractId)) return;
    if (!contract.is_sold) return;

    const pnl = Number(contract.profit);
    balance += pnl;
    riskManager.recordClosedTrade(pnl);
    logTrade({
      event: 'closed',
      contract_id: contract.contract_id,
      pnl,
      balance,
    });
    openContractId = null;
  });

  client.on('tick', async (tick) => {
    const day = todayKey();
    if (day !== currentDay) {
      currentDay = day;
      riskManager.startDay(balance);
      console.log(`Новый торговый день, стартовый баланс: ${balance.toFixed(2)}`);
    }

    strategy.ingestTick({ epoch: tick.epoch, quote: tick.quote });

    if (openContractId) {
      const closeSignal = strategy.evaluate({ inPosition: true });
      if (closeSignal.action === 'close') {
        client
          .sellContract(openContractId)
          .catch((err) => console.error('Не удалось закрыть позицию:', err.message));
      }
      return;
    }

    if (opening) return;

    const signal = strategy.evaluate({ inPosition: false });
    if (signal.action !== 'open') return;

    const { allowed, reason } = riskManager.canOpenPosition(0);
    if (!allowed) {
      if (reason !== 'max-concurrent-positions') console.log(`Пропуск сигнала: ${reason}`);
      return;
    }

    const sizing = riskManager.sizeTrade({ balance, stopDistancePct: signal.stopDistancePct });

    opening = true;
    try {
      const bought = await client.buyMultiplier({
        symbol,
        direction: signal.direction,
        stake: sizing.stake,
        multiplier: sizing.multiplier,
        stopLossUsd: sizing.stopLossUsd,
      });
      openContractId = bought.contract_id;
      await client.subscribeContract(openContractId);
      logTrade({
        event: 'opened',
        contract_id: openContractId,
        direction: signal.direction,
        stake: sizing.stake,
        multiplier: sizing.multiplier,
        stopLossUsd: sizing.stopLossUsd,
        volatilityPct: signal.volatilityPct,
      });
    } catch (err) {
      console.error('Не удалось открыть позицию:', err.message);
    } finally {
      opening = false;
    }
  });

  await client.subscribeTicks(symbol);
  console.log('Бот запущен, ожидаем тики...');

  process.on('SIGINT', () => {
    console.log('\nОстановка бота...');
    client.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Фатальная ошибка:', err.message);
  process.exit(1);
});
