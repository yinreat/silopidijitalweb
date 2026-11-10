import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, BarChart3, Banknote, BookOpen, CalendarDays, CreditCard,
  Download, Package, Printer, Receipt, RotateCcw, ShoppingBag, Trash, Trash2,
  TrendingDown, TrendingUp, Users, X, ChevronRight
} from 'lucide-react';
import {
  getSaleItems, getShopExpenses, moveSaleToTrash, permanentlyDeleteSale,
  processSaleReturn, restoreSaleFromTrash, useCashSessions, useDeletedSales, useProducts,
  useSales, useStaff
} from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import { formatCurrency, formatDateTime, PAYMENT_METHODS } from '@/lib/utils';
import DateRangeFilter, { getDateBounds, type DateRangeValue } from '@/components/DateRangeFilter';
import type { Sale, SaleItem } from '@/lib/supabase';

type Tab = 'overview' | 'products' | 'staff' | 'daily';
const money = (v: number) => formatCurrency(Number.isFinite(v) ? v : 0);
const paymentLabel = (m: Sale['payment_method']) => m === 'split' ? 'Karma' : PAYMENT_METHODS[m]?.label || m;

type CostResolution = { unitCost: number; suspicious: boolean; recordedCost: number | null };
function resolveReportUnitCost(item: SaleItem, currentCost: number): CostResolution {
  const fallback = Number.isFinite(currentCost) && currentCost >= 0 ? currentCost : 0;
  if (item.cost_at_sale === null || item.cost_at_sale === undefined) return { unitCost: fallback, suspicious: false, recordedCost: null };
  const recorded = Number(item.cost_at_sale);
  const soldFor = Math.abs(Number(item.unit_price || 0));
  const reasonableCeiling = Math.max(10000, soldFor * 1000);
  const suspicious = !Number.isFinite(recorded) || recorded < 0 || recorded > reasonableCeiling;
  return { unitCost: suspicious ? fallback : recorded, suspicious, recordedCost: Number.isFinite(recorded) ? recorded : null };
}

export default function ReportsPage() {
  const { sales, loading, reload: reloadSales } = useSales(50000);
  const { sales: deletedSales, loading: trashLoading, reload: reloadTrash } = useDeletedSales(200);
  const { products } = useProducts();
  const { staff } = useStaff();
  const { sessions: cashSessions } = useCashSessions(500);
  const staffMap = useMemo(() => new Map(staff.map(s => [s.id, s.name])), [staff]);
  const [items, setItems] = useState<SaleItem[]>([]);
  const [returnRows, setReturnRows] = useState<{ sale_item_id: string; quantity: number; amount: number }[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const [dateRange, setDateRange] = useState<DateRangeValue>({ preset:'today', startDate:todayText, endDate:todayText });
  const [staffFilter, setStaffFilter] = useState('all');
  const [reportSearch, setReportSearch] = useState('');

  const filteredSales = useMemo(() => {
    let list = sales.filter(s => !s.refunded_at && !String(s.deleted_reason || '').startsWith('İADE|'));
    if (staffFilter !== 'all') list = list.filter(s => staffFilter === '__unassigned__' ? !s.staff_id : s.staff_id === staffFilter);
    const { start, end } = getDateBounds(dateRange);
    if (dateRange.preset === 'all' || !start) return list;
    return list.filter(s => { const d = new Date(s.created_at); return d >= start && (!end || d <= end); });
  }, [sales, dateRange, staffFilter]);

  useEffect(() => {
    let cancelled = false;
    const ids = filteredSales.map(s => s.id);
    if (!ids.length) { setItems([]); setReturnRows([]); return; }
    (async () => {
      const { data: saleItemRows, error: itemError } = await supabase.from('sale_items').select('*').in('sale_id', ids);
      if (itemError) console.error('Rapor ürün satırları yüklenemedi:', itemError.message);
      const fetchedItems = (saleItemRows || []) as SaleItem[];
      const itemIds = fetchedItems.map(item => item.id).filter(Boolean);
      let fetchedReturns: { sale_item_id: string; quantity: number; amount: number }[] = [];
      if (itemIds.length) {
        const { data: returns, error: returnError } = await supabase.from('sale_returns').select('sale_item_id,quantity,amount').in('sale_item_id', itemIds);
        if (returnError) console.warn('Rapor iadeleri yüklenemedi:', returnError.message);
        fetchedReturns = (returns || []) as typeof fetchedReturns;
      }
      if (!cancelled) { setItems(fetchedItems); setReturnRows(fetchedReturns); }
    })();
    return () => { cancelled = true; };
  }, [filteredSales]);

  const costWarnings = useMemo(() => {
    const currentCosts = new Map(products.map(p => [p.id, Number(p.cost || 0)]));
    return items.flatMap(item => {
      const resolution = resolveReportUnitCost(item, currentCosts.get(item.product_id || '') || 0);
      return resolution.suspicious ? [{
        productName: item.product_name,
        recordedCost: resolution.recordedCost,
        fallbackCost: resolution.unitCost,
        saleId: item.sale_id,
      }] : [];
    });
  }, [items, products]);

  const stats = useMemo(() => {
    const total = filteredSales.reduce((a,s)=>a+Math.max(0, Number(s.total||0)-Number(s.refund_amount||0)),0);
    const cash = filteredSales.filter(s=>s.payment_method==='cash').reduce((a,s)=>a+Number(s.total||0),0);
    const card = filteredSales.filter(s=>s.payment_method==='card').reduce((a,s)=>a+Number(s.total||0),0);
    const credit = filteredSales.filter(s=>s.payment_method==='credit').reduce((a,s)=>a+Number(s.total||0),0);
    const costMap = new Map(products.map(p=>[p.id,Number(p.cost||0)]));
    const returnedByItem = new Map<string, number>();
    for (const row of returnRows) returnedByItem.set(row.sale_item_id, (returnedByItem.get(row.sale_item_id) || 0) + Number(row.quantity || 0));
    const cost = items.reduce((a,i)=>a+Math.max(0, Number(i.quantity||0)-(returnedByItem.get(i.id)||0))*resolveReportUnitCost(i, costMap.get(i.product_id||'') ?? 0).unitCost,0);
    const expenses = cashSessions.flatMap(s=>getShopExpenses(s.note)).filter(e=>inRange(e.created_at,dateRange)).reduce((a,e)=>a+Number(e.amount||0),0);
    const refunds = sales.filter(s=>s.refunded_at || String(s.deleted_reason||'').startsWith('İADE|')).filter(s=>inRange(s.refunded_at || String(s.deleted_reason||'').split('|')[1] || s.created_at,dateRange)).reduce((a,s)=>a+Number(s.refund_amount ?? (String(s.deleted_reason||'').startsWith('İADE|') ? String(s.deleted_reason).split('|')[2] : s.total) ?? 0),0);
    const profit = total-cost;
    return {total,cash,card,credit,cost,expenses,refunds,profit,margin:total?profit/total*100:0,count:filteredSales.length,avg:filteredSales.length?total/filteredSales.length:0};
  }, [filteredSales,items,returnRows,products,cashSessions,dateRange,sales]);

  const productRows = useMemo(() => {
    const returnedQty = new Map<string, number>(); const returnedAmount = new Map<string, number>();
    for (const row of returnRows) { returnedQty.set(row.sale_item_id, (returnedQty.get(row.sale_item_id)||0)+Number(row.quantity||0)); returnedAmount.set(row.sale_item_id,(returnedAmount.get(row.sale_item_id)||0)+Number(row.amount||0)); }
    const productById = new Map<string, (typeof products)[number]>(products.map(p=>[p.id,p] as const));
    const costMap = new Map(products.map(p=>[p.id,Number(p.cost||0)]));
    const map = new Map<string,{name:string;barcode:string;qty:number;revenue:number;cost:number;profit:number}>();
    items.forEach(i=>{
      const key=i.product_id||i.product_name;
      const product = productById.get(i.product_id || '');
      const q=Math.max(0,Number(i.quantity||0)-(returnedQty.get(i.id)||0)), r=Math.max(0,Number(i.subtotal||0)-(returnedAmount.get(i.id)||0)), c=q*resolveReportUnitCost(i,costMap.get(i.product_id||'')??0).unitCost;
      const old=map.get(key)||{name:i.product_name,barcode:String(i.barcode || product?.barcode || ''),qty:0,revenue:0,cost:0,profit:0};
      if (!old.barcode) old.barcode = String(i.barcode || product?.barcode || '');
      old.qty+=q; old.revenue+=r; old.cost+=c; old.profit+=r-c; map.set(key,old);
    });
    return [...map.values()].sort((a,b)=>b.revenue-a.revenue);
  }, [items,products,returnRows]);

  const staffRows = useMemo(() => {
    const map = new Map<string,{name:string;count:number;total:number}>();
    filteredSales.forEach(s=>{const key=s.staff_id||'__unassigned__'; const old=map.get(key)||{name:s.staff_id?(staffMap.get(s.staff_id)||'Bilinmiyor'):'Personel atanmamış',count:0,total:0}; old.count++; old.total+=Math.max(0,Number(s.total||0)-Number(s.refund_amount||0)); map.set(key,old);});
    return [...map.values()].sort((a,b)=>b.total-a.total);
  }, [filteredSales,staffMap]);

  const dailyRows = useMemo(() => {
    const map = new Map<string,{day:string;count:number;total:number}>();
    filteredSales.forEach(s=>{const d=new Date(s.created_at), key=d.toISOString().slice(0,10); const old=map.get(key)||{day:key,count:0,total:0}; old.count++; old.total+=Math.max(0,Number(s.total||0)-Number(s.refund_amount||0)); map.set(key,old);});
    return [...map.values()].sort((a,b)=>a.day.localeCompare(b.day));
  }, [filteredSales]);

  const lowStock = products.filter(p=>!p.unlimited_stock && Number(p.stock)<=Number(p.min_stock));

  const searchNeedle = reportSearch.trim().toLocaleLowerCase('tr-TR');
  const searchedProductRows = useMemo(() => !searchNeedle ? productRows : productRows.filter(r => r.name.toLocaleLowerCase('tr-TR').includes(searchNeedle) || String(r.barcode || '').toLocaleLowerCase('tr-TR').includes(searchNeedle)), [productRows, searchNeedle]);
  const searchedStaffRows = useMemo(() => !searchNeedle ? staffRows : staffRows.filter(r => r.name.toLocaleLowerCase('tr-TR').includes(searchNeedle)), [staffRows, searchNeedle]);
  const searchedDailyRows = useMemo(() => !searchNeedle ? dailyRows : dailyRows.filter(r => r.day.includes(searchNeedle)), [dailyRows, searchNeedle]);
  const saleItemSearchText = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) {
      const value = `${item.product_name || ''} ${item.barcode || ''}`.toLocaleLowerCase('tr-TR');
      map.set(item.sale_id, `${map.get(item.sale_id) || ''} ${value}`);
    }
    return map;
  }, [items]);
  const searchedSales = useMemo(() => !searchNeedle ? filteredSales : filteredSales.filter(s => {
    const staffName = staffMap.get(s.staff_id || '') || '';
    return [s.id, s.id.slice(-8), s.customer_name || '', staffName, paymentLabel(s.payment_method), formatDateTime(s.created_at), String(Math.max(0,Number(s.total||0)-Number(s.refund_amount||0))), saleItemSearchText.get(s.id) || '']
      .some(value => value.toLocaleLowerCase('tr-TR').includes(searchNeedle));
  }), [filteredSales, searchNeedle, staffMap, saleItemSearchText]);
  const searchedLowStock = useMemo(() => !searchNeedle ? lowStock : lowStock.filter(p => p.name.toLocaleLowerCase('tr-TR').includes(searchNeedle) || String(p.barcode || '').includes(searchNeedle)), [lowStock, searchNeedle]);

  function exportCsv() {
    const rows = [['Tarih','Personel','Müşteri','Ödeme','Tutar','Satış ID'], ...searchedSales.map(s=>[formatDateTime(s.created_at),staffMap.get(s.staff_id||'')||'Personel atanmamış',s.customer_name||'',paymentLabel(s.payment_method),Math.max(0,Number(s.total||0)-Number(s.refund_amount||0)).toFixed(2),s.id])];
    const csv='\uFEFF'+rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(';')).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}), url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=`propos-rapor-${todayText}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  async function trashSale(s: Sale) { if(!confirm('Bu satışı çöp kutusuna taşımak istiyor musun?')) return; setActionLoading(true); const ok=await moveSaleToTrash(s.id); setActionLoading(false); if(ok){setSelectedSale(null);await reloadSales();await reloadTrash();} else alert('Satış taşınamadı.'); }
  async function refund(s: Sale) {
    if (!confirm('Bu satışın kalan tüm ürünlerini orijinal ödeme dağılımına göre iade etmek istiyor musun?')) return;
    const staffId = getCurrentStaffId();
    if (!staffId) { alert('İade işlemi için önce personel girişi yapın.'); return; }
    setActionLoading(true);
    try {
      const { data: saleItems, error: itemsError } = await supabase.from('sale_items').select('id, quantity').eq('sale_id', s.id);
      if (itemsError || !saleItems?.length) throw new Error(itemsError?.message || 'Satış kalemleri bulunamadı.');
      const itemIds = saleItems.map((item: any) => item.id);
      const { data: returns, error: returnError } = await supabase.from('sale_returns').select('sale_item_id, quantity').in('sale_item_id', itemIds);
      if (returnError) throw new Error(`Önceki iadeler doğrulanamadı: ${returnError.message}`);
      const returned = new Map<string, number>();
      for (const row of returns || []) returned.set(row.sale_item_id, (returned.get(row.sale_item_id) || 0) + Number(row.quantity || 0));
      const remaining = saleItems.map((item: any) => ({ saleItemId: item.id, quantity: Math.max(0, Number(item.quantity || 0) - (returned.get(item.id) || 0)) })).filter((item: any) => item.quantity > 0);
      if (!remaining.length) throw new Error('Bu satışın iade edilebilir ürünü kalmamış.');
      const result = await processSaleReturn({ saleId: s.id, items: remaining, reason: 'Satış ekranından tam iade', staffId, returnMethod: 'original' });
      if (!result.success) throw new Error(result.error || 'İade kaydedilemedi.');
      setSelectedSale(null);
      await reloadSales();
      alert(`${money(result.refundAmount)} iade edildi. Stok ve gerekli kasa/cari kayıtları güncellendi.`);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'İade başarısız. Kayıt durumunu kontrol etmeden tekrar denemeyin.');
    } finally { setActionLoading(false); }
  }

  return <div className="reports-print-root flex h-screen flex-col overflow-hidden bg-slate-50 print:block print:h-auto">
    <header className="border-b bg-white px-4 py-4 sm:px-6 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="flex items-center gap-2"><BarChart3 className="text-teal-600" size={23}/><h1 className="text-xl font-bold text-slate-800">Silopi Dijital - ProPOS · Rapor Merkezi</h1></div><p className="mt-1 text-sm text-slate-500">Satış, kâr, personel, ürün ve günlük performans</p></div>
        <div className="flex flex-wrap items-center gap-2"><button onClick={()=>{document.body.classList.add('printing-reports');window.addEventListener('afterprint',()=>document.body.classList.remove('printing-reports'),{once:true});window.print();}} className="btn-secondary"><Printer size={16}/> Yazdır</button><button onClick={exportCsv} className="btn-secondary"><Download size={16}/> CSV</button><button onClick={()=>setShowTrash(true)} className="btn-secondary"><Trash2 size={16}/> Çöp Kutusu {deletedSales.length>0&&<span className="rounded-full bg-red-100 px-1.5 text-xs text-red-600">{deletedSales.length}</span>}</button></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2"><DateRangeFilter value={dateRange} onChange={setDateRange}/><div className="min-w-[260px] flex-1"><input className="input py-1.5 text-sm" value={reportSearch} onChange={e=>setReportSearch(e.target.value)} placeholder="Ürün/barkod ara: bugün kaç adet satıldı? Fiş, müşteri, personel de aranır." aria-label="Raporlarda ara" /></div><select value={staffFilter} onChange={e=>setStaffFilter(e.target.value)} className="input py-1.5 text-sm"><option value="all">Tüm Personel</option>{staff.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}<option value="__unassigned__">Personel atanmamış</option></select></div>
      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-slate-100"><TabButton active={tab==='overview'} onClick={()=>setTab('overview')} icon={<TrendingUp size={16}/>} text="Genel Bakış"/><TabButton active={tab==='products'} onClick={()=>setTab('products')} icon={<Package size={16}/>} text="Ürün Analizi"/><TabButton active={tab==='staff'} onClick={()=>setTab('staff')} icon={<Users size={16}/>} text="Personel"/><TabButton active={tab==='daily'} onClick={()=>setTab('daily')} icon={<CalendarDays size={16}/>} text="Günlük Trend"/></div>
    </header>

    <main className="flex-1 overflow-y-auto p-4 sm:p-6 print:overflow-visible print:p-0">
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 hidden print:block"><h1 className="text-2xl font-bold">Silopi Dijital - ProPOS — Rapor Merkezi</h1><p className="text-sm text-slate-500">Oluşturulma: {formatDateTime(new Date().toISOString())}</p></div>
        <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Toplam Ciro" value={money(stats.total)} icon={<TrendingUp/>} tone="teal"/>
          <Metric label="Satış Adedi" value={String(stats.count)} icon={<ShoppingBag/>} tone="blue"/>
          <Metric label="Gerçekleşen Kâr" value={money(stats.profit)} sub={`Marj %${stats.margin.toFixed(1)}`} icon={stats.profit>=0?<TrendingUp/>:<TrendingDown/>} tone={stats.profit>=0?'emerald':'rose'}/>
          <Metric label="İade Tutarı" value={money(stats.refunds)} icon={<RotateCcw/>} tone="rose"/>
        </section>
        {costWarnings.length > 0 && <section role="status" className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <div className="flex items-start gap-3"><AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-700"/><div className="min-w-0"><h2 className="font-bold">Kontrol gerektiren ürün maliyeti · {costWarnings.length} kayıt</h2><p className="mt-1 text-sm">Olağan dışı geçmiş maliyetler kâr raporunu bozmasın diye bu satırlarda geçici olarak ürün kartındaki güncel alış fiyatı kullanılıyor. Geçmiş satış satırı ayrıca kontrol edilmelidir.</p><div className="mt-2 space-y-1 text-xs">{costWarnings.slice(0,5).map((w,i)=><p key={`${w.saleId}-${i}`}><b>{w.productName}</b> · Kaydedilen: {w.recordedCost===null?'Geçersiz':money(w.recordedCost)} · Hesapta kullanılan: {money(w.fallbackCost)} · Fiş #{w.saleId.slice(-8)}</p>)}</div>{costWarnings.length>5&&<p className="mt-1 text-xs">+{costWarnings.length-5} kayıt daha</p>}</div></div>
        </section>}
        <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><SmallMetric label="Nakit" value={money(stats.cash)} icon={<Banknote/>}/><SmallMetric label="Kart" value={money(stats.card)} icon={<CreditCard/>}/><SmallMetric label="Veresiye" value={money(stats.credit)} icon={<BookOpen/>}/><SmallMetric label="Dükkan Gideri" value={money(stats.expenses)} icon={<Receipt/>}/></section>

        {tab==='overview' && <Overview stats={stats} products={products} lowStock={searchedLowStock} productRows={searchedProductRows} dailyRows={searchedDailyRows}/>} 
        {tab==='products' && <ProductReport rows={searchedProductRows}/>} 
        {tab==='staff' && <StaffReport rows={searchedStaffRows}/>} 
        {tab==='daily' && <DailyReport rows={searchedDailyRows}/>} 

        <section className="card mt-6 overflow-hidden print:break-before-auto">
          <div className="flex items-center justify-between border-b px-4 py-3"><div><h2 className="font-bold text-slate-800">Satış Hareketleri</h2><p className="text-xs text-slate-500">Filtreye uyan son 50 satış</p></div><span className="text-xs text-slate-400">{loading?'Yükleniyor…':`${searchedSales.length} kayıt`}</span></div>
          <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="px-4 py-3">Tarih / Personel</th><th className="px-4 py-3">Ödeme</th><th className="px-4 py-3">Müşteri</th><th className="px-4 py-3 text-right">Tutar</th><th className="px-4 py-3 print:hidden"></th></tr></thead><tbody>{searchedSales.slice(0,50).map(s=><tr key={s.id} onClick={()=>setSelectedSale(s)} className="cursor-pointer border-t hover:bg-slate-50"><td className="px-4 py-3"><b>{s.staff_id?(staffMap.get(s.staff_id)||'Personel bilinmiyor'):'Personel atanmamış'}</b><div className="text-xs text-slate-500">{formatDateTime(s.created_at)}</div></td><td className="px-4 py-3"><span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium">{paymentLabel(s.payment_method)}</span></td><td className="px-4 py-3 text-slate-600">{s.customer_name||'-'}</td><td className="px-4 py-3 text-right font-bold text-teal-700">{money(Number(s.total))}</td><td className="px-4 py-3 text-right print:hidden"><ChevronRight size={16} className="inline text-slate-400"/></td></tr>)}</tbody></table>{!searchedSales.length&&<div className="p-10 text-center text-slate-400">Bu arama ve filtrelerde satış bulunamadı.</div>}</div>
        </section>
      </div>
    </main>
    {selectedSale&&<SaleDetailModal sale={selectedSale} staffMap={staffMap} onClose={()=>setSelectedSale(null)} onTrash={()=>trashSale(selectedSale)} onRefund={()=>refund(selectedSale)} onAfterReturn={async()=>{setSelectedSale(null);await reloadSales();}} actionLoading={actionLoading}/>} 
    {showTrash&&<TrashModal sales={deletedSales} loading={trashLoading} staffMap={staffMap} onClose={()=>setShowTrash(false)} onRestore={async id=>{setActionLoading(true);const ok=await restoreSaleFromTrash(id);setActionLoading(false);if(ok){await reloadSales();await reloadTrash();}}} onDelete={async id=>{if(!confirm('Bu satış kalıcı olarak silinsin mi?'))return;setActionLoading(true);const ok=await permanentlyDeleteSale(id);setActionLoading(false);if(ok)await reloadTrash();}} actionLoading={actionLoading}/>} 
  </div>;
}

function getCurrentStaffId(): string | null {
  try {
    const raw = sessionStorage.getItem('propos-current-staff-v2');
    const parsed = raw ? JSON.parse(raw) as { id?: unknown } : null;
    return typeof parsed?.id === 'string' ? parsed.id : null;
  } catch { return null; }
}

function inRange(value:string, range:DateRangeValue){const {start,end}=getDateBounds(range);if(range.preset==='all'||!start)return true;const d=new Date(value);return d>=start&&(!end||d<=end);}
function TabButton({active,onClick,icon,text}:{active:boolean;onClick:()=>void;icon:React.ReactNode;text:string}){return <button onClick={onClick} className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold ${active?'border-teal-600 text-teal-700':'border-transparent text-slate-500 hover:text-slate-800'}`}>{icon}{text}</button>}
function Metric({label,value,sub,icon,tone}:{label:string;value:string;sub?:string;icon:React.ReactNode;tone:string}){const bg=tone==='teal'?'bg-teal-50 text-teal-700':tone==='blue'?'bg-blue-50 text-blue-700':tone==='emerald'?'bg-emerald-50 text-emerald-700':'bg-rose-50 text-rose-700';return <div className="card p-4"><div className="flex items-start justify-between"><div><p className="text-xs font-medium text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-slate-800">{value}</p>{sub&&<p className="mt-1 text-xs text-slate-500">{sub}</p>}</div><div className={`rounded-xl p-2.5 ${bg}`}>{icon}</div></div></div>}
function SmallMetric({label,value,icon}:{label:string;value:string;icon:React.ReactNode}){return <div className="card flex items-center gap-3 p-4"><div className="rounded-lg bg-slate-100 p-2 text-slate-600">{icon}</div><div><p className="text-xs text-slate-500">{label}</p><p className="font-bold text-slate-800">{value}</p></div></div>}
function Overview({stats,products,lowStock,productRows,dailyRows}:{stats:any;products:any[];lowStock:any[];productRows:any[];dailyRows:any[]}){return <div className="grid gap-6 lg:grid-cols-3"><section className="card lg:col-span-2 overflow-hidden"><div className="border-b px-4 py-3"><h2 className="font-bold">En Çok Ciro Getiren Ürünler</h2></div><div className="divide-y">{productRows.slice(0,7).map((p,i)=><div key={p.name+i} className="flex items-center gap-3 px-4 py-3"><span className="w-6 text-center text-sm font-bold text-slate-400">{i+1}</span><div className="min-w-0 flex-1"><div className="truncate font-medium">{p.name}</div><div className="text-xs text-slate-500">{p.qty} adet · Maliyet {money(p.cost)}</div></div><div className="text-right"><b>{money(p.revenue)}</b><div className={`text-xs ${p.profit>=0?'text-emerald-600':'text-rose-600'}`}>Kâr {money(p.profit)}</div></div></div>)}{!productRows.length&&<div className="p-8 text-center text-slate-400">Ürün verisi yok.</div>}</div></section><section className="card overflow-hidden"><div className="border-b px-4 py-3"><h2 className="font-bold">Stok Uyarıları</h2></div><div className="divide-y">{lowStock.slice(0,8).map(p=><div key={p.id} className="flex items-center gap-3 px-4 py-3"><AlertTriangle size={17} className="text-amber-500"/><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{p.name}</div><div className="text-xs text-slate-500">Stok: {p.stock} · Limit: {p.min_stock}</div></div></div>)}{!lowStock.length&&<div className="p-8 text-center text-emerald-600">Stok uyarısı yok.</div>}</div></section><section className="card lg:col-span-3 overflow-hidden"><div className="border-b px-4 py-3"><h2 className="font-bold">Günlük Satış Özeti</h2></div><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-2 text-left">Gün</th><th className="px-4 py-2 text-right">Satış</th><th className="px-4 py-2 text-right">Ciro</th></tr></thead><tbody>{dailyRows.slice(-14).map(r=><tr key={r.day} className="border-t"><td className="px-4 py-2">{new Date(r.day+'T00:00:00').toLocaleDateString('tr-TR')}</td><td className="px-4 py-2 text-right">{r.count}</td><td className="px-4 py-2 text-right font-semibold">{money(r.total)}</td></tr>)}</tbody></table></div></section><div className="lg:col-span-3 grid gap-3 sm:grid-cols-3"><SmallMetric label="Ortalama Satış" value={money(stats.avg)} icon={<ShoppingBag/>}/><SmallMetric label="Toplam Maliyet" value={money(stats.cost)} icon={<Package/>}/><SmallMetric label="Ürün Çeşidi" value={String(products.length)} icon={<Package/>}/></div></div>}
function ProductReport({rows}:{rows:any[]}){return <section className="card overflow-hidden"><div className="border-b px-4 py-4"><h2 className="font-bold">Ürün Performans Analizi</h2><p className="text-xs text-slate-500">Adet, ciro, maliyet ve kâr · Ürün adı veya barkodla arayabilirsin.</p></div><div className="overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-3 text-left">Ürün</th><th className="px-4 py-3 text-right">Adet</th><th className="px-4 py-3 text-right">Ciro</th><th className="px-4 py-3 text-right">Maliyet</th><th className="px-4 py-3 text-right">Kâr</th><th className="px-4 py-3 text-right">Marj</th></tr></thead><tbody>{rows.map((r,i)=><tr key={r.name+i} className="border-t"><td className="px-4 py-3 font-medium">{r.name}{r.barcode&&<div className="mt-0.5 text-[11px] font-normal text-slate-400">Barkod: {r.barcode}</div>}</td><td className="px-4 py-3 text-right">{r.qty}</td><td className="px-4 py-3 text-right">{money(r.revenue)}</td><td className="px-4 py-3 text-right">{money(r.cost)}</td><td className={`px-4 py-3 text-right font-bold ${r.profit>=0?'text-emerald-700':'text-rose-700'}`}>{money(r.profit)}</td><td className="px-4 py-3 text-right">%{r.revenue?(r.profit/r.revenue*100).toFixed(1):'0.0'}</td></tr>)}</tbody></table></div></section>}
function StaffReport({rows}:{rows:any[]}){return <section className="card overflow-hidden"><div className="border-b px-4 py-4"><h2 className="font-bold">Personel Satış Performansı</h2><p className="text-xs text-slate-500">Seçili tarih aralığına göre</p></div><div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">{rows.map((r,i)=><div key={r.name+i} className="rounded-xl border bg-white p-4"><div className="flex items-center justify-between"><span className="text-xs text-slate-400">#{i+1}</span><Users size={18} className="text-slate-400"/></div><h3 className="mt-3 font-bold">{r.name}</h3><p className="mt-1 text-xs text-slate-500">{r.count} satış</p><p className="mt-2 text-xl font-bold text-teal-700">{money(r.total)}</p></div>)}</div>{!rows.length&&<div className="p-10 text-center text-slate-400">Personel satış verisi yok.</div>}</section>}
function DailyReport({rows}:{rows:any[]}){return <section className="card overflow-hidden"><div className="border-b px-4 py-4"><h2 className="font-bold">Günlük Trend</h2></div><div className="space-y-3 p-4">{rows.map(r=><div key={r.day} className="flex items-center gap-4"><div className="w-24 text-xs text-slate-500">{new Date(r.day+'T00:00:00').toLocaleDateString('tr-TR')}</div><div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-teal-500" style={{width:`${Math.min(100,(r.total/(Math.max(...rows.map(x=>x.total),1)))*100)}%`}}/></div><div className="w-28 text-right text-sm font-bold">{money(r.total)}</div><div className="w-16 text-right text-xs text-slate-500">{r.count} satış</div></div>)}</div></section>}

function SaleDetailModal({sale,staffMap,onClose,onTrash,onRefund,onAfterReturn,actionLoading}:{sale:Sale;staffMap:Map<string,string>;onClose:()=>void;onTrash:()=>Promise<void>;onRefund:()=>Promise<void>;onAfterReturn:()=>Promise<void>;actionLoading:boolean}) {
  const [items,setItems]=useState<SaleItem[]>([]);
  const [returnedQty,setReturnedQty]=useState<Record<string,number>>({});
  const [returnHistoryOk,setReturnHistoryOk]=useState(true);
  const [loading,setLoading]=useState(true);
  const [returning,setReturning]=useState<string|null>(null);
  const [qty,setQty]=useState('1');
  useEffect(()=>{
    let cancelled=false;
    async function load(){
      setLoading(true);
      setReturnHistoryOk(true);
      const rows=await getSaleItems(sale.id);
      if(cancelled)return;
      setItems(rows);
      const ids=rows.map(i=>i.id);
      if(ids.length){
        const {data,error}=await supabase.from('sale_returns').select('sale_item_id, quantity').in('sale_item_id',ids);
        if(error){alert(`Önceki iade miktarları doğrulanamadı: ${error.message}`);setReturnedQty({});setReturnHistoryOk(false);}
        else {
          const map:Record<string,number>={};
          for(const row of data||[]) map[row.sale_item_id]=(map[row.sale_item_id]||0)+Number(row.quantity||0);
          if(!cancelled)setReturnedQty(map);
        }
      } else setReturnedQty({});
      if(!cancelled)setLoading(false);
    }
    void load();
    return()=>{cancelled=true};
  },[sale.id]);
  const fullyReturned=items.length>0&&items.every(i=>Number(i.quantity||0)-(returnedQty[i.id]||0)<=0.0001);
  const returned=!!sale.refunded_at||fullyReturned||String(sale.deleted_reason||'').startsWith('İADE|');
  async function returnItem(item:SaleItem){
    const quantity=Number(qty);
    const remaining=Math.max(0,Number(item.quantity||0)-(returnedQty[item.id]||0));
    if(!returnHistoryOk){alert('Önceki iade kayıtları doğrulanamadı; güvenlik için yeni iade engellendi. Satış İadesi bölümünden tekrar kontrol edin.');return;}
    if(!Number.isFinite(quantity)||quantity<=0||quantity>remaining){alert(`İade miktarı 0 ile kalan ${remaining} arasında olmalı.`);return;}
    const staffId=getCurrentStaffId();
    if(!staffId){alert('İade işlemi için önce personel girişi yapın.');return;}
    setReturning(item.id);
    try{
      const result=await processSaleReturn({saleId:sale.id,items:[{saleItemId:item.id,quantity}],reason:'Rapor ekranından kısmi iade',staffId,returnMethod:'original'});
      if(!result.success)throw new Error(result.error||'İade kaydedilemedi.');
      alert(`${money(result.refundAmount)} iade edildi. Ayrıntılı kalan miktarlar için satış raporunu yeniledik.`);
      await onAfterReturn();
    }catch(error){alert(error instanceof Error?error.message:'İade başarısız. Kayıt durumunu kontrol etmeden tekrar denemeyin.');}
    finally{setReturning(null);}
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
    <div className="card w-full max-w-2xl overflow-hidden" onClick={e=>e.stopPropagation()}>
      <div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="font-bold text-lg">Satış Fişi Detayı</h2><p className="text-xs text-slate-500">{formatDateTime(sale.created_at)} · #{sale.id.slice(0,8)}</p></div><div className="flex items-center gap-2">{!returned&&<><button disabled={actionLoading} onClick={()=>void onRefund()} className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700"><RotateCcw size={14} className="mr-1 inline"/>Kalanların Tümünü İade Et</button><button disabled={actionLoading} onClick={()=>void onTrash()} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600"><Trash2 size={14} className="mr-1 inline"/>Çöpe Taşı</button></>}<button onClick={onClose}><X size={20}/></button></div></div>
      <div className="grid gap-3 border-b bg-slate-50 p-4 sm:grid-cols-4"><Info label="Personel" value={sale.staff_id?(staffMap.get(sale.staff_id)||'Bilinmiyor'):'Atanmamış'}/><Info label="Ödeme" value={paymentLabel(sale.payment_method)}/><Info label="Müşteri" value={sale.customer_name||'Yok'}/><Info label="Toplam" value={money(Number(sale.total))}/></div>
      <div className="max-h-[55vh] overflow-y-auto p-4">{loading?<div className="py-10 text-center text-slate-400">Fiş ürünleri yükleniyor…</div>:<div className="space-y-2">{items.map(i=>{const remaining=Math.max(0,Number(i.quantity||0)-(returnedQty[i.id]||0));return <div key={i.id} className="rounded-xl border p-3"><div className="flex items-start justify-between gap-3"><div><b>{i.product_name}</b><div className="mt-1 text-xs text-slate-500">Satılan {i.quantity} · İade edilen {returnedQty[i.id]||0} · Kalan {remaining} × {money(Number(i.unit_price))}{i.discount_amount>0&&` · İndirim ${money(Number(i.discount_amount))}`}</div>{i.barcode&&<div className="text-[11px] text-slate-400">Barkod: {i.barcode}</div>}</div><b>{money(Number(i.subtotal))}</b></div>{!returned&&remaining>0&&<div className="mt-2 flex justify-end gap-2"><input value={qty} onChange={e=>setQty(e.target.value)} type="number" min="0.001" max={remaining} step="0.001" className="h-8 w-20 rounded border px-2 text-xs"/><button disabled={returning===i.id||!returnHistoryOk} onClick={()=>void returnItem(i)} className="rounded-lg bg-amber-50 px-3 text-xs font-semibold text-amber-700">{returning===i.id?'İşleniyor…':'Kısmi İade'}</button></div>}</div>})}</div>}{!loading&&returned&&<div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-700">Bu satışın bütün ürünleri iade edilmiş.</div>}{sale.refund_amount!=null&&Number(sale.refund_amount)>0&&<div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Şimdiye kadar iade: {money(Number(sale.refund_amount))}</div>}</div>
    </div>
  </div>;
}

function Info({label,value}:{label:string;value:string}){return <div><div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div><div className="mt-0.5 truncate text-sm font-semibold text-slate-700">{value}</div></div>}
function TrashModal({sales,loading,staffMap,onClose,onRestore,onDelete,actionLoading}:{sales:Sale[];loading:boolean;staffMap:Map<string,string>;onClose:()=>void;onRestore:(id:string)=>Promise<void>;onDelete:(id:string)=>Promise<void>;actionLoading:boolean}){return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}><div className="card w-full max-w-3xl overflow-hidden" onClick={e=>e.stopPropagation()}><div className="flex items-center justify-between border-b px-5 py-4"><div><h2 className="font-bold">Çöp Kutusu</h2><p className="text-xs text-slate-500">İptal edilen satışları geri yükle veya kalıcı sil.</p></div><button onClick={onClose}><X size={20}/></button></div><div className="max-h-[65vh] overflow-y-auto">{loading?<div className="p-10 text-center text-slate-400">Yükleniyor…</div>:!sales.length?<div className="p-10 text-center text-slate-400"><Trash2 className="mx-auto mb-2"/>Çöp kutusu boş.</div>:sales.map(s=><div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><b>{s.staff_id?(staffMap.get(s.staff_id)||'Bilinmiyor'):'Atanmamış'}</b><div className="text-xs text-slate-500">{formatDateTime(s.created_at)} · {paymentLabel(s.payment_method)} · {money(Number(s.total))}</div></div><div className="flex gap-2"><button disabled={actionLoading} onClick={()=>onRestore(s.id)} className="rounded-lg bg-teal-50 px-3 py-2 text-xs font-semibold text-teal-700">Geri Yükle</button><button disabled={actionLoading} onClick={()=>onDelete(s.id)} className="rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-600"><Trash size={14} className="mr-1 inline"/>Kalıcı Sil</button></div></div>)}</div></div></div>}
