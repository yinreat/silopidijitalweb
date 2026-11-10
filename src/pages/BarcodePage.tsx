import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Printer, X, Plus, Barcode as BarcodeIcon, Camera, Tag, Percent } from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { loadStoreSettings, useProducts } from '@/lib/hooks';
import { formatCurrency } from '@/lib/utils';
import type { Product } from '@/lib/supabase';
import BarcodeScanner from '@/components/BarcodeScanner';

type LayoutType = 'economic' | 'compact' | 'standard' | 'large';
type PrinterMode = 'a4' | 'direct';
type LabelMode = 'barcode' | 'simple';

type LayoutConfig = {
  label: string;
  perSheet: number;
  width: string;
  height: string;
  cols: number;
  rows: number;
  nameSize: number;
  priceSize: number;
  barcodeHeight: number;
  barcodeWidth: number;
  barcodeFontSize: number;
  dateSize: number;
};

type SelectedProduct = {
  product: Product;
  copies: number;
  discountEnabled: boolean;
  oldPrice: number;
  newPrice: number;
};

const LAYOUTS: Record<LayoutType, LayoutConfig> = {
  economic: {
    label: 'Ekonomik · 3 sütun × 9 satır', perSheet: 27, width: '64.5mm', height: '32mm', cols: 3, rows: 9,
    nameSize: 8.5, priceSize: 23, barcodeHeight: 21, barcodeWidth: 1.8, barcodeFontSize: 8, dateSize: 5.8,
  },
  compact: {
    label: '80 × 30 mm', perSheet: 18, width: '80mm', height: '30mm', cols: 2, rows: 9,
    nameSize: 9.8, priceSize: 24, barcodeHeight: 17, barcodeWidth: 1.75, barcodeFontSize: 8.5, dateSize: 6.6,
  },
  standard: {
    label: '100 × 38 mm', perSheet: 14, width: '100mm', height: '38mm', cols: 2, rows: 7,
    nameSize: 11.5, priceSize: 31, barcodeHeight: 23, barcodeWidth: 1.95, barcodeFontSize: 9, dateSize: 7,
  },
  large: {
    label: '100 × 50 mm', perSheet: 10, width: '100mm', height: '50mm', cols: 2, rows: 5,
    nameSize: 13, priceSize: 39, barcodeHeight: 28, barcodeWidth: 2.2, barcodeFontSize: 10, dateSize: 7.4,
  },
};

const MARKET_BARCODE_SIZING: Record<LayoutType, Pick<LayoutConfig, 'nameSize' | 'priceSize' | 'barcodeHeight' | 'barcodeWidth' | 'barcodeFontSize' | 'dateSize'>> = {
  economic: { nameSize: 8.5, priceSize: 23, barcodeHeight: 43, barcodeWidth: 0.92, barcodeFontSize: 7.2, dateSize: 5.4 },
  compact: { nameSize: 9.8, priceSize: 24, barcodeHeight: 42, barcodeWidth: 0.95, barcodeFontSize: 7.6, dateSize: 6.6 },
  standard: { nameSize: 11.5, priceSize: 31, barcodeHeight: 54, barcodeWidth: 1.05, barcodeFontSize: 8.4, dateSize: 7 },
  large: { nameSize: 13, priceSize: 39, barcodeHeight: 68, barcodeWidth: 1.15, barcodeFontSize: 9.2, dateSize: 7.2 },
};

function discountPercent(oldPrice: number, newPrice: number) {
  if (oldPrice <= 0 || newPrice >= oldPrice) return 0;
  return Math.round(((oldPrice - newPrice) / oldPrice) * 100);
}

function isValidEan13(value: string) {
  if (!/^\d{13}$/.test(value)) return false;
  const digits = value.slice(0, 12).split('').map(Number);
  const sum = digits.reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === Number(value[12]);
}

function createBarcode(ref: SVGSVGElement | null, value: string | null | undefined, config: LayoutConfig, scale = 1) {
  if (!ref) return;
  ref.replaceChildren();
  if (!value?.trim()) return;
  try {
    JsBarcode(ref, value.trim(), {
      format: isValidEan13(value.trim()) ? 'EAN13' : 'CODE128',
      width: config.barcodeWidth * scale,
      height: config.barcodeHeight * scale,
      displayValue: true,
      fontSize: config.barcodeFontSize * scale,
      margin: 0,
      textMargin: 1 * scale,
    });
  } catch (error) {
    console.error('Barkod oluşturulamadı:', error);
  }
}

export default function BarcodePage() {
  const { products, loading } = useProducts();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<SelectedProduct[]>([]);
  const [layout, setLayout] = useState<LayoutType>('economic');
  const [printerMode, setPrinterMode] = useState<PrinterMode>('a4');
  const [labelMode, setLabelMode] = useState<LabelMode>('barcode');
  const [showScanner, setShowScanner] = useState(false);
  const [storeName, setStoreName] = useState('Mağazam');

  useEffect(() => {
    let active = true;
    const defaults = { storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: '', taxRate: '0', lowStockDefault: '0' };
    void loadStoreSettings(defaults).then((settings) => {
      if (active) setStoreName(settings.storeName?.trim() || 'Mağazam');
    });
    return () => { active = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p) => p.name.toLowerCase().includes(q) || (p.barcode || '').toLocaleLowerCase('tr-TR').includes(q) || (p.additional_barcodes || []).some(code => code.toLocaleLowerCase('tr-TR').includes(q)));
  }, [products, search]);

  const totalLabels = selected.reduce((sum, item) => sum + item.copies, 0);
  const sheetsNeeded = Math.ceil(totalLabels / LAYOUTS[layout].perSheet);
  const discountedCount = selected.filter((item) => item.discountEnabled && item.oldPrice > item.newPrice).length;
  const currentLayout = labelMode === 'barcode'
    ? { ...LAYOUTS[layout], ...MARKET_BARCODE_SIZING[layout] }
    : LAYOUTS[layout];

  function addProduct(product: Product) {
    if (!product.barcode && labelMode !== 'simple') return;
    setSelected((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) => item.product.id === product.id ? { ...item, copies: item.copies + 1 } : item);
      }
      return [...prev, {
        product,
        copies: 1,
        discountEnabled: false,
        oldPrice: Number(product.price),
        newPrice: Number(product.price),
      }];
    });
  }

  function updateItem(id: string, patch: Partial<Omit<SelectedProduct, 'product'>>) {
    setSelected((prev) => prev.map((item) => item.product.id === id ? { ...item, ...patch } : item));
  }

  function handleBarcodeDetected(code: string) {
    const normalized = code.trim();
    const match = products.find((p) => (p.barcode || '').trim() === normalized || (p.additional_barcodes || []).some(code => code.trim() === normalized));
    if (match) {
      addProduct(match);
      setSearch('');
      setShowScanner(false);
    } else {
      setSearch(normalized);
    }
  }

  function updateCopies(id: string, delta: number) {
    setSelected((prev) => prev.map((item) => item.product.id === id
      ? { ...item, copies: Math.max(1, item.copies + delta) }
      : item));
  }

  function printSelectedLabels() {
    if (!selected.length) return;
    document.body.classList.add('label-printer-printing');
    const cleanup = () => document.body.classList.remove('label-printer-printing');
    window.addEventListener('afterprint', cleanup, { once: true });
    // Allow the portaled print area and print-only CSS to settle before opening
    // Chromium/Electron's print dialog.
    window.requestAnimationFrame(() => {
      window.focus();
      window.print();
    });
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Barkod & İndirim Etiketi</h1>
            <p className="text-sm text-slate-500">{printerMode === 'a4' ? 'A4 etiket kâğıdına ekonomik market etiketi basın.' : 'Rulo yazıcı için seçilen ölçüde tek etiketli sayfalar hazırlayın.'}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-600">
              {printerMode === 'direct' ? `${totalLabels} etiket · ${totalLabels} rulo sayfası` : `${totalLabels} etiket · ${sheetsNeeded || 0} A4 sayfa`}
            </div>
            {discountedCount > 0 && (
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">
                {discountedCount} indirimli ürün
              </div>
            )}
            <button onClick={() => setSelected([])} disabled={selected.length === 0} className="btn-secondary px-3 py-2">
              Temizle
            </button>
            <button onClick={printSelectedLabels} disabled={selected.length === 0} className="btn-primary px-4 py-2">
              <Printer size={17} />
              {printerMode === 'a4' ? 'A4 Etiket Kağıdına Yazdır' : 'Etiket Yazıcısına Yazdır'}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-slate-600">Etiket ölçüsü:</span>
          <span className="mr-1 text-sm font-medium text-slate-600">Etiket türü:</span>
          <button onClick={() => setLabelMode('barcode')} className={`rounded-lg px-3 py-1.5 text-sm font-bold ${labelMode === 'barcode' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>Barkodlu etiket</button>
          <button onClick={() => setLabelMode('simple')} className={`rounded-lg px-3 py-1.5 text-sm font-bold ${labelMode === 'simple' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>Barkodsuz fiyat etiketi</button>
          {(Object.keys(LAYOUTS) as LayoutType[]).map((key) => (
            <button
              key={key}
              onClick={() => setLayout(key)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${layout === key ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
            >
              {LAYOUTS[key].label}
            </button>
          ))}
          <span className="ml-1 text-xs text-slate-400">{printerMode === 'a4' ? `${LAYOUTS[layout].cols} sütun × ${LAYOUTS[layout].rows} satır · A4` : `${LAYOUTS[layout].width} × ${LAYOUTS[layout].height} · her etikete bir sayfa`}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
          <span className="mr-1 text-sm font-semibold text-slate-700">Yazıcı türü:</span>
          <button onClick={() => setPrinterMode('a4')} className={`rounded-lg px-3 py-2 text-sm font-bold ${printerMode === 'a4' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}>A4 etiket kâğıdı</button>
          <button onClick={() => setPrinterMode('direct')} className={`rounded-lg px-3 py-2 text-sm font-bold ${printerMode === 'direct' ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}>Rulo etiket yazıcısı</button>
          <p className="basis-full text-xs text-slate-500">Rulo modunda her etiket seçilen gerçek ölçüde ayrı sayfa olarak gönderilir. Yazdır penceresinde etiket yazıcını ve aynı ölçüde kâğıt boyutunu seç.</p>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <div className="flex w-1/2 min-w-0 flex-col overflow-hidden border-r border-slate-200">
          <div className="border-b border-slate-200 bg-white p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                className="input pl-10 pr-12"
                placeholder="Ürün ara veya barkod okut..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && search.trim()) {
                    const match = products.find((p) => (p.barcode || '').trim() === search.trim() || (p.additional_barcodes || []).some(code => code.trim() === search.trim()));
                    if (match) { addProduct(match); setSearch(''); }
                  }
                }}
              />
              <button onClick={() => setShowScanner(true)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-2 text-teal-600 hover:bg-teal-50" title="Barkod okut">
                <Camera size={19} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? <div className="py-12 text-center text-slate-400">Ürünler yükleniyor...</div> : filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-400"><BarcodeIcon size={42} /><p>Ürün bulunamadı</p></div>
            ) : (
              <div className="space-y-2">
                {filtered.map((product) => (
                  <button key={product.id} onClick={() => addProduct(product)} disabled={!product.barcode && labelMode !== 'simple'} className="card flex w-full items-center gap-3 p-3 text-left hover:border-teal-400 hover:shadow-md disabled:opacity-40">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-slate-100"><BarcodeIcon size={19} className="text-slate-500" /></div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-800">{product.name}</p>
                      <p className="font-mono text-xs text-slate-400">{product.barcode || (labelMode === 'simple' ? 'Barkodsuz fiyat etiketi' : 'Barkod yok · Barkodsuz moda geçin')}</p>
                    </div>
                    <span className="font-bold text-teal-700">{formatCurrency(product.price)}</span>
                    <Plus size={18} className="text-teal-500" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex w-1/2 min-w-0 flex-col overflow-hidden">
          <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm font-semibold text-slate-700">Etiket ayarları</p>
            <p className="text-xs text-slate-500">Barkodsuz fiyat etiketinde yalnızca mağaza adı, ürün adı ve büyük satış fiyatı basılır. Ürün satış fiyatı değiştirilmez.</p>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selected.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-400">
                <Tag size={46} /><p className="text-sm">Soldan ürün seçerek etiket hazırlayın</p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {selected.map((item) => {
                    const percent = discountPercent(item.oldPrice, item.newPrice);
                    const validDiscount = item.discountEnabled && item.oldPrice > item.newPrice && item.newPrice >= 0;
                    return (
                      <div key={item.product.id} className={`rounded-xl border p-3 ${validDiscount ? 'border-amber-300 bg-amber-50/50' : 'border-slate-200 bg-white'}`}>
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-slate-800">{item.product.name}</p>
                            <p className="font-mono text-xs text-slate-400">{item.product.barcode}</p>
                          </div>
                          <button onClick={() => setSelected((prev) => prev.filter((x) => x.product.id !== item.product.id))} className="text-slate-300 hover:text-red-500"><X size={18} /></button>
                        </div>
                        <div className="mt-3 grid grid-cols-[1fr_auto] gap-3">
                          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
                            <input type="checkbox" checked={item.discountEnabled} onChange={(e) => updateItem(item.product.id, { discountEnabled: e.target.checked })} />
                            <Percent size={16} /> İndirim etiketi
                          </label>
                          <div className="flex items-center gap-1">
                            <button onClick={() => updateCopies(item.product.id, -1)} className="h-8 w-8 rounded-md bg-slate-100">−</button>
                            <input className="h-8 w-14 rounded-md border border-slate-300 text-center text-sm" value={item.copies} onChange={(e) => updateItem(item.product.id, { copies: Math.max(1, Number(e.target.value) || 1) })} />
                            <button onClick={() => updateCopies(item.product.id, 1)} className="h-8 w-8 rounded-md bg-slate-100">+</button>
                          </div>
                        </div>
                        {item.discountEnabled && (
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div><label className="label text-xs">Eski fiyat</label><input type="number" min="0" step="0.01" className="input" value={item.oldPrice} onChange={(e) => updateItem(item.product.id, { oldPrice: Math.max(0, Number(e.target.value) || 0) })} /></div>
                            <div><label className="label text-xs">Yeni indirimli fiyat</label><input type="number" min="0" step="0.01" className="input font-bold" value={item.newPrice} onChange={(e) => updateItem(item.product.id, { newPrice: Math.max(0, Number(e.target.value) || 0) })} /></div>
                            <div className="col-span-2 text-right text-xs font-bold text-amber-700">{validDiscount ? `%${percent} indirim · ${formatCurrency(item.oldPrice - item.newPrice)} avantaj` : 'Eski fiyat yeni fiyattan büyük olmalı.'}</div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <div className="mb-2 flex items-center justify-between text-sm"><span className="font-medium text-slate-600">Canlı önizleme</span><span className="text-xs text-slate-400">Sarı kağıtta beyaz alan basılmaz, kağıt rengi görünür.</span></div>
                  <div className="flex justify-center overflow-auto rounded-lg border-2 border-dashed border-slate-200 p-4">
                    <PreviewLabel item={selected[0]} config={currentLayout} storeName={storeName} labelMode={labelMode} />
                  </div>
                </div>

                <div className="mt-3 rounded-lg bg-teal-50 p-3 text-xs text-teal-800">
                  <b>{totalLabels}</b> etiket · <b>{sheetsNeeded}</b> A4 sayfa. İndirimli etikette eski fiyat üstü çizilir, yeni fiyat büyük yazılır ve indirim yüzdesi gösterilir.
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {showScanner && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setShowScanner(false)} />}
      {createPortal(
        <div id="print-area" className={`barcode-print-root ${printerMode === 'direct' ? `print-direct-${layout}` : ''}`}>
          <PrintLayout selected={selected} config={currentLayout} storeName={storeName} direct={printerMode === 'direct'} labelMode={labelMode} />
        </div>,
        document.body,
      )}
    </div>
  );
}

function PrintLayout({ selected, config, storeName, direct = false, labelMode }: { selected: SelectedProduct[]; config: LayoutConfig; storeName: string; direct?: boolean; labelMode: LabelMode }) {
  const labels: SelectedProduct[] = [];
  selected.forEach((item) => { for (let i = 0; i < item.copies; i += 1) labels.push(item); });

  if (direct) return <div className="label-roll-list" style={{ display: 'flex', flexDirection: 'column', width: config.width, gap: 0 }}>
    {labels.map((item, index) => <div className="label-roll-item" key={`${item.product.id}-${index}`} style={{ width: config.width, height: config.height, pageBreakAfter: index === labels.length - 1 ? 'auto' : 'always', breakAfter: index === labels.length - 1 ? 'auto' : 'page' }}>
      <BarcodeLabel item={item} config={config} storeName={storeName} labelMode={labelMode} />
    </div>)}
  </div>;

  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(${config.cols}, ${config.width})`, gridAutoRows: config.height, columnGap: config.cols === 3 ? '1mm' : '0.8mm', rowGap: '0.8mm', width: config.cols === 3 ? '195.5mm' : '200.8mm' }}>
    {labels.map((item, index) => <BarcodeLabel key={`${item.product.id}-${index}`} item={item} config={config} storeName={storeName} labelMode={labelMode} />)}
  </div>;
}

function splitProductPackage(name: string) {
  const value = String(name || '').trim();
  const match = value.match(/^(.*?)[\s-]+(\d+(?:[.,]\d+)?\s*(?:KG|KİLOGRAM|KILOGRAM|GR|G|ML|L|LT|LİTRE|LITRE|CL|DL|MG))$/i);
  if (!match) return { title: value, packageText: '' };
  return {
    title: match[1].trim() || value,
    packageText: match[2].replace(/\s+/g, ' ').toLocaleUpperCase('tr-TR'),
  };
}

function formatLabelPrice(value: number) {
  return `${new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)} TL`;
}

function LabelContent({ item, config, svgRef, storeName, scale = 1, labelMode }: { item: SelectedProduct; config: LayoutConfig; svgRef: React.RefObject<SVGSVGElement>; storeName: string; scale?: number; labelMode: LabelMode }) {
  const percent = discountPercent(item.oldPrice, item.newPrice);
  const discounted = item.discountEnabled && item.oldPrice > item.newPrice && item.newPrice >= 0;
  const price = discounted ? item.newPrice : item.product.price;
  const { title, packageText } = splitProductPackage(item.product.name);
  const s = (v: number) => v * scale;
  const configuredStoreName = storeName?.trim() && storeName.trim().toLocaleLowerCase('tr-TR') !== 'mağazam'
    ? storeName.trim()
    : '';
  const priceText = formatLabelPrice(price);
  const labelWidthPx = (Number.parseFloat(config.width) * 96) / 25.4;
  const contentWidthPx = Math.max(60, labelWidthPx - 18);
  const priceColumnWidthPx = labelMode === 'barcode' ? contentWidthPx * 0.58 : contentWidthPx;
  const titleFontSize = Math.max(9, Math.min(config.nameSize * 1.8, contentWidthPx / Math.max(12, title.length * 0.62)));
  const priceFontSize = labelMode === 'barcode'
    ? Math.max(18, Math.min(36, config.priceSize * 1.35, priceColumnWidthPx / (priceText.length * 0.62)))
    : Math.max(22, Math.min(43, config.priceSize * 1.75, priceColumnWidthPx / (priceText.length * 0.62)));

  const brandStyle: React.CSSProperties = {
    alignSelf: 'flex-end',
    flex: '0 0 auto',
    color: '#555',
    fontSize: s(4.8),
    fontWeight: 800,
    letterSpacing: '.12em',
    lineHeight: 1,
    whiteSpace: 'nowrap',
  };

  return <div style={{
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
    overflow: 'hidden',
    padding: `${s(0.6)}px ${s(1)}px ${s(0.5)}px`,
    color: '#080808',
    fontFamily: 'Arial, Helvetica, sans-serif',
  }}>
    {configuredStoreName && <div style={{
      alignSelf: 'flex-start',
      maxWidth: '70%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      color: '#444',
      fontSize: s(5.2),
      fontWeight: 700,
      lineHeight: 1,
      marginBottom: s(1),
    }}>{configuredStoreName}</div>}

    <div style={{
      width: '100%',
      textAlign: 'center',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: s(titleFontSize),
      fontWeight: 950,
      letterSpacing: '.015em',
      lineHeight: 1.02,
      textTransform: 'uppercase',
    }}>{title}</div>

    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: s(3),
      width: '100%',
      marginTop: s(2),
      marginBottom: s(1),
      minHeight: s(10),
      lineHeight: 1,
    }}>
      <span style={{ flex: 1, minWidth: 0, borderTop: `${s(1)}px solid #111` }} />
      {packageText && <strong style={{ flex: '0 0 auto', fontSize: s(Math.max(8, config.nameSize * 0.92)), fontWeight: 900, whiteSpace: 'nowrap' }}>{packageText}</strong>}
      <span style={{ flex: 1, minWidth: 0, borderTop: `${s(1)}px solid #111` }} />
    </div>

    <div style={{
      display: 'flex',
      flex: '1 1 auto',
      minHeight: 0,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      gap: labelMode === 'barcode' ? 0 : s(2),
    }}>
      <div style={{
        display: 'flex',
        flex: labelMode === 'barcode' ? '0 0 58%' : '1 1 100%',
        minWidth: 0,
        height: '100%',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        overflow: 'hidden',
      }}>
        {discounted && <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: s(2),
          maxWidth: '100%',
          marginBottom: s(1),
          color: '#4b5563',
          fontSize: s(Math.max(7, config.nameSize * 0.78)),
          fontWeight: 800,
          whiteSpace: 'nowrap',
        }}>
          <span style={{ textDecoration: 'line-through' }}>{formatLabelPrice(item.oldPrice)}</span>
          <span>%{percent} İNDİRİM</span>
        </div>}
        <strong style={{
          maxWidth: '100%',
          fontSize: s(priceFontSize),
          fontWeight: 950,
          letterSpacing: '-.055em',
          lineHeight: 0.92,
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums',
        }}>{priceText}</strong>
      </div>

      {labelMode === 'barcode' && <div style={{
        display: 'flex',
        flex: '0 0 42%',
        minWidth: 0,
        height: '88%',
        alignItems: 'center',
        justifyContent: 'center',
        borderLeft: `${s(1)}px solid #111`,
        paddingLeft: s(2),
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}>
        <svg ref={svgRef} style={{
          display: 'block',
          width: '100%',
          maxWidth: '100%',
          height: `${config.barcodeHeight}px`,
          maxHeight: '100%',
        }} />
      </div>}
    </div>

    <div style={brandStyle}>SİLOPİDİJİTAL</div>
  </div>;
}

function BarcodeLabel({ item, config, storeName, labelMode }: { item: SelectedProduct; config: LayoutConfig; storeName: string; labelMode: LabelMode }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => { if (labelMode === 'barcode') createBarcode(ref.current, item.product.barcode, config, 1); }, [item.product.barcode, config, labelMode]);

  return <div style={{ position: 'relative', width: config.width, height: config.height, boxSizing: 'border-box', padding: '1.2mm 1.5mm 0.8mm', border: labelMode === 'simple' ? '0.35mm solid #111827' : '1px solid #111', overflow: 'hidden', pageBreakInside: 'avoid', breakInside: 'avoid', background: 'transparent' }}>
    <LabelContent item={item} config={config} svgRef={ref} storeName={storeName} labelMode={labelMode} />
  </div>;
}

function PreviewLabel({ item, config, storeName, labelMode }: { item: SelectedProduct; config: LayoutConfig; storeName: string; labelMode: LabelMode }) {
  const scale = 1.55;
  return <div className="barcode-preview-label" style={{
    width: `${Number.parseFloat(config.width) * scale}mm`,
    height: `${Number.parseFloat(config.height) * scale}mm`,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto',
  }}>
    <div style={{ width: config.width, height: config.height, transform: `scale(${scale})`, transformOrigin: 'center center', flex: '0 0 auto' }}>
      <BarcodeLabel item={item} config={config} storeName={storeName} labelMode={labelMode} />
    </div>
  </div>;
}
