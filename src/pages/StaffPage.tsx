import { useState } from 'react';
import { Plus, UserRound, X, CheckCircle2, Shield, LockKeyhole, Pencil, Search } from 'lucide-react';
import { addStaff, deleteStaff, updateStaff, useStaff, setStaffPassword } from '@/lib/hooks';
import type { Staff } from '@/lib/supabase';

export default function StaffPage() {
  const { staff, error: staffError, reload } = useStaff();
  const [staffSearch, setStaffSearch] = useState('');
  const filteredStaff = staff.filter(person => `${person.name} ${person.role}`.toLocaleLowerCase('tr-TR').includes(staffSearch.trim().toLocaleLowerCase('tr-TR')));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<Staff['role']>('cashier');
  const [pinStaff, setPinStaff] = useState<Staff | null>(null);
  const [nameStaff, setNameStaff] = useState<Staff | null>(null);
  const [editedName, setEditedName] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  async function add() {
    if (name.trim().length < 2) { window.alert('Ad soyad zorunludur.'); return; }
    if (pin.trim().length < 4 || pin.trim().length > 64) { window.alert('Şifre 4 ile 64 karakter arasında olmalı.'); return; }
    const result = await addStaff(name, pin, role, 0);
    if (result.data && !result.error) {
      setName(''); setPin(''); setRole('cashier'); setOpen(false); await reload();
    } else window.alert(result.error || 'Personel sunucuya kaydedilemedi.');
  }
  async function changeRole(id: string, nextRole: Staff['role']) {
    const target = staff.find(person => person.id === id);
    if (target?.role === 'admin' && target.active && nextRole !== 'admin' && staff.filter(person => person.active && person.role === 'admin').length <= 1) { window.alert('İşletmede en az bir aktif yönetici kalmalı. Son yöneticinin rolünü değiştiremezsin.'); return; }
    const ok = await updateStaff(id, { role: nextRole });
    if (ok) await reload(); else window.alert('Yetki değiştirilemedi.');
  }
  async function toggleActive(person: Staff) {
    if (person.role === 'admin' && person.active && staff.filter(item => item.active && item.role === 'admin').length <= 1) { window.alert('Son aktif yönetici pasifleştirilemez. Önce başka bir yöneticiyi etkinleştir.'); return; }
    const ok = await updateStaff(person.id, { active: !person.active });
    if (!ok) window.alert('Personel durumu değiştirilemedi.');
    await reload();
  }
  async function saveName() {
    if (!nameStaff) return;
    const clean = editedName.trim();
    if (clean.length < 2) { window.alert('Personel adı en az 2 karakter olmalı.'); return; }
    setNameBusy(true);
    const ok = await updateStaff(nameStaff.id, { name: clean });
    setNameBusy(false);
    if (!ok) { window.alert('Personel adı değiştirilemedi. Son aktif yöneticinin rolü veya bağlantı izni kontrol edilmiş olabilir.'); return; }
    setNameStaff(null); setEditedName(''); await reload();
  }
  async function saveNewPin() {
    if (!pinStaff) return;
    if (newPin.trim().length < 4 || newPin.trim().length > 64) { window.alert('Şifre 4 ile 64 karakter arasında olmalı.'); return; }
    if (newPin !== confirmPin) { window.alert('Şifreler eşleşmiyor.'); return; }
    setPinBusy(true);
    const result = await setStaffPassword(pinStaff.id, newPin);
    setPinBusy(false);
    if (!result.success) { window.alert(result.error || 'Şifre değiştirilemedi.'); return; }
    setPinStaff(null); setNewPin(''); setConfirmPin(''); await reload(); window.alert('Personel şifresi güncellendi.');
  }
  return <div className="flex h-screen flex-col overflow-hidden">
    <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
      <div><h1 className="text-xl font-bold text-slate-800">Personel & Yetki</h1><p className="text-sm text-slate-500">Kullanıcı, rol ve giriş şifresi yönetimi.</p></div>
      <button className="btn-primary" onClick={() => setOpen(true)}><Plus size={18}/> Personel Ekle</button>
    </div>
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto mb-6 grid max-w-5xl gap-4 md:grid-cols-3">
        <div className="card p-4"><div className="flex items-center gap-2 font-semibold text-slate-800"><LockKeyhole size={18}/> Admin</div><p className="mt-2 text-xs text-slate-500">Tüm modüller ve ayarlar dahil tam yetki.</p></div>
        <div className="card p-4"><div className="flex items-center gap-2 font-semibold text-slate-800"><Shield size={18}/> Müdür</div><p className="mt-2 text-xs text-slate-500">Günlük operasyonlar; personel ve kritik ayarlar hariç.</p></div>
        <div className="card p-4"><div className="flex items-center gap-2 font-semibold text-slate-800"><UserRound size={18}/> Kasiyer</div><p className="mt-2 text-xs text-slate-500">Satış ve müşteri/cari işlemleri.</p></div>
      </div>
      <div className="mx-auto mb-4 max-w-5xl"><div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={18}/><input className="input pl-10" placeholder="Personel adı veya yetki ara..." value={staffSearch} onChange={e=>setStaffSearch(e.target.value)}/></div></div>
      <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
        {filteredStaff.map(person => <div key={person.id} className="card p-5">
          <div className="mb-4 flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-100"><UserRound size={22}/></div><div><p className="font-bold text-slate-800">{person.name}</p><p className="text-xs text-slate-500">{person.role === 'admin' ? 'Yönetici / Admin' : person.role === 'manager' ? 'Müdür' : 'Kasiyer'}</p></div></div>
          <div className="mb-3 flex items-center justify-between text-sm"><span className={person.active ? 'text-emerald-600' : 'text-slate-400'}>{person.active ? 'Aktif' : 'Pasif'}</span><button onClick={() => void toggleActive(person)} className="text-xs text-teal-700">{person.active ? 'Pasifleştir' : 'Aktifleştir'}</button></div>
          
          <div className="flex flex-wrap gap-2"><button onClick={() => { setNameStaff(person); setEditedName(person.name); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Pencil size={14} className="mr-1 inline"/>Adı Düzenle</button><select value={person.role} onChange={e => void changeRole(person.id, e.target.value as Staff['role'])} className="input min-w-0 flex-1 py-1.5 text-xs"><option value="cashier">Kasiyer</option><option value="manager">Müdür</option><option value="admin">Admin</option></select><button onClick={() => { setPinStaff(person); setNewPin(''); setConfirmPin(''); }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Şifreyi Değiştir</button><button onClick={async () => { if (person.role === 'admin' && person.active && staff.filter(item => item.active && item.role === 'admin').length <= 1) { alert('Son aktif yönetici silinemez. İşletmede en az bir yönetici kalmalı.'); return; } if (!confirm(`${person.name} hesabı devre dışı bırakılsın mı? İşlem geçmişi korunur.`)) return; const ok = await deleteStaff(person.id); if (ok) await reload(); else alert('Personel hesabı kapatılamadı. Yetki veya son yönetici kuralı kontrol edildi.'); }} className="rounded-lg border border-red-200 p-2 text-red-500 hover:bg-red-50" title="Personeli sil"><X size={15}/></button></div>
        </div>)}
        {staff.length === 0 && <div className="card p-8 text-center text-slate-400 md:col-span-2">Henüz personel yok.</div>}
        {staff.length > 0 && filteredStaff.length === 0 && <div className="card p-8 text-center text-slate-400 md:col-span-2">Aramayla eşleşen personel bulunamadı.</div>}
      </div>
      {staffError && <div className="mx-auto mt-4 max-w-5xl rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{staffError}</div>}
    </div>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setOpen(false)}><div className="card w-full max-w-md p-6" onClick={e => e.stopPropagation()}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold">Yeni Personel</h2><button onClick={() => setOpen(false)}><X size={20}/></button></div><div className="space-y-3"><input className="input" placeholder="Ad Soyad" value={name} onChange={e => setName(e.target.value)}/><input className="input" type="password" autoComplete="new-password" placeholder="Şifre (en az 4 karakter)" value={pin} onChange={e => setPin(e.target.value)}/><select className="input" value={role} onChange={e => setRole(e.target.value as Staff['role'])}><option value="cashier">Kasiyer</option><option value="manager">Müdür</option><option value="admin">Admin</option></select><button onClick={() => void add()} className="btn-primary w-full py-3"><CheckCircle2 size={18}/> Personeli Kaydet</button></div></div></div>}
    {nameStaff && <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4" onClick={() => !nameBusy && setNameStaff(null)}><div className="card w-full max-w-md p-6" onClick={e => e.stopPropagation()}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold">Personel Adını Değiştir</h2><button disabled={nameBusy} onClick={() => setNameStaff(null)}><X size={20}/></button></div><div className="space-y-3"><input className="input" autoFocus value={editedName} maxLength={120} onChange={e => setEditedName(e.target.value)} placeholder="Ad soyad"/><button disabled={nameBusy} onClick={() => void saveName()} className="btn-primary w-full py-3">{nameBusy ? 'Kaydediliyor...' : 'Adı Kaydet'}</button></div></div></div>}
    {pinStaff && <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={() => !pinBusy && setPinStaff(null)}><div className="card w-full max-w-md p-6" onClick={e => e.stopPropagation()}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-bold">{pinStaff.name} — Şifre Değiştir</h2><button disabled={pinBusy} onClick={() => setPinStaff(null)}><X size={20}/></button></div><div className="space-y-3"><input className="input" autoFocus type="password" autoComplete="new-password" placeholder="Yeni şifre (en az 4 karakter)" value={newPin} onChange={e => setNewPin(e.target.value)}/><input className="input" type="password" autoComplete="new-password" placeholder="Yeni şifreyi tekrar girin" value={confirmPin} onChange={e => setConfirmPin(e.target.value)}/><button disabled={pinBusy} onClick={() => void saveNewPin()} className="btn-primary w-full py-3">{pinBusy ? 'Kaydediliyor...' : 'Şifreyi Kaydet'}</button></div></div></div>}
  </div>;
}
