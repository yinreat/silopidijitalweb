import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart3, TrendingUp, Wallet, Receipt, Percent, UtensilsCrossed, Gift, Info } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import DateRangeFilter, { getDateBounds, type DateRangeValue } from '@/components/DateRangeFilter';
import { getShopExpenses, useCashSessions, useProducts, useSales } from '@/lib/hooks';
import { formatCurrency } from '@/lib/utils';
import type { SaleItem } from '@/lib/supabase';

type Row = { name: string; qty: number; revenue: number; cost: number; grossProfit: number; margin: number; estimated: boolean };

export default function ProfitPage() {
  const { sales, loading: salesLoading } = useSales(50000);
  const { products, loading: productsLoading } = useProducts();
  const { sessions } = useCashSessions(500);
  const [items, setItems] = useState<SaleItem[]>([]);
  const [consumptionCost, setConsumptionCost] = useState(0);
  const [giftCost, setGiftCost] = useState(0);
  const [loadingExtra, setLoadingExtra] = useState(true);
  const today = new Date();
  const todayText = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const [range, setRange] = useState<DateRangeValue>({ preset: 'today', startDate: todayText, endDate: todayText });

  const activeSales = useMemo(() => {
    const { start, end } = getDateBounds(range);
    return sales.filter((s) => {
      if (s.refunded_at || String(s.deleted_reason || '').startsWith('İADE|')) return false;
      if (range.preset === 'all') return true;
      const d = new Date(s.created_at);
      return start ? (end ? d >= start && d < end : d >= start) : true;
    });
  }, [sales, range]);

  useEffect(() => {
    let cancelled = false;
    async function loadExtras() {
      setLoadingExtra(true);
      const ids = activeSales.map((s) => s.id);
      const { start, end } = getDateBounds(range);
      let itemRows: SaleItem[] = [];
      if (ids.length) {
        const { data, error } = await supabase.from('sale_items').select('*').in('sale_id', ids);
        if (error) console.error('Kârlılık satış kalemleri yüklenemedi:', error);
        itemRows = (data || []) as SaleItem[];
      }
      let personal = 0;
      let gifts = 0;
      const since = range.preset === 'all' || !start ? null : start.toISOString();
      let cq = supabase.from('staff_consumptions').select('total_amount,cost_amount,consumption_type,created_at');
      if (since) cq = cq.gte('created_at', since);
      if (end) cq = cq.lt('created_at', end.toISOString());
      const cr = await cq;
      if (cr.error) console.error('Personel tüketim giderleri yüklenemedi:', cr.error);
      for (const x of (cr.data || []) as any[]) {
        if (x.consumption_type === 'personal') personal += Number(x.cost_amount ?? x.total_amount ?? 0);
        else if (x.consumption_type === 'gift') gifts += Number(x.cost_amount ?? 0);
      }
      if (!cancelled) {
        setItems(itemRows); setConsumptionCost(personal); setGiftCost(gifts); setLoadingExtra(false);
      }
    }
    loadExtras();
    return () => { cancelled = true; };
  }, [activeSales, range]);

  const shopExpenses = useMemo(() => {
    const { start, end } = getDateBounds(range);
    return sessions.flatMap((s) => getShopExpenses(s.note)).filter((e) => {
      if (range.preset === 'all') return true;
      const d = new Date(e.created_at);
      return start ? (end ? d >= start && d < end : d >= start) : true;
    });
  }, [sessions, range]);

  const stats = useMemo(() => {
    const revenue = activeSales.reduce((s, x) => s + Number(x.total || 0), 0);
    const fallbackCosts = new Map(products.map((p) => [p.id, Number(p.cost || 0)]));
    const cogs = items.reduce((s, x) => s + Number(x.quantity || 0) * Number(x.cost_at_sale ?? fallbackCosts.get(x.product_id || '') ?? 0), 0);
    const grossProfit = revenue - cogs;
    const shopExpense = shopExpenses.reduce((s, x) => s + Number(x.amount || 0), 0);
    const operatingCosts = shopExpense + consumptionCost + giftCost;
    const netProfit = grossProfit - operatingCosts;
    const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;
    const estimatedRows = items.filter((x) => x.cost_is_estimated !== false).length;
    return { revenue, cogs, grossProfit, grossMargin, shopExpense, consumptionCost, giftCost, operatingCosts, netProfit, netMargin, estimatedRows, salesCount: activeSales.length };
  }, [activeSales, items, products, shopExpenses, consumptionCost, giftCost]);

  const rows = useMemo(() => {
    const costs = new Map(products.map((p) => [p.id, Number(p.cost || 0)]));
    const map = new Map<string, Row>();
    for (const it of items) {
      const key = it.product_id || `${it.barcode || ''}:${it.product_name}`;
      const q = Number(it.quantity || 0); const revenue = Number(it.subtotal || 0); const cost = q * Number(it.cost_at_sale ?? costs.get(it.product_id || '') ?? 0);
      const cur = map.get(key) || { name: it.product_name, qty: 0, revenue: 0, cost: 0, grossProfit: 0, margin: 0, estimated: false };
      cur.qty += q; cur.revenue += revenue; cur.cost += cost; cur.grossProfit += revenue - cost; cur.estimated = cur.estimated || it.cost_is_estimated !== false; cur.margin = cur.revenue > 0 ? cur.grossProfit / cur.revenue * 100 : 0;
      map.set(key, cur);
    }
    return [...map.values()].sort((a,b) => b.grossProfit - a.grossProfit).slice(0, 20);
  }, [items, products]);

  const loading = salesLoading || productsLoading || loadingExtra;

  return <div className="flex h-screen flex-col overflow-hidden bg-slate-100">
    <div className="border-b border-slate-200 bg-white px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="flex items-center gap-2"><BarChart3 className="text-emerald-600" size={22}/><h1 className="text-xl font-bold text-slate-800">Kârlılık & Marj</h1></div><p className="text-sm text-slate-500">Gerçek satış maliyeti, brüt kâr ve işletme giderleri</p></div>
<DateRangeFilter value={range} onChange={setRange} />
      </div>
    </div>
    <div className="flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-7xl space-y-6">
      {loading ? <div className="card p-12 text-center text-slate-400">Kârlılık verileri yükleniyor...</div> : <>
        {stats.estimatedRows > 0 && <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><Info size={18} className="mt-0.5 shrink-0"/><div><b>Bilgi:</b> {stats.estimatedRows} eski satış kaleminde maliyet geçmiş kayıtlardan tahmin edildi. Yeni satışlarda maliyet satış anında kesin olarak saklanır.</div></div>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={<TrendingUp className="text-teal-600"/>} label="Ciro" value={formatCurrency(stats.revenue)} />
          <Metric icon={<Receipt className="text-blue-600"/>} label="Satış Maliyeti (COGS)" value={formatCurrency(stats.cogs)} />
          <Metric icon={<Wallet className="text-emerald-600"/>} label="Brüt Kâr" value={formatCurrency(stats.grossProfit)} sub={`${stats.grossMargin.toFixed(1)}% brüt marj`} />
          <Metric icon={<Percent className="text-violet-600"/>} label="Net Kâr" value={formatCurrency(stats.netProfit)} sub={`${stats.netMargin.toFixed(1)}% net marj`} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric icon={<Wallet className="text-rose-600"/>} label="Dükkan Giderleri" value={formatCurrency(stats.shopExpense)} />
          <Metric icon={<UtensilsCrossed className="text-amber-600"/>} label="Personel Tüketimi" value={formatCurrency(stats.consumptionCost)} />
          <Metric icon={<Gift className="text-pink-600"/>} label="İkram" value={formatCurrency(stats.giftCost)} />
        </div>
        <div className="card overflow-hidden"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-bold text-slate-800">Ürün Bazlı Kârlılık</h2><p className="text-xs text-slate-500">Satış anındaki maliyet baz alınır.</p></div>
          <div className="overflow-x-auto"><table className="min-w-full text-sm"><thead className="bg-slate-50"><tr><th className="px-5 py-3 text-left">Ürün</th><th className="px-4 py-3 text-right">Adet</th><th className="px-4 py-3 text-right">Ciro</th><th className="px-4 py-3 text-right">Maliyet</th><th className="px-4 py-3 text-right">Brüt Kâr</th><th className="px-5 py-3 text-right">Marj</th></tr></thead><tbody>{rows.map((r,i)=><tr key={`${r.name}-${i}`} className="border-t border-slate-100"><td className="px-5 py-3 font-semibold text-slate-700">{r.name}{r.estimated&&<span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">tahmini</span>}</td><td className="px-4 py-3 text-right">{r.qty}</td><td className="px-4 py-3 text-right">{formatCurrency(r.revenue)}</td><td className="px-4 py-3 text-right">{formatCurrency(r.cost)}</td><td className="px-4 py-3 text-right font-bold text-emerald-700">{formatCurrency(r.grossProfit)}</td><td className="px-5 py-3 text-right font-bold text-teal-700">{r.margin.toFixed(1)}%</td></tr>)}{rows.length===0&&<tr><td colSpan={6} className="px-5 py-10 text-center text-slate-400">Bu dönemde satış bulunmuyor.</td></tr>}</tbody></table></div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3"><div className="card p-5"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Satış Sayısı</p><p className="mt-1 text-2xl font-bold text-slate-800">{stats.salesCount}</p></div><div className="card p-5"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Toplam Faaliyet Maliyeti</p><p className="mt-1 text-2xl font-bold text-rose-600">{formatCurrency(stats.operatingCosts)}</p></div><div className="card p-5"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Dönem</p><p className="mt-1 text-2xl font-bold text-slate-800">{range.preset === 'custom' ? `${range.startDate || '…'} → ${range.endDate || '…'}` : range.preset === 'today' ? 'Bugün' : range.preset === 'yesterday' ? 'Dün' : range.preset === 'week' ? 'Son 7 Gün' : range.preset === 'month' ? 'Son 30 Gün' : 'Tümü'}</p></div></div>
      </>}
    </div></div>
  </div>;
}

function Metric({icon,label,value,sub}:{icon:ReactNode;label:string;value:string;sub?:string}){
 return <div className="card p-5"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">{icon}</div><p className="text-sm text-slate-500">{label}</p><p className="text-2xl font-bold text-slate-800">{value}</p>{sub&&<p className="mt-1 text-xs text-emerald-600">{sub}</p>}</div>;
}
