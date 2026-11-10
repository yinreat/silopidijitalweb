import { useRef, useState } from 'react';
import { Database, Download, Upload, CloudDownload, ShieldCheck, AlertTriangle, LoaderCircle, HardDrive } from 'lucide-react';
import { cloudSupabase } from '@/lib/supabase';
import { getLicenseState } from '@/lib/license';
import { usePromptDialog } from '@/components/PromptDialog';

const TABLES = [
  'categories','products','customers','sales','sale_items','customer_payments','cash_sessions',
  'sale_payments','stock_movements','sale_returns','audit_logs','product_price_history','store_settings',
  'suppliers','purchase_receipts','purchase_receipt_items','supplier_payments','staff_earnings',
  'staff_daily_earnings','staff_consumptions','staff_payouts','cash_reconciliations','cash_iban_exchanges',
  'stock_counts','stock_count_items','customer_debt_adjustments',
];

function toBase64(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export default function LocalDataBootstrap({ onReady }: { onReady: () => void }) {
  const { prompt: askPrompt, dialog: promptDialog } = usePromptDialog();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function importCloudData() {
    const license = getLicenseState();
    if (!license?.businessId) { setFailure('Lisanslı işletme kimliği bulunamadı. Önce lisansı doğrulayın.'); return; }
    setBusy(true); setFailure(''); setMessage('Buluttaki işletme kayıtları okunuyor; henüz yerel veriye yazılmıyor...');
    try {
      const data: Record<string, any[]> = {};
      for (const table of TABLES) {
        const all: any[] = [];
        let offset = 0;
        while (true) {
          let rows: any[] | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            const result = await cloudSupabase.from(table).select('*').range(offset, offset + 499);
            if (!result.error) {
              rows = result.data || [];
              break;
            }
            const status = Number((result.error as { status?: number }).status || 0);
            const retryable = status === 0 || status >= 500 || /network|fetch|timeout|transaction|something went wrong/i.test(result.error.message || '');
            if (!retryable || attempt === 2) {
              throw new Error(`${table} tablosu okunamadı${status ? ` (HTTP ${status})` : ''}: ${result.error.message}`);
            }
            setMessage(`${table} tablosu geçici hata verdi; güvenli yeniden deneme ${attempt + 2}/3...`);
            await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
          all.push(...(rows || []));
          if (!rows || rows.length < 500) break;
          offset += 500;
          if (offset > 250000) throw new Error(`${table} için güvenlik sınırı aşıldı; aktarım durduruldu.`);
        }
        data[table] = all;
        setMessage(`${table}: ${all.length} kayıt hazırlandı...`);
      }
      // Staff is intentionally NOT fetched directly from the table: it may contain
      // legacy PIN/hash columns. Only the server-validated safe response is imported.
      const staffResult = await cloudSupabase.functions.invoke('propos-staff-api', { body: { action: 'list' } });
      if (staffResult.error || staffResult.data?.error || !Array.isArray(staffResult.data?.data)) {
        throw new Error(`Personel listesi aktarım için alınamadı: ${staffResult.error?.message || staffResult.data?.message || 'Geçersiz yanıt'}`);
      }
      data.staff = staffResult.data.data;
      setMessage('Tüm tablolar okundu. Yerel veritabanına atomik aktarım yapılıyor...');
      const result = await window.proposDesktop?.db?.importRows({ businessId: license.businessId, data, mode: 'replace' });
      if (!result?.ok) throw new Error(result?.error || 'Yerel veritabanına aktarım başarısız.');
      setMessage(`Aktarım tamamlandı: ${result.recordCount ?? '—'} kayıt yerel veritabanına kaydedildi.`);
      onReady();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Bulut aktarımı tamamlanamadı.');
      setMessage('Hiçbir bulut kaydı yerel veritabanına aktarılmadı; tekrar deneyebilir veya yedek kullanabilirsin.');
    } finally { setBusy(false); }
  }

  async function restoreFile(file: File) {
    const license = getLicenseState();
    if (!license?.businessId) { setFailure('Lisanslı işletme kimliği bulunamadı.'); return; }
    setBusy(true); setFailure(''); setMessage('Yedek dosyası okunuyor...');
    try {
      const buffer = await file.arrayBuffer();
      if (file.name.toLowerCase().endsWith('.proposbackup')) {
        const password = await askPrompt('Şifreli Silopi Dijital yedeğinin parolasını gir:', { title: 'Yedek Parolası', inputType: 'password', placeholder: 'Yedek parolası', confirmLabel: 'Geri yükle', required: true });
        if (password === null || password.length === 0) throw new Error('Parola girilmedi; mevcut veriler değiştirilmedi.');
        const result = await window.proposDesktop?.db?.importBackup(toBase64(buffer), password, 'replace');
        if (!result?.ok) throw new Error(result?.error || 'Yedek geri yüklenemedi.');
        setMessage(`Şifreli yedek geri yüklendi: ${result.recordCount ?? '—'} kayıt.`);
        onReady();
        return;
      }
      if (file.name.toLowerCase().endsWith('.json')) {
        const payload = JSON.parse(new TextDecoder().decode(buffer));
        if (!payload?.data || typeof payload.data !== 'object') throw new Error('Geçerli bir eski ProPOS JSON yedeği değil.');
        const allowed = Object.fromEntries(Object.entries(payload.data).filter(([key, value]) => TABLES.includes(key) && Array.isArray(value)));
        if (!Object.keys(allowed).length) throw new Error('Yedekte desteklenen ProPOS tablosu bulunamadı.');
        if (!window.confirm('Bu eski JSON yedeği yerel işletme verilerini değiştirecek. Önceki veriler bulutta silinmeyecek. Devam edilsin mi?')) throw new Error('Geri yükleme iptal edildi.');
        const result = await window.proposDesktop?.db?.importRows({ businessId: license.businessId, data: allowed, mode: 'replace' });
        if (!result?.ok) throw new Error(result?.error || 'JSON yedeği geri yüklenemedi.');
        setMessage(`Eski sürüm yedeği yerel veritabanına aktarıldı: ${result.recordCount ?? '—'} kayıt.`);
        onReady();
        return;
      }
      throw new Error('Yedek dosyası .proposbackup veya eski biçim .json olmalı.');
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Yedek geri yüklenemedi.');
    } finally { setBusy(false); }
  }

  async function startEmpty() {
    const typed = await askPrompt('Yeni boş yerel başlangıcı onaylamak için BOS BASLAT yaz. Bu seçenek buluttaki geçmiş kayıtları aktarmaz veya silmez.', { title: 'Boş Yerel Başlangıç', placeholder: 'BOS BASLAT', confirmLabel: 'Başlat', required: true });
    if (typed !== 'BOS BASLAT') { setMessage('Boş başlangıç iptal edildi.'); return; }
    setBusy(true); setFailure(''); setMessage('Yerel işletme veritabanı hazırlanıyor...');
    try {
      const result = await window.proposDesktop?.db?.startEmpty();
      if (!result?.ok) throw new Error(result?.error || 'Yerel veritabanı hazırlanamadı.');
      setMessage('Yerel veritabanı hazır. Buluttaki eski kayıtlar değiştirilmedi.');
      onReady();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Yerel başlangıç başarısız.');
    } finally { setBusy(false); }
  }

  return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
    <div className="w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl">
      <div className="bg-slate-900 px-7 py-6 text-white">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-teal-600"><Database size={25}/></div>
        <h1 className="text-2xl font-black tracking-tight">Silopi Dijital - ProPOS Yerel Veri Kurulumu</h1>
        <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">Lisans ve giriş Supabase üzerinden doğrulanır. Ürün, satış, stok, cari ve kasa kayıtları bu bilgisayarın SQLite veritabanında tutulur.</p>
      </div>
      <div className="space-y-4 p-6 sm:p-7">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-5 text-slate-600">Yerel SQLite dosyası bu Windows kullanıcı profiline kaydedilir. Bilgisayar hesabını ve ekran kilidini koru. USB'ye alınan yedek ayrıca parolayla şifrelenir.</div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900"><div className="mb-1 flex items-center gap-2 font-bold"><AlertTriangle size={17}/> İlk kurulum gerekiyor</div>Bu bilgisayarda tamamlanmış bir yerel veri kurulumu bulunamadı. Önce mevcut bulut verilerini aktarmanı veya yedeğini geri yüklemeni öneriyoruz. Bulut aktarımı hata verirse uygulama otomatik olarak boş veriyle başlamaz.</div>
        <button disabled={busy} onClick={importCloudData} className="flex w-full items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-left hover:bg-teal-100 disabled:opacity-50">
          <CloudDownload size={23} className="mt-0.5 shrink-0 text-teal-700"/><span><strong className="block text-slate-900">Mevcut bulut verilerini yerel bilgisayara aktar</strong><span className="mt-1 block text-sm leading-5 text-slate-600">Ürün, müşteri, satış, stok hareketi, kasa, personel ve cari kayıtlarını önce okur; tamamı okunmadan yerel veritabanına yazmaz.</span></span>
        </button>
        <button disabled={busy} onClick={()=>fileRef.current?.click()} className="flex w-full items-start gap-3 rounded-xl border border-slate-200 p-4 text-left hover:bg-slate-50 disabled:opacity-50">
          <Upload size={23} className="mt-0.5 shrink-0 text-slate-600"/><span><strong className="block text-slate-900">Yedek dosyasından geri yükle</strong><span className="mt-1 block text-sm leading-5 text-slate-600">Şifreli USB yedeği (.proposbackup) veya önceki ProPOS JSON yedeği (.json).</span></span>
        </button>
        <input ref={fileRef} type="file" accept=".proposbackup,.json,application/json" className="hidden" disabled={busy} onChange={e=>{const f=e.currentTarget.files?.[0]; if(f) void restoreFile(f); e.currentTarget.value='';}}/>
        <button disabled={busy} onClick={startEmpty} className="flex w-full items-start gap-3 rounded-xl border border-slate-200 p-4 text-left hover:bg-slate-50 disabled:opacity-50">
          <HardDrive size={23} className="mt-0.5 shrink-0 text-slate-600"/><span><strong className="block text-slate-900">Yeni boş yerel işletme başlat</strong><span className="mt-1 block text-sm leading-5 text-slate-600">Yalnızca gerçekten yeni bir başlangıç istiyorsan seç. Buluttaki eski kayıtları silmez fakat onları bu bilgisayara aktarmış olmaz.</span></span>
        </button>
        {busy && <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600"><LoaderCircle size={17} className="animate-spin"/>{message || 'İşlem yapılıyor...'}</div>}
        {!busy && message && <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div>}
        {failure && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-5 text-red-700">HATA: {failure}</div>}
        <p className="flex items-start gap-2 border-t border-slate-100 pt-4 text-xs leading-5 text-slate-500"><ShieldCheck size={16} className="mt-0.5 shrink-0"/> Bu işlem senin kendi ProPOS veritabanına dokunmaz. İlk aktarım/geri yükleme yarıda kalırsa mevcut yerel kayıtlar korunur.</p>
      </div>
    </div>
    {promptDialog}
  </div>;
}
