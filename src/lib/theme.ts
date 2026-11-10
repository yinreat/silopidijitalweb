export const THEME_STORAGE_KEY = 'silopidijital-theme-color-v1';
export const DEFAULT_BRAND_COLOR = '#1677FF';

function normalizeHex(value: string): string {
  const raw = String(value || '').trim();
  const match = raw.match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : DEFAULT_BRAND_COLOR;
}

function mix(hex: string, other: string, amount: number): string {
  const a = normalizeHex(hex).slice(1);
  const b = normalizeHex(other).slice(1);
  const values = [0, 2, 4].map((index) => {
    const first = parseInt(a.slice(index, index + 2), 16);
    const second = parseInt(b.slice(index, index + 2), 16);
    return Math.round(first * (1 - amount) + second * amount).toString(16).padStart(2, '0');
  });
  return `#${values.join('')}`;
}

export function getBrandColor(): string {
  try {
    return normalizeHex(localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_BRAND_COLOR);
  } catch {
    return DEFAULT_BRAND_COLOR;
  }
}

export function applyBrandColor(value: string): string {
  const color = normalizeHex(value);
  if (typeof document === 'undefined') return color;
  const root = document.documentElement.style;
  root.setProperty('--color-primary', color);
  root.setProperty('--color-primary-light', mix(color, '#FFFFFF', 0.24));
  root.setProperty('--color-primary-dark', mix(color, '#000000', 0.24));
  root.setProperty('--color-primary-soft', mix(color, '#FFFFFF', 0.93));
  root.setProperty('--color-primary-tint', mix(color, '#FFFFFF', 0.86));
  root.setProperty('--color-primary-border', mix(color, '#FFFFFF', 0.66));
  root.setProperty('--color-primary-muted', mix(color, '#FFFFFF', 0.42));
  root.setProperty('--color-primary-ink', mix(color, '#000000', 0.48));
  const digits = color.slice(1);
  const red = parseInt(digits.slice(0, 2), 16);
  const green = parseInt(digits.slice(2, 4), 16);
  const blue = parseInt(digits.slice(4, 6), 16);
  const perceivedBrightness = (red * 299 + green * 587 + blue * 114) / 1000;
  root.setProperty('--color-on-primary', perceivedBrightness >= 165 ? '#0B1329' : '#FFFFFF');
  return color;
}

export function setBrandColor(value: string): string {
  const color = applyBrandColor(value);
  try { localStorage.setItem(THEME_STORAGE_KEY, color); } catch { /* storage may be disabled */ }
  try { window.dispatchEvent(new CustomEvent('silopidijital-theme-change', { detail: { color } })); } catch { /* ignore */ }
  return color;
}
