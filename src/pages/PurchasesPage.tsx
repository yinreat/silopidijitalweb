import { useMemo, useState } from 'react';
import { Plus, Truck, PackagePlus, X, Save, ClipboardList, Phone, Power, Wallet, ReceiptText, CreditCard, Banknote, Building2, RefreshCcw, Camera } from 'lucide-react';
import {
  useProducts,
  useSuppliers,
  saveSupplier,
  toggleSupplier,
  usePurchaseReceipts,
  receivePurchase,
  useSupplierAccounts,
  paySupplier,
} from '@/lib/hooks';
import { formatCurrency } from '@/lib/utils';
import type { Product, Supplier } from '@/lib/supabase';
import BarcodeScanner from '@/components/BarcodeScanner';

type Line = { product: Product; quantity: number; unitCost: number };

type Tab = 'purchase' | 'suppliers' | 'accounts';

export default function PurchasesPage() {
  const { products } = useProducts();
  const { suppliers, reload: reloadSuppliers } = useSuppliers();
  const { receipts, reload: reloadReceipts } = usePurchaseReceipts();
  const { accounts, payments, receipts: accountReceipts, loading: accountsLoading, reload: reloadAccounts } = useSupplierAccounts();
  const [tab, setTab] = useState<Tab>('purchase');
  const [search, setSearch] = useState('');
  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false);
  const [barcodeNotice, setBarcodeNotice] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [note, setNote] = useState('');
  const [discount, setDiscount] = useState('0');
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [supplierForm, setSupplierForm] = useState({ name:'', contact_name:'', phone:'', address:'', note:'' });
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedAccountSupplier, setSelectedAccountSupplier] = useState<string>('');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<'cash'|'card'|'bank'>('cash');
  const [paymentNote, setPaymentNote] = useState('');
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState('');

  const subtotal = lines.reduce((s,x)=>s+x.quantity*x.unitCost,0);
  const total = Math.max(0, subtotal-Math.max(0,Number(discount)||0));

  const selectedAccount = accounts.find(x => x.supplier.id === selectedAccountSupplier) || null;
  const selectedPurchases = useMemo(() => accountReceipts.filter(r => r.supplier_id === selectedAccountSupplier), [accountReceipts, selectedAccountSupplier]);
  const selectedPayments = useMemo(() => payments.filter(p => p.supplier_id === selectedAccountSupplier), [payments, selectedAccountSupplier]);
  const selectedTimeline = useMemo(() => {
    const purchases = selectedPurchases.map(r => ({ type:'purchase' as const, date:r.purchase_date, id:r.id, title:r.invoice_no ? `Alış · ${r.invoice_no}` : 'Alış kaydı', amount:Number(r.total||0), paid:Number(r.paid_amount||0), status:r.status, paymentMethod:null as null }));
    const pays = selectedPayments.map(p => ({ type:'payment' as const, date:p.created_at, id:p.id, title:'Tedarikçi ödemesi', amount:Number(p.amount||0), paid:0, status:null as null, paymentMethod:p.payment_method }));
    return [...purchases, ...pays].sort((a,b)=>new Date(b.date).getTime()-new Date(a.date).getTime());
  }, [selectedPurchases, selectedPayments]);

  function addLine(product: Product) {
    setLines(prev => {
      const idx=prev.findIndex(x=>x.product.id===product.id);
      if(idx>=0) return prev.map((x,i)=>i===idx?{...x,quantity:x.quantity+1}:x);
      return [...prev,{product,quantity:1,unitCost:Number(product.cost||0)}];
    });
  }
  function updateLine(id:string, patch:Partial<Line>) { setLines(prev=>prev.map(x=>x.product.id===id?{...x,...patch}:x)); }
  function removeLine(id:string) { setLines(prev=>prev.filter(x=>x.product.id!==id)); }

  function handleBarcodeInput(code: string) {
    const normalized = code.trim();
    setSearch(normalized);
    setBarcodeNotice('');
    if (!normalized) return;
    const product = products.find(p => p.barcode === normalized || (p.additional_barcodes || []).includes(normalized));
    if (!product) {
      setBarcodeNotice(`Barkod bulunamadı: ${normalized}`);
      return;
    }
    addLine(product);
    setSearch('');
    setBarcodeNotice(`${product.name} alış sepetine eklendi.`);
  }

  async function handleSavePurchase() {
    setMessage('');
    if (!supplierId) { setMessage('Önce tedarikçi seç. Böylece alış doğrudan tedarikçi carisine işlenir.'); return; }
    if (!lines.length) { setMessage('Önce en az bir ürün ekle.'); return; }
    setSaving(true);
    let staffId:string|null=null;
    try { staffId=(JSON.parse(sessionStorage.getItem('propos-current-staff-v2')||'null') as any)?.id || null; } catch {}
    const result=await receivePurchase({ supplierId, invoiceNo, discountTotal:Number(discount)||0, staffId, notes:note, items:lines.map(x=>({productId:x.product.id,productName:x.product.name,barcode:x.product.barcode,quantity:x.quantity,unitCost:x.unitCost})) });
    if(!result.success) setMessage(result.error||'Alış kaydedilemedi.');
    else { setMessage('Alış kaydedildi. Stoklar güncellendi ve tedarikçi carisine borç işlendi.'); setLines([]); setInvoiceNo(''); setNote(''); setDiscount('0'); await Promise.all([reloadReceipts(), reloadAccounts()]); }
    setSaving(false);
  }

  async function createSupplier() {
    if(!supplierForm.name.trim()) return;
    const created=await saveSupplier(supplierForm);
    if(created){ setSupplierForm({name:'',contact_name:'',phone:'',address:'',note:''}); setShowSupplierForm(false); await Promise.all([reloadSuppliers(), reloadAccounts()]); setSupplierId(created.id); }
  }

  async function handlePaySupplier() {
    setPaymentMessage('');
    if (!selectedAccount) return;
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) { setPaymentMessage('Geçerli bir ödeme tutarı gir.'); return; }
    if (amount > selectedAccount.balance + 0.009) { setPaymentMessage('Ödeme tutarı mevcut borçtan fazla olamaz.'); return; }
    let staffId:string|null=null;
    try { staffId=(JSON.parse(sessionStorage.getItem('propos-current-staff-v2')||'null') as any)?.id || null; } catch {}
    setPaying(true);
    const result = await paySupplier({ supplierId:selectedAccount.supplier.id, amount, paymentMethod:paymentMethod, note:paymentNote, staffId });
    if (!result.success) setPaymentMessage(result.error || 'Ödeme kaydedilemedi.');
    else { setPaymentMessage(`Ödeme kaydedildi. Kalan borç: ${formatCurrency(result.balanceAfter || 0)}`); setPaymentAmount(''); setPaymentNote(''); await reloadAccounts(); }
    setPaying(false);
  }

  return <div className="flex h-full flex-col overflow-hidden bg-slate-100">
    <div className="border-b border-slate-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-bold text-slate-800">Alış & Tedarikçiler</h1><p className="text-sm text-slate-500">Alış, tedarikçi cari hesabı ve ödemeleri tek yerden yönetin.</p></div>
        <div className="flex flex-wrap gap-2">
          <button onClick={()=>setTab('purchase')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${tab==='purchase'?'bg-teal-600 text-white':'bg-slate-100 text-slate-600'}`}><PackagePlus size={16} className="mr-1 inline"/>Yeni Alış</button>
          <button onClick={()=>setTab('accounts')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${tab==='accounts'?'bg-teal-600 text-white':'bg-slate-100 text-slate-600'}`}><Wallet size={16} className="mr-1 inline"/>Tedarikçi Cari</button>
          <button onClick={()=>setTab('suppliers')} className={`rounded-lg px-3 py-2 text-sm font-semibold ${tab==='suppliers'?'bg-teal-600 text-white':'bg-slate-100 text-slate-600'}`}><Truck size={16} className="mr-1 inline"/>Tedarikçiler</button>
        </div>
      </div>
    </div>

    {tab==='purchase' && <div className="grid flex-1 min-h-0 grid-cols-1 gap-0 overflow-hidden lg:grid-cols-[1.2fr_1fr]">
      <div className="min-h-0 overflow-y-auto p-5">
        <div className="card mb-4 p-4">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm"><span className="mb-1 block font-semibold text-slate-600">Tedarikçi *</span><select className="input" value={supplierId} onChange={e=>setSupplierId(e.target.value)}><option value="">Tedarikçi seç</option>{suppliers.filter(s=>s.active).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="text-sm"><span className="mb-1 block font-semibold text-slate-600">Fatura No</span><input className="input" value={invoiceNo} onChange={e=>setInvoiceNo(e.target.value)} placeholder="Varsa fatura no"/></label>
            <label className="text-sm"><span className="mb-1 block font-semibold text-slate-600">İskonto</span><input className="input" type="number" min="0" value={discount} onChange={e=>setDiscount(e.target.value)}/></label>
          </div>
          {supplierId && <div className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-sm text-teal-800">Bu alış seçilen tedarikçinin carisine borç olarak işlenecek.</div>}
        </div>
        <div className="card p-4">
          <div className="mb-2"><div className="font-bold text-slate-700">Ürün Ekle</div><div className="text-xs text-slate-500">Ürün seçimi kaldırıldı. Barkodu okut; ürün otomatik alış sepetine eklenir.</div></div>
          <div className="flex gap-2">
            <input className="input flex-1 font-mono" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();handleBarcodeInput(search)}}} placeholder="Barkod okut veya barkodu yaz ve Enter" autoComplete="off" autoFocus/>
            <button type="button" onClick={()=>setShowBarcodeScanner(true)} className="btn" title="Kamerayla barkod tara"><Camera size={18}/></button>
          </div>
          {barcodeNotice && <div className={`mt-2 rounded-lg px-3 py-2 text-sm ${barcodeNotice.includes('eklendi')?'bg-emerald-50 text-emerald-700':'bg-slate-50 text-slate-600'}`}>{barcodeNotice}</div>}
        </div>
      </div>
      <div className="min-h-0 overflow-y-auto border-l border-slate-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-bold text-slate-800">Alış Sepeti</h2><span className="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-500">{lines.length} kalem</span></div>
        <div className="space-y-2">{lines.length===0?<div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-400">Soldan ürün seçerek alış sepetini oluştur.</div>:lines.map(x=><div key={x.product.id} className="rounded-xl border border-slate-200 p-3">
          <div className="flex items-start justify-between gap-2"><div><div className="font-semibold text-slate-700">{x.product.name}</div><div className="text-xs text-slate-400">Eski maliyet: {formatCurrency(x.product.cost||0)}</div></div><button onClick={()=>removeLine(x.product.id)} className="text-slate-400 hover:text-red-500"><X size={16}/></button></div>
          <div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs text-slate-500">Adet<input className="input mt-1" type="number" min="0.001" step="0.001" value={x.quantity} onChange={e=>updateLine(x.product.id,{quantity:Number(e.target.value)||0})}/></label><label className="text-xs text-slate-500">Birim maliyet<input className="input mt-1" type="number" min="0" step="0.01" value={x.unitCost} onChange={e=>updateLine(x.product.id,{unitCost:Number(e.target.value)||0})}/></label><div className="rounded-lg bg-slate-50 p-2"><div className="text-xs text-slate-400">Tutar</div><div className="font-bold text-slate-700">{formatCurrency(x.quantity*x.unitCost)}</div></div></div>
        </div>)}</div>
        <label className="mt-4 block text-sm"><span className="mb-1 block font-semibold text-slate-600">Not</span><textarea className="input min-h-20" value={note} onChange={e=>setNote(e.target.value)} placeholder="Alışla ilgili not"/></label>
        <div className="mt-4 border-t border-slate-200 pt-4 text-sm"><div className="flex justify-between text-slate-500"><span>Ara toplam</span><b>{formatCurrency(subtotal)}</b></div><div className="mt-1 flex justify-between text-slate-500"><span>İskonto</span><b>-{formatCurrency(Math.min(subtotal,Math.max(0,Number(discount)||0)))}</b></div><div className="mt-2 flex justify-between text-lg font-bold text-slate-800"><span>Alış toplamı</span><span>{formatCurrency(total)}</span></div></div>
        {message && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.includes('kaydedildi')?'bg-emerald-50 text-emerald-700':'bg-red-50 text-red-700'}`}>{message}</div>}
        <button disabled={saving||!lines.length||!supplierId} onClick={handleSavePurchase} className="btn-primary mt-4 flex w-full items-center justify-center gap-2 py-3 disabled:opacity-50"><Save size={17}/>{saving?'Kaydediliyor...':'Alışı Kaydet · Stoğa Ekle'}</button>
        <div className="mt-5"><h3 className="mb-2 flex items-center gap-2 font-semibold text-slate-700"><ClipboardList size={16}/> Son Alışlar</h3><div className="space-y-2">{receipts.slice(0,8).map(r=>{ const supplier=suppliers.find(s=>s.id===r.supplier_id); return <div key={r.id} className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs"><div className="flex justify-between"><span>{new Date(r.purchase_date).toLocaleString('tr-TR')}</span><b>{formatCurrency(r.total)}</b></div><div className="text-slate-400">{supplier?.name||'Tedarikçi yok'} · {r.invoice_no||'Fatura no yok'} · {r.status==='paid'?'Ödendi':r.status==='partial'?'Kısmi':'Açık'}</div></div>;})}</div></div>
      </div>
    </div>}

    {tab==='accounts' && <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-6xl">
        <div className="mb-4 flex items-center justify-between gap-3"><div><h2 className="text-lg font-bold text-slate-800">Tedarikçi Cari Hesapları</h2><p className="text-sm text-slate-500">Alış borçlarını, yapılan ödemeleri ve kalan bakiyeyi takip edin.</p></div><button onClick={reloadAccounts} className="btn-secondary flex items-center gap-2"><RefreshCcw size={16}/> Yenile</button></div>
        {accountsLoading ? <div className="card p-10 text-center text-slate-400">Cari hesaplar yükleniyor...</div> : accounts.length===0 ? <div className="card p-10 text-center text-slate-400">Henüz aktif tedarikçi yok.</div> : <div className="grid gap-4 lg:grid-cols-[1fr_1.25fr]">
          <div className="space-y-3">{accounts.map(a=><button key={a.supplier.id} onClick={()=>{setSelectedAccountSupplier(a.supplier.id);setPaymentMessage('');}} className={`card w-full p-4 text-left transition ${selectedAccountSupplier===a.supplier.id?'border-teal-400 ring-2 ring-teal-100':'hover:border-slate-300'}`}><div className="flex items-start justify-between gap-3"><div><div className="font-bold text-slate-800">{a.supplier.name}</div><div className="text-xs text-slate-400">{a.purchase_count} alış · {a.payment_count} ödeme</div></div><div className="text-right"><div className="text-xs text-slate-400">Kalan borç</div><div className={`text-xl font-bold ${a.balance>0?'text-rose-600':'text-emerald-600'}`}>{formatCurrency(a.balance)}</div></div></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><div className="rounded-lg bg-slate-50 p-2"><span className="text-slate-400">Toplam alış</span><b className="ml-2 text-slate-700">{formatCurrency(a.total_purchases)}</b></div><div className="rounded-lg bg-emerald-50 p-2"><span className="text-emerald-600">Ödenen</span><b className="ml-2 text-emerald-700">{formatCurrency(a.total_paid)}</b></div></div></button>)}</div>
          <div className="card p-5">
            {!selectedAccount ? <div className="flex min-h-[360px] items-center justify-center text-center text-slate-400"><div><Wallet className="mx-auto mb-3" size={36}/><p>Tedarikçi seçerek cari detayını aç.</p></div></div> : <>
              <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-800">{selectedAccount.supplier.name}</h3><div className="text-sm text-slate-500">Cari durum</div></div><div className="text-right"><div className="text-xs text-slate-400">Ödenecek bakiye</div><div className="text-2xl font-bold text-rose-600">{formatCurrency(selectedAccount.balance)}</div></div></div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-slate-50 p-4"><div className="text-xs text-slate-400">Toplam alış</div><div className="font-bold text-slate-800">{formatCurrency(selectedAccount.total_purchases)}</div></div><div className="rounded-xl bg-emerald-50 p-4"><div className="text-xs text-emerald-600">Toplam ödeme</div><div className="font-bold text-emerald-700">{formatCurrency(selectedAccount.total_paid)}</div></div><div className="rounded-xl bg-rose-50 p-4"><div className="text-xs text-rose-600">Kalan</div><div className="font-bold text-rose-700">{formatCurrency(selectedAccount.balance)}</div></div></div>
              {selectedAccount.balance>0 && <div className="mt-5 rounded-2xl border border-teal-200 bg-teal-50 p-4"><div className="mb-3 flex items-center gap-2 font-bold text-teal-800"><Wallet size={18}/> Tedarikçiye Ödeme</div><div className="grid gap-3 sm:grid-cols-3"><label className="text-sm"><span className="mb-1 block font-semibold text-teal-800">Tutar</span><input className="input bg-white" type="number" min="0.01" step="0.01" value={paymentAmount} onChange={e=>setPaymentAmount(e.target.value)} placeholder={String(selectedAccount.balance)}/></label><label className="text-sm"><span className="mb-1 block font-semibold text-teal-800">Yöntem</span><select className="input bg-white" value={paymentMethod} onChange={e=>setPaymentMethod(e.target.value as 'cash'|'card'|'bank')}><option value="cash">Nakit</option><option value="card">Kart</option><option value="bank">Banka / Havale</option></select></label><label className="text-sm"><span className="mb-1 block font-semibold text-teal-800">Not</span><input className="input bg-white" value={paymentNote} onChange={e=>setPaymentNote(e.target.value)} placeholder="Ödeme notu"/></label></div><button onClick={handlePaySupplier} disabled={paying} className="btn-primary mt-3 w-full py-3 disabled:opacity-50">{paying?'Kaydediliyor...':'Ödemeyi Kaydet'}</button>{paymentMessage && <div className={`mt-3 rounded-lg px-3 py-2 text-sm ${paymentMessage.includes('kaydedildi')?'bg-emerald-100 text-emerald-800':'bg-red-100 text-red-700'}`}>{paymentMessage}</div>}</div>}
              <div className="mt-5"><div className="mb-3 font-bold text-slate-700">Cari Hareketler</div><div className="max-h-[360px] space-y-2 overflow-y-auto">{selectedTimeline.length===0?<div className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-400">Henüz cari hareket yok.</div>:selectedTimeline.map(item=><div key={`${item.type}-${item.id}`} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="flex items-center justify-between gap-3"><div><div className="flex items-center gap-2 font-semibold text-slate-700">{item.type==='purchase'?<ReceiptText size={15}/>:item.paymentMethod==='cash'?<Banknote size={15}/>:item.paymentMethod==='card'?<CreditCard size={15}/>:<Building2 size={15}/>} {item.title}</div><div className="mt-1 text-xs text-slate-400">{new Date(item.date).toLocaleString('tr-TR')}{item.type==='purchase'?` · ${item.status==='paid'?'Ödendi':item.status==='partial'?'Kısmi ödendi':'Açık'}`:` · ${item.paymentMethod==='cash'?'Nakit':item.paymentMethod==='card'?'Kart':'Banka'}`}</div></div><div className={`font-bold ${item.type==='purchase'?'text-rose-600':'text-emerald-600'}`}>{item.type==='purchase'?`+${formatCurrency(item.amount)}`:`-${formatCurrency(item.amount)}`}</div></div>{item.type==='purchase' && <div className="mt-2 text-xs text-slate-500">Ödenen: <b>{formatCurrency(item.paid)}</b> · Kalan: <b>{formatCurrency(Math.max(item.amount-item.paid,0))}</b></div>}</div>)}</div></div>
            </>}
          </div>
        </div>}
      </div>
    </div>}

    {tab==='suppliers' && <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="mx-auto max-w-5xl"><div className="mb-4 flex items-center justify-between"><div><h2 className="text-lg font-bold text-slate-800">Tedarikçiler</h2><p className="text-sm text-slate-500">Ürün alışlarının kaynağını düzenli tut.</p></div><button onClick={()=>setShowSupplierForm(true)} className="btn-primary flex items-center gap-2"><Plus size={17}/> Tedarikçi Ekle</button></div>
      {showSupplierForm && <div className="card mb-4 p-4"><div className="mb-3 flex items-center justify-between"><b>Yeni Tedarikçi</b><button onClick={()=>setShowSupplierForm(false)}><X size={18}/></button></div><div className="grid gap-3 md:grid-cols-2"><input className="input" placeholder="Firma adı *" value={supplierForm.name} onChange={e=>setSupplierForm({...supplierForm,name:e.target.value})}/><input className="input" placeholder="Yetkili kişi" value={supplierForm.contact_name} onChange={e=>setSupplierForm({...supplierForm,contact_name:e.target.value})}/><input className="input" placeholder="Telefon" value={supplierForm.phone} onChange={e=>setSupplierForm({...supplierForm,phone:e.target.value})}/><input className="input" placeholder="Adres" value={supplierForm.address} onChange={e=>setSupplierForm({...supplierForm,address:e.target.value})}/><textarea className="input md:col-span-2" placeholder="Not" value={supplierForm.note} onChange={e=>setSupplierForm({...supplierForm,note:e.target.value})}/></div><button onClick={createSupplier} className="btn-primary mt-3"><Save size={16} className="mr-1 inline"/>Kaydet</button></div>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{suppliers.map(s=><div key={s.id} className={`card p-4 ${!s.active?'opacity-60':''}`}><div className="flex items-start justify-between"><div><h3 className="font-bold text-slate-800">{s.name}</h3><p className="text-xs text-slate-400">{s.contact_name||'Yetkili yok'}</p></div><button onClick={async()=>{await toggleSupplier(s.id,!s.active);await Promise.all([reloadSuppliers(),reloadAccounts()]);}} title={s.active?'Pasife al':'Aktifleştir'} className="rounded-lg bg-slate-100 p-2 text-slate-500"><Power size={16}/></button></div><div className="mt-3 space-y-1 text-sm text-slate-500">{s.phone&&<div><Phone size={14} className="mr-1 inline"/>{s.phone}</div>}{s.address&&<div>📍 {s.address}</div>}</div></div>)}</div>
    </div></div>}
    {showBarcodeScanner && <BarcodeScanner onDetected={(code)=>{setShowBarcodeScanner(false);handleBarcodeInput(code);}} onClose={()=>setShowBarcodeScanner(false)} />}
  </div>
}
