// Геометрия столбчатого графика заявок по дням. Здесь только числа —
// разметку рисует шаблон, чтобы в нём не было расчётов.

const WIDTH = 720;
const HEIGHT = 210;
const PAD = { top: 10, right: 8, bottom: 26, left: 34 };
const MAX_BAR = 24;
const BAR_GAP = 4; // воздух между соседними столбцами
const SEGMENT_GAP = 2; // разрыв цветом поверхности внутри столбца
const CORNER = 4;

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** Круглые деления оси: 0, 2, 4… вместо 0, 1.7, 3.4. */
function niceScale(maxValue) {
  const max = Math.max(1, maxValue);
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  const step = steps.find((s) => max / s <= 4) || Math.ceil(max / 4);
  const top = Math.ceil(max / step) * step;

  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { top, ticks };
}

/** Прямоугольник со скруглённым верхом и прямым низом. */
function barPath(x, y, width, height, rounded) {
  const r = rounded ? Math.min(CORNER, width / 2, height) : 0;
  if (!r) return `M${x} ${y}h${width}v${height}h${-width}z`;
  return (
    `M${x} ${y + r}` +
    `a${r} ${r} 0 0 1 ${r} ${-r}` +
    `h${width - r * 2}` +
    `a${r} ${r} 0 0 1 ${r} ${r}` +
    `v${height - r}` +
    `h${-width}z`
  );
}

/** Прямоугольник со скруглённым правым краем и прямым левым. */
function rowPath(x, y, width, height, rounded) {
  const r = rounded ? Math.min(CORNER, height / 2, width) : 0;
  if (!r) return `M${x} ${y}h${width}v${height}h${-width}z`;
  return (
    `M${x} ${y}` +
    `h${width - r}` +
    `a${r} ${r} 0 0 1 ${r} ${r}` +
    `v${height - r * 2}` +
    `a${r} ${r} 0 0 1 ${-r} ${r}` +
    `h${-(width - r)}z`
  );
}

/** Обрезает длинное название, чтобы подпись не наезжала на полосу. */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function plural(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * Раскладывает заявки по дням месяца. Дни без заявок остаются в ряду:
 * выкинуть их значило бы врать про время.
 */
function buildDailyChart(leads, period) {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month) return null;

  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    accepted: 0,
    other: 0,
    total: 0,
  }));

  leads.forEach((lead) => {
    const date = new Date(lead.created_at);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month) return;
    const bucket = days[date.getDate() - 1];
    if (!bucket) return;
    if (lead.effective === 'accepted') bucket.accepted += 1;
    else bucket.other += 1;
    bucket.total += 1;
  });

  const scale = niceScale(Math.max(...days.map((d) => d.total)));
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const baseline = PAD.top + plotHeight;
  const band = plotWidth / daysInMonth;
  const barWidth = Math.min(MAX_BAR, Math.max(3, band - BAR_GAP));

  const toHeight = (value) => (value / scale.top) * plotHeight;

  // Подписи оси X: 31 подпись подряд сливается, поэтому в узкой полосе
  // показываем каждый пятый день.
  const labelEvery = band >= 26 ? 1 : 5;

  const columns = days.map((entry) => {
    const x = PAD.left + band * (entry.day - 1) + (band - barWidth) / 2;
    const acceptedH = toHeight(entry.accepted);
    const otherH = toHeight(entry.other);
    // Разрыв вырезается из верхнего сегмента — так он оказывается между
    // сегментами, а не под столбцом.
    const gap = acceptedH > 0 && otherH > 0 ? SEGMENT_GAP : 0;

    const segments = [];
    if (entry.accepted > 0) {
      segments.push({
        key: 'accepted',
        count: entry.accepted,
        y: baseline - acceptedH,
        height: acceptedH,
        // Скругление — только у верхушки столбца, у основания угол прямой.
        rounded: entry.other === 0,
      });
    }
    if (entry.other > 0) {
      segments.push({
        key: 'other',
        count: entry.other,
        y: baseline - acceptedH - otherH,
        height: Math.max(0.5, otherH - gap),
        rounded: true,
      });
    }

    segments.forEach((seg) => {
      seg.path = barPath(x, seg.y, barWidth, seg.height, seg.rounded);
    });

    return {
      ...entry,
      x,
      width: barWidth,
      segments,
      showLabel: entry.day === 1 || entry.day % labelEvery === 0,
      hint: `${entry.day} ${MONTHS[month - 1]}: ${entry.total} ${plural(
        entry.total,
        'заявка',
        'заявки',
        'заявок'
      )}${entry.total ? `, принято ${entry.accepted}` : ''}`,
    };
  });

  return {
    width: WIDTH,
    height: HEIGHT,
    baseline,
    plotLeft: PAD.left,
    plotRight: WIDTH - PAD.right,
    corner: CORNER,
    columns,
    ticks: scale.ticks.map((value) => ({
      value,
      y: baseline - toHeight(value),
    })),
    hasData: days.some((d) => d.total > 0),
    totals: {
      total: days.reduce((sum, d) => sum + d.total, 0),
      accepted: days.reduce((sum, d) => sum + d.accepted, 0),
    },
  };
}

const SOURCE_LABEL_WIDTH = 176;
const SOURCE_VALUE_WIDTH = 46;
const SOURCE_ROW = 34;
const SOURCE_MAX_ROWS = 15;

/**
 * Заявки по источникам: горизонтальные полосы, потому что названия групп
 * длинные и в подписи под столбцом не помещаются.
 */
function buildSourceChart(leads) {
  const bySource = new Map();

  leads.forEach((lead) => {
    const name = lead.group_name || 'Без источника';
    const stat = bySource.get(name) || { name, total: 0, accepted: 0 };
    stat.total += 1;
    if (lead.effective === 'accepted') stat.accepted += 1;
    bySource.set(name, stat);
  });

  let rows = [...bySource.values()].sort((a, b) => b.total - a.total);
  if (!rows.length) return null;

  // Длинный хвост мелких источников сворачивается, иначе график уезжает вниз.
  if (rows.length > SOURCE_MAX_ROWS) {
    const head = rows.slice(0, SOURCE_MAX_ROWS - 1);
    const tail = rows.slice(SOURCE_MAX_ROWS - 1);
    head.push({
      name: `Прочие источники (${tail.length})`,
      total: tail.reduce((sum, r) => sum + r.total, 0),
      accepted: tail.reduce((sum, r) => sum + r.accepted, 0),
    });
    rows = head;
  }

  const scale = niceScale(Math.max(...rows.map((r) => r.total)));
  const plotLeft = SOURCE_LABEL_WIDTH;
  const plotWidth = WIDTH - SOURCE_LABEL_WIDTH - SOURCE_VALUE_WIDTH;
  const barHeight = Math.min(MAX_BAR, SOURCE_ROW - 12);
  const height = rows.length * SOURCE_ROW + 8;

  const toWidth = (value) => (value / scale.top) * plotWidth;

  const bars = rows.map((row, index) => {
    const y = index * SOURCE_ROW + (SOURCE_ROW - barHeight) / 2 + 4;
    const other = row.total - row.accepted;
    const acceptedW = toWidth(row.accepted);
    const otherW = toWidth(other);
    const gap = acceptedW > 0 && otherW > 0 ? SEGMENT_GAP : 0;

    const segments = [];
    if (row.accepted > 0) {
      segments.push({
        key: 'accepted',
        x: plotLeft,
        width: acceptedW,
        rounded: other === 0,
      });
    }
    if (other > 0) {
      segments.push({
        key: 'other',
        x: plotLeft + acceptedW + gap,
        width: Math.max(0.5, otherW - gap),
        rounded: true,
      });
    }

    segments.forEach((seg) => {
      seg.path = rowPath(seg.x, y, seg.width, barHeight, seg.rounded);
    });

    return {
      ...row,
      label: truncate(row.name, 26),
      labelY: y + barHeight / 2 + 3.5,
      valueX: plotLeft + toWidth(row.total) + 8,
      segments,
      hint: `${row.name}: ${row.total} ${plural(
        row.total,
        'заявка',
        'заявки',
        'заявок'
      )}, принято ${row.accepted}`,
      hit: { y: y - 5, height: barHeight + 10 },
    };
  });

  return {
    width: WIDTH,
    height,
    plotLeft,
    labelX: SOURCE_LABEL_WIDTH - 10,
    bars,
  };
}

module.exports = { buildDailyChart, buildSourceChart };
