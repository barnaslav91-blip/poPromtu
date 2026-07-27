const DEFAULTS = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  atrPeriod: 14,
  candleSeconds: 60,
  crashReturnThreshold: -0.01, // разовый тик с падением >= 1% считаем крах-событием
  cooldownTicks: 20, // сколько тиков не открываем новые позиции после краха
  minStopPct: 0.003, // нижняя граница стоп-дистанции, чтобы не ставить стоп в нулевом ATR
  stopAtrMultiple: 1.5,
};

function nextEma(prevEma, price, period) {
  const k = 2 / (period + 1);
  return prevEma === null ? price : price * k + prevEma * (1 - k);
}

// Стратегия рассчитана на то, что момент краха непредсказуем (это заявленное
// свойство синтетического индекса у Deriv): она не пытается его угадать, а
// (1) торгует только по восходящему дрейфу между крахами, (2) адаптирует
// размер стопа под текущую волатильность (ATR), (3) уходит в паузу сразу
// после обнаруженного краш-тика, пока цена не стабилизируется.
class StrategyEngine {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.tickIndex = 0;
    this.lastPrice = null;
    this.cooldownUntil = 0;

    this.currentCandle = null;
    this.prevCandleClose = null;
    this.trueRanges = [];
    this.emaFast = null;
    this.emaSlow = null;
    this.atr = null;
  }

  isReady() {
    return this.emaFast !== null && this.emaSlow !== null && this.atr !== null;
  }

  _closeCandle(candle) {
    this.emaFast = nextEma(this.emaFast, candle.close, this.opts.emaFastPeriod);
    this.emaSlow = nextEma(this.emaSlow, candle.close, this.opts.emaSlowPeriod);

    const prevClose = this.prevCandleClose ?? candle.open;
    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - prevClose),
      Math.abs(candle.low - prevClose)
    );
    this.trueRanges.push(trueRange);
    if (this.trueRanges.length > this.opts.atrPeriod) this.trueRanges.shift();
    this.atr =
      this.trueRanges.reduce((sum, tr) => sum + tr, 0) / this.trueRanges.length;

    this.prevCandleClose = candle.close;
  }

  // tick: { epoch: number (unix seconds), quote: number }
  // Возвращает { crashDetected: boolean } — сигналы читаются через evaluate().
  ingestTick(tick) {
    this.tickIndex += 1;
    const price = tick.quote;
    const bucket = Math.floor(tick.epoch / this.opts.candleSeconds);

    if (!this.currentCandle || this.currentCandle.bucket !== bucket) {
      if (this.currentCandle) this._closeCandle(this.currentCandle);
      this.currentCandle = { bucket, open: price, high: price, low: price, close: price };
    } else {
      this.currentCandle.high = Math.max(this.currentCandle.high, price);
      this.currentCandle.low = Math.min(this.currentCandle.low, price);
      this.currentCandle.close = price;
    }

    let crashDetected = false;
    if (this.lastPrice !== null) {
      const tickReturn = (price - this.lastPrice) / this.lastPrice;
      if (tickReturn <= this.opts.crashReturnThreshold) {
        crashDetected = true;
        this.cooldownUntil = this.tickIndex + this.opts.cooldownTicks;
      }
    }
    this.lastPrice = price;

    return { crashDetected, price };
  }

  // inPosition: bool — открыта ли сейчас позиция (решает вызывающий код)
  // Возвращает { action: 'open'|'close'|'hold', ...details }
  evaluate({ inPosition }) {
    if (!this.isReady()) return { action: 'hold', reason: 'warming-up' };

    const inCooldown = this.tickIndex < this.cooldownUntil;
    const uptrend = this.emaFast > this.emaSlow;

    if (inPosition) {
      if (!uptrend) return { action: 'close', reason: 'trend-flip' };
      return { action: 'hold', reason: 'trend-intact' };
    }

    if (inCooldown) return { action: 'hold', reason: 'cooldown-after-crash' };
    if (!uptrend) return { action: 'hold', reason: 'no-uptrend' };

    const volatilityPct = this.atr / this.lastPrice;
    const stopDistancePct = Math.max(
      volatilityPct * this.opts.stopAtrMultiple,
      this.opts.minStopPct
    );

    return {
      action: 'open',
      direction: 'up',
      stopDistancePct,
      volatilityPct,
    };
  }
}

module.exports = { StrategyEngine, DEFAULTS };
