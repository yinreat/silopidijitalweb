import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Barcode, Camera, CheckCircle2, RotateCcw, Search, User, XCircle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDateTime } from '@/lib/utils';
import BarcodeScanner from '@/components/BarcodeScanner';
import { processSaleReturn } from '@/lib/hooks';
import type { Sale, SaleItem } from '@/lib/supabase';

type ReturnRow = {
  item: SaleItem;
  sold: number;
  returned: number;
  remaining: number;
  quantity: number;
};

export default function ReturnsPage({ currentStaffId }: { currentStaffId?: string | null }) {
  const [sales, setSales] = useState<Sale[]>([]);
  const [search, setSearch] = useState('');
  const [saleDateFrom, setSaleDateFrom] = useState('');
  const [saleDateTo, setSaleDateTo] = useState('');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [reason, setReason] = useState('Müşteri iadesi');
  const [refundMethod, setRefundMethod] = useState<'original' | 'cash' | 'card' | 'iban' | 'credit'>('original');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [barcodeSaleIds, setBarcodeSaleIds] = useState<string[] | null>(null);

  async function loadSales() {
    setLoading(true);
    const { data, error } = await supabase
      .from('sales')
      .select('*')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) { setMessage({ ok: false, text: `Satışlar yüklenemedi: ${error.message}` }); setLoading(false); return; }
    setSales((data || []) as Sale[]);
    setLoading(false);
  }

  async function loadSale(sale: Sale) {
    setMessage(null);
    setSelectedSale(sale);
    setRefundMethod('original');
    const { data: items, error: itemError } = await supabase
      .from('sale_items')
      .select('*')
      .eq('sale_id', sale.id);
    if (itemError) {
      setRows([]);
      setMessage({ ok: false, text: `Satış kalemleri yüklenemedi: ${itemError.message}` });
      return;
    }
    const itemRows = (items || []) as SaleItem[];
    const ids = itemRows.map(i => i.id);
    let returnedMap = new Map<string, number>();
    if (ids.length) {
      const { data: returned, error: returnReadError } = await supabase.from('sale_returns').select('sale_item_id, quantity').in('sale_item_id', ids);
      if (returnReadError) { setRows([]); setMessage({ ok: false, text: `Önceki iadeler kontrol edilemedi; güvenlik için bu satışın iadesi açılmadı: ${returnReadError.message}` }); return; }
      returnedMap = new Map<string, number>();
      for (const r of returned || []) returnedMap.set(r.sale_item_id, (returnedMap.get(r.sale_item_id) || 0) + Number(r.quantity || 0));
    }
    setRows(itemRows.map(item => {
      const sold = Number(item.quantity || 0);
      const returned = Number(returnedMap.get(item.id) || 0);
      return { item, sold, returned, remaining: Math.max(sold - returned, 0), quantity: 0 };
    }));
  }

  useEffect(() => { loadSales(); }, []);

  const filteredSales = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('tr-TR');
    const from = saleDateFrom ? new Date(`${saleDateFrom}T00:00:00`) : null;
    const to = saleDateTo ? new Date(`${saleDateTo}T23:59:59.999`) : null;
    return sales.filter(s => {
      if (barcodeSaleIds && !barcodeSaleIds.includes(s.id)) return false;
      const created = new Date(s.created_at);
      if (from && created < from) return false;
      if (to && created > to) return false;
      if (!q) return true;
      const shortId = s.id.slice(-8).toLocaleLowerCase('tr-TR');
      return shortId.includes(q) || s.id.toLocaleLowerCase('tr-TR').includes(q) || String(s.total).includes(q) || (s.customer_name || '').toLocaleLowerCase('tr-TR').includes(q);
    }).slice(0, 50);
  }, [sales, search, barcodeSaleIds, saleDateFrom, saleDateTo]);

  const returnTotal = useMemo(() => Math.round(rows.reduce((sum, r) => {
    const soldQty = Math.max(Number(r.item.quantity || 0), 0.00001);
    const chargedLineTotal = Number(r.item.subtotal ?? (Number(r.item.unit_price || 0) * soldQty));
    return sum + Number(r.quantity || 0) * chargedLineTotal / soldQty;
  }, 0) * 100) / 100, [rows]);
  const hasReturn = returnTotal > 0;

  async function findSaleByBarcode(code: string) {
    const normalized = code.trim();
    if (!normalized) return;
    setMessage(null);
    setBarcodeSaleIds(null);
    const match = sales.find(s => s.id.slice(-8).toLocaleLowerCase('tr-TR') === normalized.toLocaleLowerCase('tr-TR') || s.id.toLocaleLowerCase('tr-TR') === normalized.toLocaleLowerCase('tr-TR'));
    if (match) { await loadSale(match); setSearch(''); return; }
    const { data: itemMatches, error } = await supabase.from('sale_items').select('sale_id').eq('barcode', normalized).limit(1000);
    if (error) { setMessage({ ok: false, text: `Barkoda göre satış aranamadı: ${error.message}` }); return; }
    const ids = [...new Set((itemMatches || []).map(row => String(row.sale_id)))];
    if (!ids.length) { setMessage({ ok: false, text: 'Bu satış numarası veya ürün barkoduyla iade edilebilir bir satış bulunamadı. Ürün barkodunun satış fişine kaydedilmiş olması gerekir.' }); return; }
    const { data: matchedRows, error: saleReadError } = await supabase.from('sales').select('*').in('id', ids).is('deleted_at', null).order('created_at', { ascending: false });
    if (saleReadError) { setMessage({ ok: false, text: `Barkoda ait satışlar yüklenemedi: ${saleReadError.message}` }); return; }
    const matchingSales = ((matchedRows || []) as Sale[]).filter(s => !s.refunded_at);
    if (matchingSales.length) {
      setSales(prev => { const merged = new Map(prev.map(s => [s.id, s])); for (const s of matchingSales) merged.set(s.id, s); return [...merged.values()].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at))); });
      setBarcodeSaleIds(matchingSales.map(s => s.id)); setSearch(''); setMessage({ ok: true, text: `${matchingSales.length} satışta bu ürün barkodu bulundu. Soldan doğru fişi seçin.` }); return;
    }
    setMessage({ ok: false, text: 'Bu barkodda iade edilebilir bir satış bulunamadı; bu ürünün satışı daha önce tamamen iade edilmiş olabilir.' });
  }

  function setQty(itemId: string, quantity: number) {
    setRows(prev => prev.map(r => r.item.id === itemId ? { ...r, quantity: Math.max(0, Math.min(r.remaining, quantity)) } : r));
  }

  async function submitReturn() {
    if (!selectedSale || !currentStaffId || !hasReturn || saving) {
      if (!currentStaffId) setMessage({ ok: false, text: 'İadeyi kaydetmek için önce personel girişi yapın.' });
      return;
    }
    setSaving(true); setMessage(null);
    try {
      const items = rows.filter(r => r.quantity > 0).map(r => ({ saleItemId: r.item.id, quantity: r.quantity }));
      const result = await processSaleReturn({ saleId: selectedSale.id, items, reason, staffId: currentStaffId, returnMethod: refundMethod });
      if (!result.success) { setMessage({ ok: false, text: result.error || 'İade kaydedilemedi.' }); return; }
      setMessage({ ok: true, text: `${formatCurrency(result.refundAmount || 0)} iade başarıyla kaydedildi. Stok ve iade kayıtları işlendi.${Number(result.reversedDebtAmount || 0) > 0 ? ` ${formatCurrency(Number(result.reversedDebtAmount))} eski veresiye borcuna geri eklendi.` : ''}${result.warning ? ` UYARI: ${result.warning}` : ''}` });
      await loadSales();
      const fresh = await supabase.from('sales').select('*').eq('id', selectedSale.id).maybeSingle();
      if (fresh.data) await loadSale(fresh.data as Sale); else { setSelectedSale(null); setRows([]); }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? `İade sırasında hata: ${error.message}` : 'İade sırasında beklenmeyen bir hata oluştu. Kayıt durumunu kontrol etmeden tekrar deneme.' });
    } finally { setSaving(false); }
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50 p-4 lg:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2"><RotateCcw className="text-rose-600" size={24}/><h1 className="text-2xl font-black text-slate-800">Satış İadesi</h1></div>
            <p className="mt-1 text-sm text-slate-500">Fiş numarası, müşteri, tutar veya satışta okutulmuş ürün barkoduyla ara. Satılan/önce iade edilmiş/kalan miktarı kontrol ederek kısmi ya da tam iade yap.</p>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">İade edilen ürünler stoğa geri eklenir. Nakit iade için açık kasa gerekir.</div>
        </div>

        {message && <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${message.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'}`}>{message.ok ? <CheckCircle2 size={18}/> : <AlertTriangle size={18}/>} {message.text}</div>}

        <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
          <section className="card p-4">
            <div className="mb-3 flex items-center justify-between"><div><h2 className="font-bold text-slate-800">Satış Bul</h2><p className="text-xs text-slate-500">Fiş no, tutar, müşteri veya satışta okutulmuş ürün barkodu.</p></div><button className="btn" onClick={()=>setScannerOpen(true)} title="Kamerayla tara"><Camera size={18}/></button></div>
            <div className="relative mb-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18}/><input className="input pl-10" value={search} onChange={e=>{setSearch(e.target.value);setBarcodeSaleIds(null)}} placeholder="Fiş no, tutar, müşteri veya barkod" autoComplete="off"/></div>
            <div className="mb-3 grid grid-cols-2 gap-2"><div><label className="label">Başlangıç tarihi</label><input type="date" className="input" value={saleDateFrom} max={saleDateTo || undefined} onChange={e=>{setSaleDateFrom(e.target.value);setBarcodeSaleIds(null)}}/></div><div><label className="label">Bitiş tarihi</label><input type="date" className="input" min={saleDateFrom || undefined} onChange={e=>{setSaleDateTo(e.target.value);setBarcodeSaleIds(null)}} value={saleDateTo}/></div></div>
            <div className="mb-2 text-xs text-slate-400">Gösterilen satış: {filteredSales.length} · Tarih aralığı ve arama birlikte uygulanır.</div><div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
              {loading && <div className="py-10 text-center text-sm text-slate-400">Satışlar yükleniyor...</div>}
              {!loading && filteredSales.map(s => {
                const active = selectedSale?.id === s.id;
                return <button key={s.id} onClick={()=>loadSale(s)} className={`w-full rounded-xl border p-3 text-left transition ${active ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
                  <div className="flex items-start justify-between gap-3"><div><div className="font-bold text-slate-800">#{s.id.slice(-8).toUpperCase()}</div><div className="text-xs text-slate-500">{formatDateTime(s.created_at)} · {s.customer_name || 'Peşin müşteri'}</div></div><div className="font-black text-slate-800">{formatCurrency(Number(s.total||0))}</div></div>
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400"><User size={13}/>{s.staff_id ? `Personel ID: ${s.staff_id.slice(-6)}` : 'Personel yok'} · {s.payment_method}{s.refunded_at ? ' · TAM İADE' : Number(s.refund_amount || 0) > 0 ? ` · Kısmi iade ${formatCurrency(Number(s.refund_amount || 0))}` : ''}</div>
                </button>;
              })}
              {!loading && filteredSales.length === 0 && <div className="py-10 text-center text-sm text-slate-400">Satış bulunamadı.</div>}
            </div>
          </section>

          <section className="card overflow-hidden">
            {!selectedSale ? <div className="flex min-h-[500px] flex-col items-center justify-center p-8 text-center text-slate-400"><RotateCcw size={44} className="mb-3"/><p className="font-semibold">Soldan bir satış seçin</p><p className="mt-1 text-sm">İade kalemleri burada açılacak.</p></div> : <>
              <div className="border-b border-slate-200 bg-white p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-slate-800">Satış #{selectedSale.id.slice(-8).toUpperCase()}</h2><p className="text-xs text-slate-500">{formatDateTime(selectedSale.created_at)} · {selectedSale.customer_name || 'Peşin müşteri'}</p></div><button className="btn" onClick={()=>{setSelectedSale(null);setRows([])}}><XCircle size={18}/> Temizle</button></div></div>
              <div className="divide-y divide-slate-100">
                {rows.map(r => <div key={r.item.id} className={`p-4 transition-colors ${r.returned > 0 ? 'bg-rose-50 border-l-4 border-rose-500' : 'bg-white'}`}><div className="flex items-start justify-between gap-3"><div><div className={`font-bold ${r.returned > 0 ? 'text-rose-800' : 'text-slate-800'}`}>{r.item.product_name}{r.returned > 0 && <span className="ml-2 inline-flex rounded-full bg-rose-600 px-2 py-0.5 align-middle text-[10px] font-black uppercase text-white">İADE EDİLDİ: {r.returned}</span>}</div><div className={`text-xs ${r.returned > 0 ? 'font-semibold text-rose-700' : 'text-slate-500'}`}>Satılan: {r.sold} · İade edilmiş: {r.returned} · Kalan: {r.remaining}</div></div><div className={`text-right font-bold ${r.returned > 0 ? 'text-rose-700' : 'text-slate-800'}`}>{formatCurrency(Number(r.item.unit_price||0))}</div></div><div className="mt-3 flex items-center gap-2"><button className="btn px-3" disabled={r.quantity<=0} onClick={()=>setQty(r.item.id,r.quantity-1)}>-</button><input className="input w-24 text-center" type="number" min="0" max={r.remaining} step="0.001" value={r.quantity} onChange={e=>setQty(r.item.id,Number(e.target.value))}/><button className="btn px-3" disabled={r.quantity>=r.remaining} onClick={()=>setQty(r.item.id,r.quantity+1)}>+</button><button className="ml-auto rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700" onClick={()=>setQty(r.item.id,r.remaining)} disabled={r.remaining<=0}>Tümünü İade Et</button></div></div>)}
                {rows.length===0 && <div className="p-8 text-center text-sm text-slate-400">Bu satışta iade edilebilir ürün yok.</div>}
              </div>
              <div className="border-t border-slate-200 bg-slate-50 p-4 space-y-3"><div className="grid gap-3 md:grid-cols-2"><select className="input" value={refundMethod} onChange={e=>setRefundMethod(e.target.value as any)}><option value="original">Orijinal ödeme yöntemi</option><option value="cash">Nakit iade</option><option value="card">Kart iade kaydı</option><option value="iban">IBAN iadesi</option><option value="credit">Veresiye bakiyesine iade</option></select><input className="input" value={reason} onChange={e=>setReason(e.target.value)} placeholder="İade nedeni"/></div><div className="flex flex-wrap items-center justify-between gap-3"><div><div className="text-xs text-slate-500">İade toplamı</div><div className="text-2xl font-black text-rose-700">{formatCurrency(returnTotal)}</div></div><button className="btn-primary px-6 py-3" disabled={!currentStaffId || !hasReturn || saving} onClick={submitReturn}>{saving ? 'İşleniyor...' : 'İadeyi Tamamla'}</button></div></div>
            </>}
          </section>
        </div>
      </div>
      {scannerOpen && <BarcodeScanner onDetected={(code)=>{setScannerOpen(false);findSaleByBarcode(code)}} onClose={()=>setScannerOpen(false)} />}
    </div>
  );
}
