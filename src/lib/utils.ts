export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('tr-TR', {
    style: 'currency',
    currency: 'TRY',
  }).format(amount);
}

export function formatDateTime(date: string): string {
  return new Date(date).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(date: string): string {
  return new Date(date).toLocaleString('tr-TR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function generateBarcode(): string {
  // Prefix kullanılmaz; her yeni ürün için standart 13 haneli EAN-13 barkodu üret.
  let body = '';
  for (let i = 0; i < 12; i += 1) body += Math.floor(Math.random() * 10).toString();
  const digits = body.split('').map(Number);
  const checksum = (10 - (digits.reduce((sum, d, i) => sum + d * (i % 2 === 0 ? 1 : 3), 0) % 10)) % 10;
  return body + checksum;
}

export const PAYMENT_METHODS = {
  cash: { label: 'Nakit', color: 'emerald' },
  card: { label: 'Kart', color: 'blue' },
  iban: { label: 'IBAN', color: 'cyan' },
  credit: { label: 'Veresiye', color: 'amber' },
  split: { label: 'Karma', color: 'violet' },
} as const;

export type PaymentMethod = keyof typeof PAYMENT_METHODS | 'split';

export function getEffectivePrice(product: { price:number; discount_enabled?:boolean; discount_price?:number|null; discount_starts_at?:string|null; discount_ends_at?:string|null }): number {
  const now=Date.now();
  const active=Boolean(product.discount_enabled && product.discount_price != null && product.discount_price >= 0 && (!product.discount_starts_at || new Date(product.discount_starts_at).getTime() <= now) && (!product.discount_ends_at || new Date(product.discount_ends_at).getTime() >= now));
  return active ? Number(product.discount_price) : Number(product.price);
}

/** Parse Turkish/European decimal input without dropping the decimal separator.
 * Examples: 50,129097 -> 50.129097; 1.234,56 -> 1234.56; 1,234.56 -> 1234.56.
 */
export function parseLocalizedDecimal(input: string): number | null {
  let value = String(input ?? '').trim().replace(/[\s₺]/g, '');
  if (!value) return null;

  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  let normalized = value;

  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integerPart = value.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fractionPart = value.slice(decimalIndex + 1).replace(/[.,]/g, '');
    normalized = `${integerPart}.${fractionPart}`;
  } else if (comma >= 0) {
    const integerPart = value.slice(0, comma).replace(/,/g, '').replace(/\./g, '');
    const fractionPart = value.slice(comma + 1).replace(/[.,]/g, '');
    normalized = `${integerPart}.${fractionPart}`;
  } else if ((value.match(/\./g) || []).length > 1) {
    const groups = value.split('.');
    const allGrouping = groups.slice(1).every(group => group.length === 3);
    normalized = allGrouping ? groups.join('') : `${groups.slice(0, -1).join('')}.${groups[groups.length - 1]}`;
  }

  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}


/** Normalize Turkish product names for case/diacritic/spacing-insensitive search. */
export function normalizeProductSearch(value: string): string {
  return String(value ?? '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function editDistance(a: string, b: string, cutoff: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cutoff) return cutoff + 1;
  if (a.length > b.length) [a, b] = [b, a];
  let previous = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let row = 1; row <= b.length; row += 1) {
    const current = [row];
    let rowMin = row;
    for (let col = 1; col <= a.length; col += 1) {
      const cost = a[col - 1] === b[row - 1] ? 0 : 1;
      const next = Math.min(current[col - 1] + 1, previous[col] + 1, previous[col - 1] + cost);
      current[col] = next;
      rowMin = Math.min(rowMin, next);
    }
    if (rowMin > cutoff) return cutoff + 1;
    previous = current;
  }
  return previous[a.length];
}

/** Lower scores are better. Supports missing spaces and a small number of typos. */
export function productSearchScore(query: string, candidate: string): number {
  const q = normalizeProductSearch(query);
  const c = normalizeProductSearch(candidate);
  if (!q) return 0;
  if (!c) return Number.POSITIVE_INFINITY;
  if (c === q) return 0;
  if (c.includes(q)) return 1;
  if (q.includes(c)) return 2;

  // Compare individual words as well as the joined phrase. This catches cases
  // even when words contain spacing differences or small typing mistakes.
  const queryWords = query.split(/[\s\p{P}]+/u).map(normalizeProductSearch).filter(Boolean);
  const candidateWords = candidate.split(/[\s\p{P}]+/u).map(normalizeProductSearch).filter(Boolean);
  if (queryWords.length > 1 && candidateWords.length > 0) {
    let wordScore = 0;
    let allWordsMatched = true;
    for (const word of queryWords) {
      if (candidateWords.some(candidateWord => candidateWord === word)) continue;
      if (candidateWords.some(candidateWord => candidateWord.includes(word))) {
        wordScore += 0.2;
        continue;
      }
      const cutoff = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
      const distance = Math.min(...candidateWords.map(candidateWord => editDistance(word, candidateWord, cutoff)));
      if (distance <= cutoff) wordScore += 0.5 + distance * 0.5;
      else { allWordsMatched = false; break; }
    }
    if (allWordsMatched) return 1 + wordScore;
  }

  const cutoff = q.length <= 5 ? 1 : q.length <= 10 ? 2 : 3;
  return editDistance(q, c, cutoff);
}
