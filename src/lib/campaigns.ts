import type { Product } from '@/lib/supabase';
import { getEffectivePrice } from '@/lib/utils';

export type CampaignType = 'percent' | 'fixed' | 'buy_x_get_y';
export type Campaign = {
  id: string; name: string; type: CampaignType; productIds: string[];
  value: number; buyQty?: number; getQty?: number; startsAt: string; endsAt: string;
  active: boolean; priority: number;
};

const KEY = 'propos-campaigns-v1';
export function loadCampaigns(): Campaign[] { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
export function saveCampaigns(items: Campaign[]) { localStorage.setItem(KEY, JSON.stringify(items)); window.dispatchEvent(new Event('propos-campaigns-updated')); }
export function isCampaignActive(c: Campaign, now = Date.now()) {
  return c.active && (!c.startsAt || new Date(c.startsAt).getTime() <= now) && (!c.endsAt || new Date(c.endsAt).getTime() >= now);
}
export function campaignUnitPrice(product: Product, quantity: number, campaigns = loadCampaigns()): { price:number; campaign?:Campaign; discount:number } {
  const base = getEffectivePrice(product);
  const candidates = campaigns.filter(c => c.productIds.includes(product.id) && isCampaignActive(c)).sort((a,b)=>a.priority-b.priority);
  let best = base, chosen: Campaign | undefined;
  for (const c of candidates) {
    let p = base;
    if (c.type === 'percent') p = base * (1 - Math.max(0, Math.min(100, c.value))/100);
    if (c.type === 'fixed') p = Math.max(0, c.value);
    if (c.type === 'buy_x_get_y') {
      const buy = Math.max(1, Math.floor(c.buyQty || 1)); const free = Math.max(0, Math.floor(c.getQty || 0));
      const sets = Math.floor(quantity / (buy + free)); const paid = quantity - sets * free;
      p = quantity > 0 ? (paid * base) / quantity : base;
    }
    if (p < best - 0.0001) { best = +p.toFixed(2); chosen = c; }
  }
  return { price: best, campaign: chosen, discount: +(base-best).toFixed(2) };
}
