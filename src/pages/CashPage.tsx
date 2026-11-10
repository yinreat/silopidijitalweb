import { useState, useMemo, type KeyboardEvent } from 'react';
import { Calculator, Lock, Unlock, Banknote, CreditCard, BookOpen, TrendingUp, Receipt, Calendar, X, Printer, WalletCards, Plus, MinusCircle, Store, Package, Landmark, RotateCcw, CheckCircle2, Ban, Search, Trash2 } from 'lucide-react';
import {
  useActiveCashSession,
  useCashSessions,
  openCashSession,
  closeCashSessionReconciled,
  addCashWithdrawal,
  getCashWithdrawals,
  addCashDeposit,
  getCashDeposits,
  cancelCashManualEntry,
  createCashIbanExchange,
  markCashIbanReceived,
  useCashIbanExchanges,
  addShopCashExpense,
  addShopProductExpenseBatch,
  recordCashCount,
  useLatestCashCount,
  getShopExpenses,
  getCashRefunds,
  useProducts,
  useSales,
  useSalePayments,
  useSupplierPayments,
  useSuppliers,
} from '@/lib/hooks';
import { formatCurrency, formatDateTime, PAYMENT_METHODS } from '@/lib/utils';
import type { CashSession } from '@/lib/supabase';
import { usePromptDialog } from '@/components/PromptDialog';

export default function CashPage({ currentStaffId }: { currentStaffId?: string | null }) {
  const { prompt: askPrompt, dialog: promptDialog } = usePromptDialog();
  const { session, loading, reload } = useActiveCashSession();
  const { cashCount: latestCashCount, reload: reloadCashCount } = useLatestCashCount(session?.id);
  const { sessions, reload: reloadSessions } = useCashSessions(30);
  const { sales } = useSales(500);
  const { products } = useProducts();
  const { suppliers } = useSuppliers();
  const { payments: supplierPayments } = useSupplierPayments(session?.id);
  const { rows: ibanExchanges, reload: reloadIbanExchanges } = useCashIbanExchanges(session?.id);


  const [showOpenForm, setShowOpenForm] = useState(false);
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [selectedSession, setSelectedSession] = useState<CashSession | null>(null);
  const [showWithdrawalForm, setShowWithdrawalForm] = useState(false);
  const [showDepositForm, setShowDepositForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showIbanForm, setShowIbanForm] = useState(false);
  const [showCashCountForm, setShowCashCountForm] = useState(false);
  const [cashSummaryType, setCashSummaryType] = useState<'x' | 'y' | null>(null);

  // Bugünkü satışlar (eğer kasa açıksa, kasa açılış saatinden itibaren)
  const sessionSales = useMemo(() => {
    if (!session) return [];
    const openedAt = new Date(session.opened_at).getTime();
    return sales.filter((s) => new Date(s.created_at).getTime() >= openedAt);
  }, [sales, session]);

  const splitSaleIds = useMemo(() => sessionSales.filter((s) => s.payment_method === 'split').map((s) => s.id), [sessionSales]);
  const { payments: splitSalePayments } = useSalePayments(splitSaleIds);
  const cashTotal = sessionSales.filter((s) => s.payment_method === 'cash').reduce((sum, s) => sum + parseFloat(s.total.toString()), 0)
    + splitSalePayments.filter((p) => p.method === 'cash').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const cardTotal = sessionSales.filter((s) => s.payment_method === 'card').reduce((sum, s) => sum + parseFloat(s.total.toString()), 0)
    + splitSalePayments.filter((p) => p.method === 'card').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const creditTotal = sessionSales.filter((s) => s.payment_method === 'credit').reduce((sum, s) => sum + parseFloat(s.total.toString()), 0)
    + splitSalePayments.filter((p) => p.method === 'credit').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const ibanTotal = sessionSales.filter((s) => s.payment_method === 'iban').reduce((sum, s) => sum + Number(s.total || 0), 0)
    + splitSalePayments.filter((p) => p.method === 'iban').reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const grandTotal = cashTotal + cardTotal + creditTotal + ibanTotal;
  const allWithdrawals = session ? getCashWithdrawals(session.note) : [];
  const withdrawals = allWithdrawals.filter((item) => item.category !== 'customer_iban');
  const deposits = session ? getCashDeposits(session.note) : [];
  const shopExpenses = session ? getShopExpenses(session.note) : [];
  const ibanCashOutTotal = ibanExchanges.filter((item) => item.status !== 'cancelled').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const withdrawalTotal = withdrawals.reduce((sum, item) => sum + item.amount, 0) + ibanCashOutTotal;
  const depositTotal = deposits.reduce((sum, item) => sum + item.amount, 0);
  const shopCashExpenseTotal = shopExpenses.filter((item) => item.type === 'cash').reduce((sum, item) => sum + item.amount, 0);
  const shopExpenseTotal = shopExpenses.reduce((sum, item) => sum + item.amount, 0);
  const cashRefunds = session ? getCashRefunds(session.note) : [];
  const cashRefundTotal = cashRefunds.reduce((sum, item) => sum + item.amount, 0);
  const supplierCashPaymentTotal = supplierPayments.filter((item) => item.payment_method === 'cash').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const expectedCash = session ? session.opening_amount + cashTotal + depositTotal - withdrawalTotal - shopCashExpenseTotal - supplierCashPaymentTotal - cashRefundTotal : 0;
  const saleCount = sessionSales.length;

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-400">Yükleniyor...</div>;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white px-4 py-4 xl:px-6">
        <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-start 2xl:justify-between">
          <div className="shrink-0">
            <h1 className="text-xl font-bold text-slate-800">Kasa ve Gün Sonu</h1>
            <p className="mt-1 text-sm text-slate-500">Kasa hareketleri, ara sayım ve günlük raporlar</p>
          </div>
          {session ? (
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:max-w-[900px]">
              <button onClick={() => setShowDepositForm(true)} className="btn-success flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm">
                <Plus size={17} className="shrink-0" /><span>Kasaya Para Ekle</span>
              </button>
              <button onClick={() => setShowExpenseForm(true)} className="btn-primary flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm">
                <Store size={17} className="shrink-0" /><span>Dükkân Gideri</span>
              </button>
              <button onClick={() => setShowWithdrawalForm(true)} className="btn-secondary flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm">
                <MinusCircle size={17} className="shrink-0" /><span>Kasadan Para Al</span>
              </button>
              <button onClick={() => setShowIbanForm(true)} className="flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-bold text-white hover:bg-violet-700 sm:text-sm">
                <Landmark size={17} className="shrink-0" /><span>Nakit → IBAN</span>
              </button>
              <button onClick={() => setShowCashCountForm(true)} className="btn-secondary flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm"><Calculator size={17} className="shrink-0"/><span>Kasa Sayımı</span></button>
              <button onClick={() => setCashSummaryType('x')} className="btn-secondary min-h-10 min-w-0 px-3 py-2 text-xs sm:text-sm">X Ara Raporu</button>
              <button onClick={() => setCashSummaryType('y')} className="btn-secondary min-h-10 min-w-0 px-3 py-2 text-xs sm:text-sm">Y Ayrıntılı Rapor</button>
              <button onClick={() => setShowCloseForm(true)} className="btn-primary flex min-h-10 min-w-0 items-center justify-center gap-2 px-3 py-2 text-xs sm:text-sm"><Lock size={17} className="shrink-0"/><span>Z Gün Sonu Raporu</span></button>
            </div>
          ) : (
            <button onClick={() => setShowOpenForm(true)} className="btn-success min-w-0 px-4 py-2 text-sm">
              <Unlock size={18} />
              Kasayı Aç
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          {/* Current Session Status */}
          {session ? (
            <div className="card border-teal-200 bg-teal-50 p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-600">
                  <Calculator className="text-white" size={22} />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-teal-800">Kasa Açık</h2>
                  <p className="text-sm text-teal-600">{formatDateTime(session.opened_at)} tarihinde açıldı</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg bg-white p-4 border border-teal-100">
                  <p className="text-sm text-slate-500">Açılış Nakit</p>
                  <p className="text-xl font-bold text-slate-800">{formatCurrency(session.opening_amount)}</p>
                </div>
                <div className="rounded-lg bg-white p-4 border border-teal-100">
                  <p className="text-sm text-slate-500">Satış Adedi</p>
                  <p className="text-xl font-bold text-slate-800">{saleCount}</p>
                </div>
                <div className="rounded-lg bg-white p-4 border border-teal-100">
                  <p className="text-sm text-slate-500">Toplam Ciro</p>
                  <p className="text-xl font-bold text-teal-700">{formatCurrency(grandTotal)}</p>
                </div>
                <div className="rounded-lg bg-white p-4 border border-teal-100">
                  <p className="text-sm text-slate-500">Sisteme Göre Olması Gereken</p>
                  <p className="text-xl font-bold text-emerald-700">{formatCurrency(expectedCash)}</p>
                </div>
              </div>
              {latestCashCount && (
                <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-bold text-blue-900">Son Ara Kasa Sayımı</p>
                      <p className="mt-1 text-xs text-blue-700">Fiziksel olarak sayıp kaydettiğin son nakit tutarı</p>
                    </div>
                    <p className="text-2xl font-black text-blue-900">{formatCurrency(Number(latestCashCount.counted_cash || 0))}</p>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-blue-200 pt-3 text-sm">
                    <span className="text-blue-800">Sistem farkı</span>
                    <span className={`font-extrabold ${Number(latestCashCount.difference) > 0 ? 'text-emerald-700' : Number(latestCashCount.difference) < 0 ? 'text-rose-700' : 'text-blue-900'}`}>
                      {Number(latestCashCount.difference) > 0 ? '+' : ''}{formatCurrency(Number(latestCashCount.difference || 0))}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] text-blue-700">Sistem bakiyesi ile fiziksel sayım ayrı gösterilir; sayım farkı otomatik olarak kasaya para girişi/çıkışı yazılmaz.</p>
                  <p className="mt-1 text-[11px] text-blue-600">{formatDateTime(latestCashCount.created_at)}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="card p-8 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
                <Lock className="text-slate-400" size={24} />
              </div>
              <h2 className="text-lg font-bold text-slate-700">Kasa Kapalı</h2>
              <p className="mb-4 text-sm text-slate-500">Satış yapmaya başlamak için kasayı açın</p>
              <button onClick={() => setShowOpenForm(true)} className="btn-success px-6 py-2.5">
                <Unlock size={18} />
                Kasa Aç
              </button>
            </div>
          )}

          {session && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="card border-emerald-200 bg-emerald-50 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-emerald-800">Kasaya Eklenen Para</h3>
                    <p className="text-sm text-emerald-700">Bu oturumda kasaya eklenen toplam nakit</p>
                  </div>
                  <p className="text-xl font-bold text-emerald-700">+{formatCurrency(depositTotal)}</p>
                </div>
                {deposits.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {deposits.map((item, index) => (
                      <div key={`${item.id || item.created_at}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                        <div className="min-w-0"><p className="truncate text-slate-600">{item.note || 'Not belirtilmedi'}</p><p className="text-[11px] text-slate-400">{formatDateTime(item.created_at)}</p></div>
                        <div className="flex items-center gap-2"><span className="font-semibold text-emerald-600">+{formatCurrency(item.amount)}</span>{item.id && item.category !== 'customer_debt_collection' && <button title="Hatalı girişi iptal et" onClick={async()=>{if (!item.id) return; const itemId = item.id; if(!confirm(`${formatCurrency(item.amount)} tutarlı kasa ekleme işlemi iptal edilsin mi?`)) return; const reason=(await askPrompt('İptal nedeni (opsiyonel):', { title: 'İptal Nedeni', placeholder: 'İsteğe bağlı açıklama', confirmLabel: 'İptal Et' }))?.trim() || undefined; const ok=await cancelCashManualEntry(session.id,itemId,'deposit',currentStaffId || null,reason); if(!ok) alert('İşlem iptal edilemedi. Admin/Müdür yetkisi gerekebilir.'); else { reload(); reloadSessions(); }}} className="rounded-md p-1.5 text-red-500 hover:bg-red-50"><Ban size={15}/></button>}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="card border-amber-200 bg-amber-50 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-amber-800">Kasadan Alınan Para</h3>
                    <p className="text-sm text-amber-700">Bu oturumda kasadan çıkan toplam nakit (IBAN dahil)</p>
                  </div>
                  <p className="text-xl font-bold text-amber-700">-{formatCurrency(withdrawalTotal)}</p>
                </div>
                {withdrawals.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {withdrawals.map((item, index) => (
                      <div key={`${item.id || item.created_at}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                        <div className="min-w-0"><p className="truncate text-slate-600">{item.note || 'Not belirtilmedi'}</p><p className="text-[11px] text-slate-400">{formatDateTime(item.created_at)}{item.category==='customer_iban' ? ' · IBAN bekleniyor' : ''}</p></div>
                        <div className="flex items-center gap-2"><span className="font-semibold text-red-600">-{formatCurrency(item.amount)}</span>{item.id && <button title="Hatalı çıkışı iptal et" onClick={async()=>{if (!item.id) return; const itemId = item.id; if(!confirm(`${formatCurrency(item.amount)} tutarlı kasa çıkışı iptal edilsin mi?`)) return; const reason=(await askPrompt('İptal nedeni (opsiyonel):', { title: 'İptal Nedeni', placeholder: 'İsteğe bağlı açıklama', confirmLabel: 'İptal Et' }))?.trim() || undefined; const ok=await cancelCashManualEntry(session.id,itemId,item.category==='customer_iban'?'customer_iban':'withdrawal',currentStaffId || null,reason); if(!ok) alert('İşlem iptal edilemedi. Admin/Müdür yetkisi gerekebilir.'); else { reload(); reloadSessions(); reloadIbanExchanges(); }}} className="rounded-md p-1.5 text-red-500 hover:bg-red-50"><Ban size={15}/></button>}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {session && ibanExchanges.length > 0 && (
            <div className="card border-violet-200 bg-violet-50 p-5">
              <div className="flex items-center justify-between gap-3">
                <div><h3 className="font-bold text-violet-800">Müşteriye Nakit → IBAN</h3><p className="text-sm text-violet-700">Müşteriye nakit verildi; banka transferi bu ekrandan takip edilir.</p></div>
                <p className="text-xl font-bold text-violet-700">{formatCurrency(ibanExchanges.filter(x=>x.status==='pending').reduce((s,x)=>s+Number(x.amount||0),0))}</p>
              </div>
              <div className="mt-3 space-y-2">
                {ibanExchanges.map((item)=>(
                  <div key={item.id} className="rounded-lg bg-white px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div><p className="font-semibold text-slate-700">{item.customer_name || 'İsimsiz müşteri'}{item.customer_phone ? ` · ${item.customer_phone}` : ''}</p><p className="text-xs text-slate-400">{formatDateTime(item.created_at)}{item.note ? ` · ${item.note}` : ''}</p></div>
                      <div className="text-right"><p className="font-black text-violet-700">{formatCurrency(item.amount)}</p><span className={`text-xs font-bold ${item.status==='pending' ? 'text-amber-600' : item.status==='received' ? 'text-emerald-600' : 'text-slate-400'}`}>{item.status==='pending' ? 'Transfer bekleniyor' : item.status==='received' ? 'IBAN transferi alındı' : 'İptal edildi'}</span></div>
                    </div>
                    {item.status==='pending' && <div className="mt-2 flex gap-2"><button onClick={async()=>{if(!confirm('Müşterinin IBAN transferi geldi olarak işaretlensin mi?')) return; const ok=await markCashIbanReceived(item.id,currentStaffId); if(!ok) alert('İşlem tamamlanamadı. Admin/Müdür yetkisi gerekebilir.'); else reloadIbanExchanges();}} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-bold text-white"><CheckCircle2 size={14}/> Transfer Geldi</button><button onClick={async()=>{if(!confirm('Bu işlem iptal edilsin ve para kasaya geri dönsün mü?')) return; const reason=(await askPrompt('İptal nedeni (opsiyonel):', { title: 'İptal Nedeni', placeholder: 'İsteğe bağlı açıklama', confirmLabel: 'İptal Et' }))?.trim() || undefined; const ok=await cancelCashManualEntry(session.id,item.id,'customer_iban',currentStaffId || null,reason); if(!ok) alert('İşlem iptal edilemedi.'); else { reload(); reloadSessions(); reloadIbanExchanges(); }}} className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-2 text-xs font-bold text-red-600"><RotateCcw size={14}/> İptal</button></div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {session && supplierPayments.length > 0 && (
            <div className="card border-violet-200 bg-violet-50 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-violet-800">Tedarikçi Ödemeleri</h3>
                  <p className="text-sm text-violet-700">Bu kasa oturumunda tedarikçilere yapılan ödemeler</p>
                </div>
                <p className="text-xl font-bold text-violet-700">-{formatCurrency(supplierPayments.reduce((sum, item) => sum + Number(item.amount || 0), 0))}</p>
              </div>
              <div className="mt-3 space-y-2">
                {supplierPayments.map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                    <span className="text-slate-600">{suppliers.find((supplier) => supplier.id === item.supplier_id)?.name || 'Tedarikçi'} · {item.payment_method === 'cash' ? 'Nakit' : item.payment_method === 'card' ? 'Kart' : 'Banka'}{item.note ? ` — ${item.note}` : ''}</span>
                    <span className="font-semibold text-violet-600">-{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {session && shopExpenses.length > 0 && (
            <div className="card border-rose-200 bg-rose-50 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-rose-800">Dükkân Giderleri</h3>
                  <p className="text-sm text-rose-700">Bu oturumda işletme için yapılan giderler</p>
                </div>
                <p className="text-xl font-bold text-rose-700">-{formatCurrency(shopExpenseTotal)}</p>
              </div>
              <div className="mt-3 space-y-2">
                {shopExpenses.map((item, index) => (
                  <div key={`${item.created_at}-${index}`} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                    <span className="text-slate-600">{item.type === 'product' ? `${item.product_name || 'Ürün'} · ${item.quantity || 0} adet` : 'Nakit gider'}{item.note ? ` — ${item.note}` : ''}</span>
                    <span className="font-semibold text-rose-600">-{formatCurrency(item.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {session && (
            <div className="card border-slate-200 bg-white p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-slate-800">Kasa Mutabakatı</h3>
                  <p className="text-sm text-slate-500">Beklenen kasa ile gerçek sayım arasındaki farkı gün sonunda kontrol edin.</p>
                </div>
                <div className={`rounded-full px-3 py-1 text-xs font-bold ${expectedCash >= 0 ? 'bg-teal-50 text-teal-700' : 'bg-rose-50 text-rose-700'}`}>Açık Kasa</div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Nakit Satış</p><p className="mt-1 text-lg font-black text-slate-800">{formatCurrency(cashTotal)}</p></div>
                <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Nakit Çıkışı</p><p className="mt-1 text-lg font-black text-rose-700">-{formatCurrency(withdrawalTotal + supplierCashPaymentTotal + shopCashExpenseTotal + cashRefundTotal)}</p></div>
                <div className="rounded-xl bg-teal-50 p-4"><p className="text-xs text-teal-700">Beklenen Kasa</p><p className="mt-1 text-lg font-black text-teal-800">{formatCurrency(expectedCash)}</p></div>
                <div className="rounded-xl bg-blue-50 p-4"><p className="text-xs text-blue-700">Sayım</p><p className="mt-1 text-lg font-black text-blue-800">Kapanışta girilecek</p></div>
              </div>
            </div>
          )}

          {/* Sales Breakdown */}
          {session && sessionSales.length > 0 && (
            <div className="card p-6">
              <h3 className="mb-4 font-bold text-slate-800">Bu Oturumdaki Satışlar</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-lg bg-emerald-50 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <Banknote className="text-emerald-600" size={20} />
                    <span className="text-sm text-slate-600">Nakit</span>
                  </div>
                  <p className="text-xl font-bold text-emerald-700">{formatCurrency(cashTotal)}</p>
                  <p className="text-xs text-slate-400 mt-1">{sessionSales.filter((s) => s.payment_method === 'cash').length} satış</p>
                </div>
                <div className="rounded-lg bg-blue-50 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <CreditCard className="text-blue-600" size={20} />
                    <span className="text-sm text-slate-600">Kart</span>
                  </div>
                  <p className="text-xl font-bold text-blue-700">{formatCurrency(cardTotal)}</p>
                  <p className="text-xs text-slate-400 mt-1">{sessionSales.filter((s) => s.payment_method === 'card').length} satış</p>
                </div>
                <div className="rounded-lg bg-amber-50 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <BookOpen className="text-amber-600" size={20} />
                    <span className="text-sm text-slate-600">Veresiye</span>
                  </div>
                  <p className="text-xl font-bold text-amber-700">{formatCurrency(creditTotal)}</p>
                  <p className="text-xs text-slate-400 mt-1">{sessionSales.filter((s) => s.payment_method === 'credit').length} satış</p>
                </div>
              </div>
            </div>
          )}

          {/* Session History */}
          <div className="card overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3">
              <h3 className="font-semibold text-slate-800">Kasa Oturum Geçmişi</h3>
            </div>
            {sessions.length === 0 ? (
              <div className="p-8 text-center text-slate-400">Henüz kasa oturumu yok</div>
            ) : (
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Açılış</th>
                    <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Kapanış</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600">Açılış</th>
                    <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600">Kapanış</th>
                    <th className="px-4 py-2 text-center text-xs font-semibold text-slate-600">Durum</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setSelectedSession(s)}
                    >
                      <td className="px-4 py-3 text-sm text-slate-600">{formatDateTime(s.opened_at)}</td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        {s.closed_at ? formatDateTime(s.closed_at) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-slate-700">
                        {formatCurrency(s.opening_amount)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-medium text-slate-700">
                        {s.closing_amount != null ? formatCurrency(s.closing_amount) : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.status === 'open' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {s.status === 'open' ? 'Açık' : 'Kapalı'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400"><Receipt size={16} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Open Cash Form */}
      {showOpenForm && (
        <OpenCashForm
          onClose={() => setShowOpenForm(false)}
          onOpen={async (amount, note) => {
            await openCashSession(amount, note);
            setShowOpenForm(false);
            reload();
            reloadSessions();
          }}
        />
      )}

      {/* Close Cash Form */}
      {showCloseForm && session && (
        <CloseCashForm
          session={session}
          expectedCash={expectedCash}
          cashSales={cashTotal}
          cashRefunds={cashRefundTotal}
          supplierCashPaymentTotal={supplierCashPaymentTotal}
          shopCashExpenseTotal={shopCashExpenseTotal}
          productExpenseTotal={shopExpenses.filter(item => item.type === 'product').reduce((sum,item)=>sum+item.amount,0)}
          withdrawalTotal={withdrawalTotal}
          depositTotal={depositTotal}
          cardSales={cardTotal}
          ibanSales={ibanTotal}
          creditSales={creditTotal}
          totalSales={grandTotal}
          saleCount={saleCount}
          onClose={() => setShowCloseForm(false)}
          onCloseSession={async (amount, note) => {
            const result = await closeCashSessionReconciled({
              sessionId: session.id,
              countedCash: amount,
              expectedCash,
              cashSales: cashTotal,
              cardSales: cardTotal,
              creditSales: creditTotal,
              deposits: depositTotal,
              withdrawals: withdrawalTotal,
              supplierCashPayments: supplierCashPaymentTotal,
              shopCashExpenses: shopCashExpenseTotal,
              cashRefunds: cashRefundTotal,
              saleCount,
              staffId: currentStaffId || null,
              note,
            });
            if (!result.success) {
              alert(result.error || 'Kasa kapatılamadı.');
              return;
            }
            setShowCloseForm(false);
            reload();
            reloadSessions();
          }}
        />
      )}

      {showCashCountForm && session && (
        <CashCountForm
          expectedCash={expectedCash}
          onClose={() => setShowCashCountForm(false)}
          onSave={async (countedCash, note) => {
            const result = await recordCashCount({
              sessionId: session.id, countedCash, expectedCash,
              cashSales: cashTotal, cardSales: cardTotal, creditSales: creditTotal,
              deposits: depositTotal, withdrawals: withdrawalTotal,
              supplierCashPayments: supplierCashPaymentTotal, shopCashExpenses: shopCashExpenseTotal,
              cashRefunds: cashRefundTotal, saleCount, staffId: currentStaffId || null, note,
            });
            if (!result.success) { alert(result.error || 'Ara kasa sayımı kaydedilemedi.'); return; }
            alert(`Ara kasa sayımı kaydedildi. Fark: ${formatCurrency(Number(result.difference || 0))}`);
            await reloadCashCount();
            setShowCashCountForm(false);
            reload();
            reloadSessions();
          }}
        />
      )}

      {cashSummaryType && session && (
        <CashSummaryModal
          type={cashSummaryType}
          session={session}
          values={{
            expectedCash, cashSales: cashTotal, cardSales: cardTotal, ibanSales: ibanTotal, creditSales: creditTotal, totalSales: grandTotal,
            deposits: depositTotal, withdrawals: withdrawalTotal, supplierCashPayments: supplierCashPaymentTotal,
            cashExpenses: shopCashExpenseTotal, productExpenses: shopExpenses.filter(item => item.type === 'product').reduce((sum,item)=>sum+item.amount,0),
            cashRefunds: cashRefundTotal, saleCount,
          }}
          onClose={() => setCashSummaryType(null)}
        />
      )}

      {showDepositForm && session && (
        <CashDepositForm
          onClose={() => setShowDepositForm(false)}
          onSubmit={async (amount, note) => {
            const ok = await addCashDeposit(session.id, amount, note);
            if (ok) {
              setShowDepositForm(false);
              reload();
              reloadSessions();
            } else {
              alert('Kasaya para ekleme kaydedilemedi.');
            }
          }}
        />
      )}

      {showExpenseForm && session && (
        <ShopExpenseForm
          products={products}
          onClose={() => setShowExpenseForm(false)}
          onSubmit={async (type, amount, productId, quantity, note, expenseItems) => {
            const ok = type === 'cash'
              ? await addShopCashExpense(session.id, amount, note)
              : await addShopProductExpenseBatch(session.id, expenseItems?.length ? expenseItems : (productId ? [{ productId, quantity: quantity ?? 1 }] : []), note, currentStaffId);
            if (ok) {
              setShowExpenseForm(false);
              reload();
              reloadSessions();
            } else {
              alert(type === 'cash' ? 'Dükkan gideri kaydedilemedi.' : 'Ürün gideri kaydedilemedi. Stok miktarlarını kontrol et; hiçbir ürün kaydedilemediyse işlem geri alınmış olur.');
            }
          }}
        />
      )}

      {showIbanForm && session && (
        <CashIbanExchangeForm
          onClose={() => setShowIbanForm(false)}
          onSubmit={async (amount, customerName, customerPhone, note) => {
            const result = await createCashIbanExchange(session.id, amount, customerName, customerPhone, note, currentStaffId);
            if (result.data) { setShowIbanForm(false); reload(); reloadSessions(); reloadIbanExchanges(); }
            else alert(result.error || 'Nakit → IBAN işlemi kaydedilemedi.');
          }}
        />
      )}

      {showWithdrawalForm && session && (
        <CashWithdrawalForm
          onClose={() => setShowWithdrawalForm(false)}
          onSubmit={async (amount, note) => {
            const ok = await addCashWithdrawal(session.id, amount, note);
            if (ok) {
              setShowWithdrawalForm(false);
              reload();
              reloadSessions();
            } else {
              alert('Kasadan para alma kaydedilemedi.');
            }
          }}
        />
      )}

      {/* Session Detail */}
      {selectedSession && (
        <SessionDetailModal session={selectedSession} onClose={() => setSelectedSession(null)} />
      )}
      {promptDialog}
    </div>
  );
}

function CashDepositForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (amount: number, note?: string) => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const value = parseFloat(amount) || 0;

  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="propos-modal-content card w-full max-w-md p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WalletCards className="text-emerald-600" size={22} />
            <h2 className="text-lg font-bold text-slate-800">Kasaya Para Ekle</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label">Eklenecek Tutar (TL)</label>
            <input type="number" min="0.01" step="0.01" className="input text-lg" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Örn: 1000" autoFocus />
          </div>
          <div>
            <label className="label">Not (opsiyonel)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Örn: Kasaya para koydum" />
          </div>
          <button disabled={value <= 0} onClick={() => onSubmit(value, note.trim() || undefined)} className="btn-success w-full py-3 disabled:opacity-50">
            <Plus size={18} />
            Kasaya {formatCurrency(value)} Ekle
          </button>
        </div>
      </div>
    </div>
  );
}

function CashIbanExchangeForm({ onClose, onSubmit }: { onClose:()=>void; onSubmit:(amount:number,customerName?:string,customerPhone?:string,note?:string)=>void }) {
  const [amount,setAmount]=useState(''); const [customerName,setCustomerName]=useState(''); const [customerPhone,setCustomerPhone]=useState(''); const [note,setNote]=useState('');
  const value=parseFloat(amount)||0;
  return <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}><div className="propos-modal-content card w-full max-w-md p-6 animate-slide-up" onClick={(e)=>e.stopPropagation()}>
    <div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2"><Landmark className="text-violet-600" size={22}/><h2 className="text-lg font-bold text-slate-800">Müşteriye Nakit Ver → IBAN</h2></div><button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22}/></button></div>
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-800">Müşteriye nakit verilir, müşteri işletmenin IBAN'ına transfer yapar. Nakit hemen kasadan düşer; transfer gelene kadar işlem bekleyen olarak görünür.</div>
    <div className="mt-4 space-y-4">
      <div><label className="label">Nakit Tutarı (TL)</label><input type="number" min="0.01" step="0.01" className="input text-lg" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Örn: 500" autoFocus/></div>
      <div><label className="label">Müşteri Adı</label><input className="input" value={customerName} onChange={e=>setCustomerName(e.target.value)} placeholder="Örn: Mehmet Yılmaz"/></div>
      <div><label className="label">Telefon (opsiyonel)</label><input className="input" value={customerPhone} onChange={e=>setCustomerPhone(e.target.value)} placeholder="0555..."/></div>
      <div><label className="label">Not</label><input className="input" value={note} onChange={e=>setNote(e.target.value)} placeholder="Örn: IBAN transferi bekleniyor"/></div>
      <button disabled={value<=0} onClick={()=>onSubmit(value,customerName.trim()||undefined,customerPhone.trim()||undefined,note.trim()||undefined)} className="btn-primary w-full py-3 disabled:opacity-50"><Landmark size={18}/> {formatCurrency(value)} Nakit Ver ve IBAN İşlemini Kaydet</button>
    </div></div></div>;
}

function CashWithdrawalForm({ onClose, onSubmit }: { onClose: () => void; onSubmit: (amount: number, note?: string) => void }) {
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const value = parseFloat(amount) || 0;

  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="propos-modal-content card w-full max-w-md p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WalletCards className="text-amber-600" size={22} />
            <h2 className="text-lg font-bold text-slate-800">Kasadan Para Al</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label">Alınacak Tutar (TL)</label>
            <input type="number" min="0.01" step="0.01" className="input text-lg" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Örn: 500" autoFocus />
          </div>
          <div>
            <label className="label">Not (opsiyonel)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Örn: Eve para götürdüm" />
          </div>
          <button disabled={value <= 0} onClick={() => onSubmit(value, note.trim() || undefined)} className="btn-primary w-full py-3 disabled:opacity-50">
            <MinusCircle size={18} />
            Kasadan {formatCurrency(value)} Al
          </button>
        </div>
      </div>
    </div>
  );
}

function ShopExpenseForm({ products, onClose, onSubmit }: { products: any[]; onClose: () => void; onSubmit: (type: 'cash' | 'product', amount: number, productId?: string, quantity?: number, note?: string, items?: Array<{productId:string;quantity:number}>) => void }) {
  const [type, setType] = useState<'cash' | 'product'>('cash');
  const [amount, setAmount] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Array<{productId:string;quantity:number}>>([]);
  const [note, setNote] = useState('');
  const safeProducts = products.filter((product) => !product.deleted_at);
  const normalizedQuery = query.trim().toLocaleLowerCase('tr-TR');
  const filtered = normalizedQuery ? safeProducts.filter((product) => {
    const names = String(product.name || '').toLocaleLowerCase('tr-TR');
    const barcode = String(product.barcode || '').toLocaleLowerCase('tr-TR');
    const extras = Array.isArray(product.additional_barcodes) ? product.additional_barcodes : [];
    return names.includes(normalizedQuery) || barcode.includes(normalizedQuery) || extras.some((code:string) => String(code).toLocaleLowerCase('tr-TR').includes(normalizedQuery));
  }).slice(0, 8) : [];
  const selected = items.map((item) => ({ ...item, product: safeProducts.find((product) => product.id === item.productId) })).filter((item) => !!item.product) as Array<{productId:string;quantity:number;product:any}>;
  const productValue = selected.reduce((sum, item) => sum + Number(item.product.cost || 0) * item.quantity, 0);
  const value = type === 'cash' ? (Number(amount) || 0) : productValue;

  function addProduct(product:any) {
    if (!product || (!product.unlimited_stock && Number(product.stock || 0) <= 0)) { alert('Bu ürünün kullanılabilir stoğu yok.'); return; }
    const current = items.find((item) => item.productId === product.id)?.quantity || 0;
    if (!product.unlimited_stock && current + 1 > Number(product.stock || 0)) { alert(`${product.name} için stok yetersiz. Mevcut stok: ${product.stock}`); return; }
    setItems((previous) => {
      const found = previous.find((item) => item.productId === product.id);
      return found ? previous.map((item) => item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item) : [...previous, { productId: product.id, quantity: 1 }];
    });
    setQuery('');
  }
  function changeQuantity(product:any, delta:number) {
    setItems((previous) => previous.flatMap((item) => {
      if (item.productId !== product.id) return [item];
      const next = item.quantity + delta;
      if (next <= 0) return [];
      if (!product.unlimited_stock && next > Number(product.stock || 0)) { alert(`${product.name} için stok yetersiz.`); return [item]; }
      return [{ ...item, quantity: next }];
    }));
  }
  function handleScanKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const code = query.trim().toLocaleLowerCase('tr-TR');
    if (!code) return;
    const match = safeProducts.find((product) => {
      const extras = Array.isArray(product.additional_barcodes) ? product.additional_barcodes : [];
      return String(product.barcode || '').toLocaleLowerCase('tr-TR') === code || extras.some((value:string) => String(value).toLocaleLowerCase('tr-TR') === code);
    }) || safeProducts.find((product) => String(product.name || '').trim().toLocaleLowerCase('tr-TR') === code);
    if (match) { addProduct(match); return; }
    if (filtered.length === 1) { addProduct(filtered[0]); return; }
    alert('Barkod bulunamadı. Ürün adını yazıp listeden seçebilirsin.');
  }

  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in p-3" onClick={onClose}>
      <div className="propos-modal-content card w-full max-w-2xl p-5 animate-slide-up max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2"><Store className="text-rose-600" size={22} /><div><h2 className="text-lg font-bold text-slate-800">Dükkân Gideri</h2><p className="text-xs text-slate-500">Barkod okutabilir, ürün arayabilir ve birden fazla ürün ekleyebilirsin.</p></div></div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>
        <div className="mb-4 flex rounded-lg bg-slate-100 p-1">
          <button onClick={() => setType('cash')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${type === 'cash' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'}`}>Para Gideri</button>
          <button onClick={() => setType('product')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${type === 'product' ? 'bg-white text-rose-700 shadow-sm' : 'text-slate-500'}`}>Ürün / Barkod Gideri</button>
        </div>
        <div className="space-y-4">
          {type === 'cash' ? (
            <div><label className="label">Gider Tutarı (TL)</label><input type="number" min="0.01" step="0.01" className="input text-lg" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Örn: 250" autoFocus /></div>
          ) : (
            <>
              <div className="relative"><label className="label">Ürün ara veya barkod okut</label><div className="relative"><Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input className="input pl-10 text-lg" value={query} onChange={(e)=>setQuery(e.target.value)} onKeyDown={handleScanKeyDown} placeholder="Barkod okut veya ürün adı yaz..." autoFocus autoComplete="off"/></div>
                {filtered.length > 0 && <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-sm">{filtered.map((product)=><button type="button" key={product.id} onClick={()=>addProduct(product)} className="flex w-full items-center justify-between gap-3 border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-rose-50"><span className="min-w-0"><span className="block truncate text-sm font-semibold text-slate-700">{product.name}</span><span className="block truncate text-xs text-slate-400">{product.barcode || 'Barkod yok'} · Stok {product.unlimited_stock ? 'Sınırsız' : product.stock} {product.unit || 'adet'}</span></span><span className="shrink-0 text-xs font-bold text-rose-600">Ekle</span></button>)}</div>}
              </div>
              <div className="rounded-xl border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2"><h3 className="text-sm font-bold text-slate-700">Gider listesi ({selected.length} ürün)</h3><span className="text-xs text-slate-500">Normal stoklu ürünlerde miktar stoktan düşer</span></div>
                {selected.length === 0 ? <div className="p-6 text-center text-sm text-slate-400">Henüz ürün eklenmedi. Barkod okut veya ara.</div> : <div className="divide-y divide-slate-100">{selected.map(({product,quantity})=><div key={product.id} className="flex items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-700">{product.name}</p><p className="text-xs text-slate-400">Stok: {product.unlimited_stock ? 'Sınırsız' : product.stock} · Birim maliyet: {formatCurrency(Number(product.cost||0))}</p></div><div className="flex items-center gap-1"><button type="button" className="rounded border px-2 py-1" onClick={()=>changeQuantity(product,-1)}><MinusCircle size={15}/></button><span className="min-w-7 text-center text-sm font-bold">{quantity}</span><button type="button" className="rounded border px-2 py-1" onClick={()=>changeQuantity(product,1)}><Plus size={15}/></button></div><span className="w-24 text-right text-sm font-bold">{formatCurrency(Number(product.cost||0)*quantity)}</span><button type="button" className="rounded p-1 text-rose-600 hover:bg-rose-50" onClick={()=>setItems(prev=>prev.filter(item=>item.productId!==product.id))} aria-label="Ürünü kaldır"><Trash2 size={16}/></button></div>)}</div>}
              </div>
              <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">Toplam ürün kullanım maliyeti: <b>{formatCurrency(productValue)}</b></div>
            </>
          )}
          <div><label className="label">Not (opsiyonel)</label><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={type === 'product' ? 'Örn: Büfede ikram için kullanıldı' : 'Örn: Elektrik faturası'} /></div>
          <button disabled={type==='cash' ? value <= 0 : selected.length === 0 || selected.some(({product,quantity})=>!product.unlimited_stock && quantity > Number(product.stock||0))} onClick={() => onSubmit(type, value, selected[0]?.productId, selected[0]?.quantity, note.trim() || undefined, type==='product' ? selected.map(({productId,quantity})=>({productId,quantity})) : undefined)} className="btn-primary w-full py-3 disabled:opacity-50"><Store size={18} /> Gideri Kaydet · {formatCurrency(value)}</button>
        </div>
      </div>
    </div>
  );
}

type CashCountModalProps = { expectedCash:number; onClose:()=>void; onSave:(countedCash:number,note?:string)=>void };
function CashCountForm({ expectedCash, onClose, onSave }: CashCountModalProps) {
  const [counted, setCounted] = useState(expectedCash.toFixed(2));
  const [note, setNote] = useState('');
  const actual = Math.max(0, Number(counted) || 0);
  const diff = Math.round((actual - expectedCash) * 100) / 100;
  return <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
    <div className="propos-modal-content card w-full max-w-md p-6" onClick={event=>event.stopPropagation()}>
      <div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-black text-slate-800">Ara Kasa Sayımı</h2><p className="text-xs text-slate-500">Kasayı kapatmadan sayımı kaydeder.</p></div><button onClick={onClose} className="text-slate-400"><X size={22}/></button></div>
      <div className="mb-4 rounded-lg bg-slate-50 p-4"><p className="text-sm text-slate-500">Sisteme göre kasada olması gereken (beklenen tutar)</p><p className="text-2xl font-black text-slate-800">{formatCurrency(expectedCash)}</p></div>
      <label className="label">Gerçekte saydığın nakit (TL)</label><input className="input text-xl" type="number" min="0" step="0.01" value={counted} onChange={event=>setCounted(event.target.value)} autoFocus/>
      <div className={`my-3 rounded-lg p-3 text-sm font-bold ${Math.abs(diff)<0.005?'bg-emerald-50 text-emerald-700':diff>0?'bg-amber-50 text-amber-700':'bg-rose-50 text-rose-700'}`}>{Math.abs(diff)<0.005?'Kasa tam denk':diff>0?`Fazla: ${formatCurrency(diff)}`:`Eksik: ${formatCurrency(Math.abs(diff))}`}</div>
      <label className="label">Not (opsiyonel)</label><input className="input" value={note} onChange={event=>setNote(event.target.value)} placeholder="Örn: Akşam ara sayım"/>
      <div className="mt-4 flex gap-2"><button className="btn-secondary flex-1 py-2.5" onClick={onClose}>Vazgeç</button><button className="btn-primary flex-1 py-2.5" disabled={counted.trim()===''||!Number.isFinite(Number(counted))||Number(counted)<0} onClick={()=>onSave(actual,note.trim()||undefined)}>Sayımı Kaydet</button></div>
    </div>
  </div>;
}

type CashSummaryValues = { expectedCash:number; cashSales:number; cardSales:number; ibanSales:number; creditSales:number; totalSales:number; deposits:number; withdrawals:number; supplierCashPayments:number; cashExpenses:number; productExpenses:number; cashRefunds:number; saleCount:number };
function CashSummaryModal({ type, session, values, onClose }: { type:'x'|'y'; session:CashSession; values:CashSummaryValues; onClose:()=>void }) {
  const title = type==='x' ? 'X · ARA KASA ÖZETİ' : 'Y · AYRINTILI KASA RAPORU';
  const rows:Array<[string,string]> = [
    ['Toplam satış tutarı',formatCurrency(values.totalSales)],
    ['Nakit satışlar',formatCurrency(values.cashSales)],['Kart satışları',formatCurrency(values.cardSales)],
    ['IBAN satışları',formatCurrency(values.ibanSales)],['Veresiye satışları',formatCurrency(values.creditSales)],
    ['Satış işlem sayısı',String(values.saleCount)],['Kasa açılış tutarı',formatCurrency(session.opening_amount)],
    ['Kasaya para ekleme',`+${formatCurrency(values.deposits)}`],['Kasadan para alma / IBAN dönüşümü',`-${formatCurrency(values.withdrawals)}`],
    ['Tedarikçi nakit ödemeleri',`-${formatCurrency(values.supplierCashPayments)}`],['Dükkân nakit giderleri',`-${formatCurrency(values.cashExpenses)}`],
    ['Ürün giderleri (stok)',formatCurrency(values.productExpenses)],['Nakit satış iadeleri',`-${formatCurrency(values.cashRefunds)}`],
    ['Beklenen kasa nakdi',formatCurrency(values.expectedCash)],
  ];
  function print() { document.body.classList.add('printing-cash-report'); window.addEventListener('afterprint',()=>document.body.classList.remove('printing-cash-report'),{once:true}); window.print(); }
  const summaryLabels = new Set(['Toplam satış tutarı','Nakit satışlar','Kart satışları','IBAN satışları','Veresiye satışları','Satış işlem sayısı','Kasa açılış tutarı','Beklenen kasa nakdi']);
  return <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3" onClick={onClose}>
    <div className="propos-modal-content card w-full max-w-lg p-5" onClick={event=>event.stopPropagation()}>
      <div className="cash-report-print-area rounded-lg border border-slate-200 bg-white p-4 font-mono text-sm">
        <div className="mb-3 text-center"><p className="text-base font-black">SİLOPİ DİJİTAL POS</p><p className="font-bold">{title}</p><p className="text-xs">Kasa açılışı: {formatDateTime(session.opened_at)}</p><p className="text-xs">Rapor zamanı: {formatDateTime(new Date().toISOString())}</p><p className="text-[10px]">İşletme içi rapordur; resmî mali yazarkasa raporu değildir.</p></div>
        <div className="space-y-2">{(type==='x' ? rows.filter(([label])=>summaryLabels.has(label)) : rows).map(([label,value])=><div key={label} className="flex items-start justify-between gap-3 border-b border-dashed border-slate-200 pb-1"><span>{label}</span><span className="shrink-0 text-right font-bold">{value}</span></div>)}</div>
      </div>
      <div className="cash-report-no-print mt-4 flex gap-2"><button className="btn-secondary flex-1 py-2.5" onClick={onClose}>Kapat</button><button className="btn-primary flex-1 py-2.5" onClick={print}><Printer size={17}/> Yazdır / PDF</button></div>
    </div>
  </div>;
}

function OpenCashForm({ onClose, onOpen }: { onClose: () => void; onOpen: (amount: number, note?: string) => void }) {
  const [amount, setAmount] = useState('0');
  const [note, setNote] = useState('');

  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="propos-modal-content card w-full max-w-md p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Kasa Aç</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="label">Açılış Nakit (TL)</label>
            <input
              type="number"
              step="0.01"
              className="input text-lg"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
            <p className="mt-1 text-xs text-slate-400">Kasaya başlangıçta ne kadar nakit var?</p>
          </div>
          <div>
            <label className="label">Not (opsiyonel)</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Örn: Sabah açılışı" />
          </div>
          <button
            onClick={() => onOpen(parseFloat(amount) || 0, note.trim() || undefined)}
            className="btn-success w-full py-3"
          >
            <Unlock size={18} />
            Kasayı Aç
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseCashForm({
  session,
  expectedCash,
  cashSales,
  cashRefunds,
  supplierCashPaymentTotal,
  shopCashExpenseTotal,
  productExpenseTotal,
  withdrawalTotal,
  depositTotal,
  cardSales,
  ibanSales,
  creditSales,
  totalSales,
  saleCount,
  onClose,
  onCloseSession,
}: {
  session: CashSession;
  expectedCash: number;
  cashSales: number;
  cashRefunds: number;
  supplierCashPaymentTotal: number;
  shopCashExpenseTotal: number;
  productExpenseTotal: number;
  withdrawalTotal: number;
  depositTotal: number;
  cardSales: number;
  ibanSales: number;
  creditSales: number;
  totalSales: number;
  saleCount: number;
  onClose: () => void;
  onCloseSession: (amount: number, note?: string) => void;
}) {
  const [countedCash, setCountedCash] = useState(expectedCash.toFixed(2));
  const [note, setNote] = useState('');
  const [showReport, setShowReport] = useState(false);

  const counted = parseFloat(countedCash) || 0;
  const diff = counted - expectedCash;

  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="card w-full max-w-lg p-6 animate-slide-up max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Gün Sonu - Kasa Kapat</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>

        {!showReport ? (
          <div className="space-y-4">
            {/* Summary */}
            <div className="rounded-lg bg-slate-50 p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Açılış Nakit</span>
                <span className="font-medium">{formatCurrency(session.opening_amount)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Nakit Satışlar</span>
                <span className="font-medium text-emerald-600">+{formatCurrency(cashSales)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Kasaya Eklenen</span>
                <span className="font-medium text-emerald-600">+{formatCurrency(depositTotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Kasadan Alınan</span>
                <span className="font-medium text-amber-600">-{formatCurrency(withdrawalTotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Tedarikçi Nakit Ödemeleri</span>
                <span className="font-medium text-violet-600">-{formatCurrency(supplierCashPaymentTotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Dükkân Nakit Giderleri</span>
                <span className="font-medium text-rose-600">-{formatCurrency(shopCashExpenseTotal)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Nakit İadeler</span>
                <span className="font-medium text-rose-600">-{formatCurrency(cashRefunds)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Kart Satışlar</span>
                <span className="font-medium text-blue-600">{formatCurrency(cardSales)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Veresiye Satışlar</span>
                <span className="font-medium text-amber-600">{formatCurrency(creditSales)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">Satış Adedi</span>
                <span className="font-medium">{saleCount}</span>
              </div>
              <div className="border-t border-slate-200 pt-2 flex justify-between font-bold">
                <span>Kasada olması gereken nakit</span>
                <span className="text-teal-700">{formatCurrency(expectedCash)}</span>
              </div>
            </div>

            <div>
              <label className="label">Sayılan Nakit (TL)</label>
              <input
                type="number"
                step="0.01"
                className="input text-lg"
                value={countedCash}
                onChange={(e) => setCountedCash(e.target.value)}
                autoFocus
              />
            </div>

            {diff !== 0 && (
              <div className={`rounded-lg p-3 text-center ${diff > 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                <p className={`text-sm ${diff > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {diff > 0 ? 'Fazla' : 'Eksik'}: {formatCurrency(Math.abs(diff))}
                </p>
              </div>
            )}

            <div>
              <label className="label">Not (opsiyonel)</label>
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Gün sonu notu" />
            </div>

            <div className="flex gap-2">
              <button onClick={() => setShowReport(true)} className="btn-secondary flex-1 py-2.5">
                <Printer size={18} />
                Rapor Önizle
              </button>
              <button
                onClick={() => onCloseSession(counted, note.trim() || undefined)}
                className="btn-primary flex-1 py-2.5"
              >
                <Lock size={18} />
                Kasayı Kapat
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="cash-report-print-area rounded-lg border-2 border-dashed border-slate-200 p-4 font-mono text-sm">
              <div className="text-center mb-3">
                <p className="mb-1 font-black text-base">SİLOPİ DİJİTAL POS</p><p className="font-bold text-base">Z · GÜN SONU RAPORU</p>
                <p className="text-slate-500 text-xs">{formatDateTime(session.opened_at)}</p>
                <p className="text-slate-500 text-xs">— {formatDateTime(new Date().toISOString())}</p><p className="mt-1 text-xs font-semibold">İşletme Kasa Özeti · Resmî mali yazarkasa raporu değildir</p>
              </div>
              <div className="space-y-1">
                <div className="flex justify-between font-bold"><span>Toplam Satış</span><span>{formatCurrency(totalSales)}</span></div>
                <div className="flex justify-between"><span>Kasa açılış tutarı</span><span>{formatCurrency(session.opening_amount)}</span></div>
                <div className="flex justify-between"><span>Nakit satışlar</span><span>+{formatCurrency(cashSales)}</span></div>
                <div className="flex justify-between"><span>Kasaya eklenen</span><span>+{formatCurrency(depositTotal)}</span></div>
                <div className="flex justify-between"><span>Kasadan alınan</span><span>-{formatCurrency(withdrawalTotal)}</span></div>
                <div className="flex justify-between"><span>Tedarikçi nakit ödemeleri</span><span>-{formatCurrency(supplierCashPaymentTotal)}</span></div>
                <div className="flex justify-between"><span>Dükkân nakit giderleri</span><span>-{formatCurrency(shopCashExpenseTotal)}</span></div>
                <div className="flex justify-between"><span>Ürün giderleri (stok)</span><span>{formatCurrency(productExpenseTotal)}</span></div>
                <div className="flex justify-between"><span>Nakit iadeler</span><span>-{formatCurrency(cashRefunds)}</span></div>
                <div className="flex justify-between"><span>Kart satışları</span><span>{formatCurrency(cardSales)}</span></div>
                <div className="flex justify-between"><span>IBAN satışları</span><span>{formatCurrency(ibanSales)}</span></div>
                <div className="flex justify-between"><span>Veresiye satışları</span><span>{formatCurrency(creditSales)}</span></div>
                <div className="flex justify-between"><span>Satış işlem sayısı</span><span>{saleCount}</span></div>
                <div className="border-t border-slate-300 pt-1 flex justify-between font-bold">
                  <span>Sisteme göre beklenen nakit</span><span>{formatCurrency(expectedCash)}</span>
                </div>
                <div className="flex justify-between"><span>Sayılan Nakit</span><span>{formatCurrency(counted)}</span></div>
                <div className="flex justify-between font-bold">
                  <span>{diff >= 0 ? 'Fazla' : 'Eksik'}</span>
                  <span className={diff >= 0 ? 'text-emerald-600' : 'text-red-600'}>{formatCurrency(Math.abs(diff))}</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => { document.body.classList.add('printing-cash-report'); window.addEventListener('afterprint', () => document.body.classList.remove('printing-cash-report'), { once: true }); window.print(); }} className="cash-report-no-print btn-secondary flex-1 py-2.5">
                <Printer size={18} />
                Yazdır / PDF
              </button>
              <button onClick={() => setShowReport(false)} className="btn-primary flex-1 py-2.5">
                Geri
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionDetailModal({ session, onClose }: { session: CashSession; onClose: () => void }) {
  return (
    <div className="propos-modal-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={onClose}>
      <div className="propos-modal-content card w-full max-w-md p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-slate-800">Oturum Detayı</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={22} /></button>
        </div>
        <div className="space-y-3 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-500">Durum</span>
            <span className={`font-medium ${session.status === 'open' ? 'text-teal-600' : 'text-slate-600'}`}>
              {session.status === 'open' ? 'Açık' : 'Kapalı'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">Açılış</span>
            <span className="font-medium">{formatDateTime(session.opened_at)}</span>
          </div>
          {session.closed_at && (
            <div className="flex justify-between">
              <span className="text-slate-500">Kapanış</span>
              <span className="font-medium">{formatDateTime(session.closed_at)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-slate-500">Açılış Nakit</span>
            <span className="font-medium">{formatCurrency(session.opening_amount)}</span>
          </div>
          {session.closing_amount != null && (
            <div className="flex justify-between">
              <span className="text-slate-500">Kapanış Nakiti</span>
              <span className="font-medium">{formatCurrency(session.closing_amount)}</span>
            </div>
          )}
          {session.note && (
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-400 mb-1">Not</p>
              <p className="text-sm text-slate-600">{session.note}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
