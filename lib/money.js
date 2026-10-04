// Сумма прописью для акта: «Одна тысяча двести сорок лей 50 банов».

const ONES_MASC = [
  '', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const ONES_FEM = [
  '', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = [
  '', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят',
  'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто',
];
const HUNDREDS = [
  '', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот',
  'шестьсот', 'семьсот', 'восемьсот', 'девятьсот',
];

// [единственное, 2-4, много] + род: 'm' — мужской, 'f' — женский.
const SCALES = [
  { forms: null, gender: null }, // единицы — род берётся у валюты
  { forms: ['тысяча', 'тысячи', 'тысяч'], gender: 'f' },
  { forms: ['миллион', 'миллиона', 'миллионов'], gender: 'm' },
  { forms: ['миллиард', 'миллиарда', 'миллиардов'], gender: 'm' },
];

const CURRENCIES = {
  MDL: {
    label: 'лей',
    major: { forms: ['лей', 'лея', 'леев'], gender: 'm' },
    minor: { forms: ['бан', 'бана', 'банов'], gender: 'm' },
  },
  EUR: {
    label: 'евро',
    major: { forms: ['евро', 'евро', 'евро'], gender: 'm' },
    minor: { forms: ['цент', 'цента', 'центов'], gender: 'm' },
  },
  USD: {
    label: 'доллар',
    major: { forms: ['доллар', 'доллара', 'долларов'], gender: 'm' },
    minor: { forms: ['цент', 'цента', 'центов'], gender: 'm' },
  },
};

/** Выбирает форму слова: 1 лей, 2 лея, 5 леев. */
function plural(n, forms) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return forms[2];
  switch (n % 10) {
    case 1:
      return forms[0];
    case 2:
    case 3:
    case 4:
      return forms[1];
    default:
      return forms[2];
  }
}

/** Группа из трёх цифр словами. */
function tripletToWords(value, gender) {
  const words = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;

  if (hundreds) words.push(HUNDREDS[hundreds]);

  if (tens === 1) {
    words.push(TEENS[ones]);
  } else {
    if (tens) words.push(TENS[tens]);
    if (ones) words.push(gender === 'f' ? ONES_FEM[ones] : ONES_MASC[ones]);
  }

  return words;
}

function integerToWords(value, gender) {
  if (value === 0) return ['ноль'];

  const triplets = [];
  let rest = value;
  while (rest > 0) {
    triplets.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }

  const words = [];
  for (let scale = triplets.length - 1; scale >= 0; scale -= 1) {
    const triplet = triplets[scale];
    if (!triplet) continue;

    const info = SCALES[scale];
    words.push(...tripletToWords(triplet, info.gender || gender));
    if (info.forms) words.push(plural(triplet, info.forms));
  }

  return words;
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * «1240.5» + MDL → «Одна тысяча двести сорок лей 50 банов».
 * Копейки пишутся цифрами — так принято в бухгалтерских документах.
 */
function amountInWords(amount, currencyCode) {
  const currency = CURRENCIES[currencyCode] || CURRENCIES.MDL;
  const total = Math.round(Math.abs(Number(amount) || 0) * 100);
  const major = Math.floor(total / 100);
  const minor = total % 100;

  const words = integerToWords(major, currency.major.gender);
  words.push(plural(major, currency.major.forms));

  const minorLabel = plural(minor, currency.minor.forms);
  return `${capitalize(words.join(' '))} ${String(minor).padStart(2, '0')} ${minorLabel}`;
}

function currencyLabel(currencyCode) {
  return (CURRENCIES[currencyCode] || CURRENCIES.MDL).label;
}

module.exports = { amountInWords, currencyLabel, plural, CURRENCIES };
