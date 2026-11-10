import { useEffect, useMemo, useState } from 'react';
import { BarChart3, TrendingUp, ShoppingBag, Wallet, Package, AlertTriangle, CreditCard, Banknote, BookOpen, Trophy, Landmark, Clock3 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getShopExpenses, useCashSessions, useProducts, useSales } from '@/lib/hooks';
import { formatCurrency } from '@/lib/utils';
import type { SaleItem, SalePayment } from '@/lib/supabase';

export default function DashboardPage() {
  const { sales, loading: salesLoading } = useSales(50000);
  const { products, loading: productsLoading } = useProducts();
  const { sessions: cashSessions } = useCashSessions(500);
  const [saleItems, setSaleItems] = useState<SaleItem[]>([]);
  const [salePayments, setSalePayments] = useState<SalePayment[]>([]);
  const [returnRows, setReturnRows] = useState<{ sale_item_id: string; quantity: number; amount: number }[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [range, setRange] = useState<'today' | 'yesterday' | 'week' | 'month' | 'all'>('today');

  const activeSales = useMemo(() => sales.filter((s) => {
    if (s.refunded_at || String(s.deleted_reason || '').startsWith('İADE|')) return false;
    const now = new Date();
    const created = new Date(s.created_at);
    const start = new Date(now);
    if (range === 'today') start.setHours(0, 0, 0, 0);
    else if (range === 'yesterday') {
      start.setDate(now.getDate() - 1); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(0, 0, 0, 0);
      return created >= start && created < end;
    } else if (range === 'week') { start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0); }
    else if (range === 'month') { start.setDate(now.getDate() - 29); start.setHours(0, 0, 0, 0); }
    return range === 'all' || created >= start;
  }), [sales, range]);

  useEffect(() => {
    let cancelled = false;
    async function loadItems() {
      setItemsLoading(true);
      const ids = activeSales.map((s) => s.id);
      if (ids.length === 0) {
        if (!cancelled) { setSaleItems([]); setSalePayments([]); setReturnRows([]); setItemsLoading(false); }
        return;
      }
      const [{ data, error }, paymentResult] = await Promise.all([
        supabase.from('sale_items').select('*').in('sale_id', ids),
        supabase.from('sale_payments').select('*').in('sale_id', ids),
      ]);
      const itemIds = (data || []).map((item: any) => item.id).filter(Boolean);
      let fetchedReturns: { sale_item_id: string; quantity: number; amount: number }[] = [];
      if (itemIds.length) {
        const { data: returnData, error: returnError } = await supabase.from('sale_returns').select('sale_item_id,quantity,amount').in('sale_item_id', itemIds);
        if (returnError) console.warn('Dashboard iadeleri yüklenemedi:', returnError.message);
        fetchedReturns = (returnData || []) as typeof fetchedReturns;
      }
      if (error) console.error('Dashboard satış kalemleri yüklenemedi:', error);
      if (paymentResult.error) console.warn('Dashboard ödeme dağılımları yüklenemedi:', paymentResult.error.message);
      if (!cancelled) {
        setSaleItems((data || []) as SaleItem[]);
        setSalePayments((paymentResult.data || []) as SalePayment[]);
        setReturnRows(fetchedReturns);
        setItemsLoading(false);
      }
    }
    loadItems();
    return () => { cancelled = true; };
  }, [activeSales]);

  const shopExpenses = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    let end: Date | null = null;
    if (range === 'today') start.setHours(0, 0, 0, 0);
    else if (range === 'yesterday') { start.setDate(now.getDate() - 1); start.setHours(0, 0, 0, 0); end = new Date(now); end.setHours(0, 0, 0, 0); }
    else if (range === 'week') start.setDate(now.getDate() - 7);
    else if (range === 'month') start.setMonth(now.getMonth() - 1);
    return cashSessions.flatMap((session) => getShopExpenses(session.note)).filter((expense) => {
      if (range === 'all') return true;
      const date = new Date(expense.created_at);
      return end ? date >= start && date < end : date >= start;
    });
  }, [cashSessions, range]);

  const stats = useMemo(() => {
    const revenue = activeSales.reduce((sum, s) => sum + Math.max(0, Number(s.total || 0) - Number(s.refund_amount || 0)), 0);
    const activeIds = new Set(activeSales.map(s => s.id));
    const paymentRows = salePayments.filter(p => activeIds.has(p.sale_id));
    const paymentSum = (method: SalePayment['method']) => paymentRows.filter(p => p.method === method).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const hasPaymentRows = paymentRows.length > 0;
    const cash = hasPaymentRows ? paymentSum('cash') : activeSales.filter((s) => s.payment_method === 'cash').reduce((sum, s) => sum + Number(s.total || 0), 0);
    const card = hasPaymentRows ? paymentSum('card') : activeSales.filter((s) => s.payment_method === 'card').reduce((sum, s) => sum + Number(s.total || 0), 0);
    const iban = hasPaymentRows ? paymentSum('iban') : activeSales.filter((s) => s.payment_method === 'iban').reduce((sum, s) => sum + Number(s.total || 0), 0);
    const credit = hasPaymentRows ? paymentSum('credit') : activeSales.filter((s) => s.payment_method === 'credit').reduce((sum, s) => sum + Number(s.total || 0), 0);
    const returnedQty = new Map<string, number>();
    for (const row of returnRows) returnedQty.set(row.sale_item_id, (returnedQty.get(row.sale_item_id)||0)+Number(row.quantity||0));
    const costByProduct = new Map(products.map((p) => [p.id, Number(p.cost || 0)]));
    const cost = saleItems.reduce((sum, item) => sum + Math.max(0,Number(item.quantity||0)-(returnedQty.get(item.id)||0)) * Number(item.cost_at_sale ?? costByProduct.get(item.product_id || '') ?? 0), 0);
    const shopExpense = shopExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
    const profit = revenue - cost - shopExpense;
    const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
    return { revenue, cash, card, iban, credit, cost, shopExpense, profit, margin, count: activeSales.length };
  }, [activeSales, saleItems, salePayments, returnRows, products, shopExpenses]);

  const topProducts = useMemo(() => {
    const map = new Map<string, { name: string; quantity: number; revenue: number; profit: number }>();
    const returnedQty = new Map<string, number>(); const returnedAmount = new Map<string, number>();
    for (const row of returnRows) { returnedQty.set(row.sale_item_id,(returnedQty.get(row.sale_item_id)||0)+Number(row.quantity||0)); returnedAmount.set(row.sale_item_id,(returnedAmount.get(row.sale_item_id)||0)+Number(row.amount||0)); }
    const costByProduct = new Map(products.map((p) => [p.id, Number(p.cost || 0)]));
    for (const item of saleItems) {
      const key = item.product_id || `${item.barcode || ''}:${item.product_name}`;
      const current = map.get(key) || { name: item.product_name, quantity: 0, revenue: 0, profit: 0 };
      const qty = Math.max(0, Number(item.quantity || 0)-(returnedQty.get(item.id)||0));
      const revenue = Math.max(0, Number(item.subtotal || 0)-(returnedAmount.get(item.id)||0));
      const cost = qty * Number(item.cost_at_sale ?? costByProduct.get(item.product_id || '') ?? 0);
      current.quantity += qty;
      current.revenue += revenue;
      current.profit += revenue - cost;
      map.set(key, current);
    }
    return Array.from(map.values()).sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  }, [saleItems, products, returnRows]);

  const salesTrend = useMemo(() => {
    const days: { key: string; label: string; revenue: number; count: number }[] = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const day = new Date(today); day.setDate(today.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
      const daySales = sales.filter(s => {
        if (s.refunded_at || String(s.deleted_reason || '').startsWith('İADE|')) return false;
        const d = new Date(s.created_at);
        return d.getFullYear()===day.getFullYear() && d.getMonth()===day.getMonth() && d.getDate()===day.getDate();
      });
      days.push({ key, label: day.toLocaleDateString('tr-TR',{day:'2-digit',month:'2-digit'}), revenue: daySales.reduce((sum,s)=>sum+Number(s.total||0)-Number(s.refund_amount||0),0), count: daySales.length });
    }
    return days;
  }, [sales]);
  const trendMax = Math.max(1, ...salesTrend.map(day => day.revenue));

  const lowStock = useMemo(() => products.filter((p) => !p.unlimited_stock && p.stock <= p.min_stock).sort((a, b) => a.stock - b.stock).slice(0, 6), [products]);
  const loading = salesLoading || productsLoading || itemsLoading;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><BarChart3 className="text-teal-600" size={22} /><h1 className="text-xl font-bold text-slate-800">Büfe Dashboard</h1></div>
            <p className="text-sm text-slate-500">Satış, net kâr, en çok satan ürünler ve kasa özeti</p>
          </div>
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
            {[['today', 'Bugün'], ['yesterday', 'Dün'], ['week', 'Son 7 Gün'], ['month', 'Son 30 Gün'], ['all', 'Tümü']].map(([key, label]) => (
              <button key={key} onClick={() => setRange(key as typeof range)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${range === key ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-7xl space-y-6">
          {loading ? <div className="card p-12 text-center text-slate-400">Dashboard verileri yükleniyor...</div> : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Metric icon={<TrendingUp className="text-teal-600" />} label="Toplam Ciro" value={formatCurrency(stats.revenue)} />
                <Metric icon={<Wallet className="text-emerald-600" />} label="Brüt Kâr" value={formatCurrency(stats.profit)} sub={`${stats.margin.toFixed(1)}% brüt marj`} />
                <Metric icon={<ShoppingBag className="text-blue-600" />} label="Satış Adedi" value={String(stats.count)} />
                <Metric icon={<Package className="text-purple-600" />} label="Ürün Çeşidi" value={String(products.length)} />
                <Metric icon={<Wallet className="text-rose-600" />} label="Dükkan Gideri" value={formatCurrency(stats.shopExpense)} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <PaymentCard icon={<Banknote className="text-emerald-600" />} label="Nakit" value={stats.cash} />
                <PaymentCard icon={<CreditCard className="text-blue-600" />} label="Kart" value={stats.card} />
                <PaymentCard icon={<Landmark className="text-cyan-600" />} label="IBAN" value={stats.iban} />
                <PaymentCard icon={<BookOpen className="text-amber-600" />} label="Veresiye" value={stats.credit} />
              </div>

              <section className="card overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2"><TrendingUp className="text-teal-600" size={20}/><div><h2 className="font-bold text-slate-800">Son 7 Günlük Satış Grafiği</h2><p className="text-xs text-slate-500">Dashboard hızlı görünümüdür; ayrıntılı kırılımlar Raporlar bölümündedir.</p></div></div><div className="flex items-center gap-2 text-xs text-slate-500"><Clock3 size={14}/> Gün bazında</div></div>
                <div className="grid grid-cols-7 gap-2 px-4 py-5 sm:gap-4 sm:px-6">
                  {salesTrend.map(day => <div key={day.key} className="flex min-w-0 flex-col items-center gap-2"><div className="flex h-36 w-full items-end justify-center rounded-lg bg-slate-50 px-1"><div title={`${formatCurrency(day.revenue)} · ${day.count} satış`} className="w-full max-w-12 rounded-t-md bg-teal-500 transition-all" style={{height:`${day.revenue>0?Math.max(5,day.revenue/trendMax*100):2}%`}}/></div><span className="text-[10px] font-semibold text-slate-500 sm:text-xs">{day.label}</span><span className="text-[10px] text-slate-400">{day.count} satış</span><span className="hidden text-[10px] font-bold text-slate-600 sm:block">{formatCurrency(day.revenue)}</span></div>)}
                </div>
              </section>

              <div className="grid gap-6 lg:grid-cols-3">
                <section className="card lg:col-span-2 overflow-hidden">
                  <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2"><Trophy className="text-amber-500" size={20} /><h2 className="font-bold text-slate-800">En Çok Satılan Ürünler</h2></div><span className="text-xs text-slate-400">Adede göre</span></div>
                  {topProducts.length === 0 ? <div className="p-8 text-center text-slate-400">Bu dönemde ürün satışı yok.</div> : <div className="divide-y divide-slate-100">{topProducts.map((p, i) => <div key={`${p.name}-${i}`} className="flex items-center gap-4 px-5 py-4"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 font-bold text-slate-600">{i + 1}</div><div className="min-w-0 flex-1"><p className="truncate font-semibold text-slate-800">{p.name}</p><p className="text-xs text-slate-400">{p.quantity} adet</p></div><div className="text-right"><p className="font-semibold text-teal-700">{formatCurrency(p.revenue)}</p><p className="text-xs text-emerald-600">Kâr {formatCurrency(p.profit)}</p></div></div>)}</div>}
                </section>

                <section className="card overflow-hidden">
                  <div className="border-b border-slate-200 px-5 py-4"><div className="flex items-center gap-2"><AlertTriangle className="text-amber-600" size={20} /><h2 className="font-bold text-slate-800">Kritik Stok</h2></div></div>
                  {lowStock.length === 0 ? <div className="p-8 text-center text-emerald-600">Kritik stok yok 🎉</div> : <div className="divide-y divide-slate-100">{lowStock.map((p) => <div key={p.id} className="flex items-center justify-between px-5 py-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-700">{p.name}</p><p className="text-xs text-slate-400">Minimum: {p.min_stock} {p.unit}</p></div><span className="rounded-full bg-red-100 px-2.5 py-1 text-xs font-bold text-red-700">{p.stock} {p.unit}</span></div>)}</div>}
                </section>
              </div>

              <div className="card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-bold text-slate-800">Kârlılık Özeti</h2><p className="text-sm text-slate-500">Satış anındaki kayıtlı maliyetlere göre hesaplanır.</p></div><div className="grid grid-cols-4 gap-6 text-right"><div><p className="text-xs text-slate-400">Maliyet</p><p className="font-bold text-slate-700">{formatCurrency(stats.cost)}</p></div><div><p className="text-xs text-slate-400">Dükkan Gideri</p><p className="font-bold text-rose-600">{formatCurrency(stats.shopExpense)}</p></div><div><p className="text-xs text-slate-400">Brüt Kâr</p><p className="font-bold text-emerald-600">{formatCurrency(stats.profit)}</p></div><div><p className="text-xs text-slate-400">Brüt Marj</p><p className="font-bold text-teal-700">{stats.margin.toFixed(1)}%</p></div></div></div></div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return <div className="card p-5"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">{icon}</div><p className="text-sm text-slate-500">{label}</p><p className="text-2xl font-bold text-slate-800">{value}</p>{sub && <p className="mt-1 text-xs text-teal-600">{sub}</p>}</div>;
}
function PaymentCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="card flex items-center justify-between p-5"><div className="flex items-center gap-3"><div className="rounded-lg bg-slate-100 p-2">{icon}</div><span className="font-medium text-slate-600">{label}</span></div><span className="font-bold text-slate-800">{formatCurrency(value)}</span></div>;
}
