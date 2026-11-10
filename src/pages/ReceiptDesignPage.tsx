import { useEffect, useMemo, useState } from 'react';
import { Check, Printer, ReceiptText, Save, Store } from 'lucide-react';
import ReceiptLayout from '@/components/ReceiptLayout';
import { DEFAULT_RECEIPT_DESIGN, loadReceiptDesign, saveReceiptDesign, type ReceiptDesign } from '@/lib/receiptDesign';
import { loadStoreSettings, saveStoreSettings, type StoreSettings } from '@/lib/hooks';

const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY',
  receiptFooter: 'Bizi tercih ettiğiniz için teşekkür ederiz!', taxRate: '0', lowStockDefault: '0',
};

const sampleItems = [
  { product_name: 'ÖRNEK ÜRÜN', quantity: 2, unit_price: 15, subtotal: 30 },
  { product_name: 'ÖRNEK İÇECEK', quantity: 1, unit_price: 7.5, subtotal: 7.5 },
  { product_name: 'ÖRNEK PAKETLİ ÜRÜN', quantity: 1, unit_price: 70, subtotal: 70 },
];

export default function ReceiptDesignPage() {
  const [design, setDesign] = useState<ReceiptDesign>(() => loadReceiptDesign());
  const [settings, setSettings] = useState<StoreSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    let localSettings: Partial<StoreSettings> = {};
    try {
      const raw = localStorage.getItem('pos-settings');
      if (raw) localSettings = JSON.parse(raw) as Partial<StoreSettings>;
    } catch { /* Use defaults when local preferences are malformed. */ }
    setSettings({ ...DEFAULT_SETTINGS, ...localSettings });
    void loadStoreSettings(DEFAULT_SETTINGS).then(value => {
      if (active) setSettings(previous => ({ ...previous, ...value }));
    });
    return () => { active = false; };
  }, []);

  const previewWidth = useMemo(() => design.paperWidth === '58mm' ? 230 : 310, [design.paperWidth]);
  function update<K extends keyof ReceiptDesign>(key: K, value: ReceiptDesign[K]) {
    setDesign(previous => ({ ...previous, [key]: value }));
    setSaved(false);
  }
  function updateStore<K extends keyof StoreSettings>(key: K, value: StoreSettings[K]) {
    setSettings(previous => ({ ...previous, [key]: value }));
    setSaved(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      saveReceiptDesign(design);
      localStorage.setItem('pos-settings', JSON.stringify(settings));
      await saveStoreSettings(settings);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2400);
    } finally {
      setSaving(false);
    }
  }

  function printTestReceipt() {
    document.body.classList.add('printing-receipt', design.paperWidth === '58mm' ? 'receipt-paper-58' : 'receipt-paper-80');
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('printing-receipt', 'receipt-paper-58', 'receipt-paper-80');
    }, { once: true });
    window.print();
  }

  type ReceiptBooleanKey = 'showStoreName' | 'showPhone' | 'showAddress' | 'showReceiptNo' | 'showDate' | 'showUnitPrice' | 'showCustomer' | 'showPayment' | 'showFooter';
  const flag = (key: ReceiptBooleanKey, label: string) => <label key={key} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium text-slate-700">
    <input type="checkbox" checked={design[key]} onChange={event => update(key, event.target.checked)} />
    {label}
  </label>;

  return <div className="flex h-screen flex-col overflow-hidden bg-slate-50">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
      <div>
        <div className="flex items-center gap-2"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><ReceiptText size={19}/></span><h1 className="text-xl font-black tracking-tight text-slate-900">Fiş Tasarımı</h1></div>
        <p className="mt-1 text-sm text-slate-500">Fiş makinesi çıktısını düzenle; sağ tarafta canlı önizlemesini gör.</p>
      </div>
      <div className="flex gap-2">
        <button className="btn-secondary px-4 py-2" onClick={printTestReceipt}><Printer size={16}/> Deneme Fişi Yazdır</button>
        <button className="btn-primary px-4 py-2" onClick={() => void handleSave()} disabled={saving}>{saved ? <Check size={17}/> : <Save size={17}/>} {saving ? 'Kaydediliyor...' : saved ? 'Kaydedildi' : 'Fiş Tasarımını Kaydet'}</button>
      </div>
    </header>

    <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 xl:grid-cols-[minmax(420px,0.9fr)_minmax(380px,1.1fr)] xl:overflow-hidden">
      <section className="space-y-4 xl:overflow-y-auto xl:pr-2">
        <div className="card p-5">
          <div className="mb-4 flex items-center gap-2"><Store className="text-teal-700" size={19}/><h2 className="font-extrabold text-slate-900">Fişte görünecek işletme bilgileri</h2></div>
          <div className="space-y-3">
            <div><label className="label">Dükkan / İşletme adı</label><input className="input" value={settings.storeName} onChange={event => updateStore('storeName', event.target.value)} placeholder="Örn. Silopi Market"/></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><label className="label">Telefon</label><input className="input" value={settings.storePhone} onChange={event => updateStore('storePhone', event.target.value)} placeholder="0xxx xxx xx xx"/></div><div><label className="label">Adres</label><input className="input" value={settings.storeAddress} onChange={event => updateStore('storeAddress', event.target.value)} placeholder="Mahalle / Cadde"/></div></div>
            <div><label className="label">Fiş alt yazısı</label><input className="input" value={settings.receiptFooter} onChange={event => updateStore('receiptFooter', event.target.value)} placeholder="Bizi tercih ettiğiniz için teşekkür ederiz!"/></div>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">Bu bilgiler aynı zamanda Ayarlar bölümündeki mağaza bilgileriyle birlikte saklanır.</p>
        </div>

        <div className="card p-5">
          <h2 className="mb-4 font-extrabold text-slate-900">Kağıt ve başlık</h2>
          <div className="grid grid-cols-2 gap-2"><button onClick={() => update('paperWidth','58mm')} className={`rounded-xl border px-3 py-3 text-sm font-bold ${design.paperWidth==='58mm'?'border-blue-600 bg-blue-50 text-blue-800':'border-slate-200 bg-white text-slate-600'}`}>58 mm fiş</button><button onClick={() => update('paperWidth','80mm')} className={`rounded-xl border px-3 py-3 text-sm font-bold ${design.paperWidth==='80mm'?'border-blue-600 bg-blue-50 text-blue-800':'border-slate-200 bg-white text-slate-600'}`}>80 mm fiş</button></div>
          <div className="mt-4"><label className="label">Fiş başlığı</label><input className="input" value={design.title} onChange={event => update('title',event.target.value)} placeholder="SATIŞ FİŞİ"/></div>
          <div className="mt-4"><label className="label">Yazı boyutu</label><div className="flex items-center gap-3"><input className="w-full accent-blue-600" type="range" min="0.8" max="1.25" step="0.05" value={design.fontScale} onChange={event => update('fontScale',Number(event.target.value))}/><span className="w-12 text-right text-sm font-bold tabular-nums">{Math.round(design.fontScale*100)}%</span></div></div>
          <div className="mt-4"><label className="label">Metin hizası</label><div className="grid grid-cols-2 gap-2"><button onClick={() => update('alignment','center')} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${design.alignment==='center'?'border-blue-600 bg-blue-50 text-blue-800':'border-slate-200'}`}>Ortala</button><button onClick={() => update('alignment','left')} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${design.alignment==='left'?'border-blue-600 bg-blue-50 text-blue-800':'border-slate-200'}`}>Sola hizala</button></div></div>
        </div>

        <div className="card p-5">
          <h2 className="mb-3 font-extrabold text-slate-900">Fişte gösterilecek bilgiler</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {flag('showStoreName','Dükkan adı')}
            {flag('showPhone','Telefon numarası')}
            {flag('showAddress','Dükkan adresi')}
            {flag('showReceiptNo','Fiş numarası')}
            {flag('showDate','Tarih ve saat')}
            {flag('showUnitPrice','Ürün birim fiyatı')}
            {flag('showCustomer','Müşteri adı')}
            {flag('showPayment','Ödeme yöntemi')}
            {flag('showFooter','Alt teşekkür mesajı')}
          </div>
        </div>
      </section>

      <section className="flex min-h-[520px] flex-col rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200 p-4 xl:min-h-0 xl:overflow-y-auto">
        <div className="mb-3 flex items-center justify-between gap-2"><div><h2 className="font-extrabold text-slate-900">Canlı fiş önizlemesi</h2><p className="text-xs text-slate-500">Örnek satış · {design.paperWidth}</p></div><span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-600">ÖNİZLEME</span></div>
        <div className="flex flex-1 items-start justify-center overflow-auto rounded-xl border border-dashed border-slate-300 bg-slate-300/50 p-4">
          <div className="receipt-print-area w-full bg-white p-5 shadow-xl" style={{ width: `${previewWidth}px`, minWidth: `${previewWidth}px`, maxWidth: '100%', boxSizing:'border-box' }}>
            <ReceiptLayout storeName={settings.storeName} storePhone={settings.storePhone} storeAddress={settings.storeAddress} receiptFooter={settings.receiptFooter} design={design} receiptNo="00001284" createdAt={new Date().toISOString()} items={sampleItems} total={107.5} discountTotal={0} paymentLabel="Nakit" customerName="Örnek Müşteri" changeDue={2.5}/>
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">Fiş tasarımını kaydettiğinde, satış tamamlandıktan sonra açılan fiş penceresi de aynı düzeni kullanır. Gerçek yazıcıda 58 mm veya 80 mm rulo ölçüsünü seç.</p>
      </section>
    </div>
  </div>;
}
