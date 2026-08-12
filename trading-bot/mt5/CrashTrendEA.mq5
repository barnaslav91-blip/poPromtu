//+------------------------------------------------------------------+
//| CrashTrendEA.mq5                                                  |
//| Портирован из trading-bot/src (Node.js/Deriv API) на MQL5 для MT5.|
//| Та же логика: EMA-тренд + доля растущих/падающих тиков определяют|
//| направление, стохастик подтверждает вход, ATR задаёт стоп и      |
//| трейлинг (chandelier exit), риск на сделку — фиксированный %     |
//| баланса, без мартингейла, с дневным лимитом убытка.              |
//|                                                                    |
//| EA торгует символом графика, к которому прикреплён — прикрепляйте|
//| его на график нужного инструмента (Crash 900 Index, Crash 1000   |
//| Index и т.д.), символ отдельно указывать не нужно.                |
//+------------------------------------------------------------------+
#property copyright "poPromtu"
#property version   "1.00"
#property strict

#include <Trade\Trade.mqh>

input group "Риск"
input double RiskPerTradePct           = 1.0;  // % баланса, которым рискуем в одной сделке
input double MaxDailyLossPct           = 5.0;  // дневной стоп-лимит, % от баланса на начало дня

input group "Тренд (EMA) и волатильность (ATR)"
input int    EmaFastPeriod             = 9;
input int    EmaSlowPeriod             = 21;
input int    AtrPeriod                 = 14;
input double StopAtrMultiple           = 1.5;  // жёсткий стоп = ATR * это значение
input double MinStopPct                = 0.3;  // нижняя граница стоп-дистанции, % от цены
input double TrailAtrMultiple          = 2.5;  // трейлинг, ДОЛЖЕН быть > StopAtrMultiple

input group "Крах-события"
input double CrashReturnThresholdPct   = -1.0; // разовый тик с таким падением = крах-событие
input int    CooldownTicksAfterCrash   = 20;   // сколько тиков не входим после краха

input group "Стохастик (подтверждение входа)"
input int    StochPeriod               = 14;
input int    StochSmoothK              = 3;
input int    StochSmoothD              = 3;
input double StochOverbought           = 80;
input double StochOversold             = 20;

input group "Направление (доля растущих/падающих тиков)"
input int    TickDirectionWindow         = 200;
input double TickDirectionUpThreshold    = 0.55;
input double TickDirectionDownThreshold  = 0.45;

input group "Прочее"
input ENUM_TIMEFRAMES CandleTimeframe  = PERIOD_M1;
input ulong  MagicNumber               = 900900;

CTrade trade;

int emaFastHandle = INVALID_HANDLE;
int emaSlowHandle = INVALID_HANDLE;
int atrHandle     = INVALID_HANDLE;
int stochHandle   = INVALID_HANDLE;

double   emaFast = 0, emaSlow = 0, atrValue = 0, stochK = 0, stochD = 0;
bool     indicatorsReady = false;
datetime lastBarTime = 0;

double lastTickPrice   = 0;
long   tickCounter      = 0;
long   cooldownUntilTick = 0;

int  tickDirBuffer[];
int  tickDirIndex  = 0;
int  tickDirFilled = 0;
long tickDirSum    = 0;

datetime currentDay      = 0;
double   dayStartBalance = 0;
bool     halted          = false;

// Состояние открытой позиции (одна одновременно — как и в Node-версии)
bool   posOpen         = false;
bool   posIsUp          = false;
double posExtremePrice = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   emaFastHandle = iMA(_Symbol, CandleTimeframe, EmaFastPeriod, 0, MODE_EMA, PRICE_CLOSE);
   emaSlowHandle = iMA(_Symbol, CandleTimeframe, EmaSlowPeriod, 0, MODE_EMA, PRICE_CLOSE);
   atrHandle     = iATR(_Symbol, CandleTimeframe, AtrPeriod);
   stochHandle   = iStochastic(_Symbol, CandleTimeframe, StochPeriod, StochSmoothD, StochSmoothK, MODE_SMA, STO_LOWHIGH);

   if(emaFastHandle == INVALID_HANDLE || emaSlowHandle == INVALID_HANDLE ||
      atrHandle == INVALID_HANDLE || stochHandle == INVALID_HANDLE)
   {
      Print("CrashTrendEA: не удалось создать индикаторы");
      return INIT_FAILED;
   }

   ArrayResize(tickDirBuffer, TickDirectionWindow);
   ArrayInitialize(tickDirBuffer, 0);

   trade.SetExpertMagicNumber((long)MagicNumber);

   dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   currentDay = TodayMidnight();

   RecoverOpenPosition();

   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   if(emaFastHandle != INVALID_HANDLE) IndicatorRelease(emaFastHandle);
   if(emaSlowHandle != INVALID_HANDLE) IndicatorRelease(emaSlowHandle);
   if(atrHandle != INVALID_HANDLE)     IndicatorRelease(atrHandle);
   if(stochHandle != INVALID_HANDLE)   IndicatorRelease(stochHandle);
}

//+------------------------------------------------------------------+
datetime TodayMidnight()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0; dt.min = 0; dt.sec = 0;
   return StructToTime(dt);
}

// Если EA перезапустили при уже открытой позиции — подхватываем её,
// чтобы трейлинг и exit-по-тренду продолжили работать корректно.
void RecoverOpenPosition()
{
   if(PositionSelect(_Symbol) && PositionGetInteger(POSITION_MAGIC) == (long)MagicNumber)
   {
      posOpen = true;
      posIsUp = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      posExtremePrice = PositionGetDouble(POSITION_PRICE_CURRENT);
   }
}

bool IsNewBar()
{
   datetime t[];
   if(CopyTime(_Symbol, CandleTimeframe, 0, 1, t) <= 0) return false;
   if(t[0] != lastBarTime)
   {
      lastBarTime = t[0];
      return true;
   }
   return false;
}

// Читаем значения на последней ЗАКРЫТОЙ свече (shift=1) — как и в
// Node-версии, индикаторы обновляются на закрытии свечи, не внутри неё.
void UpdateIndicators()
{
   double buf[];

   if(CopyBuffer(emaFastHandle, 0, 1, 1, buf) <= 0) { indicatorsReady = false; return; }
   emaFast = buf[0];

   if(CopyBuffer(emaSlowHandle, 0, 1, 1, buf) <= 0) { indicatorsReady = false; return; }
   emaSlow = buf[0];

   if(CopyBuffer(atrHandle, 0, 1, 1, buf) <= 0) { indicatorsReady = false; return; }
   atrValue = buf[0];

   if(CopyBuffer(stochHandle, 0, 1, 1, buf) <= 0) { indicatorsReady = false; return; }
   stochK = buf[0];

   if(CopyBuffer(stochHandle, 1, 1, 1, buf) <= 0) { indicatorsReady = false; return; }
   stochD = buf[0];

   indicatorsReady = true;
}

void PushTickDirection(int direction)
{
   if(tickDirFilled == TickDirectionWindow)
      tickDirSum -= tickDirBuffer[tickDirIndex];
   else
      tickDirFilled++;

   tickDirBuffer[tickDirIndex] = direction;
   tickDirSum += direction;
   tickDirIndex = (tickDirIndex + 1) % TickDirectionWindow;
}

bool   DirectionReady() { return tickDirFilled >= TickDirectionWindow; }
double RisingRatio()    { return (double)tickDirSum / TickDirectionWindow; }

//+------------------------------------------------------------------+
void OnTick()
{
   tickCounter++;
   double price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(price <= 0) return;

   if(lastTickPrice > 0)
   {
      double tickReturn = (price - lastTickPrice) / lastTickPrice;
      if(tickReturn <= CrashReturnThresholdPct / 100.0)
         cooldownUntilTick = tickCounter + CooldownTicksAfterCrash;

      PushTickDirection(tickReturn > 0 ? 1 : 0);
   }
   lastTickPrice = price;

   datetime today = TodayMidnight();
   if(today != currentDay)
   {
      currentDay = today;
      dayStartBalance = AccountInfoDouble(ACCOUNT_BALANCE);
      halted = false;
      Print("CrashTrendEA: новый торговый день, старт баланс ", dayStartBalance);
   }

   if(!halted && dayStartBalance > 0)
   {
      double lossPct = (dayStartBalance - AccountInfoDouble(ACCOUNT_BALANCE)) / dayStartBalance * 100.0;
      if(lossPct >= MaxDailyLossPct)
      {
         halted = true;
         Print("CrashTrendEA: дневной лимит убытка достигнут, новые сделки остановлены до следующего дня");
      }
   }

   if(IsNewBar()) UpdateIndicators();
   if(!indicatorsReady) return;

   ManageOpenPosition(price);

   if(!posOpen && !halted)
      TryOpen(price);
}

// Трейлинг реализован через подтяжку SL самой позиции (PositionModify) —
// это надёжнее, чем закрывать позицию вручную по тику: брокер исполнит
// стоп сам, даже если EA/терминал на мгновение отвалится.
void ManageOpenPosition(double price)
{
   if(!PositionSelect(_Symbol) || PositionGetInteger(POSITION_MAGIC) != (long)MagicNumber)
   {
      posOpen = false;
      return;
   }
   posOpen = true;

   bool uptrend      = emaFast > emaSlow;
   bool downtrend    = emaFast < emaSlow;
   bool trendFlipped = (posIsUp && !uptrend) || (!posIsUp && !downtrend);

   if(trendFlipped)
   {
      trade.PositionClose(_Symbol);
      posOpen = false;
      return;
   }

   posExtremePrice = posIsUp ? MathMax(posExtremePrice, price) : MathMin(posExtremePrice, price);

   double trailDistance = atrValue * TrailAtrMultiple;
   double candidateSl = posIsUp ? posExtremePrice - trailDistance : posExtremePrice + trailDistance;

   double currentSl = PositionGetDouble(POSITION_SL);
   double tp        = PositionGetDouble(POSITION_TP);

   bool improves = posIsUp
      ? (currentSl == 0 || candidateSl > currentSl)
      : (currentSl == 0 || candidateSl < currentSl);

   if(improves)
      trade.PositionModify(_Symbol, NormalizeDouble(candidateSl, _Digits), tp);
}

void TryOpen(double price)
{
   if(cooldownUntilTick > tickCounter) return;
   if(!DirectionReady()) return;

   bool uptrend   = emaFast > emaSlow;
   bool downtrend = emaFast < emaSlow;
   double risingRatio = RisingRatio();

   bool wantUp   = uptrend   && risingRatio >= TickDirectionUpThreshold;
   bool wantDown = downtrend && risingRatio <= TickDirectionDownThreshold;

   int direction = 0; // 1 = long, -1 = short, 0 = нет сигнала
   if(wantUp)
   {
      if(stochK <= stochD) return;          // stoch-not-confirmed
      if(stochK >= StochOverbought) return; // stoch-overbought
      direction = 1;
   }
   else if(wantDown)
   {
      if(stochK >= stochD) return;          // stoch-not-confirmed
      if(stochK <= StochOversold) return;   // stoch-oversold
      direction = -1;
   }
   else return;

   double stopDistance = MathMax(atrValue * StopAtrMultiple, price * MinStopPct / 100.0);
   double slPrice = (direction == 1) ? price - stopDistance : price + stopDistance;

   double lots = CalcLotSize(stopDistance);
   if(lots <= 0)
   {
      Print("CrashTrendEA: расчётный лот <= 0, пропуск сигнала");
      return;
   }

   bool ok;
   if(direction == 1)
      ok = trade.Buy(lots, _Symbol, 0, NormalizeDouble(slPrice, _Digits), 0, "crash-trend-ea");
   else
      ok = trade.Sell(lots, _Symbol, 0, NormalizeDouble(slPrice, _Digits), 0, "crash-trend-ea");

   if(ok)
   {
      posOpen = true;
      posIsUp = (direction == 1);
      posExtremePrice = price;
   }
   else
   {
      Print("CrashTrendEA: не удалось открыть позицию, retcode=", trade.ResultRetcode(),
            " (", trade.ResultRetcodeDescription(), ")");
   }
}

// Фиксированный % риска от баланса — без мартингейла, размер не растёт
// после проигрышей.
double CalcLotSize(double stopDistance)
{
   double riskAmount = AccountInfoDouble(ACCOUNT_BALANCE) * RiskPerTradePct / 100.0;

   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize  = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0 || tickValue <= 0) return 0;

   double lossPerLot = (stopDistance / tickSize) * tickValue;
   if(lossPerLot <= 0) return 0;

   double lots = riskAmount / lossPerLot;

   double volMin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double volMax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double volStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(volStep <= 0) volStep = volMin > 0 ? volMin : 0.01;

   lots = MathFloor(lots / volStep) * volStep;
   lots = MathMax(volMin, MathMin(volMax, lots));

   return lots;
}
