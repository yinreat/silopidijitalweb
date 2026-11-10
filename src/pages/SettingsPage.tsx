import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Store, Save, Info, Database, Monitor, Trash2, AlertTriangle, X, Check, Upload, Download, RefreshCw, Palette } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { cleanupExpiredTrash, loadStoreSettings, saveStoreSettings } from '@/lib/hooks';
import { usePromptDialog } from '@/components/PromptDialog';
import ThemeColorPicker from '@/components/ThemeColorPicker';
import { DEFAULT_BRAND_COLOR, getBrandColor, setBrandColor } from '@/lib/theme';
import { IS_OWNER_EDITION } from '@/lib/edition';

type AppSettings = {
  storeName: string;
  storeAddress: string;
  storePhone: string;
  currency: string;
  receiptFooter: string;
  taxRate: string;
  lowStockDefault: string;
  trashRetentionDays: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  storeName: 'Mağazam',
  storeAddress: '',
  storePhone: '',
  currency: 'TRY',
  receiptFooter: 'Bizi tercih ettiğiniz için teşekkürler!',
  taxRate: '0',
  lowStockDefault: '0',
  trashRetentionDays: '1',
};

const STORAGE_KEY = 'pos-settings';

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export { loadSettings, saveSettings };
export type { AppSettings };


async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i=0; i<bytes.length; i+=0x8000) binary += String.fromCharCode(...bytes.subarray(i, i+0x8000));
  return btoa(binary);
}

export default function SettingsPage() {
  const { prompt: askPrompt, dialog: promptDialog } = usePromptDialog();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearStep, setClearStep] = useState<'idle' | 'confirm' | 'done' | 'error'>('idle');
  const [clearing, setClearing] = useState(false);
  const [brandColor, setBrandColorState] = useState(() => getBrandColor());
  const [rgbEnabled, setRgbEnabled] = useState(() => localStorage.getItem('silopidijital-rgb-enabled') === 'true');
  const [rgbSeconds, setRgbSeconds] = useState(() => Math.max(1, Math.min(60, Number(localStorage.getItem('silopidijital-rgb-seconds') || 5))));
  const [manualBrandColor, setManualBrandColor] = useState(() => localStorage.getItem('silopidijital-rgb-base-color') || getBrandColor());
  const [updateStatus, setUpdateStatus] = useState('Güncelleme durumu kontrol edilmedi.');
  const [updateState, setUpdateState] = useState('idle');
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateBusy, setUpdateBusy] = useState(false);
  const desktopVersion = window.proposDesktop?.version || window.proposDesktopVersion || 'Web/PWA';

  useEffect(() => {
    const updater = window.proposDesktop?.updates;
    if (!updater) { setUpdateStatus('Otomatik güncelleme yalnızca Windows masaüstü sürümünde kullanılabilir.'); return; }
    let unsubscribe: (() => void) | undefined;
    updater.status().then((status: any) => {
      if (status?.message) setUpdateStatus(status.message);
      if (status?.state) setUpdateState(status.state);
      if (typeof status?.percent === 'number') setUpdatePercent(status.percent);
    }).catch(() => {});
    unsubscribe = updater.onStatus((status: any) => {
      if (status?.message) setUpdateStatus(status.message);
      if (status?.state) setUpdateState(status.state);
      if (typeof status?.percent === 'number') setUpdatePercent(status.percent);
    });
    return () => unsubscribe?.();
  }, []);

  async function checkAppUpdates() {
    const updater = window.proposDesktop?.updates;
    if (!updater) { setUpdateStatus('Bu kontrol yalnız Windows masaüstü uygulamasında kullanılabilir.'); return; }
    setUpdateBusy(true); setUpdateStatus('Güncelleme kontrol ediliyor...');
    try {
      const result = await updater.check();
      if (result?.message) setUpdateStatus(result.message);
      if (result?.configured === false) setUpdateState('not-configured');
      else if (result?.ok) setUpdateState('checking');
      else setUpdateState('error');
    } catch (error) {
      setUpdateState('error'); setUpdateStatus(error instanceof Error ? error.message : 'Güncelleme kontrol edilemedi.');
    } finally { setUpdateBusy(false); }
  }

  async function downloadAppUpdate() {
    const updater = window.proposDesktop?.updates;
    if (!updater) return;
    setUpdateBusy(true);
    try { const result = await updater.download(); setUpdateStatus(result?.message || 'Güncelleme indiriliyor...'); if (!result?.ok) setUpdateState('error'); else setUpdateState('downloading'); }
    catch (error) { setUpdateState('error'); setUpdateStatus(error instanceof Error ? error.message : 'İndirme başlatılamadı.'); }
    finally { setUpdateBusy(false); }
  }

  async function installAppUpdate() {
    const updater = window.proposDesktop?.updates;
    if (!updater) return;
    const result = await updater.install();
    if (!result?.ok) setUpdateStatus(result?.message || 'Güncelleme kurulumu başlatılamadı.');
  }

  useEffect(() => {
    const local = loadSettings();
    setSettings(local);
    loadStoreSettings(DEFAULT_SETTINGS).then(remote => {
      const merged: AppSettings = { ...DEFAULT_SETTINGS, ...local, ...remote, trashRetentionDays: String((remote as AppSettings).trashRetentionDays ?? local.trashRetentionDays ?? '1') };
      setSettings(merged);
      saveSettings(merged);
    });
  }, []);

  function update<K extends keyof AppSettings>(key: K, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    saveSettings(settings);
    const savedResult = await saveStoreSettings(settings);
    const cleanup = await cleanupExpiredTrash(Number(settings.trashRetentionDays ?? '1'));
    if (cleanup.error) console.warn('Çöp kutusu otomatik temizliği tamamlanamadı:', cleanup.error);
    setSaved(true);
    setBackupStatus(window.proposDesktop?.db && !IS_OWNER_EDITION
      ? (savedResult ? 'Ayarlar bu bilgisayara kaydedildi.' : 'Ayarlar yerel veritabanına kaydedilemedi.')
      : (savedResult ? 'Ayarlar buluta kaydedildi.' : 'Ayarlar bu cihazda kaydedildi; bulut kaydı için bağlantıyı kontrol edin.'));
    setTimeout(() => setSaved(false), 2000);
  }

  function handleReset() {
    setSettings(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  }

  function handleBrandColorChange(color: string) {
    setManualBrandColor(color);
    localStorage.setItem('silopidijital-rgb-base-color', color);
    if (!rgbEnabled) { const next = setBrandColor(color); setBrandColorState(next); }
  }

  useEffect(() => {
    localStorage.setItem('silopidijital-rgb-enabled', String(rgbEnabled));
    localStorage.setItem('silopidijital-rgb-seconds', String(Math.max(1, Math.min(60, rgbSeconds))));
    localStorage.setItem('silopidijital-rgb-base-color', manualBrandColor);
    if (!rgbEnabled) setBrandColorState(setBrandColor(manualBrandColor));
    // AppContent owns the timer so RGB remains active when this page unmounts.
    window.dispatchEvent(new Event('silopidijital-rgb-settings-change'));
  }, [rgbEnabled, rgbSeconds, manualBrandColor]);


  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState('');
  const [restoreMode, setRestoreMode] = useState<'merge'|'missing'|'replace'>('missing');

  async function exportBackup() {
    setBackupBusy(true); setBackupStatus('Yedek hazırlanıyor...');
    if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
      try {
        const password = await askPrompt('Şifreli Silopi Dijital yedeği için en az 8 karakterli parola belirle:', { title: 'Şifreli Yedek Oluştur', inputType: 'password', placeholder: 'En az 8 karakter', confirmLabel: 'Devam Et', required: true });
        if (password === null || password.length === 0) { setBackupStatus('Yedekleme iptal edildi.'); return; }
        if (password.length < 8) throw new Error('Yedek parolası en az 8 karakter olmalı.');
        const confirmation = await askPrompt('Aynı yedek parolasını tekrar gir:', { title: 'Parolayı Doğrula', inputType: 'password', placeholder: 'Parolayı tekrarla', confirmLabel: 'Yedeği Oluştur', required: true });
        if (confirmation !== password) throw new Error('Parolalar eşleşmedi; yedek oluşturulmadı.');
        const result = await window.proposDesktop.db.exportBackup(password);
        if (result?.ok === false) throw new Error(result.error || 'Yedek dosyası kaydedilemedi.');
        if (result?.cancelled) { setBackupStatus('Dosya kaydetme iptal edildi.'); return; }
        const status = await window.proposDesktop.db.status();
        setBackupStatus(`Şifreli yedek kaydedildi: ${result.path || 'seçilen konum'} · ${status.recordCount ?? 0} kayıt. USB belleği güvenle çıkarabilirsin.`);
      } catch (err) {
        setBackupStatus(`HATA: ${err instanceof Error ? err.message : 'Şifreli yedek oluşturulamadı.'}`);
      } finally { setBackupBusy(false); }
      return;
    }
    const tables = ['categories','products','customers','sales','sale_items','customer_payments','cash_sessions','sale_payments','stock_movements','sale_returns','audit_logs','product_price_history','store_settings'];
    const payload:any = { backup_version: 3, exported_at:new Date().toISOString(), app:'Silopi Dijital', source:{database:'Supabase'}, data:{}, local_data:{}, errors:[] };
    for (const table of tables) {
      const all:any[] = []; let offset = 0;
      while (true) {
        const {data,error}=await supabase.from(table).select('*').range(offset, offset + 999);
        if (error) { payload.errors.push({table,message:error.message}); break; }
        all.push(...(data || []));
        if (!data || data.length < 1000) break;
        offset += 1000;
      }
      payload.data[table]=all;
    }
    // Staff are exported through the tenant-validated server API. PIN hashes
    // and cleartext PINs must never be included in a backup JSON.
    if (IS_OWNER_EDITION) {
      const { data: ownerStaff, error: ownerStaffError } = await supabase.from('staff')
        .select('id,name,role,active,earning_rate,financial_start_at,created_at,business_id').order('name');
      if (ownerStaffError) payload.errors.push({ table: 'staff', message: ownerStaffError.message });
      else payload.data.staff = ownerStaff || [];
    } else {
      const staffResult = await supabase.functions.invoke('propos-staff-api', { body: { action: 'list' } });
      if (staffResult.error || staffResult.data?.error) payload.errors.push({table:'staff',message:staffResult.error?.message || staffResult.data?.message || staffResult.data?.error});
      else payload.data.staff = Array.isArray(staffResult.data?.data) ? staffResult.data.data : [];
    }
    try {
      payload.local_data['propos-offline-sales-v2']=JSON.parse(localStorage.getItem('propos-offline-sales-v2') || '[]');
      payload.local_data['pos-settings']=loadSettings();
      payload.local_data['propos-held-sales-v1']=JSON.parse(localStorage.getItem('propos-held-sales-v1') || '[]');
    } catch {}
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=`silopi-dijital-yedek-${new Date().toISOString().replaceAll(':','-')}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    setBackupStatus(`Yedek hazır: ${Object.values(payload.data).reduce((n:any,v:any)=>n+(Array.isArray(v)?v.length:0),0)} kayıt`);
    setBackupBusy(false);
  }

  async function restoreBackup(file: File) {
    setBackupBusy(true); setBackupStatus('Yedek okunuyor...');
    try {
      if (window.proposDesktop?.db && !IS_OWNER_EDITION) {
        if (file.name.toLowerCase().endsWith('.proposbackup')) {
          const password = await askPrompt('Şifreli Silopi Dijital yedeğinin parolasını gir:', { title: 'Yedek Parolası', inputType: 'password', placeholder: 'Yedek parolası', confirmLabel: 'Geri Yükle', required: true });
          if (password === null || password.length === 0) throw new Error('Parola girilmedi; yerel kayıtlar korunuyor.');
          if (restoreMode === 'replace' && !window.confirm('Tam geri yükleme bu bilgisayardaki yerel kayıtları yedekle değiştirecek. Yedek doğru işletmeye ait mi?')) throw new Error('Geri yükleme iptal edildi.');
          const base64 = await fileToBase64(file);
          const result = await window.proposDesktop.db.importBackup(base64, password, restoreMode);
          if (!result?.ok) throw new Error(result?.error || 'Şifreli yedek geri yüklenemedi.');
          setBackupStatus(`Şifreli yedek geri yüklendi · ${result.recordCount ?? 0} kayıt işlendi.`);
          setTimeout(()=>window.location.reload(),900);
          return;
        }
        const payload = JSON.parse(await file.text());
        if (!payload?.data || typeof payload.data !== 'object') throw new Error('Geçersiz Pro POS yedek dosyası.');
        const allowedTables = ['categories','products','customers','sales','sale_items','customer_payments','cash_sessions','sale_payments','stock_movements','sale_returns','audit_logs','product_price_history','store_settings','suppliers','purchase_receipts','purchase_receipt_items','supplier_payments','staff','staff_earnings','staff_daily_earnings','staff_consumptions','staff_payouts','cash_reconciliations','cash_iban_exchanges','stock_counts','stock_count_items','customer_debt_adjustments'];
        const data = Object.fromEntries(Object.entries(payload.data).filter(([key,value])=>allowedTables.includes(key)&&Array.isArray(value)));
        if (!Object.keys(data).length) throw new Error('Yedekte desteklenen tablo bulunamadı.');
        if (restoreMode === 'replace' && !window.confirm('Tam geri yükleme bu bilgisayardaki yerel kayıtları yedekle değiştirecek. Devam edilsin mi?')) throw new Error('Geri yükleme iptal edildi.');
        const licenseBusinessId = localStorage.getItem('propos-business-id');
        const mode = restoreMode === 'missing' ? 'missing' : restoreMode;
        const result = await window.proposDesktop.db.importRows({ businessId: licenseBusinessId, data, mode });
        if (!result?.ok) throw new Error(result?.error || 'JSON yedeği geri yüklenemedi.');
        if (payload.local_data?.['pos-settings']) saveSettings({ ...DEFAULT_SETTINGS, ...payload.local_data['pos-settings'] });
        if (Array.isArray(payload.local_data?.['propos-held-sales-v1'])) localStorage.setItem('propos-held-sales-v1', JSON.stringify(payload.local_data['propos-held-sales-v1']));
        setBackupStatus(`Yerel yedek geri yüklendi · ${result.recordCount ?? 0} kayıt.`);
        setTimeout(()=>window.location.reload(),900);
        return;
      }
      const payload = JSON.parse(await file.text());
      if (!payload?.data || typeof payload.data !== 'object') throw new Error('Geçersiz Pro POS yedek dosyası.');
      const order = ['categories','products','customers','cash_sessions','sales','sale_items','customer_payments','sale_payments','stock_movements','sale_returns','audit_logs','product_price_history','store_settings'];
      const counts:any = {};
      const chunkSize = 100;
      if (restoreMode === 'replace' && !window.confirm('Tam geri yükleme bu işletmenin satış ve stok verilerini yedekle değiştirecek; güvenli personel/ Admin kimlikleri korunacak. Yedeğin güncel olduğundan eminseniz Tamam deyin.')) { setBackupBusy(false); setBackupStatus('Geri yükleme iptal edildi.'); return; }
      if (restoreMode === 'replace') {
        const purgeOrder = ['audit_logs','product_price_history','sale_returns','stock_movements','sale_payments','customer_payments','sale_items','sales','cash_sessions','products','customers','categories'];
        for (const table of purgeOrder) {
          const { error } = await supabase.from(table).delete().neq('id','00000000-0000-0000-0000-000000000000');
          if (error) throw new Error(`${table} temizlenemedi: ${error.message}`);
        }
        await supabase.from('store_settings').delete().neq('business_id','00000000-0000-0000-0000-000000000000');
      }
      for (const table of order) {
        const rows = Array.isArray(payload.data[table]) ? payload.data[table] : [];
        counts[table]=rows.length;
        for (let i=0; i<rows.length; i+=chunkSize) {
          const chunk = rows.slice(i,i+chunkSize);
          if (!chunk.length) continue;
          let writeRows = chunk;
          if (restoreMode === 'missing' && table !== 'store_settings') {
            const ids = chunk.map((r:any)=>r?.id).filter(Boolean);
            if (ids.length) {
              const { data: existing } = await supabase.from(table).select('id').in('id', ids);
              const existingIds = new Set((existing || []).map((r:any)=>r.id));
              writeRows = chunk.filter((r:any)=>!existingIds.has(r.id));
            }
          }
          if (table === 'store_settings') {
            writeRows = restoreMode === 'replace' ? chunk : chunk;
          }
          if (writeRows.length) {
            let result;
            if (table === 'store_settings') result = await supabase.from(table).upsert(writeRows, { onConflict: 'business_id' });
            else result = await supabase.from(table).upsert(writeRows, { onConflict: 'id' });
            if (result.error) throw new Error(`${table}: ${result.error.message}`);
          }
          setBackupStatus(`${table}: ${Math.min(i+chunk.length, rows.length)}/${rows.length}`);
        }
      }
      // Staff identities stay tenant-managed; a backup cannot replace the active Admin or export PIN hashes.
      if (payload.local_data?.['pos-settings']) { const restoredSettings={ ...DEFAULT_SETTINGS, ...payload.local_data['pos-settings'] }; saveSettings(restoredSettings); await saveStoreSettings(restoredSettings); }
      if (Array.isArray(payload.local_data?.['propos-held-sales-v1'])) localStorage.setItem('propos-held-sales-v1', JSON.stringify(payload.local_data['propos-held-sales-v1']));
      setBackupStatus(`Aktarım tamamlandı · ${Object.values(counts).reduce((n:any,v:any)=>n+Number(v||0),0)} kayıt işlendi.`);
      setTimeout(()=>window.location.reload(),900);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Yedek geri yüklenemedi.';
      setBackupStatus(`HATA: ${msg}`);
    } finally { setBackupBusy(false); }
  }

  async function handleClearAll() {
    setClearing(true);
    const order = ['sale_items', 'sales', 'cash_sessions', 'products', 'categories', 'customers'];
    let allOk = true;
    for (const table of order) {
      const { error } = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) {
        console.error(`${table} temizlenemedi:`, error);
        allOk = false;
      }
    }
    setClearing(false);
    if (allOk) {
      localStorage.removeItem(STORAGE_KEY);
      setSettings(DEFAULT_SETTINGS);
      setClearStep('done');
      setTimeout(() => { setShowClearConfirm(false); setClearStep('idle'); }, 2500);
    } else {
      setClearStep('error');
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">Ayarlar</h1>
            <p className="text-sm text-slate-500">Mağaza bilgileri ve sistem ayarları</p>
          </div>
          <div className="flex gap-2">
            <button onClick={handleReset} className="btn-secondary px-4 py-2">
              Sıfırla
            </button>
            <button onClick={handleSave} className="btn-primary px-4 py-2">
              {saved ? 'Kaydedildi!' : 'Kaydet'}
              {!saved && <Save size={18} />}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Appearance / application branding */}
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50"><Palette className="text-blue-600" size={20} /></div>
              <div><h2 className="text-lg font-bold text-slate-800">Görünüm ve Tema Rengi</h2><p className="text-xs text-slate-500">Silopi Dijital logosuna uygun mavi tonunu özelleştir</p></div>
            </div>
            <p className="mb-5 text-sm text-slate-500">Seçtiğin renk düğmelere, seçili menülere, vurgulara ve uygulamadaki diğer tema alanlarına anında uygulanır. Tercihin bu bilgisayarda saklanır.</p>
            <ThemeColorPicker value={manualBrandColor} onChange={handleBrandColorChange} />
            <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><div className="font-bold text-violet-950">RGB Işık Efekti</div><p className="text-xs text-violet-800">Tema rengini sırayla değiştirir; kapatınca seçtiğin ana renge döner.</p></div>
                <label className="inline-flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-semibold text-slate-800"><input type="checkbox" checked={rgbEnabled} onChange={e => setRgbEnabled(e.target.checked)} /> RGB açık</label>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3"><label className="text-sm text-violet-950">Renk değiştirme süresi</label><input className="input w-24 bg-white" type="number" min={1} max={60} value={rgbSeconds} onChange={e => setRgbSeconds(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} /><span className="text-sm text-violet-800">saniye (1–60)</span><button type="button" className="btn" onClick={() => setRgbEnabled(v => !v)}>{rgbEnabled ? 'RGB’yi Kapat' : 'RGB’yi Aç'}</button></div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl bg-slate-900 p-4 text-white">
              <span className="h-8 w-8 rounded-lg border border-white/20" style={{ backgroundColor: brandColor }} />
              <div className="flex-1"><div className="text-sm font-bold">Canlı tema önizlemesi</div><div className="text-xs text-slate-300">Siyah, beyaz ve seçtiğin mavi tonuyla uyumlu</div></div>
              <button type="button" className="rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm" style={{ backgroundColor: brandColor }} onClick={() => handleBrandColorChange(DEFAULT_BRAND_COLOR)}>Örnek düğme</button>
            </div>
          </div>

          {/* Store Info */}
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50">
                <Store className="text-teal-600" size={20} />
              </div>
              <h2 className="text-lg font-bold text-slate-800">Mağaza Bilgileri</h2>
            </div>
            <p className="mb-4 text-sm text-slate-500">Fiş ve etiketlerde görünecek mağaza bilgileri</p>{settings.storeName.trim() === 'Mağazam' && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><b>İlk kurulum:</b> İşletme adını, telefonunu ve adresini buradan tamamla. Kaydettikten sonra fişlerde bu bilgiler kullanılır.</div>}

            <div className="space-y-4">
              <div>
                <label className="label">Mağaza Adı</label>
                <input
                  className="input"
                  value={settings.storeName}
                  onChange={(e) => update('storeName', e.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label">Telefon</label>
                  <input
                    className="input"
                    value={settings.storePhone}
                    onChange={(e) => update('storePhone', e.target.value)}
                    placeholder="0xxx xxx xx xx"
                  />
                </div>
                <div>
                  <label className="label">Para Birimi</label>
                  <select
                    className="input"
                    value={settings.currency}
                    onChange={(e) => update('currency', e.target.value)}
                  >
                    <option value="TRY">Türk Lirası (TL)</option>
                    <option value="USD">Dolar ($)</option>
                    <option value="EUR">Euro (€)</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="label">Adres</label>
                <input
                  className="input"
                  value={settings.storeAddress}
                  onChange={(e) => update('storeAddress', e.target.value)}
                  placeholder="Mağaza adresi"
                />
              </div>
            </div>
          </div>

          {/* Receipt & Label Settings */}
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50">
                <SettingsIcon className="text-blue-600" size={20} />
              </div>
              <h2 className="text-lg font-bold text-slate-800">Fiş ve Etiket Ayarları</h2>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label">Fiş Alt Yazısı</label>
                <input
                  className="input"
                  value={settings.receiptFooter}
                  onChange={(e) => update('receiptFooter', e.target.value)}
                  placeholder="Fişin altında görünecek mesaj"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label">KDV Oranı (%)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    value={settings.taxRate}
                    onChange={(e) => update('taxRate', e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Varsayılan Min. Stok</label>
                  <input
                    type="number"
                    className="input"
                    value={settings.lowStockDefault}
                    onChange={(e) => update('lowStockDefault', e.target.value)}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="card p-6">
            <div className="mb-3 flex items-center gap-2"><Trash2 className="text-rose-600" size={20}/><h2 className="text-lg font-bold text-slate-800">Çöp Kutusu ve Otomatik Temizleme</h2></div>
            <p className="mb-4 text-sm leading-6 text-slate-500">Çöp kutusundaki kayıtların ne kadar süre saklanacağını belirle. Seçilen süre tüm mevcut çöp kutusu kayıtlarına ortak uygulanır; süresi dolan ürünler ve satışlar kalıcı olarak temizlenir. Temizlik uygulama açıldığında ve açık kaldığı sürece belirli aralıklarla kontrol edilir.</p>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div><label className="label">Çöp kutusu kayıtlarını saklama süresi</label><select className="input" value={settings.trashRetentionDays} onChange={e=>update('trashRetentionDays',e.target.value)}><option value="1">1 gün (varsayılan)</option><option value="3">3 gün</option><option value="7">7 gün</option><option value="14">14 gün</option><option value="30">30 gün</option><option value="0">Otomatik silme kapalı</option></select></div>
              <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">Kalıcı silinen kayıtlar geri getirilemez. Önemli veriler için düzenli yedek al.</div>
            </div>
            <p className="mt-2 text-xs text-slate-400">Varsayılan süre 1 gündür. Şu anda çöp kutusu akışı Ürünler ve Satışlar bölümlerinde etkin; bu tek ayar iki bölüm için de geçerlidir. Çöp kutusuna taşınmamış kayıtlar bu işlemden etkilenmez.</p>
          </div>

          <div className="card p-6">
            <div className="mb-3 flex items-center gap-2"><Database className="text-teal-600" size={20}/><h2 className="text-lg font-bold text-slate-800">Yedekleme ve Geri Yükleme</h2></div>
            <p className="mb-4 text-sm text-slate-500">Bu lisanslı işletmenin ürün, satış, cari, kasa, stok ve personel verilerini yedekleyebilir veya aynı işletmenin yedeğini geri yükleyebilirsin. Başka işletmelerin yerel kayıtları bu yedeğe dahil edilmez.</p>
            <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs font-semibold text-slate-700">Geri yükleme şekli</p>
              <div className="flex flex-wrap gap-4 text-xs text-slate-600">
                <label className="inline-flex items-center gap-2"><input type="radio" checked={restoreMode==='missing'} onChange={()=>setRestoreMode('missing')}/> Sadece eksikleri ekle</label>
                <label className="inline-flex items-center gap-2"><input type="radio" checked={restoreMode==='merge'} onChange={()=>setRestoreMode('merge')}/> Birleştir / güncelle</label>
                <label className="inline-flex items-center gap-2 text-red-700"><input type="radio" checked={restoreMode==='replace'} onChange={()=>setRestoreMode('replace')}/> Tam geri yükle</label>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button disabled={backupBusy} onClick={exportBackup} className="btn-primary px-4 py-2"><Download size={17}/> {backupBusy ? 'İşleniyor...' : 'Yedekleme İndir'}</button>
              <label className={`btn-secondary px-4 py-2 cursor-pointer ${backupBusy ? 'pointer-events-none opacity-50' : ''}`}>
                <Upload size={17}/> Yedekten Geri Yükle
                <input type="file" accept=".proposbackup,.json,application/json" className="hidden" disabled={backupBusy} onChange={(e)=>{ const f=e.target.files?.[0]; if(f) restoreBackup(f); e.currentTarget.value=''; }} />
              </label>
            </div>
            {backupStatus && <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${backupStatus.startsWith('HATA:') ? 'border-red-200 bg-red-50 text-red-700' : 'border-teal-200 bg-teal-50 text-teal-800'}`}><div className="flex items-center gap-2"><RefreshCw size={15}/> {backupStatus}</div></div>}
            <p className="mt-3 text-xs text-amber-700">"Sadece eksikleri ekle" mevcut kayıtları değiştirmez. "Birleştir / güncelle" aynı ID'leri günceller. "Tam geri yükle" önce mevcut ticari kayıtları temizler; yalnızca güncel bir yedekle kullanın.</p>
          </div>

          {/* Application updates */}
          <div className="card p-6">
            <div className="mb-3 flex items-center gap-2"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-50"><RefreshCw className="text-blue-600" size={20}/></div><div><h2 className="text-lg font-bold text-slate-800">Silopi Dijital - ProPOS Güncellemeleri</h2><p className="text-xs text-slate-500">Kurulu sürüm: {desktopVersion}</p></div></div>
            <p className="mb-4 text-sm text-slate-600">Güncelleme sunucusu yapılandırıldığında uygulama yeni sürümleri kontrol eder. Yeni bir sürüm bulunduğunda buradan indirip uygulamayı yeniden başlatarak kurabilirsin.</p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{updateStatus}{updateState === 'downloading' && <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-blue-600 transition-all" style={{width:`${updatePercent}%`}}/></div>}</div>
            <div className="mt-3 flex flex-wrap gap-2"><button className="btn-primary px-4 py-2" onClick={() => void checkAppUpdates()} disabled={updateBusy}>{updateBusy ? 'Kontrol ediliyor...' : 'Güncellemeleri Kontrol Et'}</button>{updateState === 'available' && <button className="btn-secondary px-4 py-2" onClick={() => void downloadAppUpdate()} disabled={updateBusy}><Download size={16}/> Güncellemeyi İndir</button>}{updateState === 'downloaded' && <button className="btn-primary px-4 py-2" onClick={() => void installAppUpdate()}><RefreshCw size={16}/> Yeniden Başlat ve Kur</button>}</div>
            {!window.proposDesktop && <p className="mt-3 text-xs text-amber-700">Web/PWA sürümü için dağıtım sağlayıcısının web yayınlama akışı kullanılmalıdır.</p>}
          </div>

          {/* System Info */}
          <div className="card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100">
                <Info className="text-slate-600" size={20} />
              </div>
              <h2 className="text-lg font-bold text-slate-800">Sistem Bilgisi</h2>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Database size={16} className="text-teal-600" />
                  <span className="text-slate-600">Veritabanı</span>
                </div>
                <span className="font-medium text-slate-800">{window.proposDesktop && !IS_OWNER_EDITION ? 'SQLite (Bu bilgisayar)' : 'Supabase (Bulut)'}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Monitor size={16} className="text-blue-600" />
                  <span className="text-slate-600">PC Kullanımı</span>
                </div>
                <span className="font-medium text-slate-800">{window.proposDesktop ? 'Silopi Dijital - ProPOS Windows masaüstü uygulaması' : 'Tarayıcı / PWA'}</span>
              </div>
            </div>
            <div className="mt-4 rounded-lg bg-teal-50 border border-teal-200 p-4">
              <p className="text-sm text-teal-800">
                {window.proposDesktop
                  ? 'Müşteri Windows sürümünde işletme kayıtları bu bilgisayardaki yerel SQLite veritabanında tutulur; lisans doğrulaması müşteri Supabase hizmeti üzerinden yapılır. Bilgisayar sıfırlanmadan önce şifreli yedeği kaydet.'
                  : 'Web/PWA sürümü işletme kayıtlarını Supabase bulut veritabanında tutar. İnternet bağlantısı gerektiren işlemler web sürümünde bulut üzerinden yürütülür.'}
              </p>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="card border-red-200 p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50">
                <Trash2 className="text-red-600" size={20} />
              </div>
              <h2 className="text-lg font-bold text-red-700">Tehlikeli Bölge</h2>
            </div>
            <p className="mb-4 text-sm text-slate-600">
              Aşağıdaki işlem tüm ürünleri, kategorileri, satışları, müşterileri ve kasa oturumlarını
              <span className="font-semibold text-red-600"> kalıcı olarak siler</span>. Bu işlem geri alınamaz.
            </p>
            <button
              onClick={() => { setShowClearConfirm(true); setClearStep('confirm'); }}
              className="rounded-lg bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-700"
            >
              <Trash2 size={18} className="inline mr-1" />
              Tüm Verileri Temizle
            </button>
          </div>
        </div>
      </div>

      {/* Clear All Confirmation Modal */}
      {showClearConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => !clearing && setShowClearConfirm(false)}>
          <div className="card w-full max-w-md p-6 animate-slide-up" onClick={(e) => e.stopPropagation()}>
            {clearStep === 'confirm' && (
              <>
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
                    <AlertTriangle className="text-red-600" size={26} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-slate-800">Emin Misiniz?</h2>
                    <p className="text-sm text-slate-500">Bu işlem geri alınamaz</p>
                  </div>
                </div>
                <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-4">
                  <p className="text-sm text-red-700">
                    Tüm ürünler, kategoriler, satışlar, müşteriler ve kasa oturumları kalıcı olarak silinecek.
                    Bu verileri tekrar geri getiremezsiniz.
                  </p>
                </div>
                <p className="mb-4 text-center text-sm font-medium text-slate-700">
                  Onaylamak için aşağıdaki butona basın
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    disabled={clearing}
                    className="btn-secondary flex-1 py-3"
                  >
                    <X size={18} />
                    Hayır, Vazgeç
                  </button>
                  <button
                    onClick={handleClearAll}
                    disabled={clearing}
                    className="rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white transition-all hover:bg-red-700 disabled:opacity-50 flex-1 flex items-center justify-center gap-1"
                  >
                    {clearing ? 'Temizleniyor...' : (
                      <>
                        <Check size={18} />
                        Evet, Sıfırla
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
            {clearStep === 'done' && (
              <div className="text-center py-6">
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50">
                  <Check className="text-emerald-600" size={30} />
                </div>
                <h2 className="text-lg font-bold text-slate-800">Veriler Temizlendi</h2>
                <p className="mt-1 text-sm text-slate-500">Tüm veriler başarıyla silindi</p>
              </div>
            )}
            {clearStep === 'error' && (
              <div className="text-center py-6">
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
                  <AlertTriangle className="text-red-600" size={30} />
                </div>
                <h2 className="text-lg font-bold text-slate-800">Hata Oluştu</h2>
                <p className="mt-1 text-sm text-slate-500">Bazı veriler silinemedi. Tekrar deneyin.</p>
                <button onClick={() => setClearStep('confirm')} className="btn-secondary mt-4 px-4 py-2">Tekrar Dene</button>
              </div>
            )}
          </div>
        </div>
      )}
      {promptDialog}
    </div>
  );
}
