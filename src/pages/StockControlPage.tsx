import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ClipboardCheck, History, Package, Search, Trash2, Warehouse, Camera } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import type { Product, StockMovement } from '@/lib/supabase';
import { useProducts, useStaff } from '@/lib/hooks';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import DateRangeFilter, { getDateBounds, type DateRangeValue } from '@/components/DateRangeFilter';
import BarcodeScanner from '@/components/BarcodeScanner';

type Tab = 'history' | 'waste' | 'count';
type CountRow = { product: Product; countedStock: string };

function initialDateRange(): DateRangeValue {
  const d = new Date();
  const text = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return { preset: 'today', startDate: text, endDate: text };
}

const movementLabels: Record<string, string> = {
  in: 'Stok Girişi', sale: 'Satış', out: 'Stok Çıkışı', return: 'İade', adjustment: 'Düzeltme', waste: 'Fire / Zayi',
};

export default function StockControlPage({ currentStaffId }: { currentStaffId?: string | null }) {
  const [tab, setTab] = useState<Tab>('history');
  const [range, setRange] = useState<DateRangeValue>(initialDateRange());
  const [movementType, setMovementType] = useState('all');
  const [search, setSearch] = useState('');
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [loadingMovements, setLoadingMovements] = useState(true);
  const { products, reload: reloadProducts } = useProducts();
  const { staff } = useStaff();
  const [wasteProductId, setWasteProductId] = useState('');
  const [wasteBarcode, setWasteBarcode] = useState('');
  const [showWasteScanner, setShowWasteScanner] = useState(false);
  const [wasteQty, setWasteQty] = useState('1');
  const [wasteReason, setWasteReason] = useState('Bozulma / fire');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [countBarcode, setCountBarcode] = useState('');
  const [showCountScanner, setShowCountScanner] = useState(false);
  const [countRows, setCountRows] = useState<CountRow[]>([]);
  const [countNote, setCountNote] = useState('');

  const staffMap = useMemo(() => new Map(staff.map(s => [s.id, s.name])), [staff]);

  async function loadMovements() {
    setLoadingMovements(true);
    let q = supabase.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(1000);
    if (movementType !== 'all') q = q.eq('movement_type', movementType);
    if (search.trim()) q = q.ilike('product_name', `%${search.trim()}%`);
    const { start, end } = getDateBounds(range);
    if (start) q = q.gte('created_at', start.toISOString());
    if (end) q = q.lte('created_at', end.toISOString());
    const { data, error } = await q;
    if (error) console.error('Stok hareketleri yüklenemedi:', error);
    setMovements((data || []) as StockMovement[]);
    setLoadingMovements(false);
  }

  useEffect(() => { loadMovements(); }, [range, movementType]);

  function findByBarcode(code: string): Product | null {
    const normalized = code.trim();
    if (!normalized) return null;
    return products.find(p => p.barcode === normalized || (p.additional_barcodes || []).includes(normalized)) || null;
  }

  function handleWasteBarcode(code: string) {
    const product = findByBarcode(code);
    setWasteBarcode(code);
    if (!product) {
      setNotice(`Barkod bulunamadı: ${code}`);
      setWasteProductId('');
      return;
    }
    setWasteProductId(product.id);
    setWasteBarcode(code);
    setNotice(`${product.name} bulundu • stok ${product.unlimited_stock ? 'sınırsız' : product.stock} ${product.unit}`);
  }

  function handleCountBarcode(code: string) {
    const product = findByBarcode(code);
    setCountBarcode(code);
    if (!product) {
      setNotice(`Barkod bulunamadı: ${code}`);
      return;
    }
    if (product.unlimited_stock) {
      setCountBarcode('');
      setNotice(`${product.name}: Sınırsız stok ürünleri fiziksel stok sayımına alınmaz.`);
      return;
    }
    addCountProduct(product);
    setCountBarcode('');
    setNotice(`${product.name} sayım listesine eklendi.`);
  }

  async function recordWaste() {
    setNotice('');
    const qty = Number(wasteQty);
    const product = products.find(p => p.id === wasteProductId);
    if (!product) return setNotice('Ürün seçin.');
    if (!Number.isFinite(qty) || qty <= 0) return setNotice('Geçerli bir miktar girin.');
    if (!product.unlimited_stock && qty > Number(product.stock || 0)) return setNotice(`Yetersiz stok. Mevcut: ${product.stock}`);
    setBusy(true);
    const { data, error } = await supabase.rpc('record_stock_movement', { p_product_id: product.id, p_type: 'waste', p_quantity: qty, p_reason: wasteReason.trim() || 'Fire / zayi', p_staff_id: currentStaffId || null });
    setBusy(false);
    if (error || data !== true) { setNotice(error?.message || 'Fire kaydedilemedi.'); return; }
    setNotice(`${product.name} için ${qty} ${product.unit} fire kaydedildi${product.unlimited_stock ? ' (sınırsız stok adedi değişmedi)' : ''}.`);
    setWasteQty('1');
    await reloadProducts();
    await loadMovements();
  }

  function addCountProduct(product: Product) {
    if (product.unlimited_stock) { setNotice(`${product.name}: Sınırsız stok ürünleri fiziksel stok sayımına alınmaz.`); return; }
    setCountRows(rows => rows.some(r => r.product.id === product.id) ? rows : [...rows, { product, countedStock: String(product.stock ?? 0) }]);
  }
  function removeCountProduct(id: string) { setCountRows(rows => rows.filter(r => r.product.id !== id)); }
  function setCountValue(id: string, value: string) { setCountRows(rows => rows.map(r => r.product.id === id ? { ...r, countedStock: value } : r)); }

  async function completeCount() {
    setNotice('');
    const valid = countRows.map(r => ({ productId: r.product.id, countedStock: Number(r.countedStock) }));
    if (!valid.length) return setNotice('Sayım için ürün ekleyin.');
    if (valid.some(r => !Number.isFinite(r.countedStock) || r.countedStock < 0)) return setNotice('Sayım adetleri 0 veya daha büyük olmalı.');
    setBusy(true);
    const { data, error } = await supabase.rpc('complete_stock_count', { p_staff_id: currentStaffId || null, p_items: valid, p_note: countNote.trim() || null });
    setBusy(false);
    if (error || !data) { setNotice(error?.message || 'Sayım kaydedilemedi.'); return; }
    setNotice(`Sayım tamamlandı. ${countRows.length} ürün işlendi.`);
    setCountRows([]); setCountNote('');
    await reloadProducts();
    await loadMovements();
  }

  const countTotalVariance = countRows.reduce((sum, r) => sum + (Number(r.countedStock) - Number(r.product.stock || 0)), 0);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100">
      <div className="border-b border-slate-200 bg-white px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><div className="flex items-center gap-2"><Warehouse className="text-teal-600" size={22}/><h1 className="text-xl font-bold text-slate-800">Stok Kontrol</h1></div><p className="text-sm text-slate-500">Hareket, fire/zayi ve fiziksel stok sayımı</p></div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            <button onClick={() => setTab('history')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab==='history'?'bg-white text-teal-700 shadow-sm':'text-slate-500'}`}><History size={15} className="mr-1 inline"/> Hareketler</button>
            <button onClick={() => setTab('waste')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab==='waste'?'bg-white text-rose-700 shadow-sm':'text-slate-500'}`}><AlertTriangle size={15} className="mr-1 inline"/> Fire / Zayi</button>
            <button onClick={() => setTab('count')} className={`rounded-md px-3 py-1.5 text-sm font-semibold ${tab==='count'?'bg-white text-blue-700 shadow-sm':'text-slate-500'}`}><ClipboardCheck size={15} className="mr-1 inline"/> Sayım</button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-7xl space-y-5">
        {notice && <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm font-medium text-teal-800">{notice}</div>}
        {tab === 'history' && <>
          <div className="card p-4 space-y-3">
            <div className="flex flex-wrap gap-3 items-center"><DateRangeFilter value={range} onChange={setRange} /><select value={movementType} onChange={e=>setMovementType(e.target.value)} className="input w-auto"><option value="all">Tüm hareketler</option>{Object.entries(movementLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><div className="relative min-w-[220px] flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>e.key==='Enter'&&loadMovements()} className="input pl-9" placeholder="Ürün ara..." /></div><button onClick={loadMovements} className="btn">Yenile</button></div>
            <div className="text-xs text-slate-500">Toplam {movements.length} hareket</div>
          </div>
          <div className="card overflow-hidden"><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr><th className="px-4 py-3 text-left">Tarih</th><th className="px-4 py-3 text-left">Ürün</th><th className="px-4 py-3 text-left">İşlem</th><th className="px-4 py-3 text-right">Miktar</th><th className="px-4 py-3 text-right">Önce</th><th className="px-4 py-3 text-right">Sonra</th><th className="px-4 py-3 text-left">Personel</th><th className="px-4 py-3 text-left">Açıklama</th></tr></thead><tbody>{movements.map(m=><tr key={m.id} className="border-t border-slate-100"><td className="px-4 py-3 whitespace-nowrap">{formatDateTime(m.created_at)}</td><td className="px-4 py-3 font-semibold">{m.product_name}</td><td className="px-4 py-3">{movementLabels[m.movement_type] || m.movement_type}</td><td className="px-4 py-3 text-right font-bold">{m.quantity}</td><td className="px-4 py-3 text-right">{m.before_stock}</td><td className="px-4 py-3 text-right">{m.after_stock}</td><td className="px-4 py-3">{m.staff_id ? (staffMap.get(m.staff_id) || 'Personel') : '—'}</td><td className="px-4 py-3 text-slate-500">{m.reason || '—'}</td></tr>)}</tbody></table>{loadingMovements&&<div className="p-8 text-center text-slate-400">Yükleniyor...</div>}{!loadingMovements&&!movements.length&&<div className="p-8 text-center text-slate-400">Seçilen tarih aralığında stok hareketi yok.</div>}</div></div>
        </>}

        {tab === 'waste' && <div className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
          <div className="card p-5 space-y-4"><div><h2 className="font-bold text-slate-800">Fire / Zayi Kaydı</h2><p className="text-xs text-slate-500 mt-1">Bozulma, kırılma, son kullanma veya diğer stok kayıpları.</p></div><div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500">Ürün barkodu</label>
            <div className="flex gap-2">
              <input className="input flex-1 font-mono" value={wasteBarcode} onChange={e=>setWasteBarcode(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();handleWasteBarcode(wasteBarcode)}}} placeholder="Barkod okut veya yaz ve Enter" autoComplete="off" />
              <button type="button" onClick={()=>setShowWasteScanner(true)} className="btn" title="Kamerayla barkod tara"><Camera size={18}/></button>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm">{wasteProductId ? (()=>{const p=products.find(x=>x.id===wasteProductId); return p ? <><b>{p.name}</b> · mevcut {p.stock} {p.unit}</> : 'Ürün bulunamadı';})() : 'Ürünü seçmek yerine barkod okutun.'}</div>
          </div><input className="input" type="number" min="0.001" step="0.001" value={wasteQty} onChange={e=>setWasteQty(e.target.value)} placeholder="Miktar"/><input className="input" value={wasteReason} onChange={e=>setWasteReason(e.target.value)} placeholder="Fire nedeni"/><button disabled={busy} onClick={recordWaste} className="btn-primary w-full py-3">{busy?'Kaydediliyor...':'Fireyi Kaydet'}</button></div>
          <div className="card p-5"><h2 className="font-bold text-slate-800 mb-3">Stokta Kritik Ürünler</h2><div className="divide-y divide-slate-100">{products.filter(p=>!p.unlimited_stock && Number(p.stock)<=Number(p.min_stock)).slice(0,30).map(p=><div key={p.id} className="flex items-center justify-between py-3"><div className="flex items-center gap-3"><Package size={18} className="text-slate-400"/><div><div className="font-semibold text-slate-700">{p.name}</div><div className="text-xs text-slate-400">Min. {p.min_stock} {p.unit}</div></div></div><div className="font-bold text-rose-600">{p.stock} {p.unit}</div></div>)}{products.filter(p=>!p.unlimited_stock && Number(p.stock)<=Number(p.min_stock)).length===0&&<p className="text-sm text-slate-400">Kritik stok bulunmuyor.</p>}</div></div>
        </div>}

        {tab === 'count' && <div className="space-y-5">
          <div className="card p-4">
            <div className="flex flex-wrap gap-3 items-center">
              <div className="min-w-[280px] flex-1">
                <label className="mb-1 block text-xs font-semibold text-slate-500">Sayım barkodu</label>
                <div className="flex gap-2">
                  <input className="input flex-1 font-mono" value={countBarcode} onChange={e=>setCountBarcode(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();handleCountBarcode(countBarcode)}}} placeholder="Barkod okut veya yaz ve Enter" autoComplete="off" autoFocus/>
                  <button type="button" onClick={()=>setShowCountScanner(true)} className="btn" title="Kamerayla barkod tara"><Camera size={18}/></button>
                </div>
              </div>
              <input className="input max-w-sm" value={countNote} onChange={e=>setCountNote(e.target.value)} placeholder="Sayım notu (opsiyonel)"/>
            </div>
            <div className="mt-3 rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">Ürün seçimi kaldırıldı. Her ürün sayım listesine barkod okutularak eklenir.</div>
          </div>
          <div className="card overflow-hidden"><div className="border-b border-slate-200 px-5 py-4 flex items-center justify-between"><div><h2 className="font-bold text-slate-800">Sayım Listesi</h2><p className="text-xs text-slate-500">Fiziksel adedi gir; sistem farkı otomatik hesaplar.</p></div><div className={`text-sm font-bold ${countTotalVariance===0?'text-slate-400':countTotalVariance>0?'text-emerald-600':'text-rose-600'}`}>Net miktar farkı: {countTotalVariance.toFixed(3)}</div></div><div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr><th className="px-4 py-3 text-left">Ürün</th><th className="px-4 py-3 text-right">Sistem</th><th className="px-4 py-3 text-right">Sayım</th><th className="px-4 py-3 text-right">Fark</th><th className="px-4 py-3 text-right">Fark Değeri</th><th></th></tr></thead><tbody>{countRows.map(r=>{const diff=Number(r.countedStock)-Number(r.product.stock||0); const value=diff*Number(r.product.cost||0); return <tr key={r.product.id} className="border-t border-slate-100"><td className="px-4 py-3 font-semibold">{r.product.name}</td><td className="px-4 py-3 text-right">{r.product.stock}</td><td className="px-4 py-3 text-right"><input className="input w-28 text-right" type="number" min="0" step="0.001" value={r.countedStock} onChange={e=>setCountValue(r.product.id,e.target.value)}/></td><td className={`px-4 py-3 text-right font-bold ${diff===0?'text-slate-400':diff>0?'text-emerald-600':'text-rose-600'}`}>{diff>0?'+':''}{diff.toFixed(3)}</td><td className={`px-4 py-3 text-right ${value>=0?'text-emerald-600':'text-rose-600'}`}>{formatCurrency(value)}</td><td className="px-4 py-3 text-right"><button onClick={()=>removeCountProduct(r.product.id)} className="rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={16}/></button></td></tr>})}</tbody></table>{!countRows.length&&<div className="p-10 text-center text-slate-400">Yukarıdaki ürünlerden sayım listesine ekleyin.</div>}</div><div className="border-t border-slate-200 p-4 flex justify-end"><button disabled={busy || !countRows.length} onClick={completeCount} className="btn-primary px-5 py-3">{busy?'Kaydediliyor...':'Sayımı Tamamla'}</button></div></div>
        </div>}
      </div></div>
      {showWasteScanner && <BarcodeScanner onDetected={(code)=>{setShowWasteScanner(false); handleWasteBarcode(code);}} onClose={()=>setShowWasteScanner(false)} />}
      {showCountScanner && <BarcodeScanner onDetected={(code)=>{setShowCountScanner(false); handleCountBarcode(code);}} onClose={()=>setShowCountScanner(false)} />}
    </div>
  );
}
