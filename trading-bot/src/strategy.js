const DEFAULTS = {
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  atrPeriod: 14,
  candleSeconds: 60,
  crashReturnThreshold: -0.01, // разовый тик с падением >= 1% считаем крах-событием
  cooldownTicks: 20, // сколько тиков не открываем новые позиции после краха
  minStopPct: 0.003, // нижняя граница стоп-дистанции, чтобы не ставить стоп в нулевом ATR
  stopAtrMultiple: 1.5,
  // Трейлинг-стоп (chandelier exit): жёстче stopAtrMultiple быть не должен —
  // держим шире, чтобы не сработать раньше жёсткого стопа на самом входе, и
  // подтягиваем за пиком/дном по ходу движения, фиксируя часть прибыли
  // раньше, чем сработает выход по развороту EMA.
  trailAtrMultiple: 2.5,
  // Стохастик — доп. фильтр входа поверх EMA/ATR, значения по умолчанию под
  // Crash 900 Index; для других индексов (например, Crash 1000) подбираются
  // отдельно через calibrate.js, т.к. частота крахов и "шум" между ними разные.
  stochPeriod: 14,
  stochSmoothK: 3,
  stochSmoothD: 3,
  stochOverbought: 80,
  stochOversold: 20,
  // Доля растущих тиков за окно — направленческий фильтр: разрешает long
  // только когда тиков с ростом заметно больше, чем с падением, и наоборот
  // для short. В "спокойной" зоне между порогами сделок нет вообще.
  tickDirectionWindow: 200,
  tickDirectionUpThreshold: 0.55,
  tickDirectionDownThreshold: 0.45,
};

function nextEma(prevEma, price, period) {
  const k = 2 / (period + 1);
  return prevEma === null ? price : price * k + prevEma * (1 - k);
}

function average(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Стратегия рассчитана на то, что момент краха непредсказуем (это заявленное
// свойство синтетического индекса у Deriv): она не пытается его угадать, а
// (1) торгует по направлению текущего дрейфа цены — вверх (MULTUP) или вниз
// (MULTDOWN), решая по EMA-тренду и доле растущих/падающих тиков за окно,
// (2) подтверждает вход симметричным стохастиком, (3) адаптирует размер
// стопа под текущую волатильность (ATR), (4) уходит в паузу сразу после
// обнаруженного краш-тика, пока цена не стабилизируется. Шорты против
// структурно растущего между крахами индекса рискованнее лонгов — это
// решение пользователя, а не встроенное допущение стратегии.
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

    this.recentCandles = [];
    this.rawKHistory = [];
    this.kHistory = [];
    this.stochK = null;
    this.stochD = null;

    this.tickDirections = [];
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
    this._updateStochastic(candle);
  }

  _updateStochastic(candle) {
    this.recentCandles.push({ high: candle.high, low: candle.low });
    if (this.recentCandles.length > this.opts.stochPeriod) this.recentCandles.shift();
    if (this.recentCandles.length < this.opts.stochPeriod) return;

    const highestHigh = Math.max(...this.recentCandles.map((c) => c.high));
    const lowestLow = Math.min(...this.recentCandles.map((c) => c.low));
    const range = highestHigh - lowestLow;
    const rawK = range === 0 ? 50 : ((candle.close - lowestLow) / range) * 100;

    this.rawKHistory.push(rawK);
    if (this.rawKHistory.length > this.opts.stochSmoothK) this.rawKHistory.shift();
    if (this.rawKHistory.length < this.opts.stochSmoothK) return;

    this.stochK = average(this.rawKHistory);
    this.kHistory.push(this.stochK);
    if (this.kHistory.length > this.opts.stochSmoothD) this.kHistory.shift();
    this.stochD = average(this.kHistory);
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

      this.tickDirections.push(tickReturn > 0 ? 1 : 0);
      if (this.tickDirections.length > this.opts.tickDirectionWindow) this.tickDirections.shift();
    }
    this.lastPrice = price;

    return { crashDetected, price };
  }

  _buildOpenSignal(direction, risingRatio) {
    const volatilityPct = this.atr / this.lastPrice;
    const stopDistancePct = Math.max(
      volatilityPct * this.opts.stopAtrMultiple,
      this.opts.minStopPct
    );

    return {
      action: 'open',
      direction,
      stopDistancePct,
      volatilityPct,
      stochK: this.stochK,
      stochD: this.stochD,
      risingRatio,
    };
  }

  // inPosition: bool — открыта ли сейчас позиция (решает вызывающий код)
  // positionDirection: 'up' | 'down' | null — направление открытой позиции
  // Возвращает { action: 'open'|'close'|'hold', ...details }
  evaluate({ inPosition, positionDirection = null }) {
    if (!this.isReady()) return { action: 'hold', reason: 'warming-up' };

    const inCooldown = this.tickIndex < this.cooldownUntil;
    const emaUptrend = this.emaFast > this.emaSlow;
    const emaDowntrend = this.emaFast < this.emaSlow;

    if (inPosition) {
      const trendFlipped =
        (positionDirection === 'up' && !emaUptrend) || (positionDirection === 'down' && !emaDowntrend);
      if (trendFlipped) return { action: 'close', reason: 'trend-flip' };
      return { action: 'hold', reason: 'trend-intact' };
    }

    if (inCooldown) return { action: 'hold', reason: 'cooldown-after-crash' };

    if (this.tickDirections.length < this.opts.tickDirectionWindow) {
      return { action: 'hold', reason: 'direction-warming-up' };
    }
    if (this.stochK === null || this.stochD === null) {
      return { action: 'hold', reason: 'stoch-warming-up' };
    }

    const risingRatio = average(this.tickDirections);
    const wantUp = emaUptrend && risingRatio >= this.opts.tickDirectionUpThreshold;
    const wantDown = emaDowntrend && risingRatio <= this.opts.tickDirectionDownThreshold;

    if (wantUp) {
      if (this.stochK <= this.stochD) return { action: 'hold', reason: 'stoch-not-confirmed' };
      if (this.stochK >= this.opts.stochOverbought) return { action: 'hold', reason: 'stoch-overbought' };
      return this._buildOpenSignal('up', risingRatio);
    }

    if (wantDown) {
      if (this.stochK >= this.stochD) return { action: 'hold', reason: 'stoch-not-confirmed' };
      if (this.stochK <= this.opts.stochOversold) return { action: 'hold', reason: 'stoch-oversold' };
      return this._buildOpenSignal('down', risingRatio);
    }

    return { action: 'hold', reason: 'no-directional-edge' };
  }
}

module.exports = { StrategyEngine, DEFAULTS };
