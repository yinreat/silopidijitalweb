import { useMemo, useRef, useState } from 'react';
import { Gift, Search, UtensilsCrossed, ReceiptText, Plus, UserRound, ScanBarcode, Trash2, Minus, Camera } from 'lucide-react';
import { useProducts, useStaff, useStaffConsumptions, recordStaffConsumptionBatch } from '@/lib/hooks';
import type { StaffConsumption } from '@/lib/supabase';
import { getEffectivePrice, formatCurrency, formatDateTime } from '@/lib/utils';
import type { Staff, Product } from '@/lib/supabase';
import BarcodeScanner from '@/components/BarcodeScanner';

const SESSION_KEY = 'propos-current-staff-v2';
type ConsumptionType = 'personal' | 'gift';
type ConsumptionPeriod = 'today' | 'yesterday' | '7' | '31' | '90' | 'custom';
function dateKey(date: Date) { const y=date.getFullYear(); const m=String(date.getMonth()+1).padStart(2,'0'); const d=String(date.getDate()).padStart(2,'0'); return `${y}-${m}-${d}`; }
function shiftDateKey(value: string, delta: number) { const date=new Date(`${value}T12:00:00`); date.setDate(date.getDate()+delta); return dateKey(date); }

type SessionStaff = { id?: string; name?: string; role?: Staff['role'] };
type ConsumptionCartItem = { product: Product; quantity: number };

function readCurrentStaff(): SessionStaff | null {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as SessionStaff | null; } catch { return null; }
}

export default function StaffConsumptionPage() {
  const session = readCurrentStaff();
  const { staff } = useStaff();
  const { products } = useProducts();
  const barcodeRef = useRef<HTMLInputElement>(null);
  const [period, setPeriod] = useState<ConsumptionPeriod>('today');
  const [customStart, setCustomStart] = useState(dateKey(new Date()));
  const [customEnd, setCustomEnd] = useState(dateKey(new Date()));
  const [filterStaff, setFilterStaff] = useState('all');
  const [type, setType] = useState<ConsumptionType>('personal');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [barcode, setBarcode] = useState('');
  const [showScanner, setShowScanner] = useState(false);
  const [cart, setCart] = useState<ConsumptionCartItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const currentStaff = staff.find(s => s.id === session?.id) || staff.find(s => s.name.toLowerCase() === String(session?.name || '').toLowerCase()) || null;
  const canViewAll = currentStaff?.role === 'admin' || currentStaff?.role === 'manager';
  const queryStaffId = canViewAll && filterStaff !== 'all' ? filterStaff : canViewAll && filterStaff === 'all' ? undefined : currentStaff?.id;
  const customRange = period === 'custom' && customStart && customEnd && customStart <= customEnd;
  const activeStart = period === 'today' ? dateKey(new Date()) : period === 'yesterday' ? shiftDateKey(dateKey(new Date()), -1) : period === 'custom' && customRange ? customStart : undefined;
  const activeEnd = period === 'today' ? dateKey(new Date()) : period === 'yesterday' ? shiftDateKey(dateKey(new Date()), -1) : period === 'custom' && customRange ? customEnd : undefined;
  const queryDays = period === '7' ? 7 : period === '31' ? 31 : period === '90' ? 90 : period === 'custom' ? 0 : 1;
  const periodLabel = period === 'today' ? 'Bugün' : period === 'yesterday' ? 'Dün' : period === 'custom' ? (customRange ? `${customStart} – ${customEnd}` : 'Tarih aralığı seçin') : `Son ${period} gün`;
  const { rows, loading, reload } = useStaffConsumptions(queryStaffId, queryDays, activeStart, activeEnd);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr-TR');
    return products
      .filter(p => p.unlimited_stock || Number(p.stock || 0) > 0)
      .filter(p => !q || p.name.toLocaleLowerCase('tr-TR').includes(q) || String(p.barcode || '').includes(q) || (p.additional_barcodes || []).some(b => b.includes(q)))
      .slice(0, 100);
  }, [products, search]);

  const cartTotal = useMemo(() => cart.reduce((sum, item) => sum + getEffectivePrice(item.product) * item.quantity, 0), [cart]);
  const cartGiftCount = useMemo(() => cart.reduce((sum, item) => sum + item.quantity, 0), [cart]);
  const personalConsumptionTotal = type === 'personal' ? +cartTotal.toFixed(2) : 0;

  const totals = useMemo(() => {
    const personal = rows.filter(r => r.consumption_type === 'personal').reduce((sum, r) => sum + Number(r.total_amount || 0), 0);
    const gifts = rows.filter(r => r.consumption_type === 'gift').reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    return { personal, gifts };
  }, [rows]);

  const dailySummary = useMemo(() => {
    const byDay = new Map<string, { date: string; personal: number; gifts: number; quantity: number; transactions: number }>();
    for (const row of rows) {
      const date = new Date(row.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
      const current = byDay.get(date) || { date, personal: 0, gifts: 0, quantity: 0, transactions: 0 };
      current.transactions += 1; current.quantity += Number(row.quantity || 0);
      if (row.consumption_type === 'personal') current.personal += Number(row.total_amount || 0); else current.gifts += Number(row.quantity || 0);
      byDay.set(date, current);
    }
    return [...byDay.values()].sort((a,b) => b.date.localeCompare(a.date));
  }, [rows]);

  function findProductByBarcode(code: string) {
    const normalized = code.trim();
    if (!normalized) return null;
    return products.find(p => p.barcode === normalized || (p.additional_barcodes || []).includes(normalized)) || null;
  }

  function addProduct(product: Product, amount = 1) {
    const existing = cart.find(item => item.product.id === product.id);
    const nextQty = (existing?.quantity || 0) + amount;
    if (!product.unlimited_stock && nextQty > Number(product.stock || 0)) {
      setMessage({ ok: false, text: `${product.name} için stok yetersiz. Mevcut stok: ${product.stock}` });
      return;
    }
    setCart(prev => existing
      ? prev.map(item => item.product.id === product.id ? { ...item, quantity: nextQty } : item)
      : [...prev, { product, quantity: amount }]
    );
    setMessage(null);
  }

  function addByBarcode(code: string) {
    const match = findProductByBarcode(code);
    if (!match) {
      setMessage({ ok: false, text: `Barkod bulunamadı: ${code}` });
      setBarcode('');
      barcodeRef.current?.focus();
      return;
    }
    addProduct(match, Math.max(1, Number(quantity) || 1));
    setBarcode('');
    setQuantity('1');
    setTimeout(() => barcodeRef.current?.focus(), 0);
  }

  function handleBarcodeKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addByBarcode(barcode);
    }
  }

  function updateCartQuantity(productId: string, delta: number) {
    setCart(prev => prev.flatMap(item => {
      if (item.product.id !== productId) return [item];
      const next = item.quantity + delta;
      if (next <= 0) return [];
      if (!item.product.unlimited_stock && next > Number(item.product.stock || 0)) {
        setMessage({ ok: false, text: `${item.product.name} için stok yetersiz. Mevcut stok: ${item.product.stock}` });
        return [item];
      }
      return [{ ...item, quantity: next }];
    }));
  }

  function removeCartItem(productId: string) {
    setCart(prev => prev.filter(item => item.product.id !== productId));
  }

  async function submit() {
    setMessage(null);
    if (!currentStaff?.id) { setMessage({ ok: false, text: 'Aktif personel hesabı bulunamadı. Çıkış yapıp tekrar giriş yapın.' }); return; }
    if (!cart.length) { setMessage({ ok: false, text: 'Önce en az bir ürün ekleyin.' }); return; }
    setBusy(true);
    const result = await recordStaffConsumptionBatch({
      items: cart.map(item => ({ productId: item.product.id, quantity: item.quantity })),
      staffId: currentStaff.id,
      type,
      note,
    });
    setBusy(false);
    if (!result.success) { setMessage({ ok: false, text: result.error || 'İşlem kaydedilemedi.' }); return; }
    setMessage({
      ok: true,
      text: type === 'personal'
        ? `${cart.length} ürün (${formatCurrency(personalConsumptionTotal)}) kişisel tüketim gideri olarak kaydedildi ve stoktan düşüldü.`
        : `${cart.length} ürün / ${cartGiftCount} adet personel ikramı olarak kaydedildi ve stoktan düşüldü.`,
    });
    setCart([]); setNote(''); setSearch(''); setBarcode('');
    await reload();
    setTimeout(() => barcodeRef.current?.focus(), 0);
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Personel Tüketimi & İkram</h1>
            <p className="text-sm text-slate-500">Barkod okutabilir, satış ekranındaki gibi birden fazla ürün ekleyip tek seferde kaydedebilirsin.</p>
          </div>
          <div className="flex flex-col items-stretch gap-2 sm:items-end">
            <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
              {([{value:'today',label:'Bugün'},{value:'yesterday',label:'Dün'},{value:'7',label:'7 gün'},{value:'31',label:'31 gün'},{value:'90',label:'90 gün'},{value:'custom',label:'Tarih seç'}] as const).map(option => (
                <button key={option.value} type="button" onClick={() => setPeriod(option.value)} className={`rounded-lg px-3 py-2 text-xs font-semibold ${period === option.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-white'}`}>{option.label}</button>
              ))}
            </div>
            {period === 'custom' && <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-white p-2"><label className="text-xs text-slate-500">Başlangıç <input type="date" className="input ml-1 !w-auto !py-1.5" value={customStart} onChange={e=>setCustomStart(e.target.value)} /></label><label className="text-xs text-slate-500">Bitiş <input type="date" className="input ml-1 !w-auto !py-1.5" min={customStart} value={customEnd} onChange={e=>setCustomEnd(e.target.value)} /></label></div>}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-6xl space-y-6">
          {message && <div className={`rounded-xl border px-4 py-3 text-sm ${message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</div>}

          <div className="grid gap-4 md:grid-cols-3">
            <div className="card p-5"><div className="flex items-center gap-2 text-slate-500"><ReceiptText size={18}/><span className="text-xs font-semibold">Kişisel tüketim gideri</span></div><p className="mt-2 text-3xl font-black text-rose-700">-{formatCurrency(totals.personal)}</p><p className="mt-1 text-xs text-slate-400">{periodLabel}</p></div>
            <div className="card p-5"><div className="flex items-center gap-2 text-slate-500"><Gift size={18}/><span className="text-xs font-semibold">İkram adedi</span></div><p className="mt-2 text-3xl font-black text-slate-800">{totals.gifts}</p><p className="mt-1 text-xs text-slate-400">Stok hareketi olarak izlenir</p></div>
            <div className="card p-5"><div className="flex items-center gap-2 text-slate-500"><UserRound size={18}/><span className="text-xs font-semibold">İşlem yapan hesap</span></div><p className="mt-2 text-xl font-black text-slate-800">{currentStaff?.name || session?.name || '—'}</p><p className="mt-1 text-xs text-slate-400">Kayıtlar aktif hesaba bağlı</p></div>
          </div>

          <section className="card overflow-hidden"><div className="flex flex-wrap items-center justify-between gap-2 border-b p-4"><div><h2 className="font-bold text-slate-800">Günlük tüketim özeti</h2><p className="text-xs text-slate-500">{periodLabel} için kişisel tüketim tutarı ve ikram adedi</p></div><span className="text-xs text-slate-500">Seçili dönemdeki kayıtlı günler</span></div>{dailySummary.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3">Gün</th><th className="px-4 py-3 text-right">Kişisel tüketim</th><th className="px-4 py-3 text-right">İkram adedi</th><th className="px-4 py-3 text-right">Toplam ürün</th><th className="px-4 py-3 text-right">İşlem</th></tr></thead><tbody className="divide-y">{dailySummary.map(day=><tr key={day.date}><td className="px-4 py-3 font-semibold">{new Date(`${day.date}T12:00:00`).toLocaleDateString('tr-TR')}</td><td className="px-4 py-3 text-right font-bold text-rose-700">{formatCurrency(day.personal)}</td><td className="px-4 py-3 text-right">{day.gifts}</td><td className="px-4 py-3 text-right">{day.quantity}</td><td className="px-4 py-3 text-right">{day.transactions}</td></tr>)}</tbody></table></div> : <p className="p-5 text-sm text-slate-500">Seçili dönemde günlük tüketim kaydı yok.</p>}</section>

          <div className="grid gap-6 lg:grid-cols-[1.05fr_1.4fr]">
            <div className="card p-6">
              <div className="mb-5 flex items-center gap-2"><UtensilsCrossed className="text-teal-600" size={21}/><div><h2 className="font-bold text-slate-800">Yeni işlem</h2><p className="text-xs text-slate-400">Bir veya birçok ürünü birlikte ekleyebilirsin.</p></div></div>
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1">
                <button type="button" onClick={() => setType('personal')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${type === 'personal' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'}`}><UtensilsCrossed size={15} className="mr-1 inline"/>Kişisel Tüketim</button>
                <button type="button" onClick={() => setType('gift')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${type === 'gift' ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'}`}><Gift size={15} className="mr-1 inline"/>Personel İkramı</button>
              </div>

              <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3">
                <div className="mb-2 flex items-center justify-between"><div className="flex items-center gap-2"><ScanBarcode size={18} className="text-blue-700"/><span className="text-sm font-bold text-blue-900">Barkod ile ürün ekle</span></div><button type="button" onClick={() => setShowScanner(true)} className="btn-secondary px-3 py-1.5 text-xs"><Camera size={15}/> Kamera</button></div>
                <input
                  ref={barcodeRef}
                  className="input text-lg font-mono"
                  placeholder="Barkodu okut ve Enter gönder"
                  value={barcode}
                  onChange={e => setBarcode(e.target.value)}
                  onKeyDown={handleBarcodeKeyDown}
                  autoFocus
                  inputMode="numeric"
                />
                <p className="mt-1 text-[11px] text-blue-700">Barkod okuyucun Enter gönderiyorsa ürün otomatik sepete eklenir. Aynı ürünü tekrar okutursan adedi artar.</p>
              </div>

              <div className="space-y-3">
                <div><label className="label">Ürün ara ve seç</label><div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={17}/><input className="input pl-9" placeholder="Ürün adı veya barkod" value={search} onChange={e=>setSearch(e.target.value)}/></div></div>
                <div className="flex gap-2">
                  <select className="input flex-1" defaultValue="" onChange={e => { const p = products.find(x => x.id === e.target.value); if (p) addProduct(p, Math.max(1, Number(quantity) || 1)); e.currentTarget.value = ''; }}>
                    <option value="">Ürün seçin</option>
                    {filteredProducts.map(p=><option key={p.id} value={p.id}>{p.name} — stok {p.stock} — {formatCurrency(getEffectivePrice(p))}</option>)}
                  </select>
                  <input className="input w-24" type="number" min="1" step="1" value={quantity} onChange={e=>setQuantity(e.target.value)} aria-label="Eklenek adet" />
                </div>

                {cart.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                    <div className="mb-2 flex items-center justify-between"><h3 className="text-sm font-bold text-slate-700">Seçilen ürünler</h3><span className="text-xs text-slate-500">{cart.length} ürün / {cartGiftCount} adet</span></div>
                    <div className="max-h-72 space-y-2 overflow-y-auto">
                      {cart.map(item => (
                        <div key={item.product.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">
                          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-700">{item.product.name}</p><p className="text-xs text-slate-400">{formatCurrency(getEffectivePrice(item.product))} × {item.quantity}</p></div>
                          <div className="flex items-center gap-1"><button type="button" onClick={() => updateCartQuantity(item.product.id, -1)} className="h-7 w-7 rounded bg-slate-100 text-slate-600"><Minus size={14} className="mx-auto"/></button><span className="w-7 text-center text-sm font-bold">{item.quantity}</span><button type="button" onClick={() => updateCartQuantity(item.product.id, 1)} className="h-7 w-7 rounded bg-slate-100 text-slate-600"><Plus size={14} className="mx-auto"/></button></div>
                          <div className="w-20 text-right text-sm font-bold text-slate-700">{formatCurrency(getEffectivePrice(item.product) * item.quantity)}</div>
                          <button type="button" onClick={() => removeCartItem(item.product.id)} className="p-1 text-slate-300 hover:text-red-500"><Trash2 size={16}/></button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div><label className="label">Not</label><input className="input" placeholder={type === 'gift' ? 'Örn. arkadaş ikramı' : 'Örn. öğle yemeği'} value={note} onChange={e=>setNote(e.target.value)}/></div>
                <div className={`rounded-xl border px-4 py-3 text-sm ${type === 'personal' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-teal-200 bg-teal-50 text-teal-800'}`}>
                  {type === 'personal' ? <><span className="font-semibold">Kişisel tüketim gideri:</span> {formatCurrency(personalConsumptionTotal)}</> : <><span className="font-semibold">Personel ikramı:</span> 0 TL kişisel tüketim gideri — stoktan düşer.</>}
                </div>
                <button type="button" disabled={busy || cart.length === 0} onClick={submit} className="btn-primary w-full py-3"><Plus size={18}/>{busy ? 'Kaydediliyor...' : `Seçilen ${cart.length} Ürünü Kaydet`}</button>
              </div>
            </div>

            <div className="card overflow-hidden">
              <div className="border-b border-slate-200 px-5 py-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div><h2 className="font-bold text-slate-800">Son işlemler</h2><p className="text-xs text-slate-400">{periodLabel}</p></div>
                  {canViewAll && <select className="input max-w-xs" value={filterStaff} onChange={e=>setFilterStaff(e.target.value)}><option value="all">Tüm personel</option>{staff.filter(s=>s.active).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>}
                </div>
              </div>
              <div className="max-h-[620px] overflow-y-auto">
                {loading ? <div className="p-6 text-center text-sm text-slate-400">Yükleniyor...</div> : rows.length === 0 ? <div className="p-8 text-center text-sm text-slate-400">Henüz kayıt yok.</div> : rows.map((row: StaffConsumption) => (
                  <div key={row.id} className="border-b border-slate-100 px-5 py-3 last:border-b-0">
                    <div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-700">{row.product_name}</p><p className="text-xs text-slate-400">{formatDateTime(row.created_at)} · {row.quantity} adet</p></div><div className="text-right"><p className={`text-sm font-bold ${row.consumption_type==='personal'?'text-rose-700':'text-teal-700'}`}>{row.consumption_type==='personal' ? `-${formatCurrency(row.total_amount)}` : 'İkram'}</p><p className="text-[11px] text-slate-400">{row.consumption_type==='personal'?'Kişisel tüketim':'Personel ikramı'}</p></div></div>
                    {row.note && <p className="mt-1 text-xs text-slate-500">{row.note}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showScanner && <BarcodeScanner onDetected={(code) => addByBarcode(code)} onClose={() => { setShowScanner(false); setTimeout(() => barcodeRef.current?.focus(), 0); }} />}
    </div>
  );
}
