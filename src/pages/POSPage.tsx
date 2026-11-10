import { useState, useMemo, useEffect, useRef } from 'react';
import { Search, ShoppingCart, Trash2, X, CreditCard, Banknote, BookOpen, Printer, Receipt, Share2, PauseCircle, PlayCircle, Star, Landmark, LoaderCircle } from 'lucide-react';
import { useProducts, useCategories, useCustomers, completeSale, payCustomerDebt, queueOfflineSale, syncOfflineSales, getOfflineSales, retryBlockedOfflineSales, OFFLINE_SYNC_EVENT, loadStoreSettings, type CartItem, type PaymentSplit, type StoreSettings } from '@/lib/hooks';
import { formatCurrency, PAYMENT_METHODS, getEffectivePrice, type PaymentMethod } from '@/lib/utils';
import { campaignUnitPrice } from '@/lib/campaigns';
import { supabase, type Product, type SaleWithItems } from '@/lib/supabase';
import { useProductFavorites } from '@/lib/productFavorites';
import ReceiptLayout from '@/components/ReceiptLayout';
import { DEFAULT_RECEIPT_DESIGN, loadReceiptDesign, type ReceiptDesign } from '@/lib/receiptDesign';

type Props = {
  onNavigate: (page: string) => void;
};

export default function POSPage({ onNavigate }: Props) {
  const { products, loading } = useProducts();
  const { categories } = useCategories();
  const { customers } = useCustomers();
  const { favoriteIds, isFavorite } = useProductFavorites();
  const [quickFilter, setQuickFilter] = useState<'all' | 'favorites' | 'unbarcoded'>('all');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [quantityDrafts, setQuantityDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [lastSale, setLastSale] = useState<SaleWithItems | null>(null);
  const [lastSaleChange, setLastSaleChange] = useState<number | null>(null);
  const [showReceipt, setShowReceipt] = useState(false);
  const [processingSale, setProcessingSale] = useState(false);
  const [saleFeedback, setSaleFeedback] = useState('');
  const processingSaleRef = useRef(false);
  const saleAttemptRef = useRef<{ fingerprint: string; id: string } | null>(null);
  const [isOnline, setIsOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pendingOfflineSales, setPendingOfflineSales] = useState(() => getOfflineSales().length);
  const [blockedOfflineSales, setBlockedOfflineSales] = useState(() => getOfflineSales().filter(sale => sale.blocked).length);
  const [heldSales, setHeldSales] = useState<{id:string; created_at:string; items:CartItem[]; held_by?:string; hold_name?:string}[]>(() => {
    try { return JSON.parse(localStorage.getItem('propos-held-sales-v1') || '[]'); } catch { return []; }
  });
  const [showHeldSales, setShowHeldSales] = useState(false);
  const [showHoldNameDialog, setShowHoldNameDialog] = useState(false);
  const [holdNameDraft, setHoldNameDraft] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const refreshOfflineState = () => { const queue = getOfflineSales(); setPendingOfflineSales(queue.length); setBlockedOfflineSales(queue.filter(sale => sale.blocked).length); };
    const sync = () => {
      setIsOnline(true);
      syncOfflineSales().catch(() => {}).finally(refreshOfflineState);
    };
    const goOffline = () => { setIsOnline(false); refreshOfflineState(); };
    const onSyncEvent = () => refreshOfflineState();
    window.addEventListener('online', sync);
    window.addEventListener('offline', goOffline);
    window.addEventListener(OFFLINE_SYNC_EVENT, onSyncEvent);
    refreshOfflineState();
    if (navigator.onLine) sync();
    // Browser navigator.onLine can remain true while Wi-Fi/router connectivity is
    // still recovering. Retry only while items are pending, with a shared in-flight lock.
    const retryTimer = window.setInterval(() => {
      if (navigator.onLine && getOfflineSales().length > 0) sync();
    }, 15000);
    return () => {
      window.clearInterval(retryTimer);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener(OFFLINE_SYNC_EVENT, onSyncEvent);
    };
  }, []);

  const filteredProducts = useMemo(() => {
    let result = products;
    if (quickFilter === 'favorites') result = result.filter(p => favoriteIds.includes(p.id));
    if (quickFilter === 'unbarcoded') result = result.filter(p => favoriteIds.includes(p.id) && !(p.barcode || '').trim() && !(p.additional_barcodes || []).length);
    if (activeCategory) {
      result = result.filter((p) => p.category_id === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(
        (p) => p.name.toLowerCase().includes(q) || ((p.barcode && p.barcode.toLocaleLowerCase('tr-TR').includes(q)) || (p.additional_barcodes || []).some(b => b.toLocaleLowerCase('tr-TR').includes(q)))
      );
    }
    return result;
  }, [products, activeCategory, search, quickFilter, favoriteIds]);

  const cartTotal = Number(cart.reduce((sum, item) => sum + (campaignUnitPrice(item.product, item.quantity).price * (1 - (Number(item.discountPercent || 0) / 100))) * item.quantity, 0).toFixed(2));
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  async function handleRetryBlockedOfflineSales() {
    if (!navigator.onLine) { alert('Bağlantı gelince bu işlemleri yeniden deneyebilirsin.'); return; }
    const result = await retryBlockedOfflineSales();
    const queue = getOfflineSales();
    setPendingOfflineSales(queue.length);
    setBlockedOfflineSales(queue.filter(sale => sale.blocked).length);
    if (result.failed > 0) alert('Bazı çevrimdışı satışlar hâlâ eşitlenemedi. Ürün stoklarını ve müşteri bilgilerini kontrol et.');
  }

  function addToCart(product: Product) {
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        if (!product.unlimited_stock && existing.quantity >= product.stock) {
          return prev;
        }
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      if (!product.unlimited_stock && product.stock <= 0) return prev;
      return [...prev, { product, quantity: 1 }];
    });
  }

  function applyQuantity(productId: string, rawValue: string) {
    const parsed = Number(rawValue);
    if (!rawValue.trim() || !Number.isSafeInteger(parsed) || parsed < 1) return;
    setCart((prev) => prev.map((item) => {
      if (item.product.id !== productId) return item;
      const max = item.product.unlimited_stock
        ? Number.MAX_SAFE_INTEGER
        : Math.max(1, Math.floor(Number(item.product.stock) || 1));
      return { ...item, quantity: Math.min(parsed, max) };
    }));
  }

  function updateQuantityDraft(productId: string, rawValue: string) {
    setQuantityDrafts((prev) => ({ ...prev, [productId]: rawValue }));
    // Allow the field to be cleared while the user replaces the whole number.
    // Valid whole numbers update the cart immediately; blanks/partial input do not.
    if (rawValue.trim()) applyQuantity(productId, rawValue);
  }

  function commitQuantityDraft(productId: string, rawValue: string) {
    if (rawValue.trim()) applyQuantity(productId, rawValue);
    setQuantityDrafts((prev) => {
      const next = { ...prev };
      delete next[productId];
      return next;
    });
  }

  function removeFromCart(productId: string) {
    setCart((prev) => prev.filter((i) => i.product.id !== productId));
    setQuantityDrafts((prev) => { const next = { ...prev }; delete next[productId]; return next; });
  }

  function clearCart() {
    setCart([]);
    setQuantityDrafts({});
  }

  function persistHeldSales(next: {id:string; created_at:string; items:CartItem[]; held_by?:string; hold_name?:string}[]) {
    setHeldSales(next);
    try { localStorage.setItem('propos-held-sales-v1', JSON.stringify(next)); } catch {}
  }

  function holdCurrentSale() {
    if (!cart.length) return;
    setHoldNameDraft('');
    setShowHoldNameDialog(true);
  }

  function confirmHoldCurrentSale() {
    const holdName = holdNameDraft.trim();
    if (!holdName) return;
    let heldBy = 'Bilinmeyen personel';
    try { heldBy = JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null')?.name || heldBy; } catch {}
    const entry = { id: crypto.randomUUID(), created_at: new Date().toISOString(), held_by: heldBy, hold_name: holdName, items: cart.map(i => ({ ...i })) };
    persistHeldSales([entry, ...heldSales]);
    setCart([]);
    setQuantityDrafts({});
    setShowHoldNameDialog(false);
    setShowHeldSales(false);
    searchRef.current?.focus();
  }

  function resumeHeldSale(id: string) {
    const entry = heldSales.find(x => x.id === id);
    if (!entry) return;
    if (cart.length) {
      const replace = window.confirm('Mevcut sepet var. Bekletilen satışı geri yüklemek mevcut sepeti değiştirecek. Devam edilsin mi?');
      if (!replace) return;
    }
    setCart(entry.items);
    setQuantityDrafts({});
    persistHeldSales(heldSales.filter(x => x.id !== id));
    setShowHeldSales(false);
    searchRef.current?.focus();
  }

  function deleteHeldSale(id: string) {
    if (!window.confirm('Bekletilen satış silinsin mi?')) return;
    persistHeldSales(heldSales.filter(x => x.id !== id));
  }

  function handleBarcodeScan(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && search.trim()) {
      const code=search.trim(); const match = products.find((p) => p.barcode === code || (p.additional_barcodes || []).includes(code));
      if (match) {
        addToCart(match);
        setSearch('');
      }
    }
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Products Section */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Search Bar */}
        <div className="border-b border-slate-200 bg-white px-4 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
            <input
              ref={searchRef}
              type="text"
              className="input pl-10 text-lg"
              placeholder="Ürün ara veya barkod tara..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleBarcodeScan}
            />
          </div>
        </div>

        {/* 4.6 bağlantı / senkronizasyon durumu */}
        <div className={`flex flex-wrap items-center justify-between gap-2 border-t px-4 py-1.5 text-xs font-semibold ${
          isOnline && pendingOfflineSales === 0 ? 'border-emerald-100 bg-emerald-50 text-emerald-700' : 'border-amber-100 bg-amber-50 text-amber-800'
        }`}>
          <span className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${isOnline && pendingOfflineSales === 0 ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {!isOnline ? 'Çevrimdışı • Satışlar cihazda güvenli kuyruğa alınıyor' : pendingOfflineSales > 0 ? 'Bulut senkronizasyonu bekleniyor • Satışlar cihazda kuyrukta' : 'Çevrimiçi • Satışlar Supabase’e kaydediliyor'}
          </span>
          <div className="flex items-center gap-2">
            {pendingOfflineSales > 0 && <span className="rounded-full bg-white px-2 py-0.5 shadow-sm">Bekleyen: {pendingOfflineSales}</span>}
            {blockedOfflineSales > 0 && <button disabled={!isOnline} onClick={() => void handleRetryBlockedOfflineSales()} className="rounded-md border border-amber-300 bg-white px-2 py-1 text-amber-800 disabled:opacity-50">Kontrol gerektiren: {blockedOfflineSales} · Yeniden dene</button>}
          </div>
        </div>

        {/* Quick-access product filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-2">
          <span className="mr-1 text-xs font-bold uppercase tracking-wide text-slate-400">Hızlı ürünler</span>
          <button onClick={() => setQuickFilter('all')} className={`rounded-full px-3 py-1.5 text-xs font-bold ${quickFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>Tüm Ürünler</button>
          <button onClick={() => setQuickFilter('favorites')} className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold ${quickFilter === 'favorites' ? 'bg-amber-400 text-slate-950' : 'bg-amber-50 text-amber-800 hover:bg-amber-100'}`}><Star size={13} fill="currentColor"/> Yıldızlı ({favoriteIds.length})</button>
          <button onClick={() => setQuickFilter('unbarcoded')} className={`inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-bold ${quickFilter === 'unbarcoded' ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-800 hover:bg-blue-100'}`}><Star size={13} fill="currentColor"/> Yıldızlı etiketsiz ({products.filter(p => favoriteIds.includes(p.id) && !(p.barcode || '').trim() && !(p.additional_barcodes || []).length).length})</button>
        </div>

        {/* Categories */}
        <div className="flex gap-2 overflow-x-auto border-b border-slate-200 bg-white px-4 py-2">
          <button
            className={`btn px-4 py-2 text-sm whitespace-nowrap ${
              activeCategory === null ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
            onClick={() => setActiveCategory(null)}
          >
            Tümü
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              className={`btn px-4 py-2 text-sm whitespace-nowrap ${
                activeCategory === cat.id ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              onClick={() => setActiveCategory(cat.id)}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Product Grid */}
        <div className="flex-1 overflow-y-auto bg-slate-50 p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-slate-400">Ürünler yükleniyor...</div>
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
              <Search size={48} />
              <p>Ürün bulunamadı</p>
              <button className="btn-secondary text-sm" onClick={() => onNavigate('products')}>
                Ürün eklemek için tıklayın
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
              {filteredProducts.map((product) => (
                <button
                  key={product.id}
                  onClick={() => addToCart(product)}
                  className="card group flex flex-col p-3 text-left transition-all hover:border-teal-400 hover:shadow-md active:scale-95"
                >
                  <div className="mb-2 flex items-start justify-between gap-1">
                    <h3 className="line-clamp-2 text-sm font-semibold text-slate-700">
                      {product.name}
                    </h3>
                    {isFavorite(product.id) && <Star size={15} className="shrink-0 text-amber-500" fill="currentColor" />}
                  </div>
                  <div className="mt-auto">
                    <p className="text-lg font-bold text-teal-700">
                      {formatCurrency(campaignUnitPrice(product, 1).price)}
                    </p>
                    {campaignUnitPrice(product, 1).price < getEffectivePrice(product) && <p className="text-[10px] font-bold text-emerald-600">KAMPANYA</p>}
                    <p className={`text-xs ${!product.unlimited_stock && product.stock <= product.min_stock ? 'text-red-500 font-medium' : 'text-slate-400'}`}>
                      Stok: {product.unlimited_stock ? 'Sınırsız' : product.stock} {product.unit}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cart Section */}
      <div className="flex w-96 flex-col border-l border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShoppingCart className="text-teal-600" size={22} />
            <h2 className="text-lg font-bold text-slate-800">Sepet</h2>
            {cartCount > 0 && (
              <span className="rounded-full bg-teal-100 px-2 py-0.5 text-xs font-bold text-teal-700">
                {cartCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHeldSales(true)}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50"
              title="Bekletilen satışları görüntüle"
            >
              <PlayCircle size={15}/> Bekletilen ({heldSales.length})
            </button>
            <button
              onClick={holdCurrentSale}
              disabled={cart.length === 0}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold text-amber-600 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-40"
              title={cart.length ? 'Mevcut satışı askıya al' : 'Askıya almak için sepete ürün ekleyin'}
            >
              <PauseCircle size={16}/> Askıya Al
            </button>
            {cart.length > 0 && (
              <button onClick={clearCart} className="rounded-lg px-2 py-1.5 text-sm text-red-500 hover:bg-red-50 hover:text-red-600">
                Temizle
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {cart.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-300">
              <ShoppingCart size={48} />
              <p className="text-sm">Sepet boş</p>
              <p className="text-xs">Ürün seçerek başlayın</p>
            </div>
          ) : (
            <div className="space-y-2">
              {cart.map((item) => (
                <div
                  key={item.product.id}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 animate-fade-in"
                >
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700">
                      {item.product.name}
                    </p>
                    <p className="text-xs text-slate-500">
                      {formatCurrency(campaignUnitPrice(item.product, item.quantity).price * (1 - (Number(item.discountPercent || 0) / 100)))} x {item.quantity}
                    </p>
                    <div className="mt-1 flex items-center gap-1"><span className="text-[11px] text-slate-400">İsk.%</span><input aria-label="İskonto yüzdesi" type="number" min="0" max="100" step="1" className="h-6 w-14 rounded border border-slate-200 px-1 text-xs" value={item.discountPercent || ''} onChange={e=>{const v=Math.max(0,Math.min(100,Number(e.target.value)||0));setCart(prev=>prev.map(i=>i.product.id===item.product.id?{...i,discountPercent:v}:i));}} /></div>
                  </div>
                  <div className="flex flex-col items-center gap-0.5">
                    <label htmlFor={`cart-quantity-${item.product.id}`} className="text-[10px] font-semibold text-slate-400">Adet</label>
                    <input
                      id={`cart-quantity-${item.product.id}`}
                      aria-label={`${item.product.name} adet`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={item.product.unlimited_stock ? undefined : Math.max(1, item.product.stock)}
                      step={1}
                      value={quantityDrafts[item.product.id] ?? String(item.quantity)}
                      onChange={(event) => updateQuantityDraft(item.product.id, event.target.value)}
                      onBlur={(event) => commitQuantityDraft(item.product.id, event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                      className="h-8 w-[4.25rem] rounded-md border border-slate-300 bg-white px-1 text-center text-sm font-bold text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>
                  <p className="w-20 text-right text-sm font-bold text-teal-700">
                    {formatCurrency(campaignUnitPrice(item.product, item.quantity).price * (1 - (Number(item.discountPercent || 0) / 100)) * item.quantity)}
                  </p>
                  <button
                    onClick={() => removeFromCart(item.product.id)}
                    className="text-slate-300 hover:text-red-500"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cart Total */}
        <div className="border-t border-slate-200 p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-slate-500">Toplam</span>
            <span className="text-2xl font-bold text-slate-800">
              {formatCurrency(cartTotal)}
            </span>
          </div>
          <button
            disabled={cart.length === 0}
            onClick={() => setShowPayment(true)}
            className="btn-success w-full py-3 text-lg"
          >
            <CreditCard size={22} />
            Ödemeye Geç
          </button>
        </div>
      </div>

      {showHoldNameDialog && (
        <div className="propos-modal-overlay fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => setShowHoldNameDialog(false)}>
          <form className="propos-modal-content card w-full max-w-md p-5" onSubmit={(event) => { event.preventDefault(); confirmHoldCurrentSale(); }} onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-lg font-black text-slate-800">Satışı Askıya Al</h2><p className="text-sm text-slate-500">Müşteri adı veya satış için kısa bir not yaz.</p></div><button type="button" onClick={() => setShowHoldNameDialog(false)} className="text-slate-400"><X size={20}/></button></div>
            <label className="label" htmlFor="held-sale-name">Satış adı</label>
            <input id="held-sale-name" autoFocus className="input" value={holdNameDraft} onChange={(event) => setHoldNameDraft(event.target.value)} placeholder="Örn. Mehmet müşteri / telefonla sipariş" maxLength={80} />
            <div className="mt-4 flex gap-2"><button type="button" className="btn-secondary flex-1 py-2.5" onClick={() => setShowHoldNameDialog(false)}>Vazgeç</button><button type="submit" className="btn-primary flex-1 py-2.5" disabled={!holdNameDraft.trim()}>İsmi Kaydet ve Askıya Al</button></div>
          </form>
        </div>
      )}

      {showHeldSales && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setShowHeldSales(false)}>
          <div className="card w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Bekletilen Satışlar</h2>
                <p className="text-sm text-slate-500">Ödemeyi daha sonra tamamlamak için askıya aldığın sepetler.</p>
              </div>
              <button onClick={() => setShowHeldSales(false)} className="text-slate-400 hover:text-slate-600"><X size={22}/></button>
            </div>
            <div className="max-h-[60vh] space-y-2 overflow-y-auto">
              {heldSales.length === 0 ? <div className="rounded-lg bg-slate-50 p-6 text-center text-sm text-slate-400">Bekletilen satış yok.</div> : heldSales.map((entry) => {
                const total = entry.items.reduce((sum, item) => sum + campaignUnitPrice(item.product, item.quantity).price * (1 - (Number(item.discountPercent || 0) / 100)) * item.quantity, 0);
                return <div key={entry.id} className="rounded-xl border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div><p className="font-black text-slate-800">{entry.hold_name || 'İsimsiz satış'}</p><p className="text-xs font-semibold text-slate-600">{entry.items.length} ürün · {entry.items.reduce((n,i)=>n+i.quantity,0)} adet</p><p className="text-xs text-slate-400">{new Date(entry.created_at).toLocaleString('tr-TR')}</p><p className="text-xs font-semibold text-slate-500">Askıya alan: {entry.held_by || 'Eski kayıt'}</p></div>
                    <p className="font-bold text-teal-700">{formatCurrency(total)}</p>
                  </div>
                  <div className="mb-3 text-xs text-slate-500">{entry.items.map(i => `${i.quantity}× ${i.product.name}`).join(' · ')}</div>
                  <div className="flex gap-2"><button onClick={() => resumeHeldSale(entry.id)} className="btn-primary flex-1 py-2"><PlayCircle size={16}/> Geri Al</button><button onClick={() => deleteHeldSale(entry.id)} className="btn-secondary py-2 text-red-600">Sil</button></div>
                </div>;
              })}
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {showPayment && (
        <PaymentModal
          total={cartTotal}
          customers={customers}
          onClose={() => {
            if (processingSaleRef.current) return;
            setShowPayment(false);
            setSaleFeedback('');
          }}
          processing={processingSale}
          statusMessage={saleFeedback}
          onComplete={async (method, paid, customerName, customerId, splits, debtOffset) => {
            if (processingSaleRef.current || processingSale) return;
            if (debtOffset && !navigator.onLine) {
              setSaleFeedback('Fazla parayı veresiye borcundan düşmek için internet gerekir. Bağlantı gelince yeniden dene; satış kaydedilmedi.');
              return;
            }
            processingSaleRef.current = true;
            setProcessingSale(true);
            setSaleFeedback('');
            const offlineItems = cart.map(i => ({
              ...i,
              fixedUnitPrice: campaignUnitPrice(i.product, i.quantity).price * (1 - (Number(i.discountPercent||0)/100)),
            }));
            const fingerprint = JSON.stringify({
              items: offlineItems.map(i => [i.product.id, i.quantity, Number(i.fixedUnitPrice || 0)]),
              method, paid: Number(paid || 0), customerId: customerId || null,
              splits: (splits || []).map(split => [split.method, Number(split.amount || 0), split.customerId || null]),
              debtOffset: debtOffset ? [debtOffset.customerId, Number(debtOffset.amount || 0)] : null,
            });
            const saleRequestId = saleAttemptRef.current?.fingerprint === fingerprint
              ? saleAttemptRef.current.id
              : (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `sale-${Date.now()}-${Math.random().toString(36).slice(2)}`);
            saleAttemptRef.current = { fingerprint, id: saleRequestId };
            const saleAbortController = new AbortController();
            let saleTimedOut = false;
            let rejectSaleTimeout: ((reason?: unknown) => void) | undefined;
            const saleTimeoutPromise = new Promise<never>((_resolve, reject) => { rejectSaleTimeout = reject; });
            const saleTimeoutId = window.setTimeout(() => {
              saleTimedOut = true;
              saleAbortController.abort();
              rejectSaleTimeout?.(new Error('Satış isteği 20 saniye içinde yanıt vermedi.'));
            }, 20000);
            const saveToOfflineQueue = () => {
              if (debtOffset) {
                alert('Fazla parayı veresiye borcundan düşme işlemi internet gerektirir. Satış kuyruğa alınmadı; bağlantı geldiğinde işlemi yeniden yap.');
                return false;
              }
              const queued = queueOfflineSale({ items: offlineItems, paymentMethod: method, paidAmount: paid, customerName, customerId, paymentSplits: splits }, saleRequestId);
              if (queued) {
                setPendingOfflineSales(getOfflineSales().length);
                const createdAt = new Date().toISOString();
                const total = Number(offlineItems.reduce((sum, item) => sum + Number(item.fixedUnitPrice || 0) * Number(item.quantity || 0), 0).toFixed(2));
                const originalTotal = Number(offlineItems.reduce((sum, item) => sum + Number(item.product.price || 0) * Number(item.quantity || 0), 0).toFixed(2));
                let queuedStaff: { id?: string; name?: string } | null = null;
                try { queuedStaff = JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null'); } catch {}
                const localReceipt: SaleWithItems = {
                  id: saleRequestId,
                  total,
                  payment_method: method,
                  customer_name: customerName || null,
                  customer_id: customerId || null,
                  paid_amount: method === 'split'
                    ? (splits ?? []).filter(split => ['cash','card','iban'].includes(split.method)).reduce((sum, split) => sum + Number(split.amount || 0), 0)
                    : Number(paid || 0),
                  created_at: createdAt,
                  deleted_at: null,
                  deleted_reason: null,
                  settled_at: null,
                  refunded_at: null,
                  refund_amount: 0,
                  refund_reason: null,
                  original_total: originalTotal,
                  discount_total: Number((originalTotal - total).toFixed(2)),
                  payment_note: 'ÇEVRİMDIŞI · SENKRONİZASYON BEKLİYOR',
                  staff_id: queuedStaff?.id || null,
                  sale_items: offlineItems.map((item, index) => {
                    const unitPrice = Number(item.fixedUnitPrice ?? item.product.price);
                    return {
                      id: `${saleRequestId}-${index}`,
                      sale_id: saleRequestId,
                      product_id: item.product.id,
                      product_name: item.product.name,
                      barcode: item.product.barcode,
                      quantity: Number(item.quantity),
                      unit_price: unitPrice,
                      subtotal: Number((unitPrice * Number(item.quantity)).toFixed(2)),
                      original_unit_price: Number(item.product.price),
                      discount_amount: Number(((Number(item.product.price) - unitPrice) * Number(item.quantity)).toFixed(2)),
                      cost_at_sale: Number(item.product.cost || 0),
                      cost_is_estimated: true,
                    };
                  }),
                };
                saleAttemptRef.current = null;
                setSaleFeedback('');
                setLastSale(localReceipt);
                setLastSaleChange(method === 'cash' ? Math.max(0, Number(paid || 0) - total) : null);
                setShowReceipt(true);
                clearCart(); setShowPayment(false);
                return true;
              }
              setSaleFeedback('Satış çevrimdışı kuyruğa alınamadı. Ürün önbelleğini ve stok miktarını kontrol et; satış tamamlanmadı.');
              return false;
            };
            try {
              let sale: SaleWithItems | null;
              try {
                sale = await Promise.race([
                  completeSale(cart, method, paid, customerName, customerId, splits, saleRequestId, undefined, saleAbortController.signal),
                  saleTimeoutPromise,
                ]);
              } catch (saleError) {
                const detail = saleError instanceof Error ? saleError.message : 'Bilinmeyen satış hatası.';
                const looksLikeNetworkFailure = !navigator.onLine || /failed to fetch|err_internet_disconnected|networkerror|load failed|fetch failed|network request failed|timeout|abort/i.test(detail);
                console.error('Satış tamamlanamadı:', detail, saleError);
                if (!navigator.onLine) {
                  const queued = saveToOfflineQueue();
                  if (!queued) setSaleFeedback('İnternet kesildi ve satış kuyruğa alınamadı. Sepet korunuyor; bağlantı gelince tekrar dene.');
                } else if (saleTimedOut || saleAbortController.signal.aborted) {
                  // The server may have committed just before the response was lost. Keep the
                  // same client reference for a safe retry; do not create a parallel queued sale.
                  setSaleFeedback('Sunucu 20 saniyede yanıt vermedi. Sepet korunuyor. Aynı işlem kimliği kullanılacağı için satış geçmişini kontrol etmeden başka bir satış açma; bağlantı düzeldiğinde aynı işlemi güvenle tekrar deneyebilirsin.');
                } else if (looksLikeNetworkFailure) {
                  const queued = saveToOfflineQueue();
                  if (!queued) setSaleFeedback('Bağlantı sorunu nedeniyle satış tamamlanamadı. Sepet korunuyor; bağlantıyı kontrol et.');
                } else {
                  setSaleFeedback(detail || 'Satış tamamlanamadı. Sepet korunuyor.');
                }
                return;
              }
              if (!sale && !navigator.onLine && debtOffset) {
                alert('İşlem sırasında internet bağlantısı kesildi. Veresiye borcundan düşüm işlemi satışla birlikte tamamlanamadığı için satış kuyruğa alınmadı. Bağlantı geldiğinde işlemi yeniden yap.');
                return;
              }
              if (!sale && !navigator.onLine) {
                saveToOfflineQueue();
                return;
              }
              if (sale) {
                let saleForReceipt = sale;
                let receiptChange: number | null = null;
                if (debtOffset) {
                  const saleChange = Math.max(0, Number(paid) - Number(sale.total || 0));
                  receiptChange = saleChange;
                  let staffId: string | undefined;
                  try { staffId = (JSON.parse(sessionStorage.getItem('propos-current-staff-v2') || 'null') as { id?: string } | null)?.id || undefined; } catch {}
                  try {
                    const collection = await payCustomerDebt(
                      debtOffset.customerId,
                      debtOffset.amount,
                      `Satış ${sale.id.slice(-8).toUpperCase()} sırasında fazla alınan nakit veresiye borcundan düşüldü`,
                      staffId,
                    );
                    const applied = collection.success ? Number(collection.amount || 0) : 0;
                    const changeDue = Math.max(0, Number((saleChange - applied).toFixed(2)));
                    receiptChange = changeDue;
                    if (!collection.success) {
                      alert(`Satış tamamlandı ancak veresiye borcundan düşüm yapılamadı. Müşteriye ${formatCurrency(saleChange)} para üstü verin ve veresiye tahsilatını ayrıca kontrol edin.`);
                    } else {
                      // The excess is a separate customer-debt collection, not part of this sale's payment.
                      // Store the actual sale payment amount; the receipt receives changeDue separately.
                      const { error: paidAmountError } = await supabase.from('sales').update({ paid_amount: Number(sale.total || 0) }).eq('id', sale.id);
                      if (paidAmountError) console.warn('Satışın net ödenen tutarı güncellenemedi:', paidAmountError);
                      saleForReceipt = { ...sale, paid_amount: Number(sale.total || 0) };
                      alert(`${formatCurrency(applied)} veresiye borcundan düşüldü.${changeDue > 0.009 ? ` Müşteriye ${formatCurrency(changeDue)} para üstü verin.` : ''}`);
                    }
                  } catch (debtError) {
                    console.error('Fazla para veresiye borcundan düşülemedi:', debtError);
                    receiptChange = saleChange;
                    alert(`Satış tamamlandı ancak veresiye borcu güncellenemedi. Müşteriye ${formatCurrency(saleChange)} para üstü verin ve cari bakiyeyi kontrol edin.`);
                  }
                }
                saleAttemptRef.current = null;
                setSaleFeedback('');
                setLastSaleChange(receiptChange);
                setLastSale(saleForReceipt);
                setShowReceipt(true);
                clearCart();
                setShowPayment(false);
              } else {
                setSaleFeedback('Satış kaydedilemedi. Sepet korunuyor. Bağlantıyı ve ürün stoklarını kontrol et; satış geçmişini kontrol etmeden işlemi tekrar tekrar gönderme.');
              }
            } finally {
              window.clearTimeout(saleTimeoutId);
              processingSaleRef.current = false;
              setProcessingSale(false);
            }
          }}
        />
      )}

      {/* Receipt Modal */}
      {showReceipt && lastSale && (
        <ReceiptModal
          sale={lastSale}
          offlinePending={Boolean(lastSale && getOfflineSales().some((queued) => queued.queue_id === lastSale.id))}
          onClose={() => {
            setShowReceipt(false);
            setLastSale(null);
            setLastSaleChange(null);
          }}
          changeDue={lastSaleChange ?? undefined}
          onNewSale={() => {
            setShowReceipt(false);
            setLastSale(null);
            setLastSaleChange(null);
            searchRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

function PaymentModal({
  total,
  customers,
  onClose,
  onComplete,
  processing,
  statusMessage,
}: {
  total: number;
  customers: { id: string; name: string; balance: number }[];
  onClose: () => void;
  processing: boolean;
  statusMessage?: string;
  onComplete: (method: PaymentMethod, paid: number, customerName?: string, customerId?: string, splits?: PaymentSplit[], debtOffset?: { customerId: string; amount: number }) => Promise<void>;
}) {
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [paidAmount, setPaidAmount] = useState('');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [cashPart, setCashPart] = useState('');
  const [cardPart, setCardPart] = useState('');
  const [ibanPart, setIbanPart] = useState('');
  const [creditPart, setCreditPart] = useState('');
  const [remainderMethod, setRemainderMethod] = useState<'cash'|'card'|'iban'|'credit'>('card');
  const [applyChangeToDebt, setApplyChangeToDebt] = useState(false);
  const [carryShortfallToDebt, setCarryShortfallToDebt] = useState(false);
  const [error, setError] = useState('');

  const paid = parseFloat(paidAmount) || 0;
  const change = method === 'cash' ? Math.max(0, paid - total) : 0;
  const splitEntered = { cash: Number(cashPart) || 0, card: Number(cardPart) || 0, iban: Number(ibanPart) || 0, credit: Number(creditPart) || 0 };
  const splitParts = { ...splitEntered, [remainderMethod]: Math.max(0, Number((total - (Object.entries(splitEntered).filter(([key]) => key !== remainderMethod).reduce((sum, [, value]) => sum + value, 0))).toFixed(2))) } as Record<'cash'|'card'|'iban'|'credit', number>;
  const customersWithDebt = customers.filter((customer) => Number(customer.balance || 0) > 0.009);
  const selectedDebtCustomer = customersWithDebt.find((customer) => customer.id === selectedCustomerId);
  const debtOffsetAmount = applyChangeToDebt && selectedDebtCustomer ? Math.min(change, Number(selectedDebtCustomer.balance || 0)) : 0;
  const remainingChange = Math.max(0, Number((change - debtOffsetAmount).toFixed(2)));
  const cashQuickAmounts = [...new Set([total, Math.ceil(total / 50) * 50, Math.ceil(total / 100) * 100, Math.ceil(total / 200) * 200].map((amount) => Number(amount.toFixed(2))))];

  async function handleSubmit() {
    setError('');
    try {
    if (method === 'cash' && paid < total) {
      if (!carryShortfallToDebt) { setError('Kalan tutar için “Az kalan parayı veresiyeye taşı” seçeneğini işaretleyin.'); return; }
      if (!selectedCustomerId) { setError('Veresiye için kayıtlı müşteri seçin.'); return; }
      const customer = customers.find((c) => c.id === selectedCustomerId);
      const shortfall = Number((total - paid).toFixed(2));
      const splits: PaymentSplit[] = [];
      if (paid > 0) splits.push({ method: 'cash', amount: paid });
      if (shortfall > 0) splits.push({ method: 'credit', amount: shortfall, customerId: selectedCustomerId, customerName: customer?.name });
      await onComplete('split', paid, customer?.name, selectedCustomerId, splits); return;
    }
    if (method === 'cash' && applyChangeToDebt) {
      if (!navigator.onLine) { setError('Bu işlem için internet bağlantısı gerekir.'); return; }
      if (change <= 0) { setError('Aktarılacak fazla para yok.'); return; }
      if (!selectedDebtCustomer) { setError('Veresiye borcu olan müşteriyi seçin.'); return; }
      const offset = Math.min(change, Number(selectedDebtCustomer.balance || 0));
      if (offset <= 0) { setError('Seçilen müşterinin açık borcu yok.'); return; }
      await onComplete('cash', paid, selectedDebtCustomer.name, selectedDebtCustomer.id, undefined, { customerId: selectedDebtCustomer.id, amount: offset });
      return;
    }
    if (method === 'credit') {
      if (!selectedCustomerId) { setError('Veresiye için kayıtlı bir müşteri seçin.'); return; }
      const cust = customers.find((c) => c.id === selectedCustomerId);
      await onComplete(method, total, cust?.name, selectedCustomerId); return;
    }
    if (method === 'split') {
      const totalSplit = Object.values(splitParts).reduce((sum, value) => sum + value, 0);
      if (Math.abs(totalSplit - total) > 0.01) { setError(`Karma ödeme toplamı ${formatCurrency(total)} olmalı.`); return; }
      if (splitParts.credit > 0 && !selectedCustomerId) { setError('Veresiye kısmı için müşteri seçin.'); return; }
      const cust = customers.find(c => c.id === selectedCustomerId);
      const splits: PaymentSplit[] = (['cash','card','iban','credit'] as const).filter(key => splitParts[key] > 0).map(key => ({ method: key, amount: splitParts[key], ...(key === 'credit' ? { customerId: selectedCustomerId, customerName: cust?.name } : {}) }));
      await onComplete('split', splitParts.cash + splitParts.card + splitParts.iban, cust?.name, selectedCustomerId, splits); return;
    }
    await onComplete(method, method === 'cash' ? paid : total);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Satış işlemi başlatılamadı.');
    }
  }

  function quickAmount(val: number) {
    setPaidAmount(val.toFixed(2));
    setError('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-3 backdrop-blur-sm animate-fade-in" onClick={() => { if (!processing) onClose(); }}>
      <div
        className="payment-modal-card card w-full max-w-lg max-h-[92vh] overflow-y-auto p-5 sm:p-6 animate-slide-up"
        aria-busy={processing}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><CreditCard size={20}/></span><div><h2 className="text-xl font-extrabold text-slate-900">Ödeme</h2><p className="mt-0.5 text-xs text-slate-500">İşlemi kontrol et ve satışı tamamla</p></div></div>
          <button disabled={processing} onClick={onClose} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" aria-label="Ödemeyi kapat">
            <X size={22} />
          </button>
        </div>

        <div className="mb-6 rounded-lg bg-teal-50 p-4 text-center">
          <p className="text-sm text-teal-600">Ödenecek Tutar</p>
          <p className="text-3xl font-bold text-teal-700">{total === 0 ? 'ÜCRETSİZ' : formatCurrency(total)}</p>
        </div>

        {/* Payment Methods */}
        <div className="mb-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
          {(['cash', 'card', 'iban', 'credit', 'split'] as PaymentMethod[]).map((key) => {
            const val = key === 'split' ? {label:'Karma'} : PAYMENT_METHODS[key as keyof typeof PAYMENT_METHODS];
            const Icon = key === 'cash' ? Banknote : key === 'card' ? CreditCard : key === 'iban' ? Landmark : key === 'credit' ? BookOpen : Receipt;
            const activeClasses = {
              cash: 'border-emerald-500 bg-emerald-50 text-emerald-700',
              card: 'border-blue-500 bg-blue-50 text-blue-700',
              iban: 'border-cyan-500 bg-cyan-50 text-cyan-700',
              credit: 'border-amber-500 bg-amber-50 text-amber-700',
              split: 'border-violet-500 bg-violet-50 text-violet-700',
            }[key];
            return (
              <button
                key={key}
                onClick={() => { setMethod(key); setError(''); }}
                className={`flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-all ${
                  method === key ? activeClasses : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                }`}
              >
                <Icon size={24} />
                <span className="text-sm font-medium">{val.label}</span>
              </button>
            );
          })}
        </div>

        {/* Cash Payment */}
        {method === 'cash' && (
          <div className="mb-4">
            <label className="label">Alınan Para</label>
            <input
              type="number"
              className="input text-lg"
              placeholder="0.00"
              value={paidAmount}
              onChange={(e) => { setPaidAmount(e.target.value); setError(''); }}
              autoFocus
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {cashQuickAmounts.map((val, i) => (
                <button
                  key={i}
                  onClick={() => quickAmount(val)}
                  className="btn-secondary px-3 py-1.5 text-sm"
                >
                  {formatCurrency(val)}
                </button>
              ))}
            </div>
            {paid >= total && (
              <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3 text-center">
                <p className="text-sm text-emerald-700">Para Üstü</p>
                <p className="text-xl font-bold text-emerald-800">{formatCurrency(remainingChange)}</p>
                {applyChangeToDebt && debtOffsetAmount > 0 && <p className="mt-1 text-xs font-semibold text-blue-700">{formatCurrency(debtOffsetAmount)} veresiye borcundan düşülecek</p>}
              </div>
            )}
            <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50/70 p-3">
              <label className={`flex items-start gap-2.5 ${customersWithDebt.length ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-blue-600"
                  checked={applyChangeToDebt}
                  disabled={customersWithDebt.length === 0}
                  onChange={(e) => { setApplyChangeToDebt(e.target.checked); setError(''); }}
                />
                <span>
                  <span className="block text-sm font-bold text-slate-800">Fazla parayı veresiye borcundan düş</span>
                  
                </span>
              </label>
              {applyChangeToDebt && (
                <div className="mt-3 space-y-2">
                  <label className="label">Veresiye müşterisi</label>
                  <select className="input bg-white" value={selectedCustomerId} onChange={(e) => { setSelectedCustomerId(e.target.value); setError(''); }}>
                    <option value="">— Borcu olan müşteriyi seç —</option>
                    {customersWithDebt.map((customer) => <option key={customer.id} value={customer.id}>{customer.name} · Borç {formatCurrency(customer.balance)}</option>)}
                  </select>
                  {selectedDebtCustomer && paid >= total && change > 0 && (
                    <div className="rounded-lg bg-white p-2.5 text-xs text-slate-700">
                      <div className="flex justify-between gap-2"><span>Borçtan düşülecek</span><b className="text-blue-700">{formatCurrency(debtOffsetAmount)}</b></div>
                      <div className="mt-1 flex justify-between gap-2"><span>Müşteriye verilecek para üstü</span><b>{formatCurrency(remainingChange)}</b></div>
                    </div>
                  )}
                  {!navigator.onLine && <p className="text-xs text-amber-700">Bu işlem için internet bağlantısı gerekir.</p>}
                </div>
              )}
              <label className={`mt-3 flex items-center gap-2 text-sm font-semibold text-slate-700 ${paid < total ? 'cursor-pointer' : 'opacity-70'}`}>
                <input type="checkbox" className="h-4 w-4 accent-amber-600" checked={carryShortfallToDebt} onChange={e => { setCarryShortfallToDebt(e.target.checked); setError(''); }} />
                Az kalan parayı veresiyeye taşı
              </label>
              {carryShortfallToDebt && paid < total && <div className="mt-2"><label className="label">Veresiye müşterisi</label><select className="input bg-white" value={selectedCustomerId} onChange={e => { setSelectedCustomerId(e.target.value); setError(''); }}><option value="">Müşteri seç</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select><p className="mt-1 text-xs text-amber-700">Veresiye yazılacak: {formatCurrency(Math.max(0, total - paid))}</p></div>}
            </div>
          </div>
        )}

        {method === 'split' && (
          <div className="mb-4 rounded-lg border border-violet-200 bg-violet-50 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-violet-800">Karma ödeme</p><label className="text-xs font-semibold text-violet-700">Kalan tutar <select className="ml-1 rounded-md border border-violet-200 bg-white px-2 py-1" value={remainderMethod} onChange={e => { const next=e.target.value as typeof remainderMethod; if(next==='cash')setCashPart('');if(next==='card')setCardPart('');if(next==='iban')setIbanPart('');if(next==='credit')setCreditPart('');setRemainderMethod(next);setError(''); }}><option value="cash">Nakit</option><option value="card">Kart</option><option value="iban">IBAN</option><option value="credit">Veresiye</option></select></label></div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {(['cash','card','iban','credit'] as const).map(key => { const labels={cash:'Nakit',card:'Kart',iban:'IBAN',credit:'Veresiye'}; const values={cash:cashPart,card:cardPart,iban:ibanPart,credit:creditPart}; const setters={cash:setCashPart,card:setCardPart,iban:setIbanPart,credit:setCreditPart}; return <div key={key}><label className="label">{labels[key]}{remainderMethod===key?' · Kalan':''}</label><input type="number" min="0" step="0.01" className="input" value={remainderMethod===key?(splitParts[key] ? splitParts[key].toFixed(2) : '0.00'):values[key]} readOnly={remainderMethod===key} onChange={e=>{setters[key](e.target.value);setError('');}} /></div>; })}
            </div>
            {splitParts.credit>0 && <div><label className="label">Veresiye müşterisi</label><select className="input bg-white" value={selectedCustomerId} onChange={e=>setSelectedCustomerId(e.target.value)}><option value="">Müşteri seç</option>{customers.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></div>}
            <p className="text-xs font-semibold text-violet-800">Dağıtılan: {formatCurrency(Object.values(splitParts).reduce((sum,value)=>sum+value,0))} / {formatCurrency(total)} · Kalan tutar otomatik hesaplanır.</p>
          </div>
        )}

        {/* Credit Payment */}
        {method === 'credit' && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <label className="label">Veresiye Müşterisi</label>
            <select
              className="input"
              value={selectedCustomerId}
              onChange={(e) => { setSelectedCustomerId(e.target.value); setError(''); }}
            >
              <option value="">— Kayıtlı müşteri seç —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {c.balance > 0 ? `(Mevcut borç: ${formatCurrency(c.balance)})` : ''}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-amber-700">Müşteri seçimi zorunlu. Böylece alınan ürünler, tarih/saat ve borç ödeme geçmişi müşteriye bağlanır.</p>
          </div>
        )}

        {error && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800"><span className="mt-0.5 font-black">!</span><span>{error}</span></div>}
        {statusMessage && <div role="status" className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-5 text-amber-900"><LoaderCircle size={17} className={`mt-0.5 shrink-0 ${processing ? 'animate-spin' : ''}`} /><span>{statusMessage}</span></div>}
        {processing && <div className="mb-3 flex items-center gap-3 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50 px-4 py-3 text-sm text-blue-900 shadow-sm"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white text-blue-700 shadow-sm"><LoaderCircle size={19} className="animate-spin"/></span><div><p className="font-bold">Satış güvenli şekilde kaydediliyor</p><p className="mt-0.5 text-xs leading-5 text-blue-700">Ekran kilitlenmeyecek. 20 saniye içinde yanıt gelmezse sepet korunup durum bildirilecek.</p></div></div>}
        <button onClick={() => void handleSubmit()} disabled={processing} className="btn-success w-full py-3.5 text-base font-extrabold disabled:cursor-not-allowed disabled:opacity-60">
          {processing ? <><LoaderCircle size={18} className="animate-spin"/> Satış kaydediliyor…</> : <><CreditCard size={19}/> Satışı Tamamla</>}
        </button>
      </div>
    </div>
  );
}

function ReceiptModal({
  sale,
  onClose,
  onNewSale,
  changeDue,
  offlinePending = false,
}: {
  sale: SaleWithItems;
  onClose: () => void;
  onNewSale: () => void;
  changeDue?: number;
  offlinePending?: boolean;
}) {
  const methodLabel = sale.payment_method === 'split' ? 'Karma' : (PAYMENT_METHODS[sale.payment_method as keyof typeof PAYMENT_METHODS]?.label || 'Ödeme');
  const saleItems = Array.isArray(sale.sale_items) ? sale.sale_items : [];
  const [design, setDesign] = useState<ReceiptDesign>(() => loadReceiptDesign());
  const [storeSettings, setStoreSettings] = useState<StoreSettings>(() => {
    try {
      const raw = localStorage.getItem('pos-settings');
      return { storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: 'Bizi tercih ettiğiniz için teşekkür ederiz!', taxRate: '0', lowStockDefault: '0', ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return { storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: 'Bizi tercih ettiğiniz için teşekkür ederiz!', taxRate: '0', lowStockDefault: '0' };
    }
  });

  useEffect(() => {
    let active = true;
    void loadStoreSettings({ storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: 'Bizi tercih ettiğiniz için teşekkür ederiz!', taxRate: '0', lowStockDefault: '0' })
      .then(value => { if (active) setStoreSettings(previous => ({ ...previous, ...value })); });
    const refreshDesign = () => setDesign(loadReceiptDesign());
    window.addEventListener('silopi-dijital-receipt-design-change', refreshDesign);
    return () => {
      active = false;
      window.removeEventListener('silopi-dijital-receipt-design-change', refreshDesign);
    };
  }, []);

  function handlePrint() {
    document.body.classList.add('printing-receipt', design.paperWidth === '58mm' ? 'receipt-paper-58' : 'receipt-paper-80');
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('printing-receipt', 'receipt-paper-58', 'receipt-paper-80');
    }, { once: true });
    window.print();
  }

  async function shareWhatsApp() {
    const lines = [
      `*${storeSettings.storeName || 'Silopi Dijital - ProPOS'}*`,
      ...(design.showPhone && storeSettings.storePhone ? [`Tel: ${storeSettings.storePhone}`] : []),
      ...(design.showAddress && storeSettings.storeAddress ? [storeSettings.storeAddress] : []),
      `*${design.title || 'SATIŞ FİŞİ'}*`,
      ...(design.showReceiptNo ? [`Fiş No: ${sale.id.slice(-8).toUpperCase()}${offlinePending ? ' (GEÇİCİ)' : ''}`] : []),
      ...(design.showDate ? [`Tarih: ${new Date(sale.created_at).toLocaleString('tr-TR')}`] : []),
      ...(offlinePending ? ['DURUM: Çevrimdışı kaydedildi; senkronizasyon bekliyor.'] : []),
      '--------------------------------',
      ...saleItems.map(i => `${i.quantity} x ${i.product_name}${design.showUnitPrice ? ` · Birim ${formatCurrency(Number(i.unit_price || 0))}` : ''} — ${formatCurrency(i.subtotal)}`),
      '--------------------------------',
      `TOPLAM: ${formatCurrency(sale.total)}`,
      ...(design.showPayment ? [`ÖDEME: ${methodLabel}`] : []),
      ...(design.showCustomer && sale.customer_name ? [`MÜŞTERİ: ${sale.customer_name}`] : []),
      ...(design.showFooter && storeSettings.receiptFooter ? ['', storeSettings.receiptFooter] : []),
    ];
    const url = `https://wa.me/?text=${encodeURIComponent(lines.filter(Boolean).join('\n'))}`;
    try {
      if (window.proposDesktop?.openExternal) await window.proposDesktop.openExternal(url);
      else { const opened = window.open(url, '_blank', 'noopener,noreferrer'); if (!opened) window.location.href = url; }
    } catch { window.location.href = url; }
  }

  return (
    <div className="receipt-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div
        className="receipt-print-area card w-full max-w-sm p-5 animate-slide-up"
        style={{ width: design.paperWidth === '58mm' ? '58mm' : '76mm', maxWidth: 'calc(100vw - 28px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <ReceiptLayout
          storeName={storeSettings.storeName || 'Mağazam'}
          storePhone={storeSettings.storePhone}
          storeAddress={storeSettings.storeAddress}
          receiptFooter={storeSettings.receiptFooter}
          design={design}
          receiptNo={`${sale.id.slice(-8).toUpperCase()}${offlinePending ? ' · GEÇİCİ' : ''}`}
          createdAt={sale.created_at}
          items={saleItems.map(item => ({ product_name: item.product_name, quantity: Number(item.quantity), unit_price: Number(item.unit_price || 0), subtotal: Number(item.subtotal || 0) }))}
          total={Number(sale.total || 0)}
          discountTotal={Number(sale.discount_total || 0)}
          paymentLabel={methodLabel}
          customerName={sale.customer_name}
          changeDue={changeDue ?? (sale.payment_method === 'cash' ? Math.max(0, Number(sale.paid_amount || 0) - Number(sale.total || 0)) : undefined)}
          offlinePending={offlinePending}
        />
        {offlinePending && <p className="mt-3 text-[10px] leading-4 text-amber-700">Bu geçici fişin aynı işlem kimliğiyle sunucuya aktarılması bekleniyor.</p>}
        <div className="receipt-no-print mt-4 flex gap-2">
          <button onClick={handlePrint} className="btn-secondary flex-1 py-2.5"><Printer size={18}/> Yazdır</button>
          <button onClick={shareWhatsApp} className="btn-secondary flex-1 py-2.5"><Share2 size={18}/> WhatsApp</button>
          <button onClick={onNewSale} className="btn-primary flex-1 py-2.5">Yeni Satış</button>
        </div>
      </div>
    </div>
  );
}
