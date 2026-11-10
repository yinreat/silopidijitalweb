import type { ReceiptDesign } from '@/lib/receiptDesign';
import { formatCurrency } from '@/lib/utils';

export type ReceiptLineItem = {
  product_name: string;
  quantity: number;
  unit_price?: number | null;
  subtotal: number;
};

type Props = {
  storeName: string;
  storePhone?: string;
  storeAddress?: string;
  receiptFooter?: string;
  design: ReceiptDesign;
  title?: string;
  receiptNo: string;
  createdAt: string;
  items: ReceiptLineItem[];
  total: number;
  discountTotal?: number;
  paymentLabel?: string;
  customerName?: string | null;
  changeDue?: number;
  offlinePending?: boolean;
};

export default function ReceiptLayout({
  storeName, storePhone, storeAddress, receiptFooter, design, title, receiptNo,
  createdAt, items, total, discountTotal = 0, paymentLabel, customerName,
  changeDue, offlinePending = false,
}: Props) {
  const align = design.alignment === 'left' ? 'left' : 'center';
  const scale = design.fontScale;
  return <div className="receipt-layout" style={{ fontFamily: 'Arial, Helvetica, sans-serif', fontSize: `${12 * scale}px`, textAlign: align }}>
    <header className="mb-3 border-b border-dashed border-slate-400 pb-3" style={{ textAlign: align }}>
      {design.showStoreName && <h2 className="text-xl font-black leading-tight tracking-tight">{storeName || 'Mağaza'}</h2>}
      {design.showPhone && storePhone && <p className="mt-1 text-xs">Tel: {storePhone}</p>}
      {design.showAddress && storeAddress && <p className="mt-1 text-[11px] leading-snug">{storeAddress}</p>}
      <p className="mt-2 text-sm font-extrabold tracking-wide">{title || design.title || 'SATIŞ FİŞİ'}</p>
      {design.showReceiptNo && <p className="mt-1 text-[11px]">Fiş No: {receiptNo}</p>}
      {design.showDate && <p className="mt-1 text-[11px]">{new Date(createdAt).toLocaleString('tr-TR')}</p>}
      <p className={`mt-2 text-[11px] font-bold ${offlinePending ? 'text-amber-700' : 'text-emerald-700'}`}>{offlinePending ? 'ÇEVRİMDIŞI · SENKRONİZASYON BEKLİYOR' : 'SATIŞ TAMAMLANDI'}</p>
    </header>

    <div className="space-y-2 text-left">
      {items.map((item, index) => <div key={`${item.product_name}-${index}`} className="border-b border-dotted border-slate-300 pb-2">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 break-words font-semibold">{item.quantity} × {item.product_name}</span>
          <span className="shrink-0 text-right font-bold">{formatCurrency(Number(item.subtotal || 0))}</span>
        </div>
        {design.showUnitPrice && <p className="mt-0.5 text-[10px] text-slate-600">Birim fiyat: {formatCurrency(Number(item.unit_price || 0))}</p>}
      </div>)}
    </div>

    <section className="mt-3 border-t border-dashed border-slate-500 pt-3 text-left">
      {discountTotal > 0 && <div className="mb-1 flex justify-between gap-2 text-xs"><span>İndirim</span><span>-{formatCurrency(discountTotal)}</span></div>}
      <div className="flex items-center justify-between gap-2 text-lg font-black"><span>TOPLAM</span><span>{formatCurrency(total)}</span></div>
      {design.showPayment && paymentLabel && <div className="mt-1 flex justify-between gap-2 text-xs"><span>Ödeme</span><b>{paymentLabel}</b></div>}
      {design.showCustomer && customerName && <div className="mt-1 flex justify-between gap-2 text-xs"><span>Müşteri</span><b className="text-right">{customerName}</b></div>}
      {typeof changeDue === 'number' && changeDue > 0 && <div className="mt-1 flex justify-between gap-2 text-xs"><span>Para üstü</span><b>{formatCurrency(changeDue)}</b></div>}
    </section>

    {design.showFooter && receiptFooter && <footer className="mt-4 border-t border-dashed border-slate-400 pt-3 text-[11px] leading-snug">{receiptFooter}</footer>}
  </div>;
}
