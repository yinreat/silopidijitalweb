import { useEffect, useRef, type PointerEvent } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_BRAND_COLOR } from '@/lib/theme';

type HSV = { h: number; s: number; v: number };

function hexToHsv(hex: string): HSV {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.slice(0, 2), 16) / 255;
  const g = parseInt(cleaned.slice(2, 4), 16) / 255;
  const b = parseInt(cleaned.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max * 100, v: max * 100 };
}

function hsvToHex({ h, s, v }: HSV): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const val = Math.max(0, Math.min(100, v)) / 100;
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
  const m = val - chroma;
  let rgb: [number, number, number];
  if (h < 60) rgb = [chroma, x, 0];
  else if (h < 120) rgb = [x, chroma, 0];
  else if (h < 180) rgb = [0, chroma, x];
  else if (h < 240) rgb = [0, x, chroma];
  else if (h < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  return `#${rgb.map(part => Math.round((part + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export default function ThemeColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const ringRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const hueDragging = useRef(false);
  const squareDragging = useRef(false);
  const hsv = hexToHsv(value);

  useEffect(() => {
    const stop = () => { hueDragging.current = false; squareDragging.current = false; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, []);

  function updateHue(event: PointerEvent<HTMLDivElement>) {
    const rect = ringRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
    onChange(hsvToHex({ ...hexToHsv(value), h: angle }));
  }

  function updateSaturationValue(event: PointerEvent<HTMLDivElement>) {
    const rect = squareRef.current?.getBoundingClientRect();
    if (!rect) return;
    const s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 100;
    const v = (1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))) * 100;
    onChange(hsvToHex({ ...hexToHsv(value), s, v }));
  }

  const angle = (hsv.h - 90) * Math.PI / 180;
  const ringDot = { left: `${50 + 46 * Math.cos(angle)}%`, top: `${50 + 46 * Math.sin(angle)}%` };
  const squareStyle = {
    backgroundColor: `hsl(${hsv.h} 100% 50%)`,
    backgroundImage: 'linear-gradient(to top, #000000, transparent), linear-gradient(to right, #ffffff, transparent)',
  };
  const squareDot = { left: `${hsv.s}%`, top: `${100 - hsv.v}%` };

  return <div className="grid gap-5 md:grid-cols-[minmax(270px,300px)_1fr] md:items-center">
    <div className="flex flex-col items-center gap-3">
      <div className="relative h-64 w-64 select-none touch-none" aria-label="Renk çemberi">
        <div
          ref={ringRef}
          className="absolute inset-0 cursor-crosshair rounded-full"
          style={{ background: 'conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)', mask: 'radial-gradient(farthest-side, transparent calc(100% - 24px), #000 calc(100% - 23px))', WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 24px), #000 calc(100% - 23px))' }}
          onPointerDown={event => { hueDragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); updateHue(event); }}
          onPointerMove={event => { if (hueDragging.current) updateHue(event); }}
          onPointerUp={() => { hueDragging.current = false; }}
          role="slider" aria-label="Renk tonu" aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(hsv.h)} tabIndex={0}
          onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onChange(hsvToHex({ ...hexToHsv(value), h: (hsv.h + 2) % 360 })); else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onChange(hsvToHex({ ...hexToHsv(value), h: (hsv.h + 358) % 360 })); }}
        />
        <div className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgba(15,23,42,.55)]" style={ringDot} />
        <div
          ref={squareRef}
          className="absolute left-1/2 top-1/2 h-32 w-32 -translate-x-1/2 -translate-y-1/2 cursor-crosshair overflow-hidden rounded-md shadow-inner ring-1 ring-slate-900/10"
          style={squareStyle}
          onPointerDown={event => { squareDragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); updateSaturationValue(event); }}
          onPointerMove={event => { if (squareDragging.current) updateSaturationValue(event); }}
          onPointerUp={() => { squareDragging.current = false; }}
          role="slider" aria-label="Doygunluk ve parlaklık" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.v)} tabIndex={0}
          onKeyDown={event => { if (event.key.startsWith('Arrow')) { const delta = event.key === 'ArrowRight' ? 3 : event.key === 'ArrowLeft' ? -3 : event.key === 'ArrowUp' ? 3 : -3; onChange(hsvToHex({ ...hexToHsv(value), s: Math.max(0, Math.min(100, hsv.s + (event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? delta : 0))), v: Math.max(0, Math.min(100, hsv.v + (event.key === 'ArrowUp' || event.key === 'ArrowDown' ? delta : 0))) })); } }}
        >
          <div className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow-[0_0_0_2px_rgba(15,23,42,.45)]" style={squareDot} />
        </div>
      </div>
      <div className="flex w-64 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <span className="h-10 w-10 shrink-0 rounded-lg border border-slate-200" style={{ backgroundColor: value }} />
        <div className="min-w-0 flex-1"><div className="text-xs font-semibold text-slate-500">Seçilen renk</div><div className="font-mono text-sm font-bold tracking-wider text-slate-800">{value.toUpperCase()}</div></div>
        <input aria-label="Renk kodunu seç" type="color" value={value} onChange={event => onChange(event.target.value.toUpperCase())} className="h-9 w-10 cursor-pointer rounded-md border-0 bg-transparent p-0" />
      </div>
    </div>

    <div className="space-y-5">
      <div><div className="mb-2 flex items-center justify-between"><label className="text-sm font-semibold text-slate-700">Renk tonu</label><span className="font-mono text-xs text-slate-500">{Math.round(hsv.h)}°</span></div><input aria-label="Renk tonu" className="theme-range hue-range" type="range" min="0" max="360" value={Math.round(hsv.h)} onChange={event => onChange(hsvToHex({ ...hexToHsv(value), h: Number(event.target.value) }))} /></div>
      <div><div className="mb-2 flex items-center justify-between"><label className="text-sm font-semibold text-slate-700">Doygunluk</label><span className="font-mono text-xs text-slate-500">{Math.round(hsv.s)}%</span></div><input aria-label="Doygunluk" className="theme-range" style={{ background: `linear-gradient(to right, hsl(${hsv.h} 0% ${hsv.v / 2}%), hsl(${hsv.h} 100% ${hsv.v / 2}%))`, accentColor: value }} type="range" min="0" max="100" value={Math.round(hsv.s)} onChange={event => onChange(hsvToHex({ ...hexToHsv(value), s: Number(event.target.value) }))} /></div>
      <div><div className="mb-2 flex items-center justify-between"><label className="text-sm font-semibold text-slate-700">Parlaklık</label><span className="font-mono text-xs text-slate-500">{Math.round(hsv.v)}%</span></div><input aria-label="Parlaklık" className="theme-range" style={{ background: `linear-gradient(to right, #000000, hsl(${hsv.h} ${hsv.s}% 50%))`, accentColor: value }} type="range" min="0" max="100" value={Math.round(hsv.v)} onChange={event => onChange(hsvToHex({ ...hexToHsv(value), v: Number(event.target.value) }))} /></div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Hızlı renkler</div><div className="flex flex-wrap gap-2">{['#1677FF', '#08A9F4', '#0B1329', '#FFFFFF', '#2D4D73', '#111827'].map(color => <button key={color} type="button" aria-label={`Renk ${color}`} title={color} onClick={() => onChange(color)} className={`h-8 w-8 rounded-lg border shadow-sm transition-transform hover:scale-110 ${value.toUpperCase() === color ? 'ring-2 ring-offset-2 ring-slate-700' : 'border-slate-300'}`} style={{ backgroundColor: color }} />)}</div></div>
      <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => onChange(DEFAULT_BRAND_COLOR)}><RotateCcw size={15}/> Varsayılan maviye dön</button>
    </div>
  </div>;
}
