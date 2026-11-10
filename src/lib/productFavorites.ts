import { useCallback, useEffect, useState } from 'react';

const EVENT_NAME = 'silopidijital-product-favorites-updated';

function businessScope(): string {
  try {
    const direct = localStorage.getItem('propos-business-id');
    if (direct) return direct;
    const raw = localStorage.getItem('propos-desktop-license-v1');
    const state = raw ? JSON.parse(raw) as { businessId?: string } : null;
    return state?.businessId || 'web';
  } catch {
    return 'web';
  }
}

function storageKey() {
  return `silopidijital-product-favorites-v1:${businessScope()}`;
}

function readFavorites(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function useProductFavorites() {
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => readFavorites());
  const refresh = useCallback(() => setFavoriteIds(readFavorites()), []);

  useEffect(() => {
    window.addEventListener(EVENT_NAME, refresh);
    window.addEventListener('storage', refresh);
    window.addEventListener('silopidijital-business-changed', refresh);
    return () => {
      window.removeEventListener(EVENT_NAME, refresh);
      window.removeEventListener('storage', refresh);
      window.removeEventListener('silopidijital-business-changed', refresh);
    };
  }, [refresh]);

  const isFavorite = useCallback((productId: string) => favoriteIds.includes(productId), [favoriteIds]);
  const toggleFavorite = useCallback((productId: string) => {
    const current = readFavorites();
    const next = current.includes(productId) ? current.filter(id => id !== productId) : [...current, productId];
    try { localStorage.setItem(storageKey(), JSON.stringify(next)); } catch { /* Favorites are a convenience; never block sales. */ }
    setFavoriteIds(next);
    window.dispatchEvent(new Event(EVENT_NAME));
  }, []);

  return { favoriteIds, isFavorite, toggleFavorite };
}
