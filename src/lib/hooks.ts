import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { Category, Product, Sale, SaleItem, SaleWithItems, Customer, CustomerPayment, CashSession, CashReconciliation, SalePayment, StockMovement, Staff, StaffEarning, StaffConsumption, StaffPayout, Supplier, SupplierAccount, SupplierPayment, PurchaseReceipt, PurchaseReceiptItem } from '@/lib/supabase';
import { IS_OWNER_EDITION } from '@/lib/edition';
import { getEffectivePrice } from '@/lib/utils';
import { campaignUnitPrice } from '@/lib/campaigns';

/**
 * Wait for a Supabase/PostgREST thenable while respecting the caller's timeout.
 * This deliberately avoids the PostgREST builder abortSignal method, which is not exposed
 * by every compatible @supabase/postgrest-js type/version. The underlying request
 * may still finish on the server; owner sales therefore keep their clientRef for
 * idempotent retries and never start a second logical sale after timeout.
 */
function awaitWithAbortSignal<T>(request: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(request);
  if (signal.aborted) return Promise.reject(new Error('İstek zaman aşımına uğradı veya iptal edildi.'));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('İstek zaman aşımına uğradı veya iptal edildi.'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(request).then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

async function writeAudit(action: string, entityType: string, entityId?: string, details: Record<string, unknown> = {}) {
  try {
    let staffId: string | null = null;
    let staffName: string | null = null;

    // Resolve the actual Supabase staff row from the active account.
    // Older builds could keep a local/demo id in sessionStorage, which caused
    // audit entries to be saved without an actor even though the sale itself
    // had the correct staff_id.
    try {
      const raw = sessionStorage.getItem('propos-current-staff-v2');
      const saved = raw ? JSON.parse(raw) as { id?: string; name?: string } : null;
      staffId = saved?.id || null;
      staffName = saved?.name || null;

      const { data: staffRows, error: staffReadError } = await fetchStaffRows();
      if (staffReadError || !staffRows) {
        staffId = null;
      } else {
        const rows = staffRows as Staff[];
        const byId = staffId ? rows.find(row => row.id === staffId && row.active) : undefined;
        const byName = !byId && staffName ? rows.find(row => row.active && row.name.toLocaleLowerCase() === staffName!.toLocaleLowerCase()) : undefined;
        const matched = byId || byName;
        staffId = matched?.id || null;
        staffName = matched?.name || staffName;
      }
    } catch {}

    // As a second safeguard, inherit the real actor from the entity itself.
    // Sales, returns and purchase receipts already persist their staff_id.
    if (!staffId && entityId) {
      try {
        if (entityType === 'sale') {
          const { data } = await supabase.from('sales').select('staff_id').eq('id', entityId).maybeSingle();
          staffId = data?.staff_id || null;
        } else if (entityType === 'purchase_receipt') {
          const { data } = await supabase.from('purchase_receipts').select('staff_id').eq('id', entityId).maybeSingle();
          staffId = data?.staff_id || null;
        }
      } catch {}
    }

    const enrichedDetails = staffName && !details.staff_name
      ? { ...details, staff_name: staffName }
      : details;

    await supabase.from('audit_logs').insert({
      action,
      entity_type: entityType,
      entity_id: entityId || null,
      details: enrichedDetails,
      staff_id: staffId,
    });
  } catch {
    // Audit is best-effort and must never block a POS operation.
  }
}


// ===== 4.6 Offline POS cache =====
const OFFLINE_PRODUCTS_KEY = 'propos-offline-products-v1';
const OFFLINE_CATEGORIES_KEY = 'propos-offline-categories-v1';
const OFFLINE_CUSTOMERS_KEY = 'propos-offline-customers-v1';
export const OFFLINE_SYNC_EVENT = 'propos-offline-sync';

// Browser deployments can be used with more than one licensed tenant on the
// same device. Keep offline caches separated by the currently verified tenant.
// Electron keeps its existing cache names because its SQLite profile is already
// bound to one business per desktop installation.
function tenantScopedOfflineKey(key: string): string {
  if (typeof window === 'undefined' || window.proposDesktop) return key;
  const businessId = localStorage.getItem('propos-business-id') || 'unlicensed';
  return `${key}:${businessId}`;
}

function readOfflineCache<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(tenantScopedOfflineKey(key));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch { return []; }
}
function writeOfflineCache<T>(key: string, value: T[]) {
  try { localStorage.setItem(tenantScopedOfflineKey(key), JSON.stringify(value)); } catch {}
}
export function getOfflineProducts() { return readOfflineCache<Product>(OFFLINE_PRODUCTS_KEY); }
export function getOfflineCategories() { return readOfflineCache<Category>(OFFLINE_CATEGORIES_KEY); }
export function getOfflineCustomers() { return readOfflineCache<Customer>(OFFLINE_CUSTOMERS_KEY); }

function notifyOfflineSync() {
  try { window.dispatchEvent(new CustomEvent(OFFLINE_SYNC_EVENT)); } catch {}
}

export function useCategories() {
  const [categories, setCategories] = useState<Category[]>(() => getOfflineCategories());
  const [loading, setLoading] = useState(() => getOfflineCategories().length === 0);
  const requestSequence = useRef(0);
  const hasInitialData = useRef(getOfflineCategories().length > 0);

  const load = useCallback(async (showInitialLoading = true) => {
    const requestId = ++requestSequence.current;
    const cached = getOfflineCategories();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (requestId === requestSequence.current) {
        setCategories(cached);
        setLoading(false);
        hasInitialData.current = cached.length > 0;
      }
      return;
    }
    if (showInitialLoading && !hasInitialData.current && cached.length === 0) setLoading(true);
    try {
      const { data, error } = await supabase
        .from('categories')
        .select('*')
        .order('sort_order', { ascending: true });
      if (requestId !== requestSequence.current) return;
      if (error) {
        console.error('Kategoriler yüklenemedi:', error);
        if (cached.length) setCategories(cached);
      } else {
        const rows = data || [];
        setCategories(rows);
        writeOfflineCache(OFFLINE_CATEGORIES_KEY, rows);
        hasInitialData.current = true;
      }
    } catch (error) {
      if (requestId === requestSequence.current) {
        console.error('Kategoriler yüklenirken bağlantı hatası:', error);
        if (cached.length) setCategories(cached);
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void load(false); }, 300);
    };
    const onConnectivity = () => { void load(true); };
    const onSync = () => { if (navigator.onLine) scheduleRefresh(); else { setCategories(getOfflineCategories()); setLoading(false); } };
    const channel = supabase
      .channel('categories-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, scheduleRefresh)
      .subscribe();
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    window.addEventListener(OFFLINE_SYNC_EVENT, onSync);
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
      window.removeEventListener('online', onConnectivity);
      window.removeEventListener('offline', onConnectivity);
      window.removeEventListener(OFFLINE_SYNC_EVENT, onSync);
    };
  }, [load]);

  return { categories, loading, reload: () => load(true) };
}

export function useProducts() {
  const [products, setProducts] = useState<Product[]>(() => getOfflineProducts());
  const [loading, setLoading] = useState(() => getOfflineProducts().length === 0);
  const requestSequence = useRef(0);
  const productsRef = useRef<Product[]>(getOfflineProducts());
  const hasInitialData = useRef(getOfflineProducts().length > 0);

  const load = useCallback(async (showInitialLoading = true) => {
    const requestId = ++requestSequence.current;
    const cached = getOfflineProducts();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (requestId === requestSequence.current) {
        productsRef.current = cached;
        setProducts(cached);
        setLoading(false);
        hasInitialData.current = cached.length > 0;
      }
      return;
    }
    // Keep the already-rendered catalogue on screen during stock refreshes.
    // Sale item updates can emit one realtime event per product; the effect below
    // coalesces them so the grid does not disappear or flicker while a sale finishes.
    if (showInitialLoading && !hasInitialData.current && cached.length === 0) setLoading(true);
    try {
      let { data, error } = await supabase
        .from('products')
        .select('*')
        .is('deleted_at', null)
        .order('name', { ascending: true });

      if (error) {
        const message = `${error.message || ''} ${error.code || ''}`.toLowerCase();
        const missingDeletedAt = message.includes('deleted_at') || message.includes('42703') || message.includes('schema cache');
        if (missingDeletedAt) {
          const fallback = await supabase.from('products').select('*').order('name', { ascending: true });
          data = fallback.data;
          error = fallback.error;
        }
      }
      if (requestId !== requestSequence.current) return;
      if (error) {
        console.error('Ürünler yüklenemedi:', error);
        if (cached.length) { productsRef.current = cached; setProducts(cached); }
      } else {
        const rows = (data || []) as Product[];
        productsRef.current = rows;
        setProducts(rows);
        writeOfflineCache(OFFLINE_PRODUCTS_KEY, rows);
        hasInitialData.current = true;
      }
    } catch (error) {
      if (requestId === requestSequence.current) {
        console.error('Ürünler yüklenirken bağlantı hatası:', error);
        if (cached.length) { productsRef.current = cached; setProducts(cached); }
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    let refreshTimer: number | undefined;
    let stockUpdateTimer: number | undefined;
    const pendingStock = new Map<string, { stock: number; updated_at: string }>();
    const scheduleRefresh = () => {
      // A real product edit wins over any queued stock-only patch.
      if (stockUpdateTimer) window.clearTimeout(stockUpdateTimer);
      stockUpdateTimer = undefined;
      pendingStock.clear();
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void load(false); }, 350);
    };
    const onConnectivity = () => { void load(true); };
    const onSync = () => { if (navigator.onLine) scheduleRefresh(); else { const cached = getOfflineProducts(); productsRef.current = cached; setProducts(cached); setLoading(false); } };
    const handleProductRealtime = (payload: any) => {
      // A completed sale updates only stock + updated_at on its product rows.
      // Apply those small changes locally and avoid refetching the whole product
      // catalogue for every product in a multi-item sale. Real product edits,
      // inserts, deletes and trash changes still trigger one debounced refresh.
      if (payload?.eventType === 'UPDATE' && payload?.new?.id && Object.prototype.hasOwnProperty.call(payload.new, 'stock')) {
        const incoming = payload.new as Partial<Product> & { id: string };
        const previous = productsRef.current.find(product => product.id === incoming.id);
        if (previous) {
          const ignored = new Set(['stock', 'updated_at']);
          const otherFieldsChanged = Object.keys(incoming).some(key => {
            if (ignored.has(key)) return false;
            return JSON.stringify((previous as any)[key]) !== JSON.stringify((incoming as any)[key]);
          });
          if (!otherFieldsChanged) {
            // Batch stock-only events into one React render/cache write for a
            // multi-product sale instead of repainting the full product grid per row.
            pendingStock.set(incoming.id, {
              stock: Number(incoming.stock ?? previous.stock),
              updated_at: incoming.updated_at ?? previous.updated_at,
            });
            if (stockUpdateTimer) window.clearTimeout(stockUpdateTimer);
            stockUpdateTimer = window.setTimeout(() => {
              stockUpdateTimer = undefined;
              if (!pendingStock.size) return;
              const updates = new Map(pendingStock);
              pendingStock.clear();
              const next = productsRef.current.map(product => {
                const patch = updates.get(product.id);
                return patch ? { ...product, ...patch } : product;
              });
              productsRef.current = next;
              setProducts(next);
              writeOfflineCache(OFFLINE_PRODUCTS_KEY, next);
            }, 80);
            return;
          }
        }
      }
      scheduleRefresh();
    };
    const channel = supabase
      .channel('products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, handleProductRealtime)
      .subscribe();
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    window.addEventListener(OFFLINE_SYNC_EVENT, onSync);
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      if (stockUpdateTimer) window.clearTimeout(stockUpdateTimer);
      pendingStock.clear();
      supabase.removeChannel(channel);
      window.removeEventListener('online', onConnectivity);
      window.removeEventListener('offline', onConnectivity);
      window.removeEventListener(OFFLINE_SYNC_EVENT, onSync);
    };
  }, [load]);

  return { products, loading, reload: () => load(true) };
}

export async function addCategory(name: string): Promise<Category | null> {
  const { data, error } = await supabase
    .from('categories')
    .insert({ name })
    .select()
    .single();
  if (error) {
    console.error('Kategori eklenemedi:', error);
    return null;
  }
  await writeAudit('category_created', 'category', data.id, { name });
  return data;
}

export async function updateCategory(id: string, name: string): Promise<boolean> {
  const { error } = await supabase
    .from('categories')
    .update({ name })
    .eq('id', id);
  if (error) {
    console.error('Kategori güncellenemedi:', error);
    return false;
  }
  await writeAudit('category_updated', 'category', id, { name });
  return true;
}

export async function deleteCategory(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Kategori silinemedi:', error);
    return false;
  }
  await writeAudit('category_deleted', 'category', id);
  return true;
}

export async function addProduct(p: Omit<Product, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>): Promise<Product | null> {
  const payload = { ...p, unlimited_stock: p.unlimited_stock ?? false, discount_enabled: p.discount_enabled ?? false, discount_price: p.discount_price ?? null, discount_starts_at: p.discount_starts_at ?? null, discount_ends_at: p.discount_ends_at ?? null, min_stock: p.min_stock ?? 0, additional_barcodes: p.additional_barcodes ?? [] };
  let result = await supabase.from('products').insert(payload).select().single();
  if (result.error && /additional_barcodes|discount_enabled|discount_price|discount_starts_at|discount_ends_at|min_stock|unlimited_stock|deleted_at|schema cache|column/i.test(result.error.message || '')) {
    if (p.unlimited_stock) {
      console.error('Sınırsız stok kaydedilemedi: kişisel Supabase şemasında unlimited_stock alanı eksik. Gereken migration uygulanmalı.');
      return null;
    }
    const legacy = {
      name: p.name, barcode: p.barcode || null, price: p.price, cost: p.cost, stock: p.stock,
      category_id: p.category_id ?? null, unit: p.unit || 'adet'
    };
    result = await supabase.from('products').insert(legacy).select().single();
  }
  if (result.error) {
    console.error('Ürün eklenemedi:', result.error);
    return null;
  }
  const created = result.data as Product;
  await writeAudit('product_created', 'product', created.id, { name: created.name, price: created.price });
  return created;
}

export async function updateProduct(id: string, p: Partial<Omit<Product, 'id' | 'created_at' | 'updated_at' | 'deleted_at'>>): Promise<boolean> {
  const before = await supabase.from('products').select('price,cost').eq('id',id).maybeSingle();
  let result = await supabase.from('products').update(p).eq('id', id);
  if (result.error && /additional_barcodes|discount_enabled|discount_price|discount_starts_at|discount_ends_at|min_stock|unlimited_stock|deleted_at|schema cache|column/i.test(result.error.message || '')) {
    if (p.unlimited_stock !== undefined) {
      console.error('Sınırsız stok güncellenemedi: kişisel Supabase şemasında unlimited_stock alanı eksik. Gereken migration uygulanmalı.');
      return false;
    }
    const legacyKeys = new Set(['name','barcode','price','cost','stock','category_id','unit']);
    const legacy:any = {};
    Object.entries(p).forEach(([k,v]) => { if (legacyKeys.has(k)) legacy[k]=v; });
    result = await supabase.from('products').update(legacy).eq('id', id);
  }
  if (result.error) {
    console.error('Ürün güncellenemedi:', result.error);
    return false;
  }
  if (before.data && (p.price !== undefined || p.cost !== undefined)) {
    const oldPrice=Number(before.data.price||0), oldCost=Number(before.data.cost||0);
    const newPrice=p.price!==undefined?Number(p.price):oldPrice, newCost=p.cost!==undefined?Number(p.cost):oldCost;
    if (oldPrice!==newPrice || oldCost!==newCost) {
      await supabase.from('product_price_history').insert({product_id:id,old_price:oldPrice,new_price:newPrice,old_cost:oldCost,new_cost:newCost});
    }
  }
  await writeAudit('product_updated', 'product', id, { fields: Object.keys(p) });
  return true;
}

export async function deleteProduct(id: string): Promise<boolean> {
  // Önce çöp kutusuna taşı; kolon/migration yoksa gerçek silmeye geri dön.
  const { error } = await supabase.from('products').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (!error) { await writeAudit('product_deleted', 'product', id); return true; }
  const msg = `${error.message || ''} ${error.code || ''}`.toLowerCase();
  const missingDeletedAt = msg.includes('deleted_at') || msg.includes('schema cache') || msg.includes('42703');
  if (missingDeletedAt) {
    const hard = await supabase.from('products').delete().eq('id', id);
    if (!hard.error) { await writeAudit('product_hard_deleted', 'product', id); return true; }
    console.error('Ürün fiziksel olarak da silinemedi:', hard.error);
  } else console.error('Ürün çöp kutusuna taşınamadı:', error);
  return false;
}

export async function restoreProduct(id: string): Promise<boolean> {
  const { error } = await supabase.from('products').update({ deleted_at: null }).eq('id', id);
  if (error) { console.error('Ürün geri yüklenemedi:', error); return false; }
  await writeAudit('product_restored', 'product', id);
  return true;
}

export function useDeletedProducts(limit = 200) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) console.error('Ürün çöp kutusu yüklenemedi:', error);
    setProducts(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('deleted-products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { products, loading, reload: load };
}

export type CartItem = {
  product: Product;
  quantity: number;
  discountPercent?: number;
  fixedUnitPrice?: number;
};

export type PaymentSplit = { method: 'cash'|'card'|'iban'|'credit'; amount: number; customerId?: string; customerName?: string };

function cartUnitPrice(item: CartItem) {
  const effective = item.fixedUnitPrice != null ? Number(item.fixedUnitPrice) : campaignUnitPrice(item.product, Number(item.quantity || 1)).price;
  const pct = item.fixedUnitPrice != null ? 0 : Math.max(0, Math.min(100, Number(item.discountPercent || 0)));
  return +(effective * (1 - pct / 100)).toFixed(2);
}


async function recordImmediateStaffEarning(params: {
  saleId: string;
  amountPaid: number;
  currentStaffId: string;
  currentStaffName: string;
}) {
  const { saleId, amountPaid, currentStaffId, currentStaffName } = params;
  if (!IS_OWNER_EDITION) return;
  if (amountPaid <= 0 || (!currentStaffId && !currentStaffName)) return;

  const { data: staffRows, error: staffReadError } = await fetchStaffRows();
  if (staffReadError || !staffRows) return;
  const rows = staffRows as Staff[];
  let resolvedStaff = currentStaffId ? rows.find(row => row.id === currentStaffId && row.active) : undefined;
  if (!resolvedStaff && currentStaffName) {
    resolvedStaff = rows.find(row => row.active && row.name.toLocaleLowerCase() === currentStaffName.toLocaleLowerCase());
  }
  if (!resolvedStaff) return;

  const rate = Math.max(0, Math.min(100, Number(resolvedStaff.earning_rate || 0)));
  if (rate <= 0) return;
  const earningAmount = +(amountPaid * rate / 100).toFixed(2);
  const { data: saleMeta } = await supabase
    .from('sales')
    .select('business_id')
    .eq('id', saleId)
    .maybeSingle();

  const { error: earningError } = await supabase.from('staff_earnings').upsert({
    business_id: saleMeta?.business_id || null,
    staff_id: resolvedStaff.id,
    sale_id: saleId,
    amount_paid: amountPaid,
    rate_percent: rate,
    earning_amount: earningAmount,
    source: 'sale_payment',
  }, { onConflict: 'sale_id' });
  if (earningError) {
    console.warn('Satış çalışan kazancı kaydedilemedi:', earningError);
    return;
  }

  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
  const { data: existingDay } = await supabase
    .from('staff_daily_earnings')
    .select('amount_paid,earning_amount,payment_count,business_id')
    .eq('staff_id', resolvedStaff.id)
    .eq('earning_date', day)
    .maybeSingle();

  await supabase.from('staff_daily_earnings').upsert({
    business_id: saleMeta?.business_id || existingDay?.business_id || null,
    staff_id: resolvedStaff.id,
    earning_date: day,
    amount_paid: Number(existingDay?.amount_paid || 0) + amountPaid,
    earning_amount: Number(existingDay?.earning_amount || 0) + earningAmount,
    payment_count: Number(existingDay?.payment_count || 0) + 1,
  }, { onConflict: 'staff_id,earning_date' });
}

export async function completeSale(
  items: CartItem[],
  paymentMethod: Sale['payment_method'] | 'split',
  paidAmount: number,
  customerName?: string,
  customerId?: string,
  paymentSplits?: PaymentSplit[],
  clientRef?: string,
  staffContext?: { id?: string; name?: string; offlineSync?: boolean },
  signal?: AbortSignal,
): Promise<SaleWithItems | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;

  const sessionStaff = (() => {
    try {
      return JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null') as { id?: string; name?: string } | null;
    } catch {
      return null;
    }
  })();
  // Normal çevrimiçi satışta aktif hesabı kullan. Offline kuyruğun senkronizasyonunda
  // ise satış oluşturulduğu anda kaydedilen personel bilgisini özellikle öne al ki
  // sonradan başka personel giriş yapmış olsa bile satış yanlış kişiye yazılmasın.
  const currentStaffId = staffContext?.id || sessionStaff?.id || '';
  const currentStaffName = staffContext?.name || sessionStaff?.name || '';
  const originalTotal = items.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0);
  const total = items.reduce((sum, item) => sum + cartUnitPrice(item) * item.quantity, 0);
  const discountTotal = +(originalTotal - total).toFixed(2);
  const now = new Date().toISOString();
  if (!items.length || !items.every(i => Number.isFinite(Number(i.quantity)) && Number(i.quantity) > 0)) return null;
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(paidAmount) || paidAmount < 0) return null;
  // Nakit ödemede verilen para satıştan fazla olabilir; ödeme kaydına
  // satış tutarını yazar, para üstünü paid_amount alanında saklarız.
  // 0 TL toplamlı ücretsiz/test satışlarında 0 tutarlı ödeme satırı eklenmez.
  const splits = (paymentMethod === 'split'
    ? (paymentSplits || [])
    : [{
        method: paymentMethod as 'cash'|'card'|'iban'|'credit',
        amount: total,
        customerId,
        customerName
      }]
  ).filter(p => Number(p.amount) > 0);

  // Kişisel sahip sürümünde satış yalnızca Supabase atomik RPC'si ile tamamlanır.
  // RPC bir iş kuralı hatası döndürdüyse (özellikle yetersiz stok) ikinci bir
  // parçalı kayıt yoluna düşmek mükerrer/yarım satış riski oluşturur.
  const rpcItems = items.map((item) => {
    const unitPrice = cartUnitPrice(item);
    const originalUnitPrice = Number(item.product.price);
    return {
      productId: item.product.id,
      productName: item.product.name,
      barcode: item.product.barcode,
      quantity: Number(item.quantity),
      unitPrice: Number(unitPrice),
      originalUnitPrice,
      discountAmount: +((originalUnitPrice - unitPrice) * item.quantity).toFixed(2),
    };
  });
  const rpcSplits = splits.map(p => ({ method: p.method, amount: Number(p.amount), customerId: p.customerId || null }));
  const paidAtSale = paymentMethod === 'split'
    ? splits.filter(p => p.method === 'cash' || p.method === 'card' || p.method === 'iban').reduce((sum, p) => sum + Number(p.amount || 0), 0)
    : paidAmount;
  let ownerAtomicFailure: unknown = null;
  try {
    const rpcRequest = supabase.rpc('complete_sale_atomic', {
      p_total: +total.toFixed(2),
      p_payment_method: paymentMethod,
      p_paid_amount: +paidAtSale.toFixed(2),
      p_customer_id: customerId || null,
      p_customer_name: customerName || null,
      p_original_total: +originalTotal.toFixed(2),
      p_discount_total: discountTotal,
      p_client_ref: clientRef || null,
      p_items: rpcItems,
      p_splits: rpcSplits,
      p_staff_id: currentStaffId || null,
      p_staff_name: currentStaffName || null,
    });
    const rpcResult = await awaitWithAbortSignal(rpcRequest, signal);
    const { data: atomicSaleId, error: atomicError } = rpcResult;
    if (!atomicError && atomicSaleId) {
      // First try one joined read. If PostgREST relationship metadata is stale,
      // fall back to two small reads instead of treating a committed sale as failed.
      const saleQuery = supabase.from('sales').select('*, sale_items(*)').eq('id', atomicSaleId).single();
      const joinedResult = await awaitWithAbortSignal(saleQuery, signal);
      let atomicSale: any = !joinedResult.error ? joinedResult.data : null;
      let saleReadError: unknown = joinedResult.error || null;
      if (!atomicSale) {
        const basicQuery = supabase.from('sales').select('*').eq('id', atomicSaleId).single();
        const basicResult = await awaitWithAbortSignal(basicQuery, signal);
        if (!basicResult.error && basicResult.data) {
          const itemsQuery = supabase.from('sale_items').select('*').eq('sale_id', atomicSaleId).order('id', { ascending: true });
          const itemsResult = await awaitWithAbortSignal(itemsQuery, signal);
          if (!itemsResult.error) {
            atomicSale = { ...basicResult.data, sale_items: itemsResult.data || [] };
            saleReadError = null;
          } else saleReadError = itemsResult.error;
        } else saleReadError = basicResult.error || saleReadError;
      }
      if (atomicSale) {
        const immediatePaid = splits
          .filter(p => p.method === 'cash' || p.method === 'card' || p.method === 'iban')
          .reduce((sum, p) => sum + Number(p.amount || 0), 0);
        void writeAudit('sale_completed', 'sale', atomicSale.id, { total, paymentMethod, itemCount: items.length, atomic: true, immediatePaid });
        return { ...atomicSale, sale_items: (Array.isArray(atomicSale.sale_items) ? atomicSale.sale_items : []) as SaleItem[] } as SaleWithItems;
      }
      if (IS_OWNER_EDITION) ownerAtomicFailure = saleReadError || new Error('Satış kaydedildi fakat fiş okunamadı. Satış geçmişini kontrol et; aynı işlem kimliğiyle yeniden denenebilir.');
    } else if (atomicError) {
      console.warn('Atomik satış RPC başarısız:', atomicError.message, atomicError.code);
      if (IS_OWNER_EDITION) ownerAtomicFailure = atomicError;
    } else if (IS_OWNER_EDITION) {
      ownerAtomicFailure = new Error('Supabase satış RPC fonksiyonu bir satış kimliği döndürmedi.');
    }
  } catch (err) {
    console.warn('Atomik satış RPC kullanılamadı:', err);
    if (IS_OWNER_EDITION) ownerAtomicFailure = err;
  }

  if (IS_OWNER_EDITION) {
    if (ownerAtomicFailure) {
      const raw = ownerAtomicFailure instanceof Error
        ? ownerAtomicFailure.message
        : String((ownerAtomicFailure as any)?.message || ownerAtomicFailure || 'Bilinmeyen Supabase hatası');
      if (/yetersiz stok/i.test(raw)) {
        throw new Error(`${raw}. Ürün kartındaki stoğu kontrol et; ürün sürekli satılıyorsa Ürünler bölümünden Sınırsız Stok seçeneğini aç.`);
      }
      if (/karma ödeme toplamı/i.test(raw)) throw new Error(`${raw}. Nakit, kart, IBAN ve veresiye tutarlarının toplamını kontrol et.`);
      throw new Error(`Satış kaydedilmedi: ${raw}`);
    }
    throw new Error('Supabase satış işlemini doğrulayamadı. İşlem tekrar edilmedi; satış geçmişini kontrol et.');
  }

  // Customer edition compatibility fallback only. Never use this path for the
  // personal owner edition, where the cloud RPC is the source of truth.
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel atomik satış tamamlanamadı; güvenlik için parçalı fallback çalıştırılmadı.');
    return null;
  }

  if (paymentMethod === 'split') {
    const splitTotal = splits.reduce((a, p) => a + Number(p.amount || 0), 0);
    if (Math.abs(splitTotal - total) > 0.01) return null;
    if (splits.some(p => p.method === 'credit' && !p.customerId)) return null;
  } else if (paymentMethod === 'credit' && !customerId) {
    return null;
  } else if (paymentMethod === 'cash' && paidAmount + 0.0001 < total) {
    return null;
  } else if (paymentMethod === 'card' && paidAmount + 0.0001 < total) {
    return null;
  }

  const baseSalePayload = {
    total: +total.toFixed(2),
    payment_method: paymentMethod,
    paid_amount: +paidAtSale.toFixed(2),
    customer_name: customerName || null,
    staff_id: currentStaffId || null,
  };
  const extendedSalePayload = {
    ...baseSalePayload,
    original_total: +originalTotal.toFixed(2),
    discount_total: discountTotal,
    customer_id: customerId || null,
    payment_note: null,
    ...(clientRef ? { client_ref: clientRef } : {}),
  };

  if (clientRef) {
    const { data: existingSale } = await supabase.from('sales').select('*').eq('client_ref', clientRef).maybeSingle();
    if (existingSale) {
      const existingItems = await getSaleItems(existingSale.id);
      return { ...existingSale, sale_items: existingItems } as SaleWithItems;
    }
  }

  let saleInsert = await supabase.from('sales').insert(extendedSalePayload).select().single();
  if (saleInsert.error && /staff_id|customer_id|payment_note|discount_total|original_total|client_ref|schema cache|column|invalid input value/i.test(saleInsert.error.message || '')) {
    saleInsert = await supabase.from('sales').insert(baseSalePayload).select().single();
  }
  const { data: sale, error: saleError } = saleInsert;
  if (saleError || !sale) return null;

  const saleItems: Omit<SaleItem, 'id'>[] = items.map((item) => {
    const unit = cartUnitPrice(item);
    const original = Number(item.product.price);
    return { sale_id: sale.id, product_id: item.product.id, product_name: item.product.name, barcode: item.product.barcode, quantity: item.quantity, unit_price: unit, subtotal: +(unit * item.quantity).toFixed(2), original_unit_price: original, discount_amount: +((original-unit)*item.quantity).toFixed(2) };
  });
  let itemsResult:any, paymentResult:any;
  [itemsResult, paymentResult] = await Promise.all([
    supabase.from('sale_items').insert(saleItems),
    splits.length > 0 ? supabase.from('sale_payments').insert(splits.map(p => ({ sale_id: sale.id, method: p.method, amount: p.amount }))) : Promise.resolve({error:null})
  ]);
  if (itemsResult.error && /original_unit_price|discount_amount|schema cache|column/i.test(itemsResult.error.message || '')) {
    const legacySaleItems = saleItems.map(({ original_unit_price, discount_amount, ...row }) => row);
    itemsResult = await supabase.from('sale_items').insert(legacySaleItems);
  }
  if (itemsResult.error) { await supabase.from('sales').delete().eq('id', sale.id); console.error('Satış kalemleri kaydedilemedi:', itemsResult.error); return null; }
  let payError: { message?: string } | null = paymentResult?.error || null;
  // sale_payments tablosu eski kurulumlarda olmayabilir; bu durumda ana satış yine kaydedilsin.
  if (payError && !/sale_payments|schema cache|relation|does not exist|Could not find the table/i.test(payError.message || '')) {
    // Ödeme kırılımı yardımcı kayıttır; ana satışın tamamlanmasını engellemesin.
    // Base sales.payment_method / paid_amount alanları yine ana ödeme bilgisini tutar.
    console.warn('Ödeme kırılımı kaydedilemedi; ana satış korunuyor:', payError);
  }

  // Customer edition never creates staff earnings; staff management is limited to roles and secure PINs.
  if (IS_OWNER_EDITION && (currentStaffId || currentStaffName) && splits.length > 0) {
    const immediatePaid = splits
      .filter(p => p.method === 'cash' || p.method === 'card' || p.method === 'iban')
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);
    if (immediatePaid > 0) {
      const { data: staffRows, error: staffReadError } = await fetchStaffRows();
      // A staff-list issue must never cancel a sale already written to the database.
      const rows = !staffReadError && staffRows ? staffRows as Staff[] : [];
      let resolvedStaff = currentStaffId ? rows.find(row => row.id === currentStaffId && row.active) : undefined;
      if (!resolvedStaff && currentStaffName) {
        resolvedStaff = rows.find(row => row.active && row.name.toLocaleLowerCase() === currentStaffName.toLocaleLowerCase());
      }
      if (resolvedStaff) {
        const rate = Math.max(0, Math.min(100, Number(resolvedStaff.earning_rate || 0)));
        if (rate > 0) {
          const earningAmount = +(immediatePaid * rate / 100).toFixed(2);
          const { data: saleMeta } = await supabase.from('sales').select('business_id').eq('id', sale.id).maybeSingle();
          const { error: earningError } = await supabase.from('staff_earnings').upsert({
            business_id: saleMeta?.business_id || null,
            staff_id: resolvedStaff.id,
            sale_id: sale.id,
            amount_paid: immediatePaid,
            rate_percent: rate,
            earning_amount: earningAmount,
            source: 'sale_payment'
          }, { onConflict: 'sale_id' });
          if (earningError) {
            console.warn('Satış çalışan kazancı kaydedilemedi:', earningError);
          } else {
            const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
            await supabase.from('staff_daily_earnings').upsert({
              business_id: saleMeta?.business_id || null,
              staff_id: resolvedStaff.id,
              earning_date: day,
              amount_paid: immediatePaid,
              earning_amount: earningAmount,
              payment_count: 1
            }, { onConflict: 'staff_id,earning_date' });
          }
        }
      }
    }
  }

  const appliedStock: { productId: string; quantity: number; before: number; name: string }[] = [];
  const rollbackSale = async () => {
    for (const row of [...appliedStock].reverse()) {
      const restored = await supabase.rpc('record_stock_movement', {
        p_product_id: row.productId, p_type: 'return', p_quantity: row.quantity,
        p_reason: `Satış geri alma ${sale.id}`, p_sale_id: sale.id, p_staff_id: currentStaffId || null,
      });
      if (restored.error || restored.data !== true) {
        await supabase.from('products').update({ stock: row.before }).eq('id', row.productId);
      }
    }
    await supabase.from('sale_items').delete().eq('sale_id', sale.id);
    await supabase.from('sale_payments').delete().eq('sale_id', sale.id);
    await supabase.from('sales').delete().eq('id', sale.id);
  };

  const stockRows = await Promise.all(items.map(async (item) => {
    const { data: currentProduct, error: prodErr } = await supabase.from('products').select('stock,name,unlimited_stock').eq('id', item.product.id).single();
    return { item, currentProduct, prodErr };
  }));
  if (stockRows.some(r => r.prodErr || !r.currentProduct || (!r.currentProduct.unlimited_stock && Number(r.currentProduct.stock) < Number(r.item.quantity)))) {
    await Promise.all([
      supabase.from('sale_items').delete().eq('sale_id', sale.id),
      supabase.from('sale_payments').delete().eq('sale_id', sale.id),
      supabase.from('sales').delete().eq('id', sale.id)
    ]);
    return null;
  }
  const stockResults = await Promise.all(stockRows.map(async ({item,currentProduct}) => {
    const before = Number(currentProduct!.stock);
    if (currentProduct!.unlimited_stock) return { success:true, skippedStock:true, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const ok = await supabase.rpc('record_stock_movement', { p_product_id:item.product.id, p_type:'sale', p_quantity:item.quantity, p_reason:`Satış ${sale.id}`, p_sale_id:sale.id, p_staff_id:currentStaffId || null });
    if (!ok.error && ok.data === true) return { success:true, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const nextStock = before - Number(item.quantity);
    if (nextStock < 0) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const fallbackStock = await supabase.from('products').update({ stock: nextStock }).eq('id', item.product.id);
    if (fallbackStock.error) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    const movementResult = await supabase.from('stock_movements').insert({product_id:item.product.id,product_name:currentProduct!.name,movement_type:'sale',quantity:item.quantity,before_stock:before,after_stock:nextStock,sale_id:sale.id,staff_id:currentStaffId || null});
    if (movementResult.error && !/stock_movements|schema cache|relation|does not exist/i.test(movementResult.error.message || '')) return { success:false, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
    return { success:true, productId:item.product.id, quantity:Number(item.quantity), before, name:currentProduct!.name };
  }));
  if (stockResults.some(r => !r.success)) {
    await Promise.all(stockResults.filter(r => r.success).map(async row => {
      const restored = await supabase.rpc('record_stock_movement', { p_product_id: row.productId, p_type: 'return', p_quantity: row.quantity, p_reason: `Satış geri alma ${sale.id}`, p_sale_id: sale.id, p_staff_id: null });
      if (restored.error || restored.data !== true) await supabase.from('products').update({ stock: row.before }).eq('id', row.productId);
    }));
    await Promise.all([
      supabase.from('sale_items').delete().eq('sale_id', sale.id),
      supabase.from('sale_payments').delete().eq('sale_id', sale.id),
      supabase.from('sales').delete().eq('id', sale.id)
    ]);
    return null;
  }
  appliedStock.push(...stockResults.filter(r => r.success && !(r as any).skippedStock).map(r => ({productId:r.productId, quantity:r.quantity, before:r.before, name:r.name}))); 

  const creditPart = splits.filter(p => p.method === 'credit').reduce((sum,p)=>sum+p.amount,0);
  if (creditPart > 0) {
    const cid = splits.find(p=>p.method==='credit')?.customerId || customerId;
    if (!cid) {
      await rollbackSale();
      return null;
    }
    const { error: balanceError } = await supabase.rpc('increment_customer_balance', { p_customer_id: cid, p_amount: creditPart });
    if (balanceError) {
      const { data:cust, error:custReadError } = await supabase.from('customers').select('balance').eq('id',cid).single();
      if (custReadError || !cust) {
        await rollbackSale();
        console.error('Müşteri bakiyesi güncellenemedi:', balanceError, custReadError);
        return null;
      }
      const fallbackBalance = await supabase.from('customers').update({balance:Number(cust.balance||0)+creditPart}).eq('id',cid);
      if (fallbackBalance.error) {
        await rollbackSale();
        console.error('Müşteri bakiyesi güncellenemedi:', balanceError, fallbackBalance.error);
        return null;
      }
    }
  }
  await writeAudit('sale_completed', 'sale', sale.id, { total, paymentMethod, itemCount: items.length });
  return { ...sale, sale_items: saleItems as SaleItem[] } as SaleWithItems;
}

export async function addStock(product: Product, quantity: number, reason = 'Stok girişi', staffId?: string) {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  const { data, error } = await supabase.rpc('record_stock_movement', { p_product_id: product.id, p_type:'in', p_quantity:quantity, p_reason:reason, p_staff_id:staffId || null });
  if (!error && data === true) return true;
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel atomik stok girişi başarısız; güvenlik için ayrı stok güncellemesi yapılmadı:', error);
    return false;
  }
  const next = Number(product.stock || 0) + quantity;
  const fallback = await supabase.from('products').update({ stock: next }).eq('id', product.id);
  if (!fallback.error) {
    await supabase.from('stock_movements').insert({ product_id: product.id, product_name: product.name, movement_type:'in', quantity, before_stock:Number(product.stock||0), after_stock:next, reason, staff_id:staffId||null });
    return true;
  }
  console.error('Stok girişi başarısız:', error || fallback.error);
  return false;
}

export async function setStock(product: Product, quantity: number, reason = 'Stok düzeltme', staffId?: string) {
  if (!Number.isFinite(quantity) || quantity < 0) return false;
  const { data, error } = await supabase.rpc('record_stock_movement', { p_product_id: product.id, p_type:'adjustment', p_quantity:quantity, p_reason:reason, p_staff_id:staffId || null });
  if (!error && data === true) return true;
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel atomik stok düzeltmesi başarısız; güvenlik için ayrı stok güncellemesi yapılmadı:', error);
    return false;
  }
  const fallback = await supabase.from('products').update({ stock: quantity }).eq('id', product.id);
  if (!fallback.error) {
    await supabase.from('stock_movements').insert({ product_id: product.id, product_name: product.name, movement_type:'adjustment', quantity, before_stock:Number(product.stock||0), after_stock:quantity, reason, staff_id:staffId||null });
    return true;
  }
  console.error('Stok düzeltme başarısız:', error || fallback.error);
  return false;
}


export type ProcessSaleReturnInput = {
  saleId: string;
  items: Array<{ saleItemId: string; quantity: number }>;
  reason?: string;
  staffId?: string | null;
  returnMethod?: 'original'|'cash'|'card'|'iban'|'credit';
};

export async function processSaleReturn(input: ProcessSaleReturnInput): Promise<{success:boolean; refundAmount:number; costReversed:number; error?:string; warning?:string; reversedDebtAmount?:number}> {
  if (!input.saleId || !input.items.length) return { success:false, refundAmount:0, costReversed:0, error:'İade kalemleri gerekli.' };
  const { data: saleBefore, error: saleBeforeError } = await supabase.from('sales').select('id,total,refund_amount,customer_id').eq('id', input.saleId).maybeSingle();
  if (saleBeforeError || !saleBefore) return { success:false, refundAmount:0, costReversed:0, error:'İade öncesi satış kaydı doğrulanamadı.' };
  const saleToken = input.saleId.slice(-8).toUpperCase();
  const linkedDebtPaymentsBefore: any[] = [];
  let autoReverseDebtAtFullReturn = false;
  if (saleBefore.customer_id) {
    const { data: possiblePayments, error: paymentLookupError } = await supabase.from('customer_payments').select('*').eq('customer_id', saleBefore.customer_id);
    if (paymentLookupError) return { success:false, refundAmount:0, costReversed:0, error:`Veresiye mahsuplaşma kaydı doğrulanamadı; iade güvenli şekilde durduruldu: ${paymentLookupError.message}` };
    for (const payment of possiblePayments || []) {
      if (!payment.canceled_at && String(payment.note || '').includes(`Satış ${saleToken} sırasında fazla alınan nakit veresiye borcundan düşüldü`)) linkedDebtPaymentsBefore.push(payment);
    }
    if (linkedDebtPaymentsBefore.length) {
      // Calculate whether the selected quantities complete the sale return before mutating stock/cash.
      const itemIds = input.items.map(item => item.saleItemId);
      const { data: saleItems, error: selectedItemsError } = await supabase.from('sale_items').select('id,quantity,subtotal,unit_price').in('id', itemIds).eq('sale_id', input.saleId);
      if (selectedItemsError || !saleItems) return { success:false, refundAmount:0, costReversed:0, error:'İade kalemleri doğrulanamadı; veresiye mahsubu korunması için işlem durduruldu.' };
      const { data: priorReturns, error: priorReturnsError } = await supabase.from('sale_returns').select('amount').eq('sale_id', input.saleId);
      if (priorReturnsError) return { success:false, refundAmount:0, costReversed:0, error:'Önceki iade kayıtları doğrulanamadı; işlem durduruldu.' };
      const requestedRefund = saleItems.reduce((sum: number, item: any) => {
        const requested = input.items.find(line => line.saleItemId === item.id)?.quantity || 0;
        const quantity = Math.max(Number(item.quantity || 0), 0.00001);
        return sum + Math.round((Number(item.subtotal ?? Number(item.unit_price || 0) * quantity) / quantity * requested) * 100) / 100;
      }, 0);
      const priorReturnTotal = (priorReturns || []).reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);
      autoReverseDebtAtFullReturn = priorReturnTotal + requestedRefund >= Number(saleBefore.total || 0) - 0.009;
    }
  }
  const { data, error } = await supabase.rpc('process_sale_return', {
    p_sale_id: input.saleId,
    p_items: input.items,
    p_reason: input.reason?.trim() || null,
    p_staff_id: input.staffId || null,
    p_return_method: input.returnMethod || 'original',
  });
  if (error) return { success:false, refundAmount:0, costReversed:0, error:error.message };
  const refundAmount=Number(data?.refund_amount||0);
  const costReversed=Number(data?.cost_reversed||0);
  let reversedDebtAmount = 0;
  let warning: string | undefined;
  if (autoReverseDebtAtFullReturn && linkedDebtPaymentsBefore.length) {
    for (const payment of linkedDebtPaymentsBefore) {
      const { data: reversed, error: reversalError } = await supabase.rpc('restore_sale_excess_debt_payment', {
        p_payment_id: String(payment.id),
        p_reason: `Satış ${saleToken} tamamen iade edildiği için fazla ödeme veresiye mahsubu geri alındı`,
        p_staff_id: input.staffId || null,
      });
      if (!reversalError && reversed?.success) reversedDebtAmount += Number(reversed.amount || payment.amount || 0);
      else warning = `Satış iadesi kaydedildi; fakat ${formatCurrencyForAudit(Number(payment.amount || 0))} veresiye mahsubu otomatik geri alınamadı. Cari hareketlerini kontrol edin. ${reversalError?.message || reversed?.error || ''}`;
    }
  }
  await writeAudit('sale_partial_or_full_return','sale',input.saleId,{refund_amount:refundAmount,item_count:input.items.length,reason:input.reason||null,return_method:input.returnMethod||'original',reversed_debt_amount:reversedDebtAmount});
  return { success:true, refundAmount, costReversed, warning, reversedDebtAmount };
}

function formatCurrencyForAudit(value: number) { return new Intl.NumberFormat('tr-TR', { style:'currency', currency:'TRY' }).format(value); }

export async function partialReturn(saleId: string, saleItemId: string, quantity: number, reason?: string) {
  const { data, error } = await supabase.rpc('record_partial_return', {p_sale_id:saleId,p_sale_item_id:saleItemId,p_quantity:quantity,p_reason:reason||null});
  return !error && Number(data||0) > 0;
}

export function useStockMovements(productId?: string) {
  const [rows,setRows]=useState<StockMovement[]>([]); const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{ setLoading(true); let q=supabase.from('stock_movements').select('*').order('created_at',{ascending:false}).limit(500); if(productId) q=q.eq('product_id',productId); const {data,error}=await q; if(error) console.error(error); setRows((data||[]) as StockMovement[]); setLoading(false);},[productId]);
  useEffect(()=>{load();},[load]); return {movements:rows,loading,reload:load};
}

const STAFF_LOCAL_KEY='propos-staff-local-v1';
function getLocalStaff(): Staff[] { try { const raw=JSON.parse(localStorage.getItem(STAFF_LOCAL_KEY)||'[]'); return Array.isArray(raw)?raw as Staff[]:[]; } catch { return []; } }
export function getCachedStaff(): Staff[] { return getLocalStaff(); }
function saveLocalStaff(rows: Staff[]) { try { localStorage.setItem(STAFF_LOCAL_KEY, JSON.stringify(rows)); } catch {} }
function isMissingStaffTable(error:any) { const msg = `${error?.message||''} ${error?.code||''}`.toLowerCase(); return msg.includes('relation') && msg.includes('staff') || msg.includes('staff') && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('404') || msg.includes('pgrst205')); }

function isNetworkFetchFailure(error: unknown) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String((error as any)?.message || error || '');
  return !navigator.onLine || /failed to fetch|err_internet_disconnected|networkerror|load failed|fetch failed|internet_disconnected/i.test(detail);
}

function staffFetchErrorMessage(error: any, desktopMode: boolean) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error?.message || error || '');
  if (desktopMode && /failed to fetch|load failed/i.test(detail)) {
    return 'CORS_OR_NETWORK_UNAVAILABLE: Windows istemcisinin personel isteği tarayıcı/ağ katmanında tamamlanamadı. Eski sürümdeki özel x-propos-business-id başlığı PostgREST CORS isteğini engelleyebilir. 5.1.6 sürümü personel listesini lisans bağlamını doğrulayan sunucu tarafı Edge Function üzerinden doğrudan veritabanından alır; PIN hash değerlerini istemciye göndermez. İnternet bağlantısını da kontrol edin.';
  }
  if (desktopMode && isNetworkFetchFailure(error)) {
    return 'NETWORK_UNAVAILABLE: İnternet bağlantısı kesildi veya müşteri Supabase sunucusuna ulaşılamıyor. İlk Admin hesabı güvenli şekilde yalnızca sunucu bu işletmede hiç personel olmadığını doğruladığında oluşturulur. İnterneti kontrol edin; bağlantı geri gelince uygulama otomatik tekrar deneyecek.';
  }
  if (isMissingStaffTable(error)) {
    return 'MIGRATION_REQUIRED: Supabase personel tablosu bulunamadı. Müşteri projesinde supabase/migrations dosyalarının eksik olup olmadığını kontrol edin.';
  }
  if (/staff_api_failed|edge function returned a non-2xx status code|personel sunucusu/i.test(detail)) {
    return 'PERSONEL_API_HATASI: Personel Edge Function veritabanı isteğini tamamlayamadı. Sunucu günlüklerinde propos-staff-api hatası kontrol edilmeli; PIN/rol güvenliğini gevşetmeyin.';
  }
  const code = String(error?.code || '');
  if (code === '42501' || /permission denied|row-level security|not allowed/i.test(String(error?.message || ''))) {
    return 'PERSONEL_YETKISI: Sunucuya ulaşıldı ancak bu işletmenin personel kayıtlarını okuma izni reddedildi. Lisans-işletme bağlantısını ve Supabase RLS politikalarını kontrol edin.';
  }
  return String(error?.message || 'Personel kayıtları sunucudan yüklenemedi. Tekrar deneyin.');
}

// Multiple mounted widgets can ask for staff at startup. Share one in-flight
// request so transient connection failures do not spam the PostgREST endpoint.
let staffFetchInFlight: Promise<{ data: any[] | null; error: any }> | null = null;
function fetchStaffRows(): Promise<{ data: any[] | null; error: any }> {
  if (!staffFetchInFlight) {
    staffFetchInFlight = (async () => {
      try {
        if (IS_OWNER_EDITION) {
          // Alternate-edition compatibility path. Customer edition is fixed to the
          // tenant-validated staff API below; PIN hashes never reach the renderer.
          const { data, error } = await supabase.from('staff')
            .select('id,name,role,active,earning_rate,financial_start_at,created_at,business_id')
            .order('name');
          if (error) return { data: null, error };
          const rows = (data || []).map((row: any) => ({
            ...row, pin: null, pin_hash: null, has_pin: true, initial_pin_configured: true,
          }));
          return { data: rows, error: null };
        }
        // Customer edition uses the tenant-validated Edge Function; PIN/hash
        // values never leave Postgres.
        // The server-side Edge Function validates the opaque tenant token and
        // returns safe staff fields only; PIN/hash values never leave Postgres.
        const result = await supabase.functions.invoke('propos-staff-api', { body: { action: 'list' } });
        const rawRows = Array.isArray(result.data?.data) ? result.data.data as any[] : null;
        const rows = rawRows?.map((row) => ({
          ...row,
          initial_pin_configured: !(row.initial_pin_configured === false || row.initial_pin_configured === 0 || ['false', 'f', '0'].includes(String(row.initial_pin_configured ?? '').trim().toLowerCase())),
        })) ?? null;
        const error = result.error || result.data?.error && { message: result.data.message || result.data.error, code: result.data.error } || (rows === null ? { message: 'Personel sunucusu beklenen liste biçimini döndürmedi.', code: 'STAFF_API_INVALID_RESPONSE' } : null);
        return { data: rows, error };
      } catch (error) {
        return { data: null, error };
      }
    })().finally(() => { staffFetchInFlight = null; });
  }
  return staffFetchInFlight;
}



export function useStaff() {
  const [staff,setStaff]=useState<Staff[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{
    const desktopMode = typeof window !== 'undefined' && Boolean((window as Window & { proposDesktop?: unknown }).proposDesktop);
    setLoading(true);
    try {
      if (desktopMode && !IS_OWNER_EDITION && typeof navigator !== 'undefined' && !navigator.onLine) {
        setStaff([]);
        setError('NETWORK_UNAVAILABLE: İnternet bağlantısı kapalı. İlk Admin hesabını oluşturmak için uygulamanın önce lisanslı işletmenin personel listesini sunucudan doğrulaması gerekiyor. İnternet bağlantısı geri gelince otomatik yeniden denenecek.');
        return;
      }
      if (IS_OWNER_EDITION && typeof navigator !== 'undefined' && !navigator.onLine) {
        const cached = getLocalStaff().filter(person => person.active);
        if (cached.length) { setStaff(cached); setError(null); return; }
        setStaff([]); setError('Çevrimdışı personel önbelleği bulunamadı. İnternet varken bir kez giriş yapıp senkronize et.'); return;
      }
      const {data,error}=await fetchStaffRows();
      if (!error) {
        // Supabase is authoritative online; only safe staff fields are cached for offline login.
        setStaff((data||[]) as Staff[]); setError(null); saveLocalStaff((data||[]) as Staff[]); return;
      }
      console.error('Personeller yüklenemedi:',error);
      if (IS_OWNER_EDITION && isNetworkFetchFailure(error)) {
        const cached = getLocalStaff().filter(person => person.active);
        if (cached.length) { setStaff(cached); setError(null); return; }
      }
      if (desktopMode && !IS_OWNER_EDITION) { setStaff([]); setError(staffFetchErrorMessage(error, true)); }
      else if (IS_OWNER_EDITION) { setStaff([]); setError(error?.message || 'Personel verileri sunucudan yüklenemedi. Bağlantıyı kontrol edin.'); }
      else if (isMissingStaffTable(error)) { setStaff(getLocalStaff()); setError("Personel tablosu Supabase’de henüz oluşturulmamış. Şimdilik bu cihazda yerel kayıt modu kullanılıyor."); }
      else { setStaff(getLocalStaff()); setError(error.message || 'Personeller yüklenemedi.'); }
    } catch (err) {
      if (IS_OWNER_EDITION && isNetworkFetchFailure(err)) {
        const cached = getLocalStaff().filter(person => person.active);
        if (cached.length) { setStaff(cached); setError(null); return; }
      }
      setStaff(desktopMode || IS_OWNER_EDITION ? [] : getLocalStaff());
      setError(desktopMode && !IS_OWNER_EDITION ? staffFetchErrorMessage(err, true) : (err instanceof Error ? err.message : 'Personeller yüklenemedi.'));
    } finally { setLoading(false); }
  },[]);
  useEffect(()=>{void load()},[load]);
  return {staff,error,loading,reload:load};
}

type FirstAdminResult = { data: Staff | null; error: string | null };
let firstAdminCreationInFlight: Promise<FirstAdminResult> | null = null;

export function createFirstAdmin(name: string, pin: string): Promise<FirstAdminResult> {
  // React StrictMode can mount the bootstrap effect twice in development.
  // Share the same request so both effect runs observe the same single insert.
  if (firstAdminCreationInFlight) return firstAdminCreationInFlight;

  const request = (async (): Promise<FirstAdminResult> => {
    const cleanName = name.trim() || 'Admin';
    const cleanPin = pin.trim();
    if (cleanName.length < 2) return { data: null, error: 'Admin adı en az 2 karakter olmalı.' };
    if (cleanPin.length < 4 || cleanPin.length > 64) return { data: null, error: 'Admin şifresi 4 ile 64 karakter arasında olmalı.' };

    if (IS_OWNER_EDITION) {
      const { data: existing, error: existingError } = await supabase.from('staff').select('id').limit(1);
      if (existingError) return { data: null, error: `Mevcut ProPOS personelleri doğrulanamadı: ${existingError.message}` };
      if ((existing || []).length) return { data: null, error: 'Bu işletmede personel kayıtları zaten var. Yeni Admin oluşturmadan mevcut yönetici hesabıyla giriş yap.' };
      const { data: row, error: insertError } = await supabase.from('staff').insert({
        name: cleanName, role: 'admin', active: true, earning_rate: 5,
      }).select('id,name,role,active,earning_rate,financial_start_at,created_at,business_id').single();
      if (insertError || !row) return { data: null, error: insertError?.message || 'İlk yönetici Supabase üzerinde oluşturulamadı.' };
      const { data: pinSaved, error: pinError } = await supabase.rpc('set_staff_pin', { p_staff_id: row.id, p_pin: cleanPin });
      if (pinError || pinSaved !== true) {
        await supabase.from('staff').delete().eq('id', row.id);
        return { data: null, error: pinError?.message || 'Admin PIN’i güvenli şekilde kaydedilemedi.' };
      }
      const ownerAdmin: Staff = { ...row, pin: null, pin_hash: null, has_pin: true, initial_pin_configured: true } as Staff;
      saveLocalStaff([...(getLocalStaff().filter(person => person.id !== ownerAdmin.id)), ownerAdmin]);
      return { data: ownerAdmin, error: null };
    }

    const { data: response, error } = await supabase.functions.invoke('propos-staff-api', {
      body: { action: 'bootstrap_admin', name: cleanName, pin: cleanPin, earning_rate: IS_OWNER_EDITION ? 5 : 0 },
    });
    const row = response?.data;
    if (error || !row || typeof row.id !== 'string') {
      return { data: null, error: error?.message || 'İlk Admin güvenli biçimde oluşturulamadı.' };
    }

    const staffRow: Staff = {
      id: row.id,
      name: String(row.name || cleanName),
      pin: null,
      pin_hash: null,
      has_pin: true,
      initial_pin_configured: true,
      business_id: row.business_id || undefined,
      role: 'admin',
      active: true,
      earning_rate: Number(row.earning_rate ?? (IS_OWNER_EDITION ? 5 : 0)),
      financial_start_at: row.financial_start_at || row.created_at,
      created_at: row.created_at || new Date().toISOString(),
    };
    saveLocalStaff([...getLocalStaff().filter((person) => person.id !== staffRow.id), staffRow]);
    return { data: staffRow, error: null };
  })();

  firstAdminCreationInFlight = request;
  void request.finally(() => {
    if (firstAdminCreationInFlight === request) firstAdminCreationInFlight = null;
  }).catch(() => {});
  return request;
}

function currentStaffActorId(): string | null {
  try {
    const raw = sessionStorage.getItem('propos-current-staff-v2');
    const parsed = raw ? JSON.parse(raw) as { id?: unknown } : null;
    return typeof parsed?.id === 'string' ? parsed.id : null;
  } catch { return null; }
}

export async function setStaffPassword(id: string, pin: string): Promise<{ success: boolean; error?: string }> {
  const cleanPin = pin.trim();
  if (cleanPin.length < 4 || cleanPin.length > 64) return { success: false, error: 'Şifre 4 ile 64 karakter arasında olmalı.' };
  const actorId = currentStaffActorId();
  if (!actorId) return { success: false, error: 'Aktif Admin oturumu bulunamadı. Yeniden giriş yapın.' };
  if (IS_OWNER_EDITION) {
    const { data, error } = await supabase.rpc('set_staff_pin', { p_staff_id: id, p_pin: cleanPin });
    if (error || data !== true) return { success: false, error: error?.message || 'PIN Supabase üzerinde değiştirilemedi.' };
    saveLocalStaff(getLocalStaff().map(person => person.id === id ? { ...person, pin: null, pin_hash: null, has_pin: true } : person));
    await writeAudit('staff_pin_changed', 'staff', id, { pin_changed: true });
    return { success: true };
  }
  const { data: response, error } = await supabase.functions.invoke('propos-staff-api', {
    body: { action: 'set_pin', staff_id: id, pin: cleanPin, actor_staff_id: actorId },
  });
  if (error || response?.success !== true) return { success: false, error: error?.message || response?.message || 'Şifre değiştirilemedi.' };
  saveLocalStaff(getLocalStaff().map(person => person.id === id ? { ...person, pin: null, pin_hash: null, has_pin: true } : person));
  await writeAudit('staff_pin_changed', 'staff', id, { pin_changed: true });
  return { success: true };
}

export async function addStaff(name:string,pin?:string,role:Staff['role']='cashier',earningRate:number=0){
  const clean=name.trim();
  const cleanPin=pin?.trim() || '';
  const actorId=currentStaffActorId();
  if(clean.length < 2) return {data:null,error:'Ad Soyad en az 2 karakter olmalı.' as string};
  if(cleanPin.length < 4 || cleanPin.length > 64) return {data:null,error:'PIN / Şifre 4 ile 64 karakter arasında olmalı.' as string};
  if(!actorId) return {data:null,error:'Aktif Admin oturumu bulunamadı. Yeniden giriş yapın.' as string};
  const safeRate = Number.isFinite(earningRate) ? Math.max(0, Math.min(100, earningRate)) : 0;
  if (IS_OWNER_EDITION) {
    const { data: row, error: insertError } = await supabase.from('staff').insert({ name: clean, role, active: true, earning_rate: safeRate })
      .select('id,name,role,active,earning_rate,financial_start_at,created_at,business_id').single();
    if (insertError || !row) return { data: null, error: insertError?.message || 'Personel Supabase üzerinde oluşturulamadı.' as string };
    const { data: pinSaved, error: pinError } = await supabase.rpc('set_staff_pin', { p_staff_id: row.id, p_pin: cleanPin });
    if (pinError || pinSaved !== true) {
      await supabase.from('staff').delete().eq('id', row.id);
      return { data: null, error: pinError?.message || 'Personel PIN’i kaydedilemedi.' as string };
    }
    const staffRow: Staff = { ...row, pin: null, pin_hash: null, has_pin: true, initial_pin_configured: true } as Staff;
    await writeAudit('staff_created', 'staff', staffRow.id, { name: clean, role, earning_rate: safeRate });
    saveLocalStaff([...getLocalStaff().filter(person => person.id !== staffRow.id), staffRow]);
    return { data: staffRow, error: null };
  }
  const {data:response,error}=await supabase.functions.invoke('propos-staff-api',{
    body:{action:'add_staff',name:clean,pin:cleanPin,role,
      earning_rate:Number.isFinite(earningRate)?Math.max(0,Math.min(100,earningRate)):0,
      actor_staff_id:actorId},
  });
  const row=response?.data;
  if(!error && row && typeof row.id === 'string'){
    const staffRow:Staff={...row,pin:null,pin_hash:null,has_pin:true} as Staff;
    await writeAudit('staff_created','staff',staffRow.id,{name:clean,role,earning_rate:earningRate});
    saveLocalStaff([...getLocalStaff().filter(x=>x.id!==staffRow.id),staffRow]);
    return {data:staffRow,error:null};
  }
  console.error('Personel eklenemedi:',error);
  return {data:null,error:error?.message||'Personel eklenemedi.' as string};
}

export async function updateStaff(id:string, patch:Partial<Staff>){
  const actorId=currentStaffActorId();
  if(!actorId) return false;
  if (IS_OWNER_EDITION) {
    const allowed: Partial<Pick<Staff, 'name'|'role'|'active'|'earning_rate'>> = {};
    if (typeof patch.name === 'string') allowed.name = patch.name.trim();
    if (patch.role) allowed.role = patch.role;
    if (typeof patch.active === 'boolean') allowed.active = patch.active;
    if (typeof patch.earning_rate === 'number') allowed.earning_rate = Math.max(0, Math.min(100, patch.earning_rate));
    const { data, error } = await supabase.from('staff').update(allowed).eq('id', id).select('id').maybeSingle();
    if (error || !data) { console.error('Personel güncellenemedi:', error); return false; }
    saveLocalStaff(getLocalStaff().map(person => person.id === id ? { ...person, ...allowed } : person));
    await writeAudit('staff_updated', 'staff', id, { fields: Object.keys(allowed) });
    return true;
  }
  const {data:response,error}=await supabase.functions.invoke('propos-staff-api',{
    body:{action:'update_staff',staff_id:id,
      name:typeof patch.name==='string'?patch.name:null,
      role:patch.role || null,
      active:typeof patch.active==='boolean'?patch.active:null,
      earning_rate:typeof patch.earning_rate==='number'?patch.earning_rate:null,
      actor_staff_id:actorId},
  });
  if (!error && response?.success===true) { saveLocalStaff(getLocalStaff().map(x=>x.id===id?{...x,...patch}:x)); await writeAudit('staff_updated','staff',id,{fields:Object.keys(patch)}); return true; }
  console.error('Personel güncellenemedi:',error);
  return false;
}

export async function deleteStaff(id:string){
  const actorId=currentStaffActorId();
  if(!actorId) return false;
  if (IS_OWNER_EDITION) {
    // Disable rather than hard-delete so historical sales and earning ledgers
    // keep their original staff reference.
    const { data, error } = await supabase.from('staff').update({ active: false }).eq('id', id).select('id').maybeSingle();
    if (error || !data) { console.error('Personel devre dışı bırakılamadı:', error); return false; }
    saveLocalStaff(getLocalStaff().map(person => person.id === id ? { ...person, active: false } : person));
    await writeAudit('staff_deleted', 'staff', id, { soft_delete: true });
    return true;
  }
  const {data:response,error}=await supabase.functions.invoke('propos-staff-api',{body:{action:'delete_staff',staff_id:id,actor_staff_id:actorId}});
  if(!error && response?.success===true){ saveLocalStaff(getLocalStaff().filter(x=>x.id!==id)); await writeAudit('staff_deleted','staff',id); return true; }
  console.error('Personel silinemedi:',error);
  return false;
}

export type StaffConsumptionInput = {
  productId: string;
  quantity: number;
  staffId: string;
  type: 'personal' | 'gift';
  note?: string;
};

export async function recordStaffConsumption(input: StaffConsumptionInput): Promise<{ success: boolean; id?: string; error?: string }> {
  const quantity = Number(input.quantity);
  if (!input.productId || !input.staffId || !Number.isFinite(quantity) || quantity <= 0) {
    return { success: false, error: 'Geçerli ürün, personel ve adet gerekli.' };
  }
  const { data, error } = await supabase.rpc('record_staff_consumption', {
    p_product_id: input.productId,
    p_quantity: quantity,
    p_staff_id: input.staffId,
    p_consumption_type: input.type,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Personel tüketimi kaydedilemedi:', error);
    return { success: false, error: error.message || 'İşlem kaydedilemedi.' };
  }
  return { success: true, id: String(data) };
}


export type StaffConsumptionBatchItem = { productId: string; quantity: number };

export async function recordStaffConsumptionBatch(input: {
  items: StaffConsumptionBatchItem[];
  staffId: string;
  type: 'personal' | 'gift';
  note?: string;
}): Promise<{ success: boolean; error?: string; rows?: StaffConsumption[] }> {
  if (!input.staffId || !input.items.length) {
    return { success: false, error: 'En az bir ürün ve aktif personel gerekli.' };
  }
  const payloadItems = input.items.map((item) => ({ productId: item.productId, quantity: Number(item.quantity) }));
  const { data, error } = await supabase.rpc('record_staff_consumption_batch', {
    p_staff_id: input.staffId,
    p_consumption_type: input.type,
    p_items: payloadItems,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Toplu personel tüketimi kaydedilemedi:', error);
    return { success: false, error: error.message || 'İşlem kaydedilemedi.' };
  }
  await writeAudit('staff_consumption','staff',input.staffId,{consumption_type:input.type,item_count:input.items.length,note:input.note||null});
  const rows = Array.isArray((data as any)?.rows) ? (data as any).rows as StaffConsumption[] : [];
  return { success: true, rows };
}

export function useStaffConsumptions(staffId?: string, days = 31, startDate?: string, endDate?: string) {
  const [rows, setRows] = useState<StaffConsumption[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('staff_consumptions').select('*').order('created_at', { ascending: false });
    if (startDate && endDate) {
      const start = new Date(`${startDate}T00:00:00`).toISOString();
      const end = new Date(`${endDate}T23:59:59.999`).toISOString();
      query = query.gte('created_at', start).lte('created_at', end);
    } else if (days <= 0) {
      // An incomplete custom date range must not silently show the last 31 days.
      query = query.lt('created_at', new Date(0).toISOString());
    } else {
      const since = new Date(Date.now() - days * 86400000).toISOString();
      query = query.gte('created_at', since);
    }
    if (staffId) query = query.eq('staff_id', staffId);
    const { data, error } = await query;
    if (error) console.error('Personel tüketimleri yüklenemedi:', error);
    setRows((data || []) as StaffConsumption[]);
    setLoading(false);
  }, [staffId, days, startDate, endDate]);
  useEffect(() => { load(); }, [load]);
  return { rows, loading, reload: load };
}


export type StaffFinancialSummary = {
  financial_start_at: string | null;
  total_earnings: number;
  total_collected: number;
  personal_consumption: number;
  total_payouts: number;
  available_balance: number;
};

export async function recordStaffPayout(staffId: string, amount: number, note?: string): Promise<{ success: boolean; error?: string; id?: string; amount?: number; available_balance_after?: number }> {
  const value = Number(amount);
  if (!staffId || !Number.isFinite(value) || value <= 0) {
    return { success: false, error: 'Geçerli bir personel ve tutar girin.' };
  }
  const { data, error } = await supabase.rpc('record_staff_payout', {
    p_staff_id: staffId,
    p_amount: value,
    p_note: note?.trim() || null,
  });
  if (error) {
    console.error('Personel kazanç ödemesi kaydedilemedi:', error);
    return { success: false, error: error.message || 'Kazanç ödemesi kaydedilemedi.' };
  }
  const payload = (data || {}) as { id?: string; amount?: number; available_balance_after?: number };
  await writeAudit('staff_payout','staff',staffId,{amount:value,note:note||null,available_balance_after:Number(payload.available_balance_after||0)});
  return {
    success: true,
    id: payload.id,
    amount: Number(payload.amount || value),
    available_balance_after: Number(payload.available_balance_after || 0),
  };
}

export function useStaffFinancialSummary(staffId?: string, financialStartAt?: string) {
  const [summary, setSummary] = useState<StaffFinancialSummary>({ financial_start_at: null, total_earnings: 0, total_collected: 0, personal_consumption: 0, total_payouts: 0, available_balance: 0 });
  const [payouts, setPayouts] = useState<StaffPayout[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!staffId) {
      setSummary({ financial_start_at: null, total_earnings: 0, total_collected: 0, personal_consumption: 0, total_payouts: 0, available_balance: 0 });
      setPayouts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [{ data: summaryData, error: summaryError }, { data: payoutData, error: payoutError }] = await Promise.all([
      supabase.rpc('get_staff_financial_summary', { p_staff_id: staffId }),
      (() => {
        let q = supabase.from('staff_payouts').select('*').eq('staff_id', staffId).order('created_at', { ascending: false }).limit(50);
        if (financialStartAt) q = q.gte('created_at', financialStartAt);
        return q;
      })(),
    ]);
    if (summaryError) console.error('Personel bakiye özeti yüklenemedi:', summaryError);
    if (payoutError) console.error('Personel kazanç ödemeleri yüklenemedi:', payoutError);
    const next = (summaryData || {}) as Partial<StaffFinancialSummary>;
    setSummary({
      financial_start_at: next.financial_start_at ? String(next.financial_start_at) : (financialStartAt || null),
      total_earnings: Number(next.total_earnings || 0),
      total_collected: Number(next.total_collected || 0),
      personal_consumption: Number(next.personal_consumption || 0),
      total_payouts: Number(next.total_payouts || 0),
      available_balance: Number(next.available_balance || 0),
    });
    setPayouts((payoutData || []) as StaffPayout[]);
    setLoading(false);
  }, [staffId, financialStartAt]);

  useEffect(() => { load(); }, [load]);
  return { summary, payouts, loading, reload: load };
}

export function useStaffEarnings(staffId?: string, days = 31) {
  const [earnings, setEarnings] = useState<StaffEarning[]>([]);
  const [daily, setDaily] = useState<Array<{ earning_date:string; earning_amount:number; amount_paid:number; payment_count:number }>>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!staffId) { setEarnings([]); setDaily([]); setLoading(false); return; }
    setLoading(true);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [{ data, error }, { data: dailyData, error: dailyError }] = await Promise.all([
      supabase.from('staff_earnings').select('id,staff_id,customer_payment_id,amount_paid,rate_percent,earning_amount,source,created_at,reversed_at').eq('staff_id', staffId).is('reversed_at', null).gte('created_at', since).order('created_at', { ascending: false }).limit(600),
      supabase.from('staff_daily_earnings').select('earning_date,earning_amount,amount_paid,payment_count').eq('staff_id', staffId).gte('earning_date', new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0,10)).order('earning_date', { ascending: false }),
    ]);
    if (error) console.error('Personel kazançları yüklenemedi:', error);
    if (dailyError) console.error('Günlük personel kazançları yüklenemedi:', dailyError);
    setEarnings((data || []) as StaffEarning[]);
    setDaily((dailyData || []) as any);
    setLoading(false);
  }, [staffId, days]);
  useEffect(() => { load(); }, [load]);
  return { earnings, daily, loading, reload: load };
}

const OFFLINE_QUEUE_KEY='propos-offline-sales-v2';
const offlineQueueStorageKey = () => tenantScopedOfflineKey(OFFLINE_QUEUE_KEY);
export type OfflineSalePayload = {
  queue_id: string; items: CartItem[]; paymentMethod: Sale['payment_method']; paidAmount: number;
  customerName?: string; customerId?: string; paymentSplits?: PaymentSplit[];
  staff_id?: string | null; staff_name?: string | null; queued_at: string;
  blocked?: boolean; sync_error?: string;
};
export function getOfflineSales(): OfflineSalePayload[]{
  try { const raw=JSON.parse(localStorage.getItem(offlineQueueStorageKey())||'[]'); return Array.isArray(raw)?raw:[]; } catch { return []; }
}
export function queueOfflineSale(payload: Omit<OfflineSalePayload,'queue_id'|'queued_at'>, requestId?: string): boolean {
  try {
    const q=getOfflineSales();
    const queueId = requestId || crypto.randomUUID();
    // Retrying after a lost network response must reuse the same idempotency key.
    if (q.some(item => item.queue_id === queueId)) return true;

    const cached = getOfflineProducts();
    if (!cached.length) { console.error('Çevrimdışı ürün önbelleği boş.'); return false; }
    const soldByProduct = new Map<string, number>();
    for (const item of payload.items) {
      const productId = String(item.product?.id || '');
      const quantity = Number(item.quantity || 0);
      if (!productId || !Number.isFinite(quantity) || quantity <= 0) return false;
      soldByProduct.set(productId, (soldByProduct.get(productId) || 0) + quantity);
    }
    for (const [productId, sold] of soldByProduct) {
      const product = cached.find(row => row.id === productId);
      if (!product) { console.error('Ürün çevrimdışı önbellekte bulunamadı:', productId); return false; }
      if (!product.unlimited_stock && Number(product.stock || 0) < sold) {
        console.error('Çevrimdışı satış için yetersiz önbellek stoğu:', product.name, product.stock, sold);
        return false;
      }
    }
    if (payload.paymentMethod === 'credit' && (!payload.customerId || !getOfflineCustomers().some(customer => customer.id === payload.customerId))) return false;
    if (payload.paymentMethod === 'split') {
      for (const split of payload.paymentSplits || []) {
        if (split.method === 'credit' && !(split.customerId || payload.customerId)) return false;
        const linkedCustomer = split.customerId || payload.customerId;
        if (split.method === 'credit' && linkedCustomer && !getOfflineCustomers().some(customer => customer.id === linkedCustomer)) return false;
      }
    }

    let sessionStaff: { id?: string; name?: string } | null = null;
    try { sessionStaff = JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null'); } catch {}
    const entry: OfflineSalePayload = {
      ...payload,
      // Keep the employee who started this checkout even if another employee logs in before sync.
      staff_id: payload.staff_id ?? sessionStaff?.id ?? null,
      staff_name: payload.staff_name ?? sessionStaff?.name ?? null,
      queue_id: queueId,
      queued_at: new Date().toISOString(),
    };
    // Write the durable queue before changing cached stock; a failed queue write must not reserve inventory.
    localStorage.setItem(offlineQueueStorageKey(), JSON.stringify([...q, entry]));

    const next = cached.map(product => {
      if (product.unlimited_stock) return product;
      const sold = soldByProduct.get(product.id) || 0;
      return sold > 0 ? { ...product, stock: Number(product.stock || 0) - sold } : product;
    });
    writeOfflineCache(OFFLINE_PRODUCTS_KEY, next);

    // Reflect queued credit in the local customer list so repeated offline sales
    // do not display a stale debt balance. Sync will refresh from Supabase later.
    const creditByCustomer = new Map<string, number>();
    if (payload.paymentMethod === 'credit' && payload.customerId) {
      const total = payload.items.reduce((sum, item) => sum + Number(item.fixedUnitPrice ?? item.product.price) * Number(item.quantity), 0);
      creditByCustomer.set(payload.customerId, total);
    } else if (payload.paymentMethod === 'split') {
      for (const split of payload.paymentSplits || []) {
        const creditCustomerId = split.customerId || payload.customerId;
        if (split.method === 'credit' && creditCustomerId) creditByCustomer.set(creditCustomerId, (creditByCustomer.get(creditCustomerId) || 0) + Number(split.amount || 0));
      }
    }
    if (creditByCustomer.size) {
      const cachedCustomers = getOfflineCustomers().map(customer => {
        const debt = creditByCustomer.get(customer.id) || 0;
        return debt > 0 ? { ...customer, balance: Number(customer.balance || 0) + debt } : customer;
      });
      writeOfflineCache(OFFLINE_CUSTOMERS_KEY, cachedCustomers);
    }
    notifyOfflineSync();
    return true;
  } catch (error) {
    console.error('Offline satış kuyruğa alınamadı:', error);
    return false;
  }
}
let offlineSalesSyncInFlight: Promise<{ synced: number; failed: number }> | null = null;
export function syncOfflineSales(): Promise<{ synced: number; failed: number }> {
  if (!navigator.onLine) return Promise.resolve({ synced: 0, failed: getOfflineSales().length });
  if (offlineSalesSyncInFlight) return offlineSalesSyncInFlight;
  offlineSalesSyncInFlight = (async () => {
    const q = getOfflineSales();
    let synced = 0;
    const remain: OfflineSalePayload[] = [];
    for (let index = 0; index < q.length; index++) {
      const x = q[index];
      if (x.blocked) { remain.push(x); continue; }
      try {
        const sale = await completeSale(
          x.items,
          x.paymentMethod,
          x.paidAmount,
          x.customerName,
          x.customerId,
          x.paymentSplits,
          x.queue_id,
          { id: x.staff_id || undefined, name: x.staff_name || undefined, offlineSync: true }
        );
        if (sale) synced++; else remain.push(x);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String((error as any)?.message || error || 'Bilinmeyen senkronizasyon hatası');
        console.error('Offline satış senkronizasyonu başarısız:', x.queue_id, error);
        const isNetworkFailure = !navigator.onLine || /failed to fetch|err_internet_disconnected|networkerror|load failed|fetch failed|network request failed|timeout|connection reset|econn/i.test(detail);
        const isPermanentBusinessError = /yetersiz stok|müşteri bu işletmede bulunamadı|karma ödeme toplamı|geçersiz satış|sepette|ürün bu işletmede bulunamadı|müşteri gerekli/i.test(detail);
        if (isPermanentBusinessError) {
          remain.push({ ...x, blocked: true, sync_error: detail });
        } else {
          remain.push(x);
        }
        // Don't fire one failed cloud request per queued sale during an outage.
        // Keep the untouched tail queued and retry when connectivity recovers.
        if (isNetworkFailure) {
          remain.push(...q.slice(index + 1));
          break;
        }
      }
    }
    localStorage.setItem(offlineQueueStorageKey(), JSON.stringify(remain));
    notifyOfflineSync();
    return { synced, failed: remain.length };
  })().finally(() => { offlineSalesSyncInFlight = null; });
  return offlineSalesSyncInFlight;
}

export async function retryBlockedOfflineSales() {
  const q = getOfflineSales();
  const reset = q.map(item => item.blocked ? { ...item, blocked: false, sync_error: undefined } : item);
  localStorage.setItem(offlineQueueStorageKey(), JSON.stringify(reset));
  notifyOfflineSync();
  return syncOfflineSales();
}

export function useSales(limit = 50) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const target = Math.max(1, Number(limit || 50));
    const pageSize = Math.min(1000, target);
    const chunks: Sale[] = [];
    let offset = 0;
    let lastError: any = null;
    while (chunks.length < target) {
      let result = await supabase
        .from('sales')
        .select('*')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (result.error && /deleted_at|schema cache|column/i.test(result.error.message || '')) {
        result = await supabase
          .from('sales')
          .select('*')
          .order('created_at', { ascending: false })
          .range(offset, offset + pageSize - 1);
      }
      if (result.error) { lastError = result.error; break; }
      const rows = (result.data || []) as Sale[];
      chunks.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
    }
    if (lastError) console.error('Satışlar yüklenemedi:', lastError);
    setSales(chunks.slice(0, target));
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('sales-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sales, loading, reload: load };
}

export type StoreSettings = {
  storeName: string; storeAddress: string; storePhone: string; currency: string;
  receiptFooter: string; taxRate: string; lowStockDefault: string; trashRetentionDays?: string;
};

export async function loadStoreSettings(defaults: StoreSettings): Promise<StoreSettings> {
  try {
    const { data } = await supabase.from('store_settings').select('settings').limit(1).maybeSingle();
    if (data?.settings && typeof data.settings === 'object') return { ...defaults, ...(data.settings as Partial<StoreSettings>) };
  } catch {}
  return defaults;
}

export async function saveStoreSettings(settings: StoreSettings): Promise<boolean> {
  try {
    const { data } = await supabase.rpc('get_default_business_id');
    const businessId = data as string | null;
    if (!businessId) return false;
    const { error } = await supabase.from('store_settings').upsert({ business_id: businessId, settings, updated_at: new Date().toISOString() }, { onConflict: 'business_id' });
    return !error;
  } catch { return false; }
}

// ===== Müşteriler =====

export function useCustomers() {
  const [customers, setCustomers] = useState<Customer[]>(() => getOfflineCustomers());
  const [loading, setLoading] = useState(() => getOfflineCustomers().length === 0);
  const requestSequence = useRef(0);
  const hasInitialData = useRef(getOfflineCustomers().length > 0);

  const load = useCallback(async (showInitialLoading = true) => {
    const requestId = ++requestSequence.current;
    const cached = getOfflineCustomers();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (requestId === requestSequence.current) {
        setCustomers(cached);
        setLoading(false);
        hasInitialData.current = cached.length > 0;
      }
      return;
    }
    if (showInitialLoading && !hasInitialData.current && cached.length === 0) setLoading(true);
    try {
      const { data, error } = await supabase
        .from('customers')
        .select('*')
        .order('name', { ascending: true });
      if (requestId !== requestSequence.current) return;
      if (error) {
        console.error('Müşteriler yüklenemedi:', error);
        if (cached.length) setCustomers(cached);
      } else {
        const rows = data || [];
        setCustomers(rows);
        writeOfflineCache(OFFLINE_CUSTOMERS_KEY, rows);
        hasInitialData.current = true;
      }
    } catch (error) {
      if (requestId === requestSequence.current) {
        console.error('Müşteriler yüklenirken bağlantı hatası:', error);
        if (cached.length) setCustomers(cached);
      }
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
    let refreshTimer: number | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { refreshTimer = undefined; void load(false); }, 250);
    };
    const onConnectivity = () => { void load(true); };
    const onSync = () => { if (navigator.onLine) scheduleRefresh(); else { setCustomers(getOfflineCustomers()); setLoading(false); } };
    const channel = supabase
      .channel('customers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, scheduleRefresh)
      .subscribe();
    window.addEventListener('online', onConnectivity);
    window.addEventListener('offline', onConnectivity);
    window.addEventListener(OFFLINE_SYNC_EVENT, onSync);
    return () => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      supabase.removeChannel(channel);
      window.removeEventListener('online', onConnectivity);
      window.removeEventListener('offline', onConnectivity);
      window.removeEventListener(OFFLINE_SYNC_EVENT, onSync);
    };
  }, [load]);

  return { customers, loading, reload: () => load(true) };
}

export async function addCustomer(name: string, phone?: string): Promise<Customer | null> {
  const cleanName = name.trim();
  const cleanPhone = phone?.trim() || null;
  if (!cleanName) return null;

  try {
    // Resolve the active business explicitly. This avoids relying on a DB
    // DEFAULT and makes desktop/licensed installations deterministic.
    const { data: businessId, error: businessError } = await supabase.rpc('get_default_business_id');
    if (businessError || !businessId) {
      console.error('Müşteri eklenemedi: aktif işletme bulunamadı.', businessError);
      return null;
    }

    const { data, error } = await supabase
      .from('customers')
      .insert({ name: cleanName, phone: cleanPhone, balance: 0, business_id: businessId as string })
      .select('*')
      .single();
    if (error || !data) {
      console.error('Müşteri eklenemedi:', error);
      return null;
    }
    try { await writeAudit('customer_created', 'customer', data.id, { name: data.name, phone: data.phone }); } catch (auditError) {
      console.warn('Müşteri kaydedildi fakat işlem günlüğü yazılamadı:', auditError);
    }
    writeOfflineCache(OFFLINE_CUSTOMERS_KEY, [data as Customer, ...getOfflineCustomers().filter(c => c.id !== data.id)]);
    return data as Customer;
  } catch (error) {
    console.error('Müşteri ekleme beklenmeyen hata:', error);
    return null;
  }
}

export async function updateCustomer(id: string, name: string, phone?: string): Promise<boolean> {
  const { error } = await supabase
    .from('customers')
    .update({ name: name.trim(), phone: phone?.trim() || null })
    .eq('id', id);
  if (error) {
    console.error('Müşteri güncellenemedi:', error);
    return false;
  }
  await writeAudit('customer_updated', 'customer', id, { name: name.trim(), phone: phone?.trim() || null });
  return true;
}

export async function deleteCustomer(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('customers')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('Müşteri silinemedi:', error);
    return false;
  }
  await writeAudit('customer_deleted', 'customer', id);
  return true;
}

export async function payCustomerDebt(id: string, amount: number, note?: string, staffId?: string): Promise<{ success: boolean; amount: number }> {
  if (!Number.isFinite(amount) || amount <= 0) return { success: false, amount: 0 };

  const { data, error } = await supabase.rpc('pay_customer_debt', {
    p_customer_id: id,
    p_amount: amount,
    p_note: note?.trim() || null,
    p_staff_id: staffId || null,
  });

  const rpcPaid = data == null ? NaN : Number(data);
  if (!error && Number.isFinite(rpcPaid)) {
    if (rpcPaid > 0) await writeAudit('customer_payment', 'customer', id, { amount: rpcPaid, note: note?.trim() || null });
    return { success: rpcPaid > 0, amount: rpcPaid };
  }

  // Local SQLite RPC executes the whole collection in one transaction. Never
  // replay a failed local collection as independent balance/payment mutations.
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel veresiye tahsilatı başarısız; parçalı fallback çalıştırılmadı:', error);
    return { success: false, amount: 0 };
  }
  // Yeni migration henüz uygulanmadıysa eski şema ile güvenli geri dönüş.
  const { data: cust } = await supabase.from('customers').select('balance').eq('id', id).maybeSingle();
  if (!cust) return { success: false, amount: 0 };
  const payment = Math.min(Number(cust.balance || 0), amount);
  if (payment <= 0) return { success: false, amount: 0 };

  const { error: updateError } = await supabase.from('customers').update({
    balance: Number(cust.balance || 0) - payment,
  }).eq('id', id);
  if (updateError) {
    console.error('Borç ödemesi yapılamadı:', updateError);
    return { success: false, amount: 0 };
  }

  try {
    const { data: insertedPayment } = await supabase.from('customer_payments').insert({ customer_id: id, amount: payment, note: note?.trim() || null, staff_id: staffId || null }).select().single();
    if (IS_OWNER_EDITION && staffId && insertedPayment) {
      const { data: staffRows } = await fetchStaffRows();
      const staffRow = (staffRows as Staff[] | null)?.find(row => row.id === staffId && row.active);
      const rate = Math.max(0, Math.min(100, Number(staffRow?.earning_rate || 0)));
      if (rate > 0) await supabase.from('staff_earnings').insert({ staff_id: staffId, customer_payment_id: insertedPayment.id, amount_paid: payment, rate_percent: rate, earning_amount: +(payment * rate / 100).toFixed(2), source: 'customer_payment' });
    }
  } catch {
    // Eski veritabanında ödeme tablosu yoksa bakiye yine güncellenmiş olur.
  }
  // Migration henüz uygulanmadıysa da mümkünse kapanan açık veresiye kayıtlarını işaretle.
  if (Number(cust.balance || 0) - payment <= 0.01) {
    const { data: customerRow } = await supabase.from('customers').select('name').eq('id', id).maybeSingle();
    let settleQuery = supabase.from('sales').update({ settled_at: new Date().toISOString() }).is('settled_at', null).in('payment_method', ['credit','split']);
    if (customerRow?.name) {
      settleQuery = settleQuery.or(`customer_id.eq.${id},and(customer_id.is.null,customer_name.eq.${customerRow.name.replace(/,/g, '')})`);
    } else {
      settleQuery = settleQuery.eq('customer_id', id);
    }
    await settleQuery;
  }
  await writeAudit('customer_payment', 'customer', id, { amount: payment, note: note?.trim() || null });
  return { success: true, amount: payment };
}

export async function recordCustomerCashLoan(customerId: string, amount: number, note?: string, staffId?: string): Promise<{ success: boolean; id?: string; error?: string }> {
  if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: 'Borç tutarı sıfırdan büyük olmalı.' };
  const { data, error } = await supabase.rpc('record_customer_cash_loan', { p_customer_id: customerId, p_amount: +amount.toFixed(2), p_note: note?.trim() || null, p_staff_id: staffId || null });
  if (error || !data) {
    console.error('Müşteriye borç para verilemedi:', error);
    return { success: false, error: error?.message || 'Borç verme işlemi kaydedilemedi.' };
  }
  await writeAudit('customer_cash_loan', 'customer', customerId, { amount: +amount.toFixed(2), note: note?.trim() || null, adjustmentId: String(data) });
  return { success: true, id: String(data) };
}

export async function cancelCustomerCashLoan(adjustmentId: string, reason?: string, staffId?: string): Promise<{ success: boolean; error?: string }> {
  const { data, error } = await supabase.rpc('cancel_customer_cash_loan', { p_adjustment_id: adjustmentId, p_reason: reason?.trim() || 'Borç verme işlemi geri alındı', p_staff_id: staffId || null });
  if (error || data !== true) {
    console.error('Borç para verme geri alınamadı:', error);
    return { success: false, error: error?.message || 'Borç verme işlemi geri alınamadı. Müşteri bakiyesini kontrol edin.' };
  }
  await writeAudit('customer_cash_loan_reversed', 'customer_debt_adjustment', adjustmentId, { reason: reason || null });
  return { success: true };
}

export async function reverseCustomerPayment(paymentId: string, reason?: string, staffId?: string): Promise<{ success: boolean; amount?: number; error?: string }> {
  const { data, error } = await supabase.rpc('reverse_customer_payment', { p_payment_id: paymentId, p_reason: reason?.trim() || 'Tahsilat geri alındı', p_staff_id: staffId || null });
  if (error || !data || data.success !== true) {
    console.error('Tahsilat geri alınamadı:', error || data);
    return { success: false, error: error?.message || data?.error || 'Tahsilat geri alınamadı.' };
  }
  await writeAudit('customer_payment_reversed', 'customer_payment', paymentId, { amount: Number(data.amount || 0), customer_id: data.customer_id, reason: reason || null });
  return { success: true, amount: Number(data.amount || 0) };
}

export function useCustomerDebtHistory(customerId: string | null) {
  const [sales, setSales] = useState<SaleWithItems[]>([]);
  const [archiveSales, setArchiveSales] = useState<SaleWithItems[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [loanAdjustments, setLoanAdjustments] = useState<any[]>([]);
  const [salePayments, setSalePayments] = useState<SalePayment[]>([]);
  const [staffNames, setStaffNames] = useState<Record<string, string>>({});
  const [currentBalance, setCurrentBalance] = useState<number | null>(null);
  const [customerName, setCustomerName] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!customerId) {
      setSales([]); setArchiveSales([]); setPayments([]); setLoanAdjustments([]); setSalePayments([]); setStaffNames({}); setCurrentBalance(null); setCustomerName('');
      return;
    }

    setLoading(true);
    const customerResult = await supabase
      .from('customers')
      .select('name,balance')
      .eq('id', customerId)
      .maybeSingle();

    const name = customerResult.data?.name || '';
    setCustomerName(name);

    async function fetchAllSaleRows() {
      let primary = await supabase
        .from('sales')
        .select('*, sale_items(*)')
        .eq('customer_id', customerId)
        .in('payment_method', ['credit','split'])
        .order('created_at', { ascending: false })
        .limit(1000);

      if (primary.error && /deleted_at|settled_at|schema cache|column/i.test(primary.error.message || '')) {
        primary = await supabase
          .from('sales')
          .select('*, sale_items(*)')
          .eq('customer_id', customerId)
          .in('payment_method', ['credit','split'])
          .order('created_at', { ascending: false })
          .limit(1000);
      }

      let rows = (primary.data || []) as SaleWithItems[];
      // Eski sürümlerde customer_id yazılmadan yalnızca müşteri adı kaydedilmiş olabilir.
      if (name) {
        const legacy = await supabase
          .from('sales')
          .select('*, sale_items(*)')
          .eq('customer_name', name)
          .in('payment_method', ['credit','split'])
          .order('created_at', { ascending: false })
          .limit(1000);
        if (!legacy.error) {
          const merged = [...rows, ...((legacy.data || []) as SaleWithItems[])];
          const seen = new Set<string>();
          rows = merged.filter((x) => !seen.has(x.id) && seen.add(x.id));
        }
      }
      rows.sort((a:any,b:any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return rows;
    }

    const [allSaleRows, paymentResult, loanResult] = await Promise.all([
      fetchAllSaleRows(),
      supabase.from('customer_payments').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1000),
      supabase.from('customer_debt_adjustments').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }).limit(1000),
    ]);
    const activeSales = allSaleRows.filter((sale: any) => sale.settled_at == null);
    const settledSales = allSaleRows.filter((sale: any) => sale.settled_at != null);
    const allSales = allSaleRows;

    const saleIds = allSales.map((sale) => sale.id);
    let salePaymentRows: SalePayment[] = [];
    let returnRows: any[] = [];
    if (saleIds.length) {
      const [paymentQuery, returnQuery] = await Promise.all([
        supabase.from('sale_payments').select('*').in('sale_id', saleIds).order('created_at', { ascending: true }),
        supabase.from('sale_returns').select('sale_id,sale_item_id,quantity,amount').in('sale_id', saleIds),
      ]);
      if (!paymentQuery.error) salePaymentRows = (paymentQuery.data || []) as SalePayment[];
      if (!returnQuery.error) returnRows = returnQuery.data || [];
    }
    const returnsByItem = returnRows.reduce((acc: Record<string, { quantity: number; amount: number }>, row: any) => {
      if (!row.sale_item_id) return acc;
      const item = acc[row.sale_item_id] || { quantity: 0, amount: 0 };
      item.quantity += Number(row.quantity || 0); item.amount += Number(row.amount || 0); acc[row.sale_item_id] = item;
      return acc;
    }, {});
    const attachReturns = (rows: SaleWithItems[]) => rows.map((sale: any) => ({
      ...sale,
      sale_items: (sale.sale_items || []).map((item: any) => ({
        ...item,
        returned_quantity: Number(returnsByItem[item.id]?.quantity || 0),
        returned_amount: Number(returnsByItem[item.id]?.amount || 0),
      })),
      refund_amount: Number(sale.refund_amount || 0),
    }));
    const returnAwareActiveSales = attachReturns(activeSales);
    const returnAwareSettledSales = attachReturns(settledSales);
    const staffIds = Array.from(new Set([
      ...((paymentResult.data || []) as any[]).map((p) => p.staff_id).filter(Boolean),
      ...allSales.map((s: any) => s.staff_id).filter(Boolean),
    ]));
    let staffMap: Record<string, string> = {};
    if (staffIds.length) {
      const staffQuery = await supabase.from('staff').select('id,name').in('id', staffIds);
      if (!staffQuery.error && staffQuery.data) {
        staffMap = Object.fromEntries(staffQuery.data.map((row: any) => [row.id, row.name]));
      }
    }

    const paymentsBySale = salePaymentRows.reduce((acc: Record<string, SalePayment[]>, row) => {
      (acc[row.sale_id] ||= []).push(row);
      return acc;
    }, {});
    const attachPayments = (rows: SaleWithItems[]) => rows.map((row: any) => ({ ...row, sale_payments: paymentsBySale[row.id] || [] }));
    setSales(attachPayments(returnAwareActiveSales));
    setArchiveSales(attachPayments(returnAwareSettledSales));
    setPayments((paymentResult.data || []) as CustomerPayment[]);
    setLoanAdjustments((loanResult.data || []) as any[]);
    setSalePayments(salePaymentRows);
    setStaffNames(staffMap);
    setCurrentBalance(customerResult.data ? Number(customerResult.data.balance || 0) : null);
    setLoading(false);
  }, [customerId]);

  useEffect(() => {
    void load();
    if (!customerId) return;
    // One checkout can emit several realtime events (sale, payment, balance).
    // Debounce them into a single data refresh to avoid UI freezes on large accounts.
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { void load(); }, 220);
    };
    const channel = supabase
      .channel(`customer-debt-${customerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `customer_id=eq.${customerId}` }, scheduleLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_payments', filter: `customer_id=eq.${customerId}` }, scheduleLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_debt_adjustments', filter: `customer_id=eq.${customerId}` }, scheduleLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers', filter: `id=eq.${customerId}` }, scheduleLoad)
      .subscribe();
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      void supabase.removeChannel(channel);
    };
  }, [customerId, load]);

  return { sales, archiveSales, payments, loanAdjustments, salePayments, staffNames, currentBalance, customerName, loading, reload: load };
}



// ===== Kasa Oturumları =====

export function useActiveCashSession() {
  const [session, setSession] = useState<CashSession | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('cash_sessions')
      .select('*')
      .eq('status', 'open')
      .order('opened_at', { ascending: false })
      .maybeSingle();
    if (error) {
      console.error('Kasa oturumu yüklenemedi:', error);
    }
    setSession(data || null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('cash-sessions-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { session, loading, reload: load };
}

export async function openCashSession(openingAmount: number, note?: string): Promise<CashSession | null> {
  const { data, error } = await supabase
    .from('cash_sessions')
    .insert({
      opening_amount: openingAmount,
      status: 'open',
      note: note || null,
    })
    .select()
    .single();
  if (error) {
    console.error('Kasa açılamadı:', error);
    return null;
  }
  await writeAudit('cash_opened', 'cash_session', data.id, { opening_amount: openingAmount, note: note || null });
  return data;
}

export type CashWithdrawal = { id?: string; amount: number; note?: string; created_at: string; canceled?: boolean; category?: string; exchange_id?: string };
export type CashDeposit = { id?: string; amount: number; note?: string; created_at: string; canceled?: boolean; category?: string };
export type ShopExpense = { type: 'cash' | 'product'; amount: number; note?: string; product_id?: string; product_name?: string; quantity?: number; created_at: string };

const WITHDRAWAL_PREFIX = '[PARA_ALMA]';
const DEPOSIT_PREFIX = '[PARA_EKLE]';
const EXPENSE_PREFIX = '[DUKKAN_GIDERI]';

// Older 4.4.1 builds could store literal backslash+n separators.
// Normalize both actual and legacy separators so the current cash session remains readable.
function splitCashNote(note?: string | null): string[] {
  if (!note) return [];
  return note.replace(/\\+n/g, '\n').split(/\r?\n/);
}

export function getCashWithdrawals(note?: string | null): CashWithdrawal[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(WITHDRAWAL_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(WITHDRAWAL_PREFIX.length));
      if (!value || typeof value.amount !== 'number' || value.canceled === true) return [];
      return [{ id: value.id || undefined, amount: value.amount, note: value.note || undefined, created_at: value.created_at || '', canceled: false, category: value.category || undefined, exchange_id: value.exchange_id || undefined }];
    } catch { return []; }
  });
}

export function getCashDeposits(note?: string | null): CashDeposit[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(DEPOSIT_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(DEPOSIT_PREFIX.length));
      if (!value || typeof value.amount !== 'number' || value.canceled === true) return [];
      return [{ id: value.id || undefined, amount: value.amount, note: value.note || undefined, created_at: value.created_at || '', canceled: false, category: value.category || undefined }];
    } catch { return []; }
  });
}

export type CashIbanExchange = { id:string; business_id:string|null; cash_session_id:string; staff_id:string|null; customer_name:string|null; customer_phone:string|null; amount:number; status:'pending'|'received'|'cancelled'; note:string|null; created_at:string; received_at:string|null; cancelled_at:string|null; cancellation_reason:string|null };

export function useCashIbanExchanges(cashSessionId?: string | null) {
  const [rows,setRows]=useState<CashIbanExchange[]>([]);
  const load=useCallback(async()=>{
    if(!cashSessionId){ setRows([]); return; }
    const {data,error}=await supabase.from('cash_iban_exchanges').select('*').eq('cash_session_id',cashSessionId).order('created_at',{ascending:false});
    if(error) console.error('IBAN işlemleri yüklenemedi:',error);
    setRows((data||[]) as CashIbanExchange[]);
  },[cashSessionId]);
  useEffect(()=>{ load(); },[load]);
  return {rows,reload:load};
}

async function resolveRemoteStaffId(preferredId?: string | null): Promise<string | null> {
  try {
    const { data, error } = await fetchStaffRows();
    if (error || !data) return null;
    const rows = data as Staff[];
    if (preferredId) {
      const matched = rows.find(row => row.id === preferredId && row.active);
      if (matched) return matched.id;
    }
    const raw = sessionStorage.getItem('propos-current-staff-v2');
    const saved = raw ? JSON.parse(raw) as { id?: string; name?: string } : null;
    if (saved?.id) {
      const matched = rows.find(row => row.id === saved.id && row.active);
      if (matched) return matched.id;
    }
    if (saved?.name) {
      const exact = rows.find(row => row.active && row.name.toLocaleLowerCase() === saved.name!.toLocaleLowerCase());
      if (exact) return exact.id;
      const partial = rows.find(row => row.active && row.name.toLocaleLowerCase().includes(saved.name!.toLocaleLowerCase()));
      if (partial) return partial.id;
    }
  } catch (err) {
    console.error('Aktif personel çözümlenemedi:', err);
  }
  return null;
}

export async function cancelCashManualEntry(cashSessionId:string, entryId:string, entryKind:'deposit'|'withdrawal'|'customer_iban', staffId?:string|null, reason?:string):Promise<boolean>{
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId) return false;
  const {data,error}=await supabase.rpc('cancel_cash_manual_entry',{p_cash_session_id:cashSessionId,p_entry_id:entryId,p_entry_kind:entryKind,p_staff_id:resolvedStaffId,p_reason:reason?.trim()||null});
  if(error){ console.error('Kasa hareketi iptal edilemedi:',error); return false; }
  if(data===true) await writeAudit('cash_entry_cancelled','cash_session',cashSessionId,{entry_id:entryId,entry_kind:entryKind,reason:reason||null});
  return data===true;
}

export async function createCashIbanExchange(cashSessionId:string, amount:number, customerName?:string, customerPhone?:string, note?:string, staffId?:string|null){
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId || !Number.isFinite(amount) || amount<=0) return {data:null,error:'Geçersiz IBAN işlemi'};
  const {data,error}=await supabase.rpc('create_cash_iban_exchange',{p_cash_session_id:cashSessionId,p_amount:amount,p_customer_name:customerName?.trim()||null,p_customer_phone:customerPhone?.trim()||null,p_note:note?.trim()||null,p_staff_id:resolvedStaffId});
  if(error){ console.error('Müşteri nakit/IBAN işlemi kaydedilemedi:',error); return {data:null,error:error.message||'İşlem kaydedilemedi'}; }
  await writeAudit('customer_iban_created','cash_session',cashSessionId,{amount,customer_name:customerName||null,customer_phone:customerPhone||null,note:note||null});
  return {data,error:null};
}

export async function markCashIbanReceived(exchangeId:string, staffId?:string|null):Promise<boolean>{
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  if(!resolvedStaffId) return false;
  const {data,error}=await supabase.rpc('mark_cash_iban_received',{p_exchange_id:exchangeId,p_staff_id:resolvedStaffId});
  if(error){ console.error('IBAN transferi tamamlanamadı:',error); return false; }
  if(data===true) await writeAudit('customer_iban_received','cash_iban_exchange',exchangeId);
  return data===true;
}


export type SupplierCashPayment = { amount:number; supplier_id?:string; payment_id?:string; note?:string; created_at:string };
const SUPPLIER_PAYMENT_PREFIX = '[TEDARIKCI_ODEME]';

export function getSupplierCashPayments(note?: string | null): SupplierCashPayment[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(SUPPLIER_PAYMENT_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(SUPPLIER_PAYMENT_PREFIX.length));
      if (!value || typeof value.amount !== 'number') return [];
      return [{ amount:value.amount, supplier_id:value.supplier_id || undefined, payment_id:value.payment_id || undefined, note:value.note || undefined, created_at:value.created_at || '' }];
    } catch { return []; }
  });
}

export type CashRefund = { amount: number; reason?: string; sale_id?: string; created_at: string };
const CASH_REFUND_PREFIX = '[PARA_CIKISI_Iade]';

export function getCashRefunds(note?: string | null): CashRefund[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(CASH_REFUND_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(CASH_REFUND_PREFIX.length));
      if (!value || typeof value.amount !== 'number') return [];
      return [{ amount: value.amount, reason: value.reason || undefined, sale_id: value.sale_id || undefined, created_at: value.created_at || '' }];
    } catch { return []; }
  });
}

export function getShopExpenses(note?: string | null): ShopExpense[] {
  if (!note) return [];
  return splitCashNote(note).flatMap((line) => {
    if (!line.startsWith(EXPENSE_PREFIX)) return [];
    try {
      const value = JSON.parse(line.slice(EXPENSE_PREFIX.length));
      if (!value || (value.type !== 'cash' && value.type !== 'product') || typeof value.amount !== 'number') return [];
      if (value.type === 'product' && Array.isArray(value.items)) {
        return value.items.filter((item: any) => item && typeof item.amount === 'number').map((item: any) => ({
          type: 'product' as const,
          amount: Number(item.amount || 0),
          note: value.note || undefined,
          product_id: item.product_id || item.productId || undefined,
          product_name: item.product_name || item.productName || undefined,
          quantity: typeof item.quantity === 'number' ? item.quantity : undefined,
          created_at: value.created_at || item.created_at || '',
        }));
      }
      return [{
        type: value.type,
        amount: value.amount,
        note: value.note || undefined,
        product_id: value.product_id || undefined,
        product_name: value.product_name || undefined,
        quantity: typeof value.quantity === 'number' ? value.quantity : undefined,
        created_at: value.created_at || '',
      } as ShopExpense];
    } catch {
      return [];
    }
  });
}

export type ShopProductExpenseItem = { productId: string; quantity: number };

export async function addShopProductExpenseBatch(id: string, items: ShopProductExpenseItem[], note?: string, staffId?: string | null): Promise<boolean> {
  const clean = items.filter(item => !!item.productId && Number.isFinite(item.quantity) && item.quantity > 0);
  if (!clean.length) return false;
  const resolvedStaffId = await resolveRemoteStaffId(staffId);
  const { data, error } = await supabase.rpc('record_shop_product_expense_batch', {
    p_cash_session_id: id,
    p_items: clean,
    p_note: note?.trim() || null,
    p_staff_id: resolvedStaffId,
  });
  if (error || !data?.success) {
    console.error('Toplu ürün gideri kaydedilemedi:', error || data);
    return false;
  }
  await writeAudit('shop_product_expense_batch', 'cash_session', id, { items: clean, amount: Number(data.amount || 0), note: note || null });
  return true;
}

export async function addShopCashExpense(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const { data: session, error: readError } = await supabase.from('cash_sessions').select('note, status').eq('id', id).single();
  if (readError || !session || session.status !== 'open') return false;
  const entry = `${EXPENSE_PREFIX}${JSON.stringify({ type: 'cash', amount, note: note?.trim() || undefined, created_at: new Date().toISOString() })}`;
  const nextNote = [session.note || '', entry].filter(Boolean).join('\n');
  const { error } = await supabase.from('cash_sessions').update({ note: nextNote }).eq('id', id);
  if (error) { console.error('Dükkan gideri kaydedilemedi:', error); return false; }
  return true;
}

export async function addShopProductExpense(id: string, product: Product, quantity: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(quantity) || quantity <= 0 || (!product.unlimited_stock && quantity > product.stock)) return false;
  const { data: session, error: readError } = await supabase.from('cash_sessions').select('note, status').eq('id', id).single();
  if (readError || !session || session.status !== 'open') return false;
  const { data: currentProduct, error: productReadError } = await supabase.from('products').select('stock, name, cost, unlimited_stock').eq('id', product.id).single();
  if (productReadError || !currentProduct || (!currentProduct.unlimited_stock && Number(currentProduct.stock) < quantity)) return false;
  const costAmount = Number(currentProduct.cost || 0) * quantity;
  const beforeStock = Number(currentProduct.stock || 0);
  if (!currentProduct.unlimited_stock) {
    const { error: stockError } = await supabase.from('products').update({ stock: beforeStock - quantity }).eq('id', product.id);
    if (stockError) { console.error('Gider için stok düşülemedi:', stockError); return false; }
  }
  const entry = `${EXPENSE_PREFIX}${JSON.stringify({ type: 'product', amount: costAmount, quantity, product_id: product.id, product_name: currentProduct.name, unlimited_stock: Boolean(currentProduct.unlimited_stock), note: note?.trim() || undefined, created_at: new Date().toISOString() })}`;
  const nextNote = [session.note || '', entry].filter(Boolean).join('\n');
  const { error } = await supabase.from('cash_sessions').update({ note: nextNote }).eq('id', id);
  if (error) {
    if (!currentProduct.unlimited_stock) await supabase.from('products').update({ stock: beforeStock }).eq('id', product.id);
    console.error('Ürün gideri kaydedilemedi:', error);
    return false;
  }
  return true;
}

export async function addCashDeposit(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const staffId = await resolveRemoteStaffId();
  if (!staffId) { console.error('Kasaya para eklenemedi: aktif admin/müdür personeli bulunamadı.'); return false; }
  const { data, error } = await supabase.rpc('add_cash_manual_entry', { p_cash_session_id:id, p_amount:amount, p_kind:'deposit', p_staff_id:staffId, p_note:note?.trim()||null });
  if (error || data !== true) { console.error('Kasaya para eklenemedi:', error); return false; }
  await writeAudit('cash_deposit','cash_session',id,{amount,note:note||null});
  return true;
}

export async function addCashWithdrawal(id: string, amount: number, note?: string): Promise<boolean> {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const staffId = await resolveRemoteStaffId();
  if (!staffId) { console.error('Kasadan para alınamadı: aktif admin/müdür personeli bulunamadı.'); return false; }
  const { data, error } = await supabase.rpc('add_cash_manual_entry', { p_cash_session_id:id, p_amount:amount, p_kind:'withdrawal', p_staff_id:staffId, p_note:note?.trim()||null });
  if (error || data !== true) { console.error('Kasadan para alınamadı:', error); return false; }
  await writeAudit('cash_withdrawal','cash_session',id,{amount,note:note||null});
  return true;
}

export async function closeCashSession(id: string, closingAmount: number, note?: string): Promise<boolean> {
  const { data: current, error: readError } = await supabase
    .from('cash_sessions')
    .select('note')
    .eq('id', id)
    .single();
  if (readError) {
    console.error('Kasa notu okunamadı:', readError);
    return false;
  }
  const baseNote = (current?.note || '').split('\n').filter((line: string) => !line.startsWith('[KAPANIS_NOTU]')).join('\n').trim();
  const nextNote = [baseNote, note?.trim() ? `[KAPANIS_NOTU]${note.trim()}` : ''].filter(Boolean).join('\n');
  const { error } = await supabase
    .from('cash_sessions')
    .update({
      closing_amount: closingAmount,
      status: 'closed',
      closed_at: new Date().toISOString(),
      note: nextNote || null,
    })
    .eq('id', id);
  if (error) {
    console.error('Kasa kapatılamadı:', error);
    return false;
  }
  return true;
}

export type CashReconciliationInput = {
  sessionId: string;
  countedCash: number;
  expectedCash: number;
  cashSales: number;
  cardSales: number;
  creditSales: number;
  deposits: number;
  withdrawals: number;
  supplierCashPayments: number;
  shopCashExpenses: number;
  cashRefunds: number;
  saleCount: number;
  staffId?: string | null;
  note?: string;
};

export function useLatestCashCount(cashSessionId?: string | null) {
  const [cashCount, setCashCount] = useState<CashReconciliation | null>(null);

  const load = useCallback(async () => {
    if (!cashSessionId) {
      setCashCount(null);
      return;
    }
    const { data, error } = await supabase
      .from('cash_counts')
      .select('*')
      .eq('cash_session_id', cashSessionId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error('Son ara kasa sayımı yüklenemedi:', error);
      return;
    }
    setCashCount((data || null) as CashReconciliation | null);
  }, [cashSessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { cashCount, reload: load };
}

export async function recordCashCount(input: CashReconciliationInput): Promise<{success:boolean; error?:string; difference?:number}> {
  const { data, error } = await supabase.rpc('record_cash_count', {
    p_session_id: input.sessionId,
    p_counted_cash: input.countedCash,
    p_expected_cash: input.expectedCash,
    p_cash_sales: input.cashSales,
    p_card_sales: input.cardSales,
    p_credit_sales: input.creditSales,
    p_deposits: input.deposits,
    p_withdrawals: input.withdrawals,
    p_supplier_cash_payments: input.supplierCashPayments,
    p_shop_cash_expenses: input.shopCashExpenses,
    p_cash_refunds: input.cashRefunds,
    p_sale_count: input.saleCount,
    p_staff_id: input.staffId || null,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Ara kasa sayımı kaydedilemedi:', error);
    return { success:false, error:error.message };
  }
  await writeAudit('cash_count_recorded', 'cash_session', input.sessionId, { counted_cash: input.countedCash, expected_cash: input.expectedCash, difference: Number(data?.difference || 0), note: input.note || null });
  return { success:true, difference:Number(data?.difference || 0) };
}

export async function closeCashSessionReconciled(input: CashReconciliationInput): Promise<{success:boolean; error?:string; difference?:number}> {
  const { data, error } = await supabase.rpc('close_cash_session_reconciled', {
    p_session_id: input.sessionId,
    p_counted_cash: input.countedCash,
    p_expected_cash: input.expectedCash,
    p_cash_sales: input.cashSales,
    p_card_sales: input.cardSales,
    p_credit_sales: input.creditSales,
    p_deposits: input.deposits,
    p_withdrawals: input.withdrawals,
    p_supplier_cash_payments: input.supplierCashPayments,
    p_shop_cash_expenses: input.shopCashExpenses,
    p_cash_refunds: input.cashRefunds,
    p_sale_count: input.saleCount,
    p_staff_id: input.staffId || null,
    p_note: input.note?.trim() || null,
  });
  if (error) {
    console.error('Kasa mutabakatı kaydedilemedi:', error);
    return { success:false, error:error.message };
  }
  return { success:true, difference:Number(data?.difference || 0) };
}

export function useCashSessions(limit = 30) {
  const [sessions, setSessions] = useState<CashSession[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('cash_sessions')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('Kasa oturumları yüklenemedi:', error);
    }
    setSessions(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('cash-sessions-list-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_sessions' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sessions, loading, reload: load };
}

export async function getSaleItems(saleId: string): Promise<SaleItem[]> {
  const { data, error } = await supabase
    .from('sale_items')
    .select('*')
    .eq('sale_id', saleId);
  if (error) {
    console.error('Satış kalemleri yüklenemedi:', error);
    return [];
  }
  return data || [];
}

export function useSalesByDate(startDate: string, endDate: string) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    let { data, error } = await supabase
      .from('sales')
      .select('*')
      .gte('created_at', startDate)
      .lte('created_at', endDate)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });

    if (error && /deleted_at|schema cache|column/i.test(error.message || '')) {
      const fallback = await supabase
        .from('sales')
        .select('*')
        .gte('created_at', startDate)
        .lte('created_at', endDate)
        .order('created_at', { ascending: false });
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.error('Satışlar yüklenemedi:', error);
    }
    setSales((data || []) as Sale[]);
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => {
    load();
  }, [load]);

  return { sales, loading, reload: load };
}


// ===== Rapor / Satış Çöp Kutusu =====
// Satışı fiziksel olarak silmez. Stok ve veresiye bakiyesini güvenli şekilde geri alır.
export async function moveSaleToTrash(id: string, reason = 'Kullanıcı tarafından iptal edildi'): Promise<boolean> {
  // Idempotent transaction: if the sale is already in the trash, treat it as success.
  const { data: rpcData, error: rpcError } = await supabase.rpc('move_sale_to_trash_v2', {
    p_sale_id: id,
    p_reason: reason,
  });

  if (!rpcError && rpcData === true) { await writeAudit('sale_trashed', 'sale', id, { reason }); return true; }
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel satış iptali başarısız; güvenlik için stok/cariyi ayrı adımlarla değiştirmiyoruz:', rpcError);
    return false;
  }

  // Some Supabase projects cache the RPC schema for a short time. If the RPC
  // is unavailable, verify whether a previous attempt already moved the sale.
  const { data: currentSale, error: currentSaleError } = await supabase
    .from('sales')
    .select('id, deleted_at')
    .eq('id', id)
    .maybeSingle();

  if (!currentSaleError && currentSale?.deleted_at) return true;

  // Safe fallback for projects where the new RPC is not yet visible.
  // Do not touch stock unless the sale itself can be marked as deleted.
  const deletedAt = new Date().toISOString();
  const { data: moved, error: moveError } = await supabase
    .from('sales')
    .update({ deleted_at: deletedAt, deleted_reason: reason })
    .eq('id', id)
    .is('deleted_at', null)
    .select('id, deleted_at')
    .maybeSingle();

  if (moveError || !moved?.deleted_at) {
    console.error('Satış çöp kutusuna taşınamadı:', { rpcError, rpcData, moveError });
    return false;
  }

  // Once the sale is marked deleted, restore the stock/cari movement.
  // If a product update fails, leave the sale in the trash rather than
  // reporting a false success; the user can retry the operation.
  const { data: items, error: itemsError } = await supabase
    .from('sale_items')
    .select('product_id, quantity')
    .eq('sale_id', id);

  if (itemsError) {
    console.error('Satış kalemleri okunamadı:', itemsError);
    return false;
  }

  for (const item of items || []) {
    if (!item.product_id) continue;
    const { data: product, error: productError } = await supabase
      .from('products')
      .select('stock')
      .eq('id', item.product_id)
      .maybeSingle();
    if (productError || !product) {
      console.error('Stok okunamadı:', productError);
      return false;
    }

    const { error: stockError } = await supabase
      .from('products')
      .update({ stock: Number(product.stock || 0) + Number(item.quantity || 0) })
      .eq('id', item.product_id);
    if (stockError) {
      console.error('Stok geri alınamadı:', stockError);
      return false;
    }
  }

  return true;
}

export async function restoreSaleFromTrash(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('restore_sale_from_trash', {
    p_sale_id: id,
  });
  if (!error) return data === true;
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    console.error('Yerel satış geri yükleme işlemi başarısız; stok ve cari ayrı adımlarla değiştirilmedi:', error);
    return false;
  }

  console.error('Satış RPC ile geri yüklenemedi, yedek yöntem deneniyor:', error);
  const { data: sale } = await supabase.from('sales').select('*').eq('id', id).maybeSingle();
  if (!sale || !sale.deleted_at) return false;
  const { data: items, error: itemsError } = await supabase
    .from('sale_items').select('product_id, quantity').eq('sale_id', id);
  if (itemsError) return false;
  for (const item of items || []) {
    if (!item.product_id) continue;
    const { data: product } = await supabase.from('products').select('stock').eq('id', item.product_id).maybeSingle();
    if (!product) return false;
    const { error: stockError } = await supabase.from('products')
      .update({ stock: Number(product.stock || 0) - Number(item.quantity || 0) }).eq('id', item.product_id);
    if (stockError) return false;
  }
  if (sale.payment_method === 'credit' && sale.customer_id) {
    const { data: customer } = await supabase.from('customers').select('balance').eq('id', sale.customer_id).maybeSingle();
    if (customer) await supabase.from('customers').update({ balance: Number(customer.balance || 0) + Number(sale.total || 0) }).eq('id', sale.customer_id);
  }
  const { error: restoreError } = await supabase.from('sales').update({ deleted_at: null, deleted_reason: null }).eq('id', id);
  return !restoreError;
}

export async function refundSale(id: string, reason = 'Müşteri iadesi'): Promise<boolean> {
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    const { data: sale, error: saleError } = await supabase.from('sales').select('*').eq('id', id).maybeSingle();
    if (saleError || !sale || sale.deleted_at) return false;
    if (sale.refunded_at || Number(sale.refund_amount || 0) >= Number(sale.total || 0) - 0.009) return true;
    const { data: items, error: itemError } = await supabase.from('sale_items').select('*').eq('sale_id', id);
    if (itemError || !items?.length) return false;
    const ids = items.map((item: any) => item.id);
    const { data: returns, error: returnReadError } = await supabase.from('sale_returns').select('sale_item_id, quantity').in('sale_item_id', ids);
    if (returnReadError) return false;
    const returned = new Map<string, number>();
    for (const item of returns || []) returned.set(item.sale_item_id, (returned.get(item.sale_item_id) || 0) + Number(item.quantity || 0));
    const remaining = items.map((item: any) => ({
      saleItemId: item.id,
      quantity: Math.max(0, Number(item.quantity || 0) - (returned.get(item.id) || 0)),
    })).filter((item: any) => item.quantity > 0);
    if (!remaining.length) return false;
    const { data, error } = await supabase.rpc('process_sale_return', {
      p_sale_id: id, p_items: remaining, p_reason: reason || 'Müşteri iadesi',
      p_staff_id: null, p_return_method: 'original',
    });
    if (error || Number(data?.refund_amount || 0) <= 0) {
      console.error('Yerel atomik satış iadesi başarısız:', error || data);
      return false;
    }
    await writeAudit('sale_refunded', 'sale', id, { total: Number(data.refund_amount || 0), reason });
    return true;
  }
  // Web/PWA eski sürümleri için uyumluluk akışı.
  const { data: sale, error: saleError } = await supabase
    .from('sales')
    .select('id, total, payment_method, customer_name, paid_amount, created_at')
    .eq('id', id)
    .maybeSingle();

  if (saleError || !sale) {
    console.error('İade için satış okunamadı:', saleError);
    return false;
  }

  // İade edilmiş olup olmadığını, varsa işaret alanından kontrol et.
  let existingReason = '';
  const { data: statusRow } = await supabase
    .from('sales')
    .select('deleted_reason')
    .eq('id', id)
    .maybeSingle();
  if (statusRow?.deleted_reason) existingReason = String(statusRow.deleted_reason);
  if (existingReason.startsWith('İADE|')) return true;

  // Satış kalemleri yalnızca temel şema alanlarıyla okunur.
  const { data: items, error: itemsError } = await supabase
    .from('sale_items')
    .select('product_id, quantity, barcode, product_name')
    .eq('sale_id', id);

  if (itemsError || !items || items.length === 0) {
    console.error('İade ürünleri okunamadı:', itemsError);
    return false;
  }

  const quantities = new Map<string, number>();
  for (const item of items) {
    let productId = item.product_id as string | null;

    if (!productId && item.barcode) {
      const { data: byBarcode } = await supabase
        .from('products').select('id').eq('barcode', item.barcode).maybeSingle();
      productId = byBarcode?.id || null;
    }
    if (!productId && item.product_name) {
      const { data: byName } = await supabase
        .from('products').select('id').eq('name', item.product_name).maybeSingle();
      productId = byName?.id || null;
    }
    if (!productId) {
      console.error('İade ürünü bulunamadı:', item);
      return false;
    }
    quantities.set(productId, (quantities.get(productId) || 0) + Number(item.quantity || 0));
  }

  // Veresiye satışsa customer_id varsa bakiyeyi geri al.
  let customerId: string | null = null;
  let previousBalance: number | null = null;
  if (sale.payment_method === 'credit') {
    const { data: creditSale } = await supabase
      .from('sales').select('customer_id').eq('id', id).maybeSingle();
    customerId = creditSale?.customer_id || null;
    if (customerId) {
      const { data: customer, error: customerError } = await supabase
        .from('customers').select('balance').eq('id', customerId).maybeSingle();
      if (customerError || !customer) {
        console.error('İade müşteri bakiyesi okunamadı:', customerError);
        return false;
      }
      previousBalance = Number(customer.balance || 0);
    }
  }

  const previousStocks = new Map<string, number>();
  for (const [productId] of quantities) {
    const { data: product, error: productError } = await supabase
      .from('products').select('stock').eq('id', productId).maybeSingle();
    if (productError || !product) {
      console.error('İade ürünü okunamadı:', { productId, productError });
      return false;
    }
    previousStocks.set(productId, Number(product.stock || 0));
  }

  const updatedProducts: string[] = [];
  let balanceUpdated = false;
  try {
    for (const [productId, quantity] of quantities) {
      const { error } = await supabase.from('products')
        .update({ stock: (previousStocks.get(productId) || 0) + quantity })
        .eq('id', productId);
      if (error) throw error;
      updatedProducts.push(productId);
    }

    if (customerId && previousBalance !== null) {
      const { error } = await supabase.from('customers')
        .update({ balance: Math.max(0, previousBalance - Number(sale.total || 0)) })
        .eq('id', customerId);
      if (error) throw error;
      balanceUpdated = true;
    }

    // Önce mevcut iade/çöp kutusu kolonları varsa satış kaydını koruyarak işaretle.
    const marker = `İADE|${new Date().toISOString()}|${Number(sale.total || 0)}|${reason || 'Müşteri iadesi'}`;
    let marked = false;

    const withTrashColumns = await supabase.from('sales')
      .update({ deleted_reason: marker, deleted_at: null })
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (!withTrashColumns.error && withTrashColumns.data) {
      marked = true;
    } else {
      const reasonOnly = await supabase.from('sales')
        .update({ deleted_reason: marker })
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (!reasonOnly.error && reasonOnly.data) marked = true;
    }

    // Eski veritabanında deleted_reason/deleted_at yoksa satış kaydını silerek
    // iade işlemini tamamla. Stok ve cari hareketi zaten geri alınmış durumda.
    if (!marked) {
      const { error: deleteError } = await supabase.from('sales').delete().eq('id', id);
      if (deleteError) throw deleteError;
    }

    await writeAudit('sale_refunded', 'sale', id, { total: Number(sale.total || 0), reason });
    return true;
  } catch (error) {
    console.error('İade işlemi sırasında hata:', error);
    for (const productId of updatedProducts) {
      await supabase.from('products')
        .update({ stock: previousStocks.get(productId) || 0 }).eq('id', productId);
    }
    if (balanceUpdated && customerId && previousBalance !== null) {
      await supabase.from('customers').update({ balance: previousBalance }).eq('id', customerId);
    }
    return false;
  }
}

export async function permanentlyDeleteSale(id: string): Promise<boolean> {
  if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
    const { data, error } = await supabase.rpc('permanently_delete_sale', { p_sale_id: id });
    if (error || data !== true) {
      console.error('Yerel satış kalıcı olarak silinemedi:', error);
      return false;
    }
    return true;
  }
  const { error } = await supabase.from('sales').delete().eq('id', id);
  if (error) {
    console.error('Satış kalıcı olarak silinemedi:', error);
    return false;
  }
  return true;
}

export type TrashCleanupResult = { deletedProducts: number; deletedSales: number; error?: string };

/** Kalıcı temizliği yalnızca çöp kutusuna taşınmış kayıtlar için yapar. 0, otomatik silmeyi kapatır. */
export async function cleanupExpiredTrash(retentionDays?: number): Promise<TrashCleanupResult> {
  let days = retentionDays;
  if (days === undefined || !Number.isFinite(days)) {
    try {
      const raw = localStorage.getItem('pos-settings');
      const settings = raw ? JSON.parse(raw) as { trashRetentionDays?: string | number } : {};
      days = Number(settings.trashRetentionDays ?? 1);
    } catch { days = 1; }
  }
  days = Math.max(0, Math.floor(Number(days)));
  if (!days) return { deletedProducts: 0, deletedSales: 0 };
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const result: TrashCleanupResult = { deletedProducts: 0, deletedSales: 0 };
  const errors: string[] = [];
  try {
    const { data: expiredSales, error: salesError } = await supabase.from('sales').select('id').not('deleted_at', 'is', null).lt('deleted_at', cutoff).limit(500);
    if (salesError) errors.push(`Satış çöp kutusu: ${salesError.message}`);
    else {
      for (const sale of expiredSales || []) {
        if (await permanentlyDeleteSale(String(sale.id))) result.deletedSales += 1;
        else errors.push(`Satış kalıcı silinemedi: ${String(sale.id)}`);
      }
    }
    const { data: expiredProducts, error: productsError } = await supabase.from('products').select('id').not('deleted_at', 'is', null).lt('deleted_at', cutoff).limit(500);
    if (productsError) errors.push(`Ürün çöp kutusu: ${productsError.message}`);
    else {
      for (const product of expiredProducts || []) {
        const { error } = await supabase.from('products').delete().eq('id', String(product.id));
        if (!error) result.deletedProducts += 1;
        else errors.push(`Ürün kalıcı silinemedi (${String(product.id)}): ${error.message}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length) result.error = errors.slice(0, 4).join(' · ');
  if (result.deletedProducts || result.deletedSales) await writeAudit('trash_auto_cleanup', 'trash', undefined, { retention_days: days, ...result });
  return result;
}

export function useDeletedSales(limit = 200) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.error('Çöp kutusu yüklenemedi:', error);
    }
    setSales(data || []);
    setLoading(false);
  }, [limit]);

  useEffect(() => {
    load();
    const channel = supabase
      .channel('deleted-sales-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load]);

  return { sales, loading, reload: load };
}


// ===== Alış & Tedarikçiler =====
export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('suppliers').select('*').order('name');
    if (error) console.error('Tedarikçiler yüklenemedi:', error);
    setSuppliers((data || []) as Supplier[]);
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
    const ch = supabase.channel('suppliers-changes').on('postgres_changes', { event:'*', schema:'public', table:'suppliers' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);
  return { suppliers, loading, reload: load };
}

export async function saveSupplier(input: Partial<Supplier> & { name: string }): Promise<Supplier | null> {
  let businessId: string | null = null;
  try {
    const { data, error } = await supabase.rpc('get_default_business_id');
    if (error) throw error;
    businessId = typeof data === 'string' ? data : null;
  } catch (error) {
    console.error('Tedarikçi kaydedilemedi: lisanslı işletme oturumu bulunamadı.', error);
    return null;
  }
  if (!businessId) return null;
  const payload = {
    business_id: businessId,
    name: input.name.trim(),
    contact_name: input.contact_name?.trim() || null,
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    note: input.note?.trim() || null,
    active: input.active ?? true,
    updated_at: new Date().toISOString(),
  };
  if (!payload.name) return null;
  let result;
  if (input.id) result = await supabase.from('suppliers').update(payload).eq('id', input.id).select().single();
  else result = await supabase.from('suppliers').insert(payload).select().single();
  if (result.error || !result.data) {
    console.error('Tedarikçi kaydedilemedi:', result.error);
    return null;
  }
  await writeAudit(input.id ? 'supplier_updated' : 'supplier_created', 'supplier', result.data.id, { name: payload.name });
  return result.data as Supplier;
}

export async function toggleSupplier(id: string, active: boolean): Promise<boolean> {
  const { error } = await supabase.from('suppliers').update({ active, updated_at: new Date().toISOString() }).eq('id', id);
  return !error;
}

export function usePurchaseReceipts(limit = 100) {
  const [rows, setRows] = useState<PurchaseReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.from('purchase_receipts').select('*').order('purchase_date', { ascending:false }).limit(limit);
    if (error) console.error('Alış kayıtları yüklenemedi:', error);
    setRows((data || []) as PurchaseReceipt[]);
    setLoading(false);
  }, [limit]);
  useEffect(() => {
    load();
    const ch = supabase.channel('purchase-receipts-changes').on('postgres_changes', { event:'*', schema:'public', table:'purchase_receipts' }, () => load()).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);
  return { receipts: rows, loading, reload: load };
}

export async function receivePurchase(input: {
  supplierId: string | null;
  invoiceNo?: string;
  purchaseDate?: string;
  discountTotal?: number;
  staffId: string | null;
  notes?: string;
  items: Array<{ productId: string; productName: string; barcode?: string | null; quantity: number; unitCost: number }>;
}): Promise<{ success:boolean; id?:string; error?:string }> {
  if (!input.items.length) return { success:false, error:'Alış için en az bir ürün gerekli.' };
  const cleanItems = input.items.map(x => ({ productId:x.productId, productName:x.productName, barcode:x.barcode || null, quantity:Number(x.quantity), unitCost:Number(x.unitCost) }));
  if (cleanItems.some(x => !x.productId || x.quantity <= 0 || !Number.isFinite(x.quantity) || x.unitCost < 0 || !Number.isFinite(x.unitCost))) {
    return { success:false, error:'Alış kalemlerinde geçersiz değer var.' };
  }
  const { data, error } = await supabase.rpc('receive_purchase_atomic', {
    p_supplier_id: input.supplierId || null,
    p_invoice_no: input.invoiceNo?.trim() || null,
    p_purchase_date: input.purchaseDate || new Date().toISOString(),
    p_discount_total: Number(input.discountTotal || 0),
    p_staff_id: input.staffId || null,
    p_items: cleanItems,
    p_notes: input.notes?.trim() || null,
  });
  if (error) {
    console.error('Alış kaydedilemedi:', error);
    return { success:false, error:error.message || 'Alış kaydedilemedi.' };
  }
  await writeAudit('purchase_received', 'purchase_receipt', String(data), { supplier_id: input.supplierId, item_count: cleanItems.length });
  return { success:true, id:String(data) };
}

export async function loadPurchaseItems(receiptId: string): Promise<PurchaseReceiptItem[]> {
  const { data, error } = await supabase.from('purchase_receipt_items').select('*').eq('purchase_receipt_id', receiptId).order('created_at');
  if (error) { console.error('Alış kalemleri yüklenemedi:', error); return []; }
  return (data || []) as PurchaseReceiptItem[];
}

export function useSupplierAccounts() {
  const [accounts, setAccounts] = useState<SupplierAccount[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [receipts, setReceipts] = useState<PurchaseReceipt[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: suppliersData, error: suppliersError }, { data: receiptsData, error: receiptsError }, { data: paymentsData, error: paymentsError }] = await Promise.all([
      supabase.from('suppliers').select('*').order('name'),
      supabase.from('purchase_receipts').select('*').not('supplier_id', 'is', null).order('purchase_date', { ascending: false }),
      supabase.from('supplier_payments').select('*').order('created_at', { ascending: false }),
    ]);
    if (suppliersError) console.error('Tedarikçiler yüklenemedi:', suppliersError);
    if (receiptsError) console.error('Tedarikçi alışları yüklenemedi:', receiptsError);
    if (paymentsError) console.error('Tedarikçi ödemeleri yüklenemedi:', paymentsError);
    const nextSuppliers = (suppliersData || []) as Supplier[];
    const nextReceipts = (receiptsData || []) as PurchaseReceipt[];
    const nextPayments = (paymentsData || []) as SupplierPayment[];
    const computed = nextSuppliers.filter(s => s.active).map((supplier) => {
      const supplierReceipts = nextReceipts.filter(r => r.supplier_id === supplier.id);
      const supplierPayments = nextPayments.filter(p => p.supplier_id === supplier.id);
      const totalPurchases = supplierReceipts.reduce((sum, r) => sum + Number(r.total || 0), 0);
      const totalPaid = supplierPayments.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      return {
        supplier,
        total_purchases: Number(totalPurchases.toFixed(2)),
        total_paid: Number(totalPaid.toFixed(2)),
        balance: Number(Math.max(totalPurchases - totalPaid, 0).toFixed(2)),
        purchase_count: supplierReceipts.length,
        payment_count: supplierPayments.length,
      };
    });
    setAccounts(computed);
    setPayments(nextPayments);
    setReceipts(nextReceipts);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const channels = [
      supabase.channel('supplier-accounts-suppliers').on('postgres_changes', { event:'*', schema:'public', table:'suppliers' }, load).subscribe(),
      supabase.channel('supplier-accounts-receipts').on('postgres_changes', { event:'*', schema:'public', table:'purchase_receipts' }, load).subscribe(),
      supabase.channel('supplier-accounts-payments').on('postgres_changes', { event:'*', schema:'public', table:'supplier_payments' }, load).subscribe(),
    ];
    return () => channels.forEach(channel => { supabase.removeChannel(channel); });
  }, [load]);

  return { accounts, payments, receipts, loading, reload: load };
}

export async function paySupplier(input: {
  supplierId: string;
  amount: number;
  paymentMethod: 'cash' | 'card' | 'bank';
  note?: string;
  staffId?: string | null;
  purchaseReceiptId?: string | null;
}): Promise<{ success: boolean; id?: string; balanceAfter?: number; error?: string }> {
  if (!input.supplierId || !Number.isFinite(input.amount) || input.amount <= 0) return { success:false, error:'Geçerli bir ödeme tutarı girin.' };
  const { data, error } = await supabase.rpc('pay_supplier_atomic', {
    p_supplier_id: input.supplierId,
    p_amount: Number(input.amount),
    p_payment_method: input.paymentMethod,
    p_note: input.note?.trim() || null,
    p_staff_id: input.staffId || null,
    p_purchase_receipt_id: input.purchaseReceiptId || null,
  });
  if (error) {
    console.error('Tedarikçi ödemesi kaydedilemedi:', error);
    return { success:false, error:error.message || 'Tedarikçi ödemesi kaydedilemedi.' };
  }
  const result = (data || {}) as { id?: string; balance_after?: number };
  await writeAudit('supplier_payment', 'supplier', input.supplierId, { amount: input.amount, payment_method: input.paymentMethod, purchase_receipt_id: input.purchaseReceiptId || null });
  return { success:true, id:result.id, balanceAfter:Number(result.balance_after || 0) };
}

export function useSalePayments(saleIds: string[]) {
  const idsKey = saleIds.join('|');
  const stableIds = useMemo(() => idsKey ? idsKey.split('|').filter(Boolean) : [], [idsKey]);
  const [payments, setPayments] = useState<SalePayment[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!stableIds.length) { setPayments([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase.from('sale_payments').select('*').in('sale_id', stableIds).limit(5000);
    if (error) console.error('Satış ödeme dağılımları yüklenemedi:', error);
    setPayments((data || []) as SalePayment[]);
    setLoading(false);
  }, [stableIds]);
  useEffect(() => { void load(); }, [load]);
  return { payments, loading, reload: load };
}

export function useSupplierPayments(cashSessionId?: string | null) {
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    let query = supabase.from('supplier_payments').select('*').order('created_at', { ascending:false });
    if (cashSessionId) query = query.eq('cash_session_id', cashSessionId);
    const { data, error } = await query.limit(500);
    if (error) console.error('Tedarikçi ödemeleri yüklenemedi:', error);
    setPayments((data || []) as SupplierPayment[]);
    setLoading(false);
  }, [cashSessionId]);
  useEffect(() => {
    load();
    const ch = supabase.channel(`supplier-payments-${cashSessionId || 'all'}`).on('postgres_changes', { event:'*', schema:'public', table:'supplier_payments' }, load).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, cashSessionId]);
  return { payments, loading, reload: load };
}
