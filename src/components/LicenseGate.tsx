import { useState } from 'react';
import { KeyRound, ShieldCheck, Wifi, WifiOff } from 'lucide-react';
import { activateLicense } from '@/lib/license';
import { createFirstAdmin, saveStoreSettings } from '@/lib/hooks';
import { supabase } from '@/lib/supabase';

const STAFF_SESSION_KEY = 'propos-current-staff-v2';

type StaffLoginRow = {
  id: string;
  name: string;
  role: 'admin' | 'manager' | 'cashier' | string;
  active: boolean;
  has_pin?: boolean;
  initial_pin_configured?: boolean;
  business_id?: string | null;
  earning_rate?: number;
  financial_start_at?: string | null;
  created_at?: string | null;
};

function rememberStaff(staff: StaffLoginRow) {
  sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
    ...staff,
    pin: null,
    pin_hash: null,
    has_pin: true,
    initial_pin_configured: true,
  }));
}

export default function LicenseGate({ onActivated }: { onActivated: () => void }) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [storeName, setStoreName] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const cleanCode = code.replace(/\s+/g, '').trim().toUpperCase();
    const cleanPassword = password.trim();
    if (cleanCode.length < 6) { setError('Lisans kodunu girin.'); return; }
    if (storeName.trim().length < 2) { setError('Dükkan adı en az 2 karakter olmalı.'); return; }
    if (cleanPassword.length < 4 || cleanPassword.length > 64) {
      setError('Şifre 4 ile 64 karakter arasında olmalı.');
      return;
    }

    setBusy(true);
    try {
      // The licensed business name is resolved from the license center; users do
      // not need to type a different name that could bind the license incorrectly.
      await activateLicense(cleanCode);

      const businessSettings = { storeName: storeName.trim(), storePhone: storePhone.trim(), storeAddress: storeAddress.trim(), currency: 'TRY', receiptFooter: 'Bizi tercih ettiğiniz için teşekkür ederiz!', taxRate: '0', lowStockDefault: '0', trashRetentionDays: '1' };
      // Persist the shop identity on this customer installation and in its licensed business settings.
      localStorage.setItem('pos-settings', JSON.stringify(businessSettings));

      const { data: staffResponse, error: staffError } = await supabase.functions.invoke('propos-staff-api', {
        body: { action: 'list' },
      });
      if (staffError || !Array.isArray(staffResponse?.data)) {
        throw new Error(staffResponse?.message || staffError?.message || 'Lisans doğrulandı ancak kullanıcı listesi alınamadı. İnternet bağlantısını kontrol edin.');
      }

      const staff = staffResponse.data as StaffLoginRow[];
      const activeStaff = staff.filter(person => person.active);

      // The first user for a newly licensed, empty business is always the owner
      // and receives full permissions. The server refuses this action if any
      // staff row already exists, so later users cannot self-promote.
      if (staff.length === 0) {
        const created = await createFirstAdmin('İşletme Sahibi', cleanPassword);
        if (!created.data || created.error) throw new Error(created.error || 'İlk yönetici hesabı oluşturulamadı.');
        const storeSaved = await saveStoreSettings(businessSettings);
        if (!storeSaved) console.warn('İlk kurulum mağaza bilgileri bu bilgisayarda saklandı; bulut kaydı ayrıca kontrol edilmeli.');
        rememberStaff(created.data as StaffLoginRow);
        onActivated();
        return;
      }

      const admins = activeStaff.filter(person => person.role === 'admin');
      if (admins.length === 0) {
        throw new Error('Bu işletmede aktif yönetici hesabı bulunamadı. Mevcut personel ve yetkiler korunmuştur; lisanslı işletme kaydını kontrol edin.');
      }

      // Recover the one legacy initial Admin which was seeded without a chosen
      // password. This path is server-limited to a business with exactly one row.
      const legacyInitialAdmin = staff.length === 1
        && admins.length === 1
        && (admins[0].initial_pin_configured === false || admins[0].has_pin === false);
      if (legacyInitialAdmin) {
        const { data, error: pinSetupError } = await supabase.functions.invoke('propos-staff-api', {
          body: { action: 'set_initial_admin_pin', pin: cleanPassword },
        });
        if (pinSetupError || !data?.data?.id) {
          throw new Error(data?.message || pinSetupError?.message || 'İlk yönetici şifresi kaydedilemedi.');
        }
        await saveStoreSettings(businessSettings);
        rememberStaff(data.data as StaffLoginRow);
        onActivated();
        return;
      }

      // Existing installation: verify the supplied password only against active
      // Admin accounts. Never silently turn a cashier/manager into an Admin.
      let matchedAdmin: StaffLoginRow | null = null;
      for (const admin of admins) {
        if (!admin.has_pin) continue;
        const { data, error: verifyError } = await supabase.functions.invoke('propos-staff-api', {
          body: { action: 'verify_pin', staff_id: admin.id, pin: cleanPassword },
        });
        if (verifyError) {
          throw new Error(data?.message || verifyError.message || 'Yönetici şifresi doğrulanamadı. İnternet bağlantısını kontrol edin.');
        }
        if (data?.valid === true) {
          matchedAdmin = admin;
          break;
        }
      }

      if (!matchedAdmin) {
        throw new Error('Yönetici şifresi hatalı. Bu lisansa bağlı mevcut yönetici hesabının şifresini girin. Personel PIN’leri ve yetkileri değiştirilmedi.');
      }

      await saveStoreSettings(businessSettings);
      rememberStaff(matchedAdmin);
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Giriş başarısız. Lisans kodunu ve şifreyi kontrol edin.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950 p-4">
    <form onSubmit={submit} className="max-h-[94vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-white shadow-2xl">
      <div className="bg-slate-900 px-7 py-6 text-white">
        <div className="mb-4 rounded-xl border border-slate-700 bg-slate-950 px-4 py-3">
          <img src="./silopi-dijital-logo.png" alt="Silopi Dijital" className="mx-auto h-auto w-full max-w-[280px]" />
        </div>
        <div className="mb-4 text-xs font-black tracking-[0.22em] text-slate-300">SİLOPİ DİJİTAL - PROPOS</div>
        <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-blue-300"/> Lisanslı Giriş</div>
      </div>
      <div className="space-y-4 p-7">
        <p className="text-sm leading-6 text-slate-600">Önce işletme bilgilerini tanımla, ardından lisans ve yönetici şifrenle giriş yap. İşletme adı, telefon ve adres bilgileri Ayarlar bölümünde de düzenlenebilir; fişlerde kullanılabilir.</p>
        {!window.proposDesktop && <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-900">Web sürümü güvenli bulut bağlantısı kullanır ve çalışmak için internet gerektirir. Bu tarayıcı lisans için ayrı bir cihaz olarak kaydedilebilir.</div>}
        <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4"><div className="mb-3 text-xs font-black uppercase tracking-wide text-blue-900">İşletme bilgileri</div>
          <label className="mb-3 block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Dükkan / İşletme adı *</span><input className="input" value={storeName} onChange={e=>setStoreName(e.target.value)} placeholder="Örn. Silopi Market" autoComplete="organization" /></label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Telefon</span><input className="input" value={storePhone} onChange={e=>setStorePhone(e.target.value)} placeholder="0xxx xxx xx xx" autoComplete="tel" /></label><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Adres</span><input className="input" value={storeAddress} onChange={e=>setStoreAddress(e.target.value)} placeholder="Mahalle / Cadde" autoComplete="street-address" /></label></div>
        </div>
        <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Lisans / Aktivasyon kodu</span><div className="relative"><KeyRound className="absolute left-3 top-3.5 text-slate-400" size={18}/><input className="input pl-10 font-mono uppercase tracking-wider" autoFocus value={code} onChange={e=>setCode(e.target.value.replace(/\s+/g, '').toUpperCase())} placeholder="PROPOS-XXXX-XXXX-XXXX-XXXX" autoComplete="off" /></div></label>
        <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-slate-500">Yönetici şifresi</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Şifreni gir" maxLength={64}/></label>
        {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm leading-5 text-red-700">{error}</div>}
        <button disabled={busy} className="btn-primary flex w-full items-center justify-center gap-2 py-3.5">{busy ? 'Lisans doğrulanıyor, giriş yapılıyor...' : <><ShieldCheck size={18}/> Sisteme Giriş Yap</>}</button>
        <div className="flex items-center justify-between border-t border-slate-100 pt-4 text-[11px] text-slate-400"><span className="flex items-center gap-1"><Wifi size={13}/> İlk giriş çevrimiçi</span><span className="flex items-center gap-1"><WifiOff size={13}/> Lisans sonrası offline</span></div>
      </div>
    </form>
  </div>;
}
