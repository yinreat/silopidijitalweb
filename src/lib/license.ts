import { supabase } from './supabase';

export type LicenseState = {
  activated: boolean;
  businessId: string;
  businessName: string;
  /** ID of the license in the central license-management project. */
  licenseId: string;
  expiresAt: string | null;
  activatedAt: string;
  deviceId: string;
  lastVerifiedAt: string;
  /** Opaque 31-day tenant-session token issued by the customer Supabase Edge Function. */
  businessContextToken: string;
};

const KEY = 'propos-desktop-license-v1';
const BUSINESS_KEY = 'propos-business-id';
const BUSINESS_CONTEXT_TOKEN_KEY = 'propos-business-context-token-v1';
const GRACE_DAYS = 30;

class LicenseRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LicenseRejectedError';
  }
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function deviceLabel() {
  const version = window.proposDesktop?.version;
  if (window.proposDesktop) return version ? `ProPOS Windows ${version}` : 'ProPOS Windows';
  const platform = typeof navigator !== 'undefined' ? navigator.platform : 'Browser';
  return `ProPOS Web (${platform || 'Browser'})`;
}

export function getDeviceId(): string {
  const desktopId = window.proposDesktop?.deviceId;
  if (desktopId) return desktopId;
  const existing = localStorage.getItem('propos-device-id');
  if (existing) return existing;
  const id = randomId();
  localStorage.setItem('propos-device-id', id);
  return id;
}

export function getLicenseState(): LicenseState | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) as LicenseState : null;
  } catch {
    return null;
  }
}

export function isDesktopApp(): boolean {
  return Boolean(window.proposDesktop);
}

export function setBusinessContext(businessId: string) {
  localStorage.setItem(BUSINESS_KEY, businessId);
  try { window.dispatchEvent(new Event('silopidijital-business-changed')); } catch { /* ignore non-browser contexts */ }
}

export function restoreBusinessContext() {
  const state = getLicenseState();
  const id = state?.businessId || localStorage.getItem(BUSINESS_KEY) || null;
  if (id) setBusinessContext(id);
  if (state?.businessContextToken) localStorage.setItem(BUSINESS_CONTEXT_TOKEN_KEY, state.businessContextToken);
  else localStorage.removeItem(BUSINESS_CONTEXT_TOKEN_KEY);
  return id;
}

async function saveLicense(state: LicenseState) {
  const previous = getLicenseState();
  // A browser may be reused for a different customer license. Never carry the
  // previous tenant's signed-in staff identity into the new business session.
  if (!window.proposDesktop && (!previous || previous.businessId !== state.businessId)) {
    try { sessionStorage.removeItem('propos-current-staff-v2'); } catch {}
  }
  // Bind the local SQLite profile before any staff bootstrap can write rows.
  // Refuse to overwrite another business profile on this Windows user account.
  if (window.proposDesktop?.db) {
    const bound = await window.proposDesktop.db.setBusinessId(state.businessId);
    if (!bound?.ok) throw new Error(bound?.error || 'Yerel işletme profili bu lisansa bağlanamadı. Mevcut yerel kayıtlar korunmuştur.');
  }
  localStorage.setItem(KEY, JSON.stringify(state));
  setBusinessContext(state.businessId);
  if (state.businessContextToken) localStorage.setItem(BUSINESS_CONTEXT_TOKEN_KEY, state.businessContextToken);
  else localStorage.removeItem(BUSINESS_CONTEXT_TOKEN_KEY);
}

function normalizeLicenseCode(code: string) {
  return code.replace(/\s+/g, '').trim().toUpperCase();
}

function explainCode(code?: string) {
  switch (code) {
    case 'license_not_found': return 'Lisans kodu bulunamadı. Lisans merkezinden tam kodu yeniden kopyalayıp dene.';
    case 'license_inactive': return 'Bu lisans aktif değil veya iptal edilmiş.';
    case 'license_expired': return 'Bu lisansın süresi dolmuş.';
    case 'device_revoked': return 'Bu bilgisayarın lisans erişimi kapatılmış.';
    case 'device_not_activated': return 'Bu bilgisayar lisansla eşleştirilmemiş. Lisans kodunu tekrar girerek etkinleştir.';
    case 'device_limit_reached': return 'Bu lisansın izin verilen bilgisayar sayısı dolmuş.';
    case 'invalid_input': return 'Lisans kodu PROPOS-XXXX-XXXX-XXXX-XXXX biçiminde olmalı.';
    default: return 'Lisans doğrulanamadı. İnternet bağlantısını ve lisans kodunu kontrol et.';
  }
}


export async function activateLicense(licenseCode: string, businessName?: string): Promise<LicenseState> {
  const deviceId = getDeviceId();
  const normalizedCode = normalizeLicenseCode(licenseCode);
  const { data, error } = await supabase.functions.invoke('activate-customer-license', {
    body: {
      license_key: normalizedCode,
      ...(businessName?.trim() ? { business_name: businessName.trim() } : {}),
      device_id: deviceId,
      device_label: deviceLabel(),
    },
  });

  if (error) {
    // Edge Function transport errors may not expose the JSON body via supabase-js.
    throw new Error('Lisans servisine bağlanılamadı. İnternet bağlantısını kontrol edip yeniden dene.');
  }

  const result = data as {
    ok?: boolean;
    code?: string;
    message?: string;
    license_id?: string;
    business_id?: string;
    business_name?: string;
    expires_at?: string | null;
    business_context_token?: string;
  } | null;

  if (!result?.ok || !result.license_id || !result.business_id || !result.business_context_token) {
    throw new Error(result?.message || explainCode(result?.code));
  }

  const now = new Date().toISOString();
  const state: LicenseState = {
    activated: true,
    businessId: result.business_id,
    businessName: result.business_name || businessName?.trim() || 'Silopi Dijital - ProPOS İşletmesi',
    licenseId: result.license_id,
    expiresAt: result.expires_at ?? null,
    activatedAt: now,
    deviceId,
    lastVerifiedAt: now,
    businessContextToken: result.business_context_token,
  };
  await saveLicense(state);
  return state;
}

export async function verifyLicenseOnline(): Promise<boolean> {
  const state = getLicenseState();
  if (!state) return false;

  // This customer-side Edge Function re-verifies license+device at the central
  // license service, then rotates the server-issued tenant context token.
  const { data, error } = await supabase.functions.invoke('activate-customer-license', {
    body: {
      license_id: state.licenseId,
      business_name: state.businessName,
      device_id: state.deviceId,
      device_label: deviceLabel(),
    },
  });
  if (error) throw new Error('Lisans sunucusuyla çevrimiçi doğrulama tamamlanamadı.');

  const result = data as {
    ok?: boolean; code?: string; rejected?: boolean; message?: string;
    license_id?: string; business_id?: string; business_name?: string;
    business_context_token?: string; expires_at?: string | null;
  } | null;

  if (!result?.ok || !result.license_id || !result.business_id || !result.business_context_token) {
    if (result?.rejected || ['license_not_found','license_inactive','license_expired','device_revoked','device_limit_reached','device_not_activated'].includes(String(result?.code || ''))) {
      throw new LicenseRejectedError(result?.message || explainCode(result?.code));
    }
    throw new Error(result?.message || explainCode(result?.code));
  }
  if (result.license_id !== state.licenseId || result.business_id !== state.businessId) {
    throw new LicenseRejectedError('Lisansın işletme bağlantısı değişmiş. Lisansı yeniden etkinleştir.');
  }

  const next: LicenseState = {
    ...state,
    businessContextToken: result.business_context_token,
    lastVerifiedAt: new Date().toISOString(),
    expiresAt: result.expires_at ?? state.expiresAt,
  };
  await saveLicense(next);
  return true;
}

export function licenseUsableOffline(): boolean {
  const state = getLicenseState();
  if (!state || !state.businessContextToken || !/^[0-9a-f]{64}$/.test(state.businessContextToken)) return false;
  if (state.expiresAt && new Date(state.expiresAt).getTime() < Date.now()) return false;
  const last = new Date(state.lastVerifiedAt || state.activatedAt).getTime();
  return Number.isFinite(last) && Date.now() - last <= GRACE_DAYS * 24 * 60 * 60 * 1000;
}

export async function prepareDesktopLicense(): Promise<boolean> {
  const state = getLicenseState();
  if (!state) return false;
  if (!navigator.onLine) {
    setBusinessContext(state.businessId);
    // The Windows edition can use its local SQLite profile during the
    // configured grace period. The browser edition uses cloud data and
    // therefore cannot be treated as operational while offline.
    return isDesktopApp() && licenseUsableOffline();
  }

  try {
    const onlineOk = await verifyLicenseOnline();
    if (onlineOk) return true;
    return false;
  } catch (error) {
    // Explicit revocation/expiry must block immediately. Offline grace only applies
    // to network/server errors, not to a rejection returned by the license service.
    if (error instanceof LicenseRejectedError) return false;
    setBusinessContext(state.businessId);
    return isDesktopApp() && licenseUsableOffline();
  }
}
