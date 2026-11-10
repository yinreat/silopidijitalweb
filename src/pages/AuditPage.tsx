import { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Calculator, CreditCard, Download, Eye, Filter, RefreshCw, ReceiptText, ShieldCheck, ShoppingBag, UserRound, X } from 'lucide-react';
import DateRangeFilter, { getDateBounds, type DateRangeValue } from '@/components/DateRangeFilter';
import { supabase } from '@/lib/supabase';
import { formatDateTime } from '@/lib/utils';
import type { Sale, SaleItem, Staff } from '@/lib/supabase';

type AuditRow = {
  id: string;
  staff_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
  business_id: string | null;
  staff_name?: string | null;
};

const SESSION_KEY = 'propos-current-staff-v2';
function currentStaffId() {
  try { return (JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as Staff | null)?.id || ''; } catch { return ''; }
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    sale_completed: 'Satış tamamlandı',
    sale_partial_or_full_return: 'Satış iadesi',
    sale_refunded: 'Satış iadesi',
    sale_trashed: 'Satış iptali',
    product_created: 'Ürün oluşturuldu',
    product_updated: 'Ürün güncellendi',
    product_deleted: 'Ürün silindi',
    product_restored: 'Ürün geri yüklendi',
    category_created: 'Kategori oluşturuldu',
    category_updated: 'Kategori güncellendi',
    category_deleted: 'Kategori silindi',
    supplier_created: 'Tedarikçi oluşturuldu',
    supplier_updated: 'Tedarikçi güncellendi',
    supplier_payment: 'Tedarikçi ödemesi',
    purchase_received: 'Alış kaydı',
    staff_created: 'Personel oluşturuldu',
    staff_updated: 'Personel güncellendi',
    staff_deleted: 'Personel silindi',
    cash_opened: 'Kasa açıldı',
    cash_deposit: 'Kasaya para eklendi',
    cash_withdrawal: 'Kasadan para alındı',
    cash_entry_cancelled: 'Kasa hareketi iptal edildi',
    customer_iban_created: 'Nakit → IBAN',
    customer_iban_received: 'IBAN transferi alındı',
    customer_cash_loan: 'Müşteriye borç para verildi',
    customer_cash_loan_reversed: 'Borç para verme geri alındı',
    customer_payment: 'Borç tahsilatı',
    customer_payment_reversed: 'Tahsilat geri alındı',
    cash_closed: 'Kasa kapatıldı',
    staff_consumption: 'Personel tüketimi',
    staff_payout: 'Personel kazanç ödemesi',
    stock_adjustment: 'Stok düzeltildi',
    stock_count_completed: 'Stok sayımı tamamlandı',
  };
  return map[action] || action.replaceAll('_', ' ');
}

const detailLabels: Record<string, string> = {
  total: 'Toplam',
  itemCount: 'Ürün Adedi',
  staff_name: 'Personel',
  paymentMethod: 'Ödeme Yöntemi',
  name: 'Ürün / Kategori Adı',
  product_name: 'Ürün Adı',
  productName: 'Ürün Adı',
  price: 'Fiyat',
  amount: 'Tutar',
  subtotal: 'Ara Toplam',
  grandTotal: 'Genel Toplam',
  discount: 'İndirim',
  cost: 'Maliyet',
  profit: 'Kâr',
  paid: 'Ödenen',
  remaining: 'Kalan',
  reason: 'Açıklama / Neden',
  fields: 'Değiştirilen Alanlar',
  quantity: 'Miktar',
  qty: 'Miktar',
  stock: 'Stok',
  oldPrice: 'Eski Fiyat',
  newPrice: 'Yeni Fiyat',
  oldStock: 'Eski Stok',
  newStock: 'Yeni Stok',
  customer: 'Müşteri',
  customer_name: 'Müşteri',
  supplier: 'Tedarikçi',
  supplier_name: 'Tedarikçi',
  barcode: 'Barkod',
  category: 'Kategori',
  category_name: 'Kategori',
  description: 'Açıklama',
};

const paymentLabels: Record<string, string> = {
  cash: 'Nakit',
  card: 'Kart',
  credit: 'Veresiye',
  iban: 'IBAN',
};

const moneyKeyPattern = /(total|subtotal|grandtotal|price|amount|discount|cost|profit|paid|remaining|oldprice|newprice|paymentamount|cashamount|cardamount|creditamount)/i;

function humanizeKey(key: string) {
  if (detailLabels[key]) return detailLabels[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, char => char.toLocaleUpperCase('tr-TR'));
}

function isMoneyKey(key: string) {
  return moneyKeyPattern.test(key);
}

function formatDetailValue(key: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number') {
    return isMoneyKey(key)
      ? new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(value)
      : new Intl.NumberFormat('tr-TR').format(value);
  }
  if (typeof value === 'string') {
    if (key === 'paymentMethod' || key === 'payment_method') return paymentLabels[value] || humanizeKey(value);
    if (key.toLowerCase().includes('date') || key.toLowerCase().includes('time')) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return formatDateTime(value);
    }
    return value;
  }
  return null;
}

function detailsText(details: Record<string, unknown> | null) {
  if (!details) return '';
  return Object.entries(details).map(([k, v]) => {
    const formatted = formatDetailValue(k, v);
    if (formatted !== null) return `${humanizeKey(k)}: ${formatted}`;
    if (Array.isArray(v)) return `${humanizeKey(k)}: ${v.length} kayıt`;
    if (v && typeof v === 'object') return `${humanizeKey(k)}: ayrıntılı bilgi`;
    return `${humanizeKey(k)}: ${String(v)}`;
  }).join(' • ');
}

function DetailValue({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  const formatted = formatDetailValue(label, value);
  if (formatted !== null) {
    return <div className="rounded-xl border border-slate-200 bg-white px-4 py-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{humanizeKey(label)}</div><div className="mt-1 break-words text-sm font-semibold text-slate-800">{formatted}</div></div>;
  }

  if (Array.isArray(value)) {
    return <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{humanizeKey(label)}</div><div className="mt-3 space-y-2">{value.length ? value.map((item, index) => <div key={`${label}-${index}`} className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700"><span className="mr-2 font-semibold text-slate-400">{index + 1}.</span>{typeof item === 'object' && item !== null ? <div className="mt-2 grid gap-2 sm:grid-cols-2">{Object.entries(item as Record<string, unknown>).map(([k, v]) => <DetailValue key={k} label={k} value={v} depth={depth + 1} />)}</div> : String(item)}</div>) : <span className="text-sm text-slate-400">Kayıt bulunmuyor.</span>}</div></div>;
  }

  if (value && typeof value === 'object') {
    return <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{humanizeKey(label)}</div><div className={`mt-3 grid gap-2 ${depth > 0 ? 'sm:grid-cols-1' : 'sm:grid-cols-2'}`}>{Object.entries(value as Record<string, unknown>).map(([k, v]) => <DetailValue key={k} label={k} value={v} depth={depth + 1} />)}</div></div>;
  }

  return null;
}

function toCsv(rows: AuditRow[]) {
  const header = ['Tarih','Personel','İşlem','Modül','Kayıt ID','Detay'];
  const esc = (value: string) => `"${value.replaceAll('"','""')}"`;
  const lines = rows.map(r => [formatDateTime(r.created_at), r.staff_name || r.staff_id || '-', actionLabel(r.action), r.entity_type || '-', r.entity_id || '-', detailsText(r.details)].map(esc).join(','));
  return [header.map(esc).join(','), ...lines].join('\n');
}

export default function AuditPage({ staff }: { staff: Staff[] }) {
  const currentId = currentStaffId();
  const isAdmin = staff.find(s => s.id === currentId)?.role === 'admin';
  const [range, setRange] = useState<DateRangeValue>({ preset: 'today', ...(() => { const d = new Date(); const x = d.toISOString().slice(0,10); return { startDate: x, endDate: x }; })() });
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<AuditRow | null>(null);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [selectedSaleItems, setSelectedSaleItems] = useState<SaleItem[]>([]);
  const [saleDetailLoading, setSaleDetailLoading] = useState(false);
  const [saleDetailError, setSaleDetailError] = useState('');

  const actorMap = useMemo(() => new Map(staff.map(s => [s.id, s.name])), [staff]);
  const load = useCallback(async () => {
    if (!isAdmin || !currentId) return;
    setLoading(true);
    const bounds = getDateBounds(range);
    const { data, error } = await supabase.rpc('get_audit_logs_admin', {
      p_staff_id: currentId,
      p_start: bounds.start?.toISOString() || null,
      p_end: bounds.end?.toISOString() || null,
      p_action: action || null,
      p_actor_staff_id: actor || null,
      p_search: search.trim() || null,
      p_limit: 1000,
    });
    if (error) {
      console.error('İşlem geçmişi yüklenemedi:', error);
      setRows([]);
    } else {
      const mapped = ((data || []) as AuditRow[]).map(r => ({ ...r, staff_name: actorMap.get(r.staff_id || '') || null }));
      setRows(mapped);
    }
    setLoading(false);
  }, [action, actor, currentId, isAdmin, range, search, actorMap]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected]);

  useEffect(() => {
    if (!selected || selected.entity_type !== 'sale' || !selected.entity_id) {
      setSelectedSale(null);
      setSelectedSaleItems([]);
      setSaleDetailError('');
      return;
    }
    let cancelled = false;
    (async () => {
      setSaleDetailLoading(true);
      setSaleDetailError('');
      const [{ data: sale, error: saleError }, { data: items, error: itemsError }] = await Promise.all([
        supabase.from('sales').select('*').eq('id', selected.entity_id).maybeSingle(),
        supabase.from('sale_items').select('*').eq('sale_id', selected.entity_id),
      ]);
      if (cancelled) return;
      if (saleError) {
        setSaleDetailError('Satış bilgileri yüklenemedi.');
        setSelectedSale(null);
      } else {
        setSelectedSale((sale || null) as Sale | null);
      }
      if (itemsError) {
        setSaleDetailError(prev => prev || 'Satış kalemleri yüklenemedi.');
        setSelectedSaleItems([]);
      } else {
        setSelectedSaleItems((items || []) as SaleItem[]);
      }
      setSaleDetailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selected]);

  const formatMoney = (value: number | null | undefined) => new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(Number(value || 0));
  const paymentLabel = (method?: string | null) => paymentLabels[method || ''] || (method === 'split' ? 'Bölünmüş ödeme' : method || '-');

  if (!isAdmin) {
    return <div className="h-full overflow-auto p-6"><div className="mx-auto max-w-2xl card p-8 text-center"><ShieldCheck className="mx-auto mb-3 text-amber-600" size={38}/><h1 className="text-xl font-bold text-slate-800">İşlem Geçmişi</h1><p className="mt-2 text-sm text-slate-500">Bu alan yalnızca Yönetici / Admin hesabına açıktır.</p></div></div>;
  }

  return <div className="h-full overflow-auto p-6">
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-bold text-slate-800">İşlem Geçmişi</h1><p className="text-sm text-slate-500">Kim, ne zaman, hangi kaydı değiştirdi? Tüm kritik hareketleri buradan takip edin.</p></div>
        <div className="flex gap-2"><button className="btn-secondary" onClick={load}><RefreshCw size={16}/> Yenile</button><button className="btn-secondary" onClick={() => { const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download='propos-islem-gecmisi.csv'; a.click(); URL.revokeObjectURL(url); }} disabled={!rows.length}><Download size={16}/> CSV</button></div>
      </div>

      <div className="card p-4 space-y-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700"><Filter size={16}/> Filtreler</div>
        <DateRangeFilter value={range} onChange={setRange}/>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_2fr]">
          <select className="input" value={actor} onChange={e=>setActor(e.target.value)}><option value="">Tüm personeller</option>{staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <input className="input" placeholder="İşlem türü..." value={action} onChange={e=>setAction(e.target.value)}/>
          <input className="input" placeholder="Kayıt, detay, neden veya metin ara..." value={search} onChange={e=>setSearch(e.target.value)}/>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="border-b border-slate-200 px-5 py-4 flex items-center justify-between"><span className="font-semibold text-slate-800">{rows.length} kayıt</span><span className="text-xs text-slate-400">En yeni üstte</span></div>
        {loading ? <div className="p-8 text-center text-sm text-slate-400">Yükleniyor...</div> : rows.length === 0 ? <div className="p-8 text-center text-sm text-slate-400">Seçilen filtrelerde kayıt bulunamadı.</div> : <div className="divide-y divide-slate-100">{rows.map(r=><div key={r.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-slate-800">{actionLabel(r.action)}</span><span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">{r.entity_type || 'genel'}</span></div><p className="mt-1 text-xs text-slate-400">{formatDateTime(r.created_at)} • {r.staff_name || 'Personel bilinmiyor'} {r.entity_id ? `• ${r.entity_id}` : ''}</p><p className="mt-1 truncate text-xs text-slate-500">{detailsText(r.details)}</p></div><button className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50" onClick={()=>setSelected(r)}><Eye size={15}/> Detay</button>
        </div>)}</div>}
      </div>
    </div>

    {selected && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/55 p-3 sm:p-5" onClick={()=>setSelected(null)}>
      <div className="card flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden p-0" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true" aria-label="İşlem detayı">
        <div className="border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-lg font-bold text-slate-800">{actionLabel(selected.action)}</p>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">İşlem kaydı</span>
              </div>
              <p className="mt-1 text-xs text-slate-400">İşlemin tüm ayrıntıları</p>
            </div>
            <button className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50" onClick={()=>setSelected(null)}><X size={16}/> Kapat</button>
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tarih</div><div className="mt-1 text-sm font-semibold text-slate-800">{formatDateTime(selected.created_at)}</div></div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Personel</div><div className="mt-1 truncate text-sm font-semibold text-slate-800">{selected.staff_name || 'Personel bilinmiyor'}</div></div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Modül</div><div className="mt-1 text-sm font-semibold text-slate-800">{selected.entity_type || 'Genel'}</div></div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Kayıt ID</div><div className="mt-1 truncate text-xs font-semibold text-slate-700" title={selected.entity_id || '-'}>{selected.entity_id || '-'}</div></div>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto bg-slate-50/70 px-5 py-5 sm:px-6">
          {selected.entity_type === 'sale' ? <>
            {saleDetailLoading ? <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-400">Satış fişi hazırlanıyor...</div> : saleDetailError && !selectedSale ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">{saleDetailError}</div> : <div className="space-y-4">
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
                  <div className="flex items-center gap-3"><div className="rounded-xl bg-slate-900 p-2.5 text-white"><ReceiptText size={20}/></div><div><h2 className="font-bold text-slate-800">Satış Fişi</h2><p className="text-xs text-slate-400">Satışın tüm ürün ve ödeme ayrıntıları</p></div></div>
                </div>
                <div className="px-5 py-4 sm:px-6">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="flex gap-3 rounded-xl bg-slate-50 p-3"><ShoppingBag size={17} className="mt-0.5 text-slate-500"/><div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Ürün / Kalem</div><div className="text-sm font-bold text-slate-800">{selectedSaleItems.reduce((n, i) => n + Number(i.quantity || 0), 0)} adet</div></div></div>
                    <div className="flex gap-3 rounded-xl bg-slate-50 p-3"><CreditCard size={17} className="mt-0.5 text-slate-500"/><div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Ödeme</div><div className="text-sm font-bold text-slate-800">{paymentLabel(selectedSale?.payment_method || String(selected.details?.paymentMethod || ''))}</div></div></div>
                    <div className="flex gap-3 rounded-xl bg-slate-50 p-3"><UserRound size={17} className="mt-0.5 text-slate-500"/><div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Müşteri</div><div className="truncate text-sm font-bold text-slate-800">{selectedSale?.customer_name || 'Genel müşteri'}</div></div></div>
                    <div className="flex gap-3 rounded-xl bg-slate-50 p-3"><Banknote size={17} className="mt-0.5 text-slate-500"/><div><div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Ödenen</div><div className="text-sm font-bold text-slate-800">{formatMoney(selectedSale?.paid_amount ?? selected.details?.total as number)}</div></div></div>
                  </div>
                </div>

                <div className="border-y border-slate-200 bg-white">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 bg-slate-50 px-5 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-400 sm:grid-cols-[1fr_90px_110px_120px]"><span>Ürün</span><span className="text-right">Miktar</span><span className="text-right">Birim</span><span className="text-right">Tutar</span></div>
                  {selectedSaleItems.length ? <div className="divide-y divide-slate-100">{selectedSaleItems.map((item, index) => <div key={item.id || `${item.product_name}-${index}`} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-5 py-3.5 sm:grid-cols-[1fr_90px_110px_120px]"><div className="min-w-0"><div className="truncate text-sm font-semibold text-slate-800">{item.product_name || 'Ürün'}</div><div className="mt-0.5 text-[11px] text-slate-400">{item.barcode ? `Barkod: ${item.barcode}` : 'Barkod yok'}{Number(item.discount_amount || 0) > 0 ? ` · İndirim: ${formatMoney(item.discount_amount)}` : ''}</div></div><div className="text-right text-sm font-semibold text-slate-700">{Number(item.quantity || 0)}</div><div className="text-right text-sm text-slate-600">{formatMoney(item.unit_price)}</div><div className="text-right text-sm font-bold text-slate-800">{formatMoney(item.subtotal)}</div></div>)}</div> : <div className="p-8 text-center text-sm text-slate-400">Bu satış için ürün kalemi bulunamadı.</div>}
                </div>

                <div className="grid gap-4 px-5 py-5 sm:grid-cols-[1fr_280px] sm:px-6">
                  <div className="rounded-xl border border-dashed border-slate-200 p-4"><div className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-700"><Calculator size={16}/> Satış özeti</div><div className="space-y-2 text-sm"><div className="flex justify-between gap-3 text-slate-500"><span>Liste toplamı</span><b className="text-slate-700">{formatMoney(selectedSale?.original_total)}</b></div><div className="flex justify-between gap-3 text-slate-500"><span>İndirim</span><b className="text-emerald-600">-{formatMoney(selectedSale?.discount_total)}</b></div><div className="flex justify-between gap-3 text-slate-500"><span>Ödenen</span><b className="text-slate-700">{formatMoney(selectedSale?.paid_amount)}</b></div>{selectedSale?.payment_method === 'credit' && <div className="flex justify-between gap-3 text-slate-500"><span>Veresiye</span><b className="text-rose-600">{formatMoney(Math.max(Number(selectedSale.total || 0) - Number(selectedSale.paid_amount || 0), 0))}</b></div>}</div></div>
                  <div className="rounded-2xl bg-slate-900 p-5 text-white"><div className="text-xs text-slate-300">GENEL TOPLAM</div><div className="mt-1 text-3xl font-black">{formatMoney(selectedSale?.total ?? Number(selected.details?.total || 0))}</div><div className="mt-2 text-xs text-slate-300">{selectedSaleItems.length} farklı ürün · {selectedSaleItems.reduce((n, i) => n + Number(i.quantity || 0), 0)} adet</div></div>
                </div>
              </div>
              {saleDetailError && <div className="text-xs text-amber-700">{saleDetailError}</div>}
            </div>}
          </> : <>
            <div className="mb-3"><h2 className="text-sm font-bold text-slate-800">İşlem Detayları</h2><p className="mt-0.5 text-xs text-slate-400">Teknik veri yerine kullanıcı dostu bilgiler gösteriliyor.</p></div>
            {selected.details && Object.keys(selected.details).length > 0 ? <div className="grid gap-3 sm:grid-cols-2">{Object.entries(selected.details).map(([key, value]) => <DetailValue key={key} label={key} value={value} />)}</div> : <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">Bu işlem için ek detay bulunmuyor.</div>}
          </>}
        </div>
      </div>
    </div>}
  </div>;
}
