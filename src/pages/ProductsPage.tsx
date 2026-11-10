import { useState } from 'react';
import { Plus, Pencil, Trash2, X, Search, Package, AlertTriangle, RotateCcw, Star } from 'lucide-react';
import { useProducts, useCategories, useSuppliers, addProduct, updateProduct, deleteProduct, useDeletedProducts, restoreProduct, addStock, setStock } from '@/lib/hooks';
import { formatCurrency, generateBarcode, parseLocalizedDecimal, productSearchScore } from '@/lib/utils';
import type { Product } from '@/lib/supabase';
import { loadSettings } from '@/pages/SettingsPage';
import { useProductFavorites } from '@/lib/productFavorites';

export default function ProductsPage() {
  const { products, loading, reload: reloadProducts } = useProducts();
  const { isFavorite, toggleFavorite } = useProductFavorites();
  const { products: deletedProducts, loading: trashLoading, reload: reloadTrash } = useDeletedProducts(200);
  const [showTrash, setShowTrash] = useState(false);
  const { categories } = useCategories();
  const { suppliers } = useSuppliers();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [stockProduct, setStockProduct] = useState<Product | null>(null);

  const filtered = !search.trim() ? products : products
    .map(product => {
      const nameScore = productSearchScore(search, product.name);
      const barcodeValues = [product.barcode || '', ...(product.additional_barcodes || [])].filter(Boolean);
      const barcodeScore = barcodeValues.reduce((best, value) => {
        const lowerQuery = search.trim().toLocaleLowerCase('tr-TR');
        const lowerValue = value.toLocaleLowerCase('tr-TR');
        const score = lowerValue.includes(lowerQuery) ? 0 : Number.POSITIVE_INFINITY;
        return Math.min(best, score);
      }, Number.POSITIVE_INFINITY);
      return { product, score: Math.min(nameScore, barcodeScore) };
    })
    .filter(row => !search.trim() || row.score <= Math.max(1, Math.min(3, search.trim().length <= 5 ? 1 : search.trim().length <= 10 ? 2 : 3)))
    .sort((a, b) => a.score - b.score || a.product.name.localeCompare(b.product.name, 'tr-TR'))
    .map(row => row.product);

  const lowStock = products.filter((p) => !p.unlimited_stock && p.stock <= p.min_stock);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Ürün Yönetimi</h1>
            <p className="text-sm text-slate-500">{products.length} ürün kayıtlı</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTrash(true)}
              className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              <Trash2 size={17} />
              Ürün Çöp Kutusu
              {deletedProducts.length > 0 && <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-xs text-red-600">{deletedProducts.length}</span>}
            </button>
            <button
              onClick={() => { setEditing(null); setShowForm(true); }}
              className="btn-primary px-4 py-2"
            >
              <Plus size={18} />
              Yeni Ürün
            </button>
          </div>
        </div>
      </div>

      {/* Low Stock Alert */}
      {lowStock.length > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 px-6 py-2 text-sm text-amber-700">
          <AlertTriangle size={16} />
          <span>{lowStock.length} üründe stok azaldı: </span>
          <span className="font-medium">{lowStock.slice(0, 3).map((p) => p.name).join(', ')}{lowStock.length > 3 ? '...' : ''}</span>
        </div>
      )}

      {/* Search */}
      <div className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
          <input
            type="text"
            className="input pl-10"
            placeholder="Ürün Arama"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Products Table */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex h-full items-center justify-center text-slate-400">Yükleniyor...</div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
            <Package size={48} />
            <p>Ürün bulunamadı</p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-center text-sm font-semibold text-slate-600">Yıldız</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-600">Ürün</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-600">Barkodlar</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-600">Kategori</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-slate-600">Tedarikçi</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-slate-600">Fiyat</th>
                  <th className="px-4 py-3 text-right text-sm font-semibold text-slate-600">Stok</th>
                  <th className="px-4 py-3 text-center text-sm font-semibold text-slate-600">İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const cat = categories.find((c) => c.id === product.category_id);
                  return (
                    <tr key={product.id} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-3 text-center">
                        <button type="button" title={isFavorite(product.id) ? 'Hızlı satış yıldızını kaldır' : 'Hızlı satış için yıldızla'} onClick={() => toggleFavorite(product.id)} className={`rounded-lg p-2 transition-colors ${isFavorite(product.id) ? 'text-amber-500 hover:bg-amber-50' : 'text-slate-300 hover:bg-amber-50 hover:text-amber-500'}`}>
                          <Star size={18} fill={isFavorite(product.id) ? 'currentColor' : 'none'} />
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-800">{product.name}</p>
                        <p className="text-xs text-slate-400">{product.unit}{product.unlimited_stock ? ' · Sınırsız stok' : ''}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-500 font-mono"><div>{product.barcode || product.additional_barcodes?.[0] || <span className="text-amber-600">Barkodsuz</span>}</div>{(product.additional_barcodes || []).length > (product.barcode ? 0 : 1) && <div className="mt-1 text-[10px] text-slate-400">+{product.additional_barcodes.length - (product.barcode ? 0 : 1)} ek barkod</div>}</td>
                      <td className="px-4 py-3 text-sm text-slate-500">{cat?.name || '-'}</td>
                      <td className="px-4 py-3 text-sm text-slate-500">{suppliers.find((s) => s.id === product.primary_supplier_id)?.name || '-'}</td>
                      <td className="px-4 py-3 text-right font-semibold text-teal-700">{formatCurrency(product.price)}</td>
                      <td className="px-4 py-3 text-right">
                        <span className={`text-sm font-medium ${!product.unlimited_stock && product.stock <= product.min_stock ? 'text-red-500' : 'text-slate-600'}`}>
                          {product.unlimited_stock ? 'Sınırsız' : product.stock}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-1">
                          {product.unlimited_stock ? (
                            <span className="rounded-md bg-indigo-50 px-2 py-1 text-[11px] font-semibold text-indigo-700" title="Bu üründe stok takibi kapalı">Sınırsız</span>
                          ) : (
                            <button title="Stok girişi" onClick={() => setStockProduct(product)} className="rounded-md px-2 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">+ Stok</button>
                          )}
                          <button
                            onClick={() => { setEditing(product); setShowForm(true); }}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-teal-600"
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            onClick={async () => {
                              if (confirm(`"${product.name}" ürününü çöp kutusuna taşımak istiyor musunuz? Ürün verisi silinmeyecek.`)) {
                                await deleteProduct(product.id);
                                await reloadProducts();
                                await reloadTrash();
                              }
                            }}
                            className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showTrash && (
        <ProductTrashModal
          products={deletedProducts}
          loading={trashLoading}
          onClose={() => setShowTrash(false)}
          onRestore={async (id) => {
            const ok = await restoreProduct(id);
            if (ok) {
              await reloadProducts();
              await reloadTrash();
            } else {
              alert('Ürün geri yüklenemedi.');
            }
          }}
        />
      )}

      {stockProduct && <StockEntryModal product={stockProduct} onClose={()=>setStockProduct(null)} onSaved={async()=>{setStockProduct(null);await reloadProducts();}} />}

      {showForm && (
        <ProductForm
          product={editing}
          categories={categories}
          suppliers={suppliers}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); }}
        />
      )}
    </div>
  );
}

function ProductTrashModal({
  products,
  loading,
  onClose,
  onRestore,
}: {
  products: Product[];
  loading: boolean;
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="card w-full max-w-2xl max-h-[80vh] overflow-hidden animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2"><Trash2 size={19} /> Ürün Çöp Kutusu</h2>
            <p className="text-xs text-slate-500 mt-1">Ürünler fiziksel olarak silinmez. Buradan geri yükleyebilirsin.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">✕</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading ? (
            <div className="p-10 text-center text-slate-400">Yükleniyor...</div>
          ) : products.length === 0 ? (
            <div className="p-10 text-center text-slate-400">Ürün çöp kutusu boş.</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {products.map((product) => (
                <div key={product.id} className="flex items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <p className="font-medium text-slate-700">{product.name}</p>
                    <p className="text-xs text-slate-400">{product.barcode || 'Barkod yok'} · {formatCurrency(product.price)}</p>
                  </div>
                  <button
                    onClick={() => onRestore(product.id)}
                    className="flex items-center gap-1.5 rounded-md bg-teal-50 px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-100"
                  >
                    <RotateCcw size={14} /> Geri Yükle
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProductForm({
  product,
  categories,
  suppliers,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: { id: string; name: string }[];
  suppliers: { id: string; name: string; active: boolean }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(product?.name || '');
  const [barcode, setBarcode] = useState(product?.barcode || '');
  const [additionalBarcodes, setAdditionalBarcodes] = useState((product?.additional_barcodes || []).join(', '));
  const [price, setPrice] = useState(product?.price.toString() || '');
  const [cost, setCost] = useState(product?.cost.toString() || '0');
  const [stock, setStock] = useState(product?.stock.toString() || '0');
  const [unlimitedStock, setUnlimitedStock] = useState(Boolean(product?.unlimited_stock));
  const [minStock, setMinStock] = useState(product ? String(product.min_stock ?? 0) : '0');
  const [categoryId, setCategoryId] = useState(product?.category_id || '');
  const [unit, setUnit] = useState(product?.unit || 'adet');
  const [supplierId, setSupplierId] = useState(product?.primary_supplier_id || '');
  const [discountEnabled, setDiscountEnabled] = useState(Boolean(product?.discount_enabled));
  const [discountPrice, setDiscountPrice] = useState(product?.discount_price?.toString() || '');
  const [discountEndsAt, setDiscountEndsAt] = useState(product?.discount_ends_at ? new Date(product.discount_ends_at).toISOString().slice(0,16) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsedPrice = parseLocalizedDecimal(price);
    const parsedCost = cost.trim() === '' ? 0 : parseLocalizedDecimal(cost);
    const parsedDiscount = discountPrice.trim() === '' ? null : parseLocalizedDecimal(discountPrice);
    if (!name.trim()) { setError('Ürün adı gerekli'); return; }
    if (parsedPrice === null || parsedPrice < 0) { setError('Geçerli bir satış fiyatı girin. Ondalık için virgül veya nokta kullanabilirsiniz.'); return; }
    if (parsedCost === null || parsedCost < 0) { setError('Geçerli ve 0 veya daha büyük bir alış fiyatı girin.'); return; }
    if (Number(stock) < 0 || !Number.isFinite(Number(stock))) { setError('Stok 0 veya daha büyük olmalı'); return; }
    if (Number(minStock) < 0 || !Number.isFinite(Number(minStock))) { setError('Minimum stok 0 veya daha büyük olmalı'); return; }
    if (discountEnabled) {
      if (parsedDiscount === null || parsedDiscount < 0 || parsedDiscount >= parsedPrice) { setError('İndirimli fiyat, normal fiyattan küçük olmalı'); return; }
    }

    setSaving(true);
    const data = {
      name: name.trim(),
      barcode: barcode.trim() || null,
      additional_barcodes: Array.from(new Set(additionalBarcodes.split(/[,;\n\r]+/).map(x => x.trim()).filter(x => x && x !== barcode.trim()))),
      price: parsedPrice,
      cost: parsedCost,
      stock: parseFloat(stock) || 0,
      unlimited_stock: unlimitedStock,
      min_stock: parseFloat(minStock) || 0,
      category_id: categoryId || null,
      unit,
      primary_supplier_id: supplierId || null,
      discount_enabled: discountEnabled,
      discount_price: parsedDiscount,
      discount_starts_at: null,
      discount_ends_at: discountEndsAt ? new Date(discountEndsAt).toISOString() : null,
    };

    const ok = product ? await updateProduct(product.id, data) : Boolean(await addProduct(data));
    setSaving(false);
    if (!ok) {
      setError('Ürün kaydedilemedi. Supabase bağlantısını ve tablo izinlerini kontrol edin.');
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="card w-full max-w-lg p-6 animate-slide-up max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-slate-800">
            {product ? 'Ürün Düzenle' : 'Yeni Ürün'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={22} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Ürün Adı *</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>

          <div>
            <label className="label">Barkod</label>
            <div className="flex gap-2">
              <input className="input font-mono" value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Barkod veya boş bırak" />
              <button
                type="button"
                onClick={() => setBarcode(generateBarcode())}
                className="btn-secondary whitespace-nowrap"
              >
                <Plus size={16} />
                Sistem Barkodu
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-3">
            <label className="label flex items-center gap-2"><Package size={15} className="text-blue-600" /> Ek barkodlar · aynı ürün ve aynı fiyat</label>
            <textarea className="input font-mono text-sm" rows={2} value={additionalBarcodes} onChange={e => setAdditionalBarcodes(e.target.value)} placeholder="Örn. 8691234567890, 8691234567891, 8691234567892" />
            <p className="mt-1.5 text-xs leading-5 text-slate-500">Birden fazla barkodu virgül, noktalı virgül veya alt alta yazabilirsin. Hepsi tek ürünün fiyatını ve stok miktarını kullanır; barkod okutulunca aynı ürünü bulur.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Satış Fiyatı (TL) *</label>
              <input type="text" inputMode="decimal" autoComplete="off" className="input" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Örn. 70,00" />
            </div>
            <div>
              <label className="label">Alış Fiyatı (TL)</label>
              <input type="text" inputMode="decimal" autoComplete="off" className="input" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Örn. 50,129097" />
            </div>
          </div>

          <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3">
            <label className="flex items-start gap-2 text-sm font-semibold text-indigo-900"><input type="checkbox" className="mt-0.5" checked={unlimitedStock} onChange={e=>setUnlimitedStock(e.target.checked)} /> <span>Sınırsız stok <span className="block text-xs font-normal leading-5 text-indigo-700">Bu ürün satıldığında, ikram edildiğinde veya gider olarak kullanıldığında stok adedi azaltılmaz ve stok uyarısına girmez.</span></span></label>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Stok Adedi</label>
              <input type="number" step="0.001" className="input" value={stock} disabled={unlimitedStock} onChange={(e) => setStock(e.target.value)} />
              {unlimitedStock && <p className="mt-1 text-xs text-indigo-600">Stok adedi sınırsız olduğu için kullanılmıyor.</p>}
            </div>
            <div>
              <label className="label">Min. Stok Uyarı</label>
              <input type="number" step="0.001" className="input" value={minStock} onChange={(e) => setMinStock(e.target.value)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Kategori</label>
              <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Kategorisiz</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Birim</label>
              <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
                <option value="adet">Adet</option>
                <option value="kg">Kg</option>
                <option value="gr">Gr</option>
                <option value="lt">Litre</option>
                <option value="ml">Ml</option>
                <option value="paket">Paket</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label">Ana Tedarikçi</label>
            <select className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Tedarikçi seçilmedi</option>
              {suppliers.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">Bu ürünün varsayılan tedarikçisini belirler. Alış yaptığında seçilen tedarikçi otomatik olarak güncellenir.</p>
          </div>

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-amber-800"><input type="checkbox" checked={discountEnabled} onChange={e=>setDiscountEnabled(e.target.checked)} /> Satışta indirimli fiyatı aktif et</label>
            {discountEnabled && <div className="mt-3 grid grid-cols-2 gap-3"><div><label className="label">İndirimli fiyat</label><input type="text" inputMode="decimal" autoComplete="off" className="input" value={discountPrice} onChange={e=>setDiscountPrice(e.target.value)} placeholder="Örn. 60,00" /></div><div><label className="label">Bitiş tarihi/saat</label><input type="datetime-local" className="input" value={discountEndsAt} onChange={e=>setDiscountEndsAt(e.target.value)} /></div></div>}
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1 py-2.5">
              İptal
            </button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 py-2.5">
              {saving ? 'Kaydediliyor...' : product ? 'Güncelle' : 'Ekle'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


function StockEntryModal({product,onClose,onSaved}:{product:Product;onClose:()=>void;onSaved:()=>Promise<void>}){
 const [mode,setMode]=useState<'in'|'set'>('in'); const [qty,setQty]=useState(''); const [reason,setReason]=useState('Mal kabul / stok girişi'); const [saving,setSaving]=useState(false); const [err,setErr]=useState('');
 async function save(){const n=Number(qty); if(!Number.isFinite(n)||n<0||(mode==='in'&&n<=0)){setErr('Geçerli bir miktar girin.');return;} setSaving(true); const ok=mode==='in'?await addStock(product,n,reason):await setStock(product,n,reason); setSaving(false); if(!ok){setErr('Stok güncellenemedi. Supabase migration uygulanmış mı kontrol edin.');return;} await onSaved();}
 return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}><div className="card w-full max-w-md p-6" onClick={e=>e.stopPropagation()}><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-bold text-slate-800">Stok İşlemi</h2><p className="text-sm text-slate-500">{product.name} · mevcut {product.stock} {product.unit}</p></div><button onClick={onClose}><X size={20}/></button></div><div className="mb-4 grid grid-cols-2 gap-2"><button onClick={()=>setMode('in')} className={`btn py-2 ${mode==='in'?'bg-emerald-600 text-white':'bg-slate-100'}`}>Stok Ekle</button><button onClick={()=>setMode('set')} className={`btn py-2 ${mode==='set'?'bg-blue-600 text-white':'bg-slate-100'}`}>Stok Düzelt</button></div><div><label className="label">{mode==='in'?'Eklenecek miktar':'Yeni stok miktarı'}</label><input autoFocus type="number" step="0.001" min="0" className="input text-lg" value={qty} onChange={e=>setQty(e.target.value)} /></div><div className="mt-3"><label className="label">Açıklama</label><input className="input" value={reason} onChange={e=>setReason(e.target.value)} /></div>{err&&<p className="mt-3 text-sm text-red-500">{err}</p>}<button disabled={saving} onClick={save} className="btn-primary mt-4 w-full py-3">{saving?'Kaydediliyor...':'Stok Kaydet'}</button></div></div>
}
