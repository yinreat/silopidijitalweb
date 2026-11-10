import * as React from 'react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { ShoppingCart, Package, Tags, Barcode, BarChart3, Settings, Users, Calculator, Wallet, UtensilsCrossed, RotateCcw, ShieldCheck, BadgePercent, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import POSPage from '@/pages/POSPage';
import ProductsPage from '@/pages/ProductsPage';
import CategoriesPage from '@/pages/CategoriesPage';
import BarcodePage from '@/pages/BarcodePage';
import ReportsPage from '@/pages/ReportsPage';
import SettingsPage from '@/pages/SettingsPage';
import CustomersPage from '@/pages/CustomersPage';
import StaffPage from '@/pages/StaffPage';
import CashPage from '@/pages/CashPage';
import StaffConsumptionPage from '@/pages/StaffConsumptionPage';
import DashboardPage from '@/pages/DashboardPage';
import ProfitPage from '@/pages/ProfitPage';
import AuditPage from '@/pages/AuditPage';
import ReturnsPage from '@/pages/ReturnsPage';
import PricingPage from '@/pages/PricingPage';
import PosterPage from '@/pages/PosterPage';
import ReceiptDesignPage from '@/pages/ReceiptDesignPage';
import { POS_APP_NAME } from '@/lib/edition';
import { useStaff, createFirstAdmin, saveStoreSettings, cleanupExpiredTrash, loadStoreSettings, getOfflineSales, syncOfflineSales } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';
import type { Staff } from '@/lib/supabase';
import LicenseGate from '@/components/LicenseGate';
import { isDesktopApp, getLicenseState, prepareDesktopLicense, restoreBusinessContext } from '@/lib/license';
import { applyBrandColor, getBrandColor, setBrandColor } from '@/lib/theme';

type Page = 'dashboard' | 'pos' | 'receipt-design' | 'products' | 'profit' | 'returns' | 'categories' | 'barcode' | 'reports' | 'customers' | 'cash' | 'staff' | 'consumption' | 'audit' | 'pricing' | 'posters' | 'settings';


class AppErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) { console.error('Uygulama hatası:', error, info); }
  render() {
    if (this.state.error) return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-lg">
          <h1 className="mb-2 text-lg font-bold text-red-700">Sayfa yüklenemedi</h1>
          <p className="mb-4 text-sm text-slate-600">Bir uygulama hatası oluştu. Bu ekran beyaz kalmak yerine hatayı gösteriyor.</p>
          <pre className="mb-4 max-h-48 overflow-auto rounded bg-slate-100 p-3 text-xs text-slate-700">{this.state.error.message}</pre>
          <button onClick={() => window.location.reload()} className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white">Yenile</button>
        </div>
      </div>
    );
    return this.props.children;
  }
}

type NavItem = { key: Page; label: string; icon: typeof ShoppingCart };
const navItems: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { key: 'pos', label: 'Satış', icon: ShoppingCart },
  { key: 'receipt-design', label: 'Fiş Tasarımı', icon: FileText },
  { key: 'products', label: 'Ürünler', icon: Package },
  { key: 'returns', label: 'Satış İadesi', icon: RotateCcw },
  { key: 'customers', label: 'Müşteriler & Cari', icon: Users },
  { key: 'cash', label: 'Kasa & Gün Sonu', icon: Calculator },
  { key: 'reports', label: 'Raporlar', icon: BarChart3 },
  { key: 'pricing', label: 'Fiyat & Kampanyalar', icon: BadgePercent },
  { key: 'staff', label: 'Personel & Yetki', icon: Users },
  { key: 'audit', label: 'İşlem Geçmişi', icon: ShieldCheck },
  { key: 'settings', label: 'Ayarlar', icon: Settings },
];

const navChildren: Partial<Record<Page, NavItem[]>> = {
  products: [
    { key: 'categories', label: 'Kategoriler', icon: Tags },
    { key: 'barcode', label: 'Barkod & Etiket Yazdır', icon: Barcode },
  ],
  reports: [
    { key: 'profit', label: 'Kârlılık & Marj', icon: Wallet },
  ],
  pricing: [
    { key: 'posters', label: 'Profesyonel Kampanya Afişi', icon: FileText },
  ],
  staff: [
    { key: 'consumption', label: 'Personel Tüketimi & İkram', icon: UtensilsCrossed },
  ],
};

function navGroupKey(page: Page): Page {
  if (page === 'categories' || page === 'barcode') return 'products';
  if (page === 'profit') return 'reports';
  if (page === 'posters') return 'pricing';
  if (page === 'consumption') return 'staff';
  return page;
}



const STAFF_SESSION_KEY = 'propos-current-staff-v2';

function canAccess(role: Staff['role'] | null, page: Page) {
  if (!role) return true;
  if (role === 'admin') return true;
  if (role === 'manager') return page !== 'staff' && page !== 'settings' && page !== 'audit';
  return page === 'pos' || page === 'customers' || page === 'consumption';
}

function roleLabel(role: Staff['role']) {
  return role === 'admin' ? 'Yönetici / Admin' : role === 'manager' ? 'Müdür' : 'Kasiyer';
}

function readSession(): Staff | null {
  // Public evaluation build: sign in automatically as the isolated demo admin.
  // The demo tenant contains fictional records only; never enable this in a customer production build.
  if (import.meta.env.VITE_PROPOS_DEMO_MODE === 'true') {
    const id = import.meta.env.VITE_DEMO_STAFF_ID || '56440000-0000-4000-8000-000000000002';
    return {
      id,
      name: 'Değerlendirme Yöneticisi',
      role: 'admin',
      active: true,
      pin: null,
      pin_hash: null,
      has_pin: true,
      initial_pin_configured: true,
      earning_rate: 0,
      financial_start_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      business_id: import.meta.env.VITE_DEMO_BUSINESS_ID || '56440000-0000-4000-8000-000000000001',
    };
  }
  try { const raw = sessionStorage.getItem(STAFF_SESSION_KEY); return raw ? JSON.parse(raw) as Staff : null; } catch { return null; }
}
function writeSession(staff: Staff | null) {
  try {
    if (staff) sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(staff));
    else sessionStorage.removeItem(STAFF_SESSION_KEY);
  } catch {}
}

function FirstAdminSetup({ onCreated }: { onCreated: (staff: Staff) => Promise<void> }) {
  const [name, setName] = useState('Admin');
  const [storeName, setStoreName] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (storeName.trim().length < 2) { setError('Dükkan adı en az 2 karakter olmalı.'); return; }
    if (name.trim().length < 2) { setError('Admin adı en az 2 karakter olmalı.'); return; }
    if (pin.trim().length < 4 || pin.trim().length > 64) { setError('Admin şifresi 4 ile 64 karakter arasında olmalı.'); return; }
    if (pin !== confirm) { setError('Şifreler eşleşmiyor.'); return; }
    setBusy(true);
    try {
      const result = await createFirstAdmin(name.trim(), pin);
      if (!result.data || result.error) {
        setError(result.error || 'Admin hesabı sunucuya kaydedilemedi. İnternet ve Supabase kurulumunu kontrol edin.');
        return;
      }
      const storeSettings = { storeName: storeName.trim(), storeAddress: storeAddress.trim(), storePhone: storePhone.trim(), currency: 'TRY', receiptFooter: 'Bizi tercih ettiğiniz için teşekkürler!', taxRate: '0', lowStockDefault: '0' };
      try { localStorage.setItem('pos-settings', JSON.stringify(storeSettings)); } catch {}
      const savedStore = await saveStoreSettings(storeSettings);
      if (!savedStore) console.warn('İlk kurulumda mağaza bilgisi sunucuya kaydedilemedi; cihaz ayarlarına yazıldı.');
      await onCreated(result.data as Staff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin kaydı başarısız.');
    } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950 p-4">
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
      <div className="mx-auto mb-4 w-full rounded-2xl bg-slate-950 px-5 py-4"><img src="./silopi-dijital-logo.png" alt="Silopi Dijital" className="mx-auto h-auto w-full max-w-[250px]" /></div>
      <h1 className="text-center text-xl font-black tracking-tight text-slate-900">İlk Kurulum</h1>
      <p className="mt-2 text-center text-sm leading-6 text-slate-500">Önce dükkan bilgilerini ve ilk yönetici hesabını oluştur. Bu bilgiler fişlerde kullanılır.</p>
      <div className="mt-6 space-y-3">
        <div><label className="label">Dükkan adı *</label><input autoFocus className="input" autoComplete="organization" placeholder="Örn. Silopi Market" value={storeName} onChange={e=>setStoreName(e.target.value)} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><div><label className="label">Telefon (isteğe bağlı)</label><input className="input" autoComplete="tel" placeholder="0xxx xxx xx xx" value={storePhone} onChange={e=>setStorePhone(e.target.value)} /></div><div><label className="label">Adres (isteğe bağlı)</label><input className="input" autoComplete="street-address" placeholder="Dükkan adresi" value={storeAddress} onChange={e=>setStoreAddress(e.target.value)} /></div></div>
        <div className="border-t pt-3"><label className="label">İlk yönetici adı *</label><input className="input" autoComplete="name" placeholder="Admin ad soyad" value={name} onChange={e=>setName(e.target.value)} /></div>
        <input className="input" autoComplete="new-password" type="password" placeholder="Admin şifresi (en az 4 karakter)" value={pin} onChange={e=>setPin(e.target.value)} maxLength={64} />
        <input className="input" autoComplete="new-password" type="password" placeholder="Admin şifresini tekrar girin" value={confirm} onChange={e=>setConfirm(e.target.value)} maxLength={64} />
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button disabled={busy} className="btn-primary w-full py-3">{busy ? 'İlk kurulum kaydediliyor...' : 'Bilgileri Kaydet ve Sistemi Başlat'}</button>
      </div>
      <p className="mt-4 text-center text-[11px] text-slate-400">Şifre açık metin olarak sunucuya geri gönderilmez; doğrulama için güvenli hash saklanır.</p>
    </form>
  </div>;
}

function InitialAdminPinSetup({ onCompleted }: { onCompleted: (staff: Staff) => Promise<void> }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    if (pin.trim().length < 4 || pin.trim().length > 64) { setError('Admin şifresi 4 ile 64 karakter arasında olmalı.'); return; }
    if (pin !== confirm) { setError('Şifreler eşleşmiyor.'); return; }
    setBusy(true);
    try {
      const { data, error: requestError } = await supabase.functions.invoke('propos-staff-api', {
        body: { action: 'set_initial_admin_pin', pin: pin.trim() },
      });
      if (requestError || !data?.data?.id) {
        setError(data?.message || requestError?.message || 'Admin şifresi kaydedilemedi. İnternet bağlantısını kontrol edin.');
        return;
      }
      await onCompleted(data.data as Staff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Admin şifresi kaydedilemedi.');
    } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950 p-4">
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-600 text-white"><ShieldCheck size={28}/></div>
      <h1 className="text-center text-xl font-bold text-slate-800">Admin Şifreni Belirle</h1>
      <p className="mt-2 text-center text-sm leading-6 text-slate-500">Önceki kurulumda varsayılan Admin şifresi atanmış. Güvenliğin için şimdi kendi şifreni belirle. Bundan sonraki girişlerde bu şifre istenecek.</p>
      <div className="mt-6 space-y-3">
        <input autoFocus className="input" autoComplete="new-password" type="password" placeholder="Yeni Admin şifresi (en az 4 karakter)" value={pin} onChange={e=>setPin(e.target.value)} maxLength={64} />
        <input className="input" autoComplete="new-password" type="password" placeholder="Yeni şifreyi tekrar girin" value={confirm} onChange={e=>setConfirm(e.target.value)} maxLength={64} />
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button disabled={busy} className="btn-primary w-full py-3">{busy ? 'Şifre güvenli şekilde kaydediliyor...' : 'Şifremi Kaydet ve Sisteme Gir'}</button>
      </div>
      <p className="mt-4 text-center text-[11px] text-slate-400">Bu tek seferlik kurulum yalnızca varsayılan ilk Admin hesabında kullanılabilir.</p>
    </form>
  </div>;
}

function StaffLogin({ staff, onLogin }: { staff: Staff[]; onLogin: (s: Staff) => void }) {
  const [selected, setSelected] = useState(staff.find(s => s.active)?.id || '');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const active = staff.filter(s => s.active);
  const current = active.find(s => s.id === selected) || active[0];
  useEffect(() => { if (!selected && current) setSelected(current.id); }, [selected, current]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError('');
    const s = active.find(x => x.id === selected);
    if (!s) { setError('Aktif personel bulunamadı.'); return; }
    if (s.has_pin || s.pin_hash) {
      try {
        const { data, error: verifyError } = await supabase.functions.invoke('propos-staff-api', {
          body: { action: 'verify_pin', staff_id: s.id, pin: pin.trim() },
        });
        if (verifyError || typeof data?.valid !== 'boolean') {
          setError(verifyError?.message || data?.message || 'PIN doğrulanamadı. İnternet bağlantısını kontrol edip yeniden deneyin.');
          return;
        }
        if (data.valid !== true) { setError('PIN hatalı.'); return; }
      } catch (err) {
        console.error('PIN doğrulama istisnası:', err);
        setError(err instanceof Error
          ? `PIN doğrulama isteği çalıştırılamadı: ${err.message}`
          : 'PIN doğrulama isteği çalıştırılamadı. Ayrıntı için F12 Console kaydını kontrol edin.');
        return;
      }
    } else if (s.pin && s.pin !== pin.trim()) {
      setError('PIN hatalı.');
      return;
    } else if (!s.pin) {
      setError('Bu personel için giriş şifresi tanımlı değil. Yönetici hesabıyla şifre belirleyin.');
      return;
    }
    // Customer staff rows are verified by the tenant-aware staff API.
    onLogin(s);
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 p-4">
    <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
      <div className="mx-auto mb-4 w-full rounded-2xl border border-slate-700 bg-slate-950 px-5 py-4 shadow-inner"><img src="./silopi-dijital-logo.png" alt="Silopi Dijital" className="mx-auto h-auto w-full max-w-[270px] object-contain" /></div>
      <h1 className="text-center text-xl font-black tracking-tight text-slate-900">{POS_APP_NAME}</h1>
      <p className="mt-1 text-center text-sm text-slate-500">Kullanıcını seç ve şifreni gir. Yönetici için ayrı bir giriş ekranı yoktur.</p>
      <div className="mt-6 space-y-3">
        <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Kullanıcı</span><select className="input" aria-label="Kullanıcı seçin" value={selected} onChange={e=>setSelected(e.target.value)}>
          {active.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <input className="input font-mono" autoFocus type="password" placeholder="PIN / Şifre" value={pin} onChange={e=>setPin(e.target.value)} maxLength={64}/>
        {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <button className="btn-primary w-full py-3" type="submit">Giriş Yap</button>
      </div>
    </form>
  </div>;
}

function AppContent() {
  const { staff, error: staffError, reload: reloadStaff, loading: staffLoading } = useStaff();
  useEffect(() => {
    if (staffLoading || staffError) return;
    let active = true;
    const runCleanup = async () => {
      let retentionDays: number | null = null;
      try {
        const raw = localStorage.getItem('pos-settings');
        const local = raw ? JSON.parse(raw) as { trashRetentionDays?: string | number } : null;
        if (local?.trashRetentionDays !== undefined && local?.trashRetentionDays !== null && local.trashRetentionDays !== '') retentionDays = Number(local.trashRetentionDays);
        if (retentionDays === null || !Number.isFinite(retentionDays)) {
          const remote = await loadStoreSettings({ storeName: 'Mağazam', storeAddress: '', storePhone: '', currency: 'TRY', receiptFooter: '', taxRate: '0', lowStockDefault: '0', trashRetentionDays: '1' });
          retentionDays = Number(remote.trashRetentionDays ?? 1);
        }
      } catch { retentionDays = 1; }
      if (!active) return;
      const result = await cleanupExpiredTrash(retentionDays ?? 1);
      if (result.error) console.warn('Çöp kutusu temizliği:', result.error);
    };
    void runCleanup();
    const timer = window.setInterval(() => { void runCleanup(); }, 6 * 60 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [staffLoading, staffError]);
  const [currentStaff, setCurrentStaff] = useState<Staff | null>(() => readSession());
  const [page, setPage] = useState<Page>('pos');
  const [online, setOnline] = useState(navigator.onLine);
  const [rgbSettingsRevision, setRgbSettingsRevision] = useState(0);

  // Keep the offline sales queue syncing even when the user is on Dashboard,
  // Reports, or another page instead of the POS page. The shared in-flight lock
  // in hooks.ts prevents duplicate commits if POSPage is mounted too.
  useEffect(() => {
    const syncPending = () => {
      if (navigator.onLine && getOfflineSales().length > 0) {
        void syncOfflineSales().catch(error => console.warn('Çevrimdışı satış kuyruğu eşitlenemedi:', error));
      }
    };
    window.addEventListener('online', syncPending);
    syncPending();
    const timer = window.setInterval(syncPending, 15000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', syncPending);
    };
  }, []);

  // Keep RGB theme cycling alive while navigating between pages, not only while Settings is mounted.
  useEffect(() => {
    const handler = () => setRgbSettingsRevision(value => value + 1);
    window.addEventListener('silopidijital-rgb-settings-change', handler);
    return () => window.removeEventListener('silopidijital-rgb-settings-change', handler);
  }, []);

  useEffect(() => {
    const manualColor = localStorage.getItem('silopidijital-rgb-base-color') || getBrandColor();
    if (localStorage.getItem('silopidijital-rgb-enabled') !== 'true') {
      setBrandColor(manualColor);
      return;
    }
    const colors = ['#0EA5E9', '#2563EB', '#7C3AED', '#DB2777', '#F97316', '#16A34A', '#06B6D4'];
    let index = 0;
    const apply = () => { setBrandColor(colors[index % colors.length]); index += 1; };
    apply();
    const seconds = Math.max(1, Math.min(60, Number(localStorage.getItem('silopidijital-rgb-seconds') || '5')));
    const timer = window.setInterval(apply, seconds * 1000);
    return () => window.clearInterval(timer);
  }, [rgbSettingsRevision]);
  const activeStaff = useMemo(() => staff.filter(s => s.active), [staff]);
  const handleFirstAdminCreated = useCallback(async (admin: Staff) => {
    await reloadStaff();
    writeSession(admin);
    setCurrentStaff(admin);
    setPage('pos');
  }, [reloadStaff]);
  useEffect(() => {
    if (!activeStaff.length) { setCurrentStaff(null); writeSession(null); return; }
    const saved = currentStaff && activeStaff.find(s => s.id === currentStaff.id);
    if (saved) { setCurrentStaff(saved); writeSession(saved); }
    else { setCurrentStaff(null); writeSession(null); }
  }, [activeStaff]);

  useEffect(() => {
    const onlineHandler=()=>{
      const connected = navigator.onLine;
      setOnline(connected);
      // The first-admin screen is deliberately gated on a successful server read.
      // Automatically re-read staff as soon as the connection returns.
      if (connected) void reloadStaff();
    };
    window.addEventListener('online',onlineHandler);
    window.addEventListener('offline',onlineHandler);
    return () => { window.removeEventListener('online',onlineHandler); window.removeEventListener('offline',onlineHandler); };
  }, [reloadStaff]);


  const allowedItems = navItems.filter(item => canAccess(currentStaff?.role || null, item.key) || (navChildren[item.key] || []).some(child => canAccess(currentStaff?.role || null, child.key)));
  useEffect(() => {
    if (!canAccess(currentStaff?.role || null, page)) setPage('pos');
  }, [currentStaff, page]);
  if (staffLoading) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white"><div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-teal-400"/><p className="text-sm">İşletme verileri yükleniyor...</p></div></div>;
  if (staffError) {
    const corsFailure = /CORS_OR_NETWORK_UNAVAILABLE/i.test(staffError);
    const networkFailure = !corsFailure && (!online || /NETWORK_UNAVAILABLE|failed to fetch|err_internet_disconnected|networkerror|load failed/i.test(staffError));
    const migrationFailure = /MIGRATION_REQUIRED|migration|schema cache|does not exist|pgrst205/i.test(staffError);
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl">
      <div className={`mb-3 flex h-12 w-12 items-center justify-center rounded-xl ${networkFailure || corsFailure ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}><ShieldCheck size={25}/></div>
      <h1 className="text-xl font-bold text-slate-900">{corsFailure ? 'Sunucu isteği tarayıcı tarafından engellendi' : networkFailure ? 'İnternet bağlantısı kurulamadı' : migrationFailure ? 'Personel kurulumu eksik' : 'İşletme verileri yüklenemedi'}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">{corsFailure
        ? 'Bu sürümdeki özel x-propos-business-id başlığı PostgREST CORS isteğini engelleyebilir. 5.1.6 sürümünde personel işlemleri lisans bağlamını doğrulayan sunucu tarafı Edge Function üzerinden veritabanına bağlanır. Bu RPC PIN hash değerlerini istemciye göndermez.'
        : networkFailure
        ? 'Console’de görünen ERR_INTERNET_DISCONNECTED, Windows uygulamasının o anda internete ulaşamadığını gösterir. Lisans doğrulanmış olsa bile ilk Admin’i güvenli oluşturmak için personel listesinin lisanslı işletme adına sunucudan okunması gerekir. Yerel/geçici Admin oluşturulmuyor.'
        : migrationFailure
          ? 'Personel tablosu veya gerekli Supabase migration kurulumu eksik görünüyor. Müşteri projesinin migration dosyaları kontrol edilmeli.'
          : 'Sunucuya ulaşıldı ancak işletme personel verileri alınamadı. Aşağıdaki hata yetki veya veri tabanı kurulumuna işaret edebilir.'}</p>
      {staffError && <p className="mt-3 break-words rounded-lg bg-slate-100 p-3 text-xs text-slate-600">{staffError.replace(/^NETWORK_UNAVAILABLE:\s*|^MIGRATION_REQUIRED:\s*|^PERSONEL_YETKISI:\s*/,'')}</p>}
      <div className="mt-4 flex flex-wrap items-center gap-3"><button className="btn-primary" onClick={() => void reloadStaff()} disabled={staffLoading}>{staffLoading ? 'Kontrol ediliyor...' : 'Bağlantıyı Kontrol Et ve Yeniden Dene'}</button><span className={`text-xs font-semibold ${online ? 'text-emerald-700' : 'text-amber-700'}`}>{online ? 'Windows çevrimiçi gösteriyor' : 'Windows çevrimdışı gösteriyor'}</span></div>
      {networkFailure && <p className="mt-3 text-xs text-slate-500">İnternet yeniden bağlanınca uygulama personel listesini otomatik tekrar yükler. Sunucu boş liste döndürürse ilk açılış Admin oluşturma ekranı açılacak.</p>}
    </div></div>;
  }
  // Never seed a default PIN. New installations choose it during license activation; older 5.1.6 default Admin accounts get a one-time secure setup screen.
  if (staff.length === 0) return <FirstAdminSetup onCreated={handleFirstAdminCreated} />;
  const initialPinState: unknown = staff.length === 1 ? (staff[0] as Staff & { initial_pin_configured?: unknown }).initial_pin_configured : undefined;
  const initialPinNotConfigured = initialPinState === false || initialPinState === 0 || ['false', 'f', '0'].includes(String(initialPinState ?? '').trim().toLowerCase());
  // Do not depend on Electron's preload marker here: the server-controlled flag is authoritative.
  // This also makes recovery work if a packaged build's desktop bridge fails to initialise.
  if (staff.length === 1 && staff[0].role === 'admin' && staff[0].active && initialPinNotConfigured) return <InitialAdminPinSetup onCompleted={handleFirstAdminCreated} />;
  if (activeStaff.length === 0) return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-6"><div className="max-w-md rounded-2xl bg-white p-6 text-center"><h1 className="text-xl font-bold">Aktif kullanıcı yok</h1><p className="mt-2 text-sm text-slate-600">Bu işletmede tüm kullanıcılar pasif. Merkezi destekten hesabınızı etkinleştirin.</p></div></div>;
  if (!currentStaff) return <StaffLogin staff={staff} onLogin={(s) => { writeSession(s); setCurrentStaff(s); setPage('pos'); }} />;
  return <PCLayout page={page} setPage={setPage} online={online} currentStaff={currentStaff} staff={staff} allowedItems={allowedItems} onLogout={() => { writeSession(null); setCurrentStaff(null); }} />;
}

function SidebarNavigation({ page, setPage, currentStaff, allowedItems }: { page: Page; setPage: (p: Page) => void; currentStaff: Staff | null; allowedItems: typeof navItems }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const role = currentStaff?.role || null;
  const activeGroup = navGroupKey(page);
  useEffect(() => {
    if (page !== activeGroup) setExpanded(prev => ({ ...prev, [activeGroup]: true }));
  }, [page, activeGroup]);

  function targetFor(item: NavItem): Page {
    if (canAccess(role, item.key)) return item.key;
    return (navChildren[item.key] || []).find(child => canAccess(role, child.key))?.key || 'pos';
  }

  return <nav className="app-sidebar-nav min-h-0 flex-1 space-y-1 overflow-y-auto p-3 [scrollbar-width:thin]">
    {allowedItems.map(item => {
      const Icon = item.icon;
      const children = (navChildren[item.key] || []).filter(child => canAccess(role, child.key));
      const hasChildren = children.length > 0;
      const active = activeGroup === item.key;
      const isExpanded = Boolean(expanded[item.key]);
      return <div key={item.key} className="app-nav-group">
        <div className={`app-nav-item flex items-center rounded-lg transition-all ${active ? 'is-active bg-blue-600 text-white shadow-sm' : 'text-slate-300 hover:bg-slate-700 hover:text-white'}`}>
          <button onClick={() => setPage(targetFor(item))} className="app-nav-link flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-3 text-left text-sm font-medium">
            <Icon size={19} />
            <span className="flex-1">{item.label}</span>
          </button>
          {hasChildren && <button aria-label={`${item.label} alt menüsü`} title="Alt menüyü aç/kapat" onClick={() => setExpanded(prev => ({ ...prev, [item.key]: !isExpanded }))} className="mr-1 rounded-md p-2 hover:bg-white/10">
            {isExpanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
          </button>}
        </div>
        {hasChildren && isExpanded && <div className="ml-4 mt-1 space-y-1 border-l border-slate-600 pl-2">
          {children.map(child => {
            const ChildIcon = child.icon;
            return <button key={child.key} onClick={() => setPage(child.key)} className={`app-nav-child flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-xs font-medium transition-colors ${page === child.key ? 'is-active bg-blue-500/20 text-blue-200' : 'text-slate-400 hover:bg-slate-700 hover:text-white'}`}>
              <ChildIcon size={15}/><span>{child.label}</span>
            </button>;
          })}
        </div>}
      </div>;
    })}
  </nav>;
}

function PCLayout({ page, setPage, online, currentStaff, staff, allowedItems, onLogout }: { page: Page; setPage: (p: Page) => void; online: boolean; currentStaff: Staff | null; staff: Staff[]; allowedItems: typeof navItems; onLogout: () => void }) {
  return (
    <div className="pc-app-shell flex h-screen overflow-hidden bg-slate-100">
      {/* Sidebar */}
      <aside className="pc-sidebar flex w-64 flex-col text-white">
        <div className="sidebar-brand border-b border-slate-700 px-4 py-4">
          <div className="flex min-h-12 items-center justify-center overflow-hidden">
            <img
              src="./silopi-dijital-logo.png"
              alt="Silopi Dijital - ProPOS"
              className="block h-14 w-full max-w-[224px] object-contain object-center"
              draggable={false}
            />
          </div>
          <p className="mt-2 text-center text-[10px] font-black tracking-[0.18em] text-slate-300">PROPOS · MAĞAZA YÖNETİMİ</p>
          <p className={`mt-3 text-[10px] font-semibold ${online?'text-blue-300':'text-amber-300'}`}>{online?'● Çevrimiçi':'● Çevrimdışı · Kuyruk aktif'}</p>
          {import.meta.env.VITE_PROPOS_DEMO_MODE === 'true' && <div className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1.5 text-center text-[9px] font-black tracking-[0.12em] text-amber-200">DEĞERLENDİRME DEMOSU · ÖRNEK VERİ</div>}
        </div>

        <SidebarNavigation page={page} setPage={setPage} currentStaff={currentStaff} allowedItems={allowedItems} />

        {currentStaff && <div className="border-t border-slate-700 p-3"><div className="mb-2 rounded-lg bg-slate-700/60 px-3 py-2"><p className="text-sm font-semibold text-white">{currentStaff.name}</p><p className="text-xs text-slate-400">{roleLabel(currentStaff.role)}</p></div><button onClick={onLogout} className="mb-2 flex w-full items-center justify-center rounded-lg bg-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-600">Personel Değiştir / Çıkış</button></div>}
      </aside>

      {/* Main Content */}
      <main className={`app-main app-page-${page} min-w-0 flex-1 overflow-hidden`}>
        {page === 'dashboard' && <DashboardPage />}
        {page === 'pos' && <POSPage onNavigate={(p) => setPage(p as Page)} />}
        {page === 'receipt-design' && <ReceiptDesignPage />}
        {page === 'products' && <ProductsPage />}
        {page === 'profit' && <ProfitPage />}
        {page === 'returns' && <ReturnsPage currentStaffId={currentStaff?.id} />}
        {page === 'categories' && <CategoriesPage />}
        {page === 'barcode' && <BarcodePage />}
        {page === 'reports' && <ReportsPage />}
        {page === 'customers' && <CustomersPage />}
        {page === 'cash' && <CashPage currentStaffId={currentStaff?.id} />}
        {page === 'staff' && <StaffPage />}
        {page === 'consumption' && <StaffConsumptionPage />}
        {page === 'audit' && <AuditPage staff={staff} />}
        {page === 'pricing' && <PricingPage />}
        {page === 'posters' && <PosterPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}


function CustomerLicenseBootstrap() {
  const [ready, setReady] = useState(false);
  const [licensed, setLicensed] = useState(false);
  const [localCheckReady, setLocalCheckReady] = useState(false);
  const [localSetupError, setLocalSetupError] = useState('');
  const [localDataReady, setLocalDataReady] = useState(false);

  useEffect(() => {
    // Evaluation-only public demo. It points at a dedicated fictional tenant,
    // never at a customer's licensed business. The context token is public by design.
    if (import.meta.env.VITE_PROPOS_DEMO_MODE === 'true') {
      const businessId = import.meta.env.VITE_DEMO_BUSINESS_ID || '56440000-0000-4000-8000-000000000001';
      const contextToken = import.meta.env.VITE_DEMO_CONTEXT_TOKEN || '5644564456445644564456445644564456445644564456445644564456445644';
      if (/^[0-9a-f-]{36}$/i.test(businessId) && /^[0-9a-f]{64}$/i.test(contextToken)) {
        // Remove any old licensed browser identity before switching to the demo tenant.
        localStorage.removeItem('propos-desktop-license-v1');
        localStorage.setItem('propos-business-id', businessId);
        localStorage.setItem('propos-business-context-token-v1', contextToken);
        sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify(readSession()));
        setLicensed(true);
      } else {
        setLicensed(false);
      }
      setLocalCheckReady(true);
      setLocalDataReady(true);
      setReady(true);
      return;
    }

    // Normal customer desktop/browser builds continue to require a valid license.
    // Desktop uses local SQLite after license verification; licensed web uses Supabase.
    restoreBusinessContext();
    prepareDesktopLicense().then(ok => {
      setLicensed(ok);
      setReady(true);
      if (!isDesktopApp()) {
        setLocalCheckReady(true);
        setLocalDataReady(true);
      }
    }).catch(() => {
      setLicensed(false);
      setReady(true);
      if (!isDesktopApp()) {
        setLocalCheckReady(true);
        setLocalDataReady(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!isDesktopApp() || !ready || !licensed) return;
    let cancelled = false;
    (async () => {
      try {
        const state = getLicenseState();
        if (!state?.businessId || !window.proposDesktop?.db) throw new Error('Lisans veya yerel veritabanı bağlamı bulunamadı.');
        const bound = await window.proposDesktop.db.setBusinessId(state.businessId);
        if (!bound?.ok) {
          setLocalSetupError(bound?.error || 'Yerel veritabanı bu lisansa bağlanamadı.');
          return;
        }
        const status = await window.proposDesktop.db.status();
        if (status?.ok === false) throw new Error(status.error || 'Yerel veritabanı okunamadı.');
        if (cancelled) return;
        if (status.initialized || Number(status.recordCount || 0) > 0) {
          // Existing local data is never replaced during launch. The user can
          // manage backup/restore from Settings after signing in.
          setLocalDataReady(true);
        } else {
          // Fresh customer installs start with an empty local database; no
          // import/restore wizard interrupts the license-and-password login.
          const initialized = await window.proposDesktop.db.startEmpty();
          if (!initialized?.ok || !initialized.initialized) {
            throw new Error(initialized?.error || 'Boş yerel veritabanı başlatılamadı.');
          }
          if (!cancelled) setLocalDataReady(true);
        }
      } catch (error) {
        if (!cancelled) {
          setLocalSetupError(error instanceof Error ? error.message : 'Yerel veritabanı denetlenemedi.');
        }
      } finally { if (!cancelled) setLocalCheckReady(true); }
    })();
    return () => { cancelled = true; };
  }, [ready, licensed]);

  if (!ready) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white"><div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-teal-400"/><p className="text-sm">Silopi Dijital - ProPOS lisansı doğrulanıyor...</p></div></div>;
  if (!licensed) return <LicenseGate onActivated={() => setLicensed(true)} />;
  if (isDesktopApp() && licensed && !localCheckReady) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white"><div className="text-center"><div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-teal-400"/><p className="text-sm">Yerel Silopi Dijital - ProPOS veritabanı kontrol ediliyor...</p></div></div>;
  if (isDesktopApp() && licensed && localSetupError) return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4"><div className="w-full max-w-lg rounded-2xl bg-white p-6"><h1 className="mb-2 text-lg font-bold text-red-700">Yerel veri güvenlik kontrolü durdu</h1><p className="mb-4 text-sm leading-6 text-slate-700">{localSetupError}</p><p className="mb-4 text-xs leading-5 text-slate-500">Yerel veri güvenlik kontrolü tamamlanamadığı için uygulama kayıtları otomatik değiştirmedi veya silmedi. Lisans bağlantısını kontrol edin; gerekiyorsa Ayarlar bölümünden bu işletmeye ait doğru yedeği geri yükleyin.</p><button onClick={()=>window.location.reload()} className="btn-primary w-full py-3">Yeniden Kontrol Et</button></div></div>;
  return <AppContent />;
}

export default function App() {
  useEffect(() => {
    applyBrandColor(getBrandColor());
    const handleThemeChange = (event: Event) => {
      const detail = (event as CustomEvent<{ color?: string }>).detail;
      applyBrandColor(detail?.color || getBrandColor());
    };
    window.addEventListener('silopidijital-theme-change', handleThemeChange);
    return () => window.removeEventListener('silopidijital-theme-change', handleThemeChange);
  }, []);
  return <AppErrorBoundary><CustomerLicenseBootstrap /></AppErrorBoundary>;
}
