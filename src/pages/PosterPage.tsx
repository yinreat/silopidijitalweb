import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgePercent, ImagePlus, Printer, Upload, X, Palette, FileText, Copy } from 'lucide-react';
import { loadStoreSettings, useProducts } from '@/lib/hooks';
import { campaignUnitPrice, isCampaignActive, loadCampaigns, type Campaign } from '@/lib/campaigns';
import { formatCurrency, getEffectivePrice } from '@/lib/utils';

type PrintMode = 'bw' | 'color';
type Layout = 'single' | '2' | '4' | '6';

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Fotoğraf okunamadı.'));
    reader.readAsDataURL(file);
  });
}

function calcCampaignPrice(product: any, campaigns: Campaign[]) {
  const result = campaignUnitPrice(product, 1, campaigns);
  return result.price < getEffectivePrice(product) ? result.price : getEffectivePrice(product);
}

export default function PosterPage() {
  const { products, loading } = useProducts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [campaigns] = useState<Campaign[]>(loadCampaigns());
  const [productId, setProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [image, setImage] = useState('');
  const [oldPrice, setOldPrice] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [title, setTitle] = useState('İNDİRİM');
  const [subtitle, setSubtitle] = useState('SADECE BU HAFTA');
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<PrintMode>('bw');
  const [layout, setLayout] = useState<Layout>('single');
  const [copies, setCopies] = useState(1);
  const [imageScale, setImageScale] = useState(115);
  const [storeName, setStoreName] = useState('Mağazam');

  useEffect(() => {
    let active = true;
    const defaults = { storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: '', taxRate: '0', lowStockDefault: '0' };
    void loadStoreSettings(defaults).then((settings) => {
      if (active) setStoreName(settings.storeName?.trim() || 'Mağazam');
    });
    return () => { active = false; };
  }, []);

  const selectedProduct = products.find(p => p.id === productId);
  const activeCampaigns = campaigns.filter(isCampaignActive);
  const filteredProducts = useMemo(() => {
    const q = productSearch.toLocaleLowerCase('tr-TR').trim();
    return products.filter(p => !q || p.name.toLocaleLowerCase('tr-TR').includes(q) || p.barcode?.includes(q)).slice(0, 120);
  }, [products, productSearch]);

  const discountPercent = useMemo(() => {
    const old = Number(oldPrice);
    const next = Number(newPrice);
    if (!old || !next || next >= old) return 0;
    return Math.round(((old - next) / old) * 100);
  }, [oldPrice, newPrice]);

  function chooseProduct(id: string) {
    setProductId(id);
    const p = products.find(x => x.id === id);
    if (!p) return;
    const normal = getEffectivePrice(p);
    const campaign = calcCampaignPrice(p, campaigns);
    setOldPrice(normal.toFixed(2));
    setNewPrice(campaign.toFixed(2));
    if (!image) setImage('');
  }

  async function onFile(file?: File) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Lütfen JPG, PNG veya WEBP ürün fotoğrafı seçin.'); return; }
    if (file.size > 8 * 1024 * 1024) { alert('Ürün fotoğrafı 8 MB veya daha küçük olmalı.'); return; }
    try { setImage(await readImage(file)); } catch (e) { alert(e instanceof Error ? e.message : 'Fotoğraf yüklenemedi.'); }
  }

  function applyCampaign(c: Campaign) {
    const p = selectedProduct;
    if (!p || !c.productIds.includes(p.id)) return;
    const result = campaignUnitPrice(p, 1, [c]);
    setNewPrice(result.price.toFixed(2));
    setTitle(c.name || 'İNDİRİM');
  }

  function print() {
    document.body.classList.add('printing-poster');
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-poster'), { once: true });
    window.print();
  }

  const posterCount = layout === 'single' ? 1 : Number(layout);
  const renderCount = layout === 'single' ? Math.max(1, copies) : posterCount;
  const priceChanged = Number(newPrice) < Number(oldPrice);
  const productName = selectedProduct?.name || 'ÜRÜN ADI';
  const productBarcode = selectedProduct?.barcode || '';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100">
      <header className="border-b bg-white px-5 py-4 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-black text-slate-800"><BadgePercent className="text-teal-600"/> Kampanya Afiş Tasarım Merkezi</h1>
            <p className="text-sm text-slate-500">İşletme adınızla A4 indirim afişini hazırlayın, önizleyin ve yazdırın.</p>
          </div>
          <button className="btn-primary px-5 py-2.5" onClick={print}><Printer size={18}/> Yazdır / PDF</button>
        </div>
      </header>

      <main className="flex-1 overflow-auto p-4 print:p-0">
        <div className="mx-auto grid max-w-[1500px] gap-4 lg:grid-cols-[390px_1fr] print:block">
          <section className="space-y-4 print:hidden">
            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2 font-bold"><FileText size={18}/> 1. Ürün ve fiyat</div>
              <input className="input mb-2" placeholder="Ürün ara / barkod okut..." value={productSearch} onChange={e=>setProductSearch(e.target.value)} />
              <select className="input" value={productId} onChange={e=>chooseProduct(e.target.value)} disabled={loading}>
                <option value="">Ürün seçin</option>
                {filteredProducts.map(p=><option key={p.id} value={p.id}>{p.name}{p.barcode ? ` — ${p.barcode}` : ''}</option>)}
              </select>
              {selectedProduct && <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Normal fiyat: <b>{formatCurrency(getEffectivePrice(selectedProduct))}</b></div>}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold text-slate-600">Eski fiyat<input className="input mt-1 text-lg font-black" type="number" step="0.01" value={oldPrice} onChange={e=>setOldPrice(e.target.value)} /></label>
                <label className="text-xs font-semibold text-slate-600">Yeni fiyat<input className="input mt-1 text-lg font-black" type="number" step="0.01" value={newPrice} onChange={e=>setNewPrice(e.target.value)} /></label>
              </div>
              {discountPercent > 0 && <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-bold text-emerald-700">%{discountPercent} indirim</div>}
              {selectedProduct && activeCampaigns.some(c=>c.productIds.includes(selectedProduct.id)) && <div className="mt-3"><p className="mb-1 text-xs font-bold text-slate-600">Aktif kampanyadan uygula</p><div className="flex flex-wrap gap-1">{activeCampaigns.filter(c=>c.productIds.includes(selectedProduct.id)).map(c=><button key={c.id} className="btn-secondary px-2 py-1 text-xs" onClick={()=>applyCampaign(c)}>{c.name}</button>)}</div></div>}
            </div>

            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2 font-bold"><ImagePlus size={18}/> 2. Ürün fotoğrafı</div>
              <input ref={fileRef} className="hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>onFile(e.target.files?.[0])}/>
              {image ? <div className="relative overflow-hidden rounded-xl border bg-white p-2"><img src={image} alt="Ürün" className="h-40 w-full object-contain"/><button className="absolute right-2 top-2 rounded-full bg-white p-1.5 shadow" onClick={()=>setImage('')}><X size={16}/></button></div> : <button className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-8 text-slate-500 hover:border-teal-400 hover:bg-teal-50" onClick={()=>fileRef.current?.click()}><Upload size={28}/><span className="font-semibold">Ürün fotoğrafı yükle</span><span className="text-xs">JPG / PNG / WEBP · maksimum 8 MB</span></button>}
              {image && <button className="btn-secondary mt-2 w-full py-2" onClick={()=>fileRef.current?.click()}><Upload size={15}/> Fotoğrafı değiştir</button>}
            </div>

            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2 font-bold"><Palette size={18}/> 3. Tasarım</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs font-semibold text-slate-600">Başlık<input className="input mt-1" value={title} onChange={e=>setTitle(e.target.value)} /></label>
                <label className="text-xs font-semibold text-slate-600">Alt başlık<input className="input mt-1" value={subtitle} onChange={e=>setSubtitle(e.target.value)} /></label>
              </div>
              <label className="mt-2 block text-xs font-semibold text-slate-600">Kısa not (isteğe bağlı)<input className="input mt-1" placeholder="Örn. Stoklarla sınırlıdır" value={note} onChange={e=>setNote(e.target.value)} /></label>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button className={`btn py-2.5 ${mode==='bw'?'bg-slate-900 text-white':'btn-secondary'}`} onClick={()=>setMode('bw')}>⚫ Siyah-Beyaz</button>
                <button className={`btn py-2.5 ${mode==='color'?'bg-red-600 text-white':'btn-secondary'}`} onClick={()=>setMode('color')}>🌈 Renkli</button>
              </div>
              <p className="mt-2 text-[11px] text-slate-400">Varsayılan siyah-beyazdır; renkli seçeneği sadece renkli yazıcı için kullanılır.</p>
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="mb-1 flex items-center justify-between text-xs font-bold text-slate-700">
                  <span>Ürün fotoğrafı büyüklüğü</span><span>%{imageScale}</span>
                </div>
                <input aria-label="Ürün fotoğrafı büyüklüğü" className="w-full accent-teal-600" type="range" min="70" max="150" step="5" value={imageScale} onChange={e=>setImageScale(Number(e.target.value))} />
                <p className="mt-1 text-[11px] text-slate-500">Fotoğraf, afiş çerçevesinin dışına taşmadan büyütülür.</p>
              </div>
            </div>

            <div className="card p-4">
              <div className="mb-3 flex items-center gap-2 font-bold"><Copy size={18}/> 4. A4 yerleşimi</div>
              <div className="grid grid-cols-3 gap-2">
                <button className={`btn py-2 ${layout==='single'?'bg-teal-600 text-white':'btn-secondary'}`} onClick={()=>setLayout('single')}>1 Afiş</button>
                <button className={`btn py-2 ${layout==='2'?'bg-teal-600 text-white':'btn-secondary'}`} onClick={()=>setLayout('2')}>2 Afiş</button>
                <button className={`btn py-2 ${layout==='4'?'bg-teal-600 text-white':'btn-secondary'}`} onClick={()=>setLayout('4')}>4 Afiş</button>
                <button className={`btn py-2 ${layout==='6'?'bg-teal-600 text-white':'btn-secondary'}`} onClick={()=>setLayout('6')}>6 Afiş</button>
              </div>
              {layout==='single' && <label className="mt-3 block text-xs font-semibold text-slate-600">Tekli afiş kopya sayısı<input className="input mt-1" type="number" min="1" max="20" value={copies} onChange={e=>setCopies(Math.min(20,Math.max(1,Number(e.target.value)||1)))} /></label>}
            </div>

          </section>

          <section className="print-preview-shell min-h-[calc(100vh-120px)] rounded-2xl border border-slate-200 bg-slate-300 p-5 print:min-h-0 print:border-0 print:bg-white print:p-0">
            <div className="mb-3 flex items-center justify-between print:hidden"><div><p className="text-sm font-bold text-slate-700">A4 Önizleme</p><p className="text-xs text-slate-500">Yazdırma sırasında tarayıcıdan A4 / Dikey seçin.</p></div><span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-600">{mode==='bw'?'Siyah-Beyaz':'Renkli'} · {layout==='single'?'1':layout} afiş</span></div>
            <div id="poster-print-area" className={`poster-print-area poster-mode-${mode} poster-layout-${layout}`}>
              {Array.from({length: renderCount}).map((_,i)=><Poster key={i} imageScale={imageScale} mode={mode} storeName={storeName} productName={productName} image={image} oldPrice={oldPrice} newPrice={newPrice} title={title} subtitle={subtitle} note={note} discountPercent={discountPercent} barcode={productBarcode} priceChanged={priceChanged} />)}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function Poster({mode,storeName,productName,image,oldPrice,newPrice,title,subtitle,note,discountPercent,barcode,priceChanged,imageScale}:{mode:PrintMode;storeName:string;productName:string;image:string;oldPrice:string;newPrice:string;title:string;subtitle:string;note:string;discountPercent:number;barcode:string;priceChanged:boolean;imageScale:number}) {
  return <article className="poster-card">
    <div className="poster-border">
      <div className="poster-top">
        <div className="poster-brand">{storeName || 'Mağazam'}</div>
      </div>
      <div className="poster-title"><span>{title || 'İNDİRİM'}</span></div>
      <div className="poster-product">
        <div className="poster-name-wrap"><h2>{productName}</h2>{barcode && <p>BARKOD: {barcode}</p>}</div>
        <div className="poster-image-box">{image ? <img src={image} alt={productName} style={{ transform: `scale(${imageScale / 100})` }} /> : <div className="poster-placeholder"><ImagePlus size={42}/><span>ÜRÜN FOTOĞRAFI</span></div>}</div>
      </div>
      <div className="poster-prices">
        {oldPrice && priceChanged && <div className="poster-old"><span>{Number(oldPrice).toFixed(2)}</span><small> TL</small><i/></div>}
        <div className="poster-new"><strong>{newPrice ? Number(newPrice).toFixed(2) : '00.00'}</strong><span> TL</span></div>
        {discountPercent > 0 && <div className="poster-discount">%{discountPercent}<br/><b>İNDİRİM</b></div>}
      </div>
      {note && <div className="poster-note">{note}</div>}
      <div className="poster-bottom">{subtitle || 'SADECE BU HAFTA'}</div>
    </div>
  </article>;
}
