export type ReceiptDesign = {
  paperWidth: '58mm' | '80mm';
  title: string;
  showStoreName: boolean;
  showPhone: boolean;
  showAddress: boolean;
  showReceiptNo: boolean;
  showDate: boolean;
  showUnitPrice: boolean;
  showCustomer: boolean;
  showPayment: boolean;
  showFooter: boolean;
  fontScale: number;
  alignment: 'center' | 'left';
};

export const DEFAULT_RECEIPT_DESIGN: ReceiptDesign = {
  paperWidth: '80mm',
  title: 'SATIŞ FİŞİ',
  showStoreName: true,
  showPhone: true,
  showAddress: true,
  showReceiptNo: true,
  showDate: true,
  showUnitPrice: true,
  showCustomer: true,
  showPayment: true,
  showFooter: true,
  fontScale: 1,
  alignment: 'center',
};

const STORAGE_KEY = 'silopi-dijital-receipt-design-v1';

export function loadReceiptDesign(): ReceiptDesign {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RECEIPT_DESIGN;
    const parsed = JSON.parse(raw) as Partial<ReceiptDesign>;
    return {
      ...DEFAULT_RECEIPT_DESIGN,
      ...parsed,
      paperWidth: parsed.paperWidth === '58mm' ? '58mm' : '80mm',
      fontScale: Math.min(1.25, Math.max(0.8, Number(parsed.fontScale) || 1)),
      alignment: parsed.alignment === 'left' ? 'left' : 'center',
    };
  } catch {
    return DEFAULT_RECEIPT_DESIGN;
  }
}

export function saveReceiptDesign(design: ReceiptDesign) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
  window.dispatchEvent(new CustomEvent('silopi-dijital-receipt-design-change'));
}
