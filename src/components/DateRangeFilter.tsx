import { CalendarDays } from 'lucide-react';

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'all' | 'custom';

export type DateRangeValue = {
  preset: Preset;
  startDate: string;
  endDate: string;
};

function isoDateLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function presetDates(preset: Preset) {
  const now = new Date();
  const end = isoDateLocal(now);
  if (preset === 'today') return { startDate: end, endDate: end };
  if (preset === 'yesterday') {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    const day = isoDateLocal(d);
    return { startDate: day, endDate: day };
  }
  if (preset === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { startDate: isoDateLocal(d), endDate: end };
  }
  if (preset === 'month') {
    const d = new Date(now);
    d.setDate(d.getDate() - 29);
    return { startDate: isoDateLocal(d), endDate: end };
  }
  return { startDate: '', endDate: '' };
}

export function getDateBounds(value: DateRangeValue) {
  const { preset, startDate, endDate } = value;
  if (preset === 'all') return { start: null as Date | null, end: null as Date | null };
  const fallback = presetDates(preset);
  const startText = startDate || fallback.startDate;
  const endText = endDate || fallback.endDate;
  const start = startText ? new Date(`${startText}T00:00:00`) : new Date(0);
  const end = endText ? new Date(`${endText}T23:59:59.999`) : null;
  return { start, end };
}

export default function DateRangeFilter({ value, onChange }: { value: DateRangeValue; onChange: (value: DateRangeValue) => void }) {
  const presets: Array<[Preset, string]> = [
    ['today', 'Bugün'],
    ['yesterday', 'Dün'],
    ['week', 'Son 7 Gün'],
    ['month', 'Son 30 Gün'],
    ['all', 'Tümü'],
  ];
  const setPreset = (preset: Preset) => {
    if (preset === 'all') onChange({ preset, startDate: '', endDate: '' });
    else onChange({ preset, ...presetDates(preset) });
  };
  const setCustom = (which: 'startDate' | 'endDate', val: string) => {
    const next = { ...value, preset: 'custom' as const, [which]: val };
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
        {presets.map(([key, label]) => (
          <button key={key} onClick={() => setPreset(key)} type="button" className={`rounded-md px-3 py-1.5 text-sm font-medium ${value.preset === key ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{label}</button>
        ))}
      </div>
      <div className={`flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1.5 ${value.preset === 'custom' ? 'border-teal-300 bg-teal-50' : 'border-slate-200 bg-white'}`}>
        <CalendarDays size={16} className="text-slate-500" />
        <input aria-label="Başlangıç tarihi" type="date" value={value.startDate} onChange={e => setCustom('startDate', e.target.value)} className="bg-transparent text-sm text-slate-700 outline-none" />
        <span className="text-xs font-semibold text-slate-400">—</span>
        <input aria-label="Bitiş tarihi" type="date" value={value.endDate} onChange={e => setCustom('endDate', e.target.value)} className="bg-transparent text-sm text-slate-700 outline-none" />
      </div>
    </div>
  );
}
