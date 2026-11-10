import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, X, ScanLine, Check } from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';

type BarcodeScannerProps = {
  onDetected: (barcode: string) => void;
  onClose: () => void;
};

export default function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);
  const lastScanRef = useRef<{ code: string; time: number }>({ code: '', time: 0 });

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const reader = new BrowserMultiFormatReader();
        readerRef.current = reader;

        const allDevices = await BrowserMultiFormatReader.listVideoInputDevices();
        if (!mounted || allDevices.length === 0) {
          setError('Kamera bulunamadı. Cihazınızda kamera olduğundan emin olun.');
          return;
        }
        setDevices(allDevices);

        const backCamera = allDevices.find((d) => /back|rear|environment/i.test(d.label)) || allDevices[allDevices.length - 1];
        const deviceId = backCamera.deviceId;
        setSelectedDeviceId(deviceId);
        startScan(deviceId);
      } catch (err) {
        console.error('Kamera hatası:', err);
        setError('Kamera erişimi reddedildi. Tarayıcı ayarlarından kamera izni verin.');
      }
    }

    init();

    return () => {
      mounted = false;
      stopScan();
    };
  }, []);

  const stopScan = useCallback(() => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    setScanning(false);
  }, []);

  const startScan = useCallback((deviceId: string) => {
    if (!readerRef.current || !videoRef.current) return;

    stopScan();
    setScanning(true);
    setError('');

    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        facingMode: 'environment',
      },
    };

    readerRef.current
      .decodeFromConstraints(constraints, videoRef.current, (result, err) => {
        if (result) {
          const code = result.getText();
          const now = Date.now();

          if (code === lastScanRef.current.code && now - lastScanRef.current.time < 2000) return;
          lastScanRef.current = { code, time: now };

          setLastScan(code);
          navigator.vibrate?.(100);

          setTimeout(() => {
            onDetected(code);
          }, 600);
        }
      })
      .then((controls) => {
        controlsRef.current = controls;
      })
      .catch((err) => {
        console.error('Tarama başlatılamadı:', err);
        setError('Kamera başlatılamadı.');
        setScanning(false);
      });
  }, [onDetected, stopScan]);

  function switchCamera(deviceId: string) {
    setSelectedDeviceId(deviceId);
    startScan(deviceId);
  }

  return (
    <div className="fixed inset-0 z-[60] bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between bg-slate-800 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <ScanLine size={22} />
          <h2 className="text-base font-bold">Barkod Tara</h2>
        </div>
        <button onClick={() => { stopScan(); onClose(); }} className="rounded-lg p-1.5 hover:bg-slate-700">
          <X size={24} />
        </button>
      </div>

      {/* Camera View */}
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          autoPlay
          playsInline
          muted
          style={{ objectFit: 'cover' }}
        />

        {/* Scan frame overlay */}
        {scanning && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="relative h-48 w-72 rounded-xl border-2 border-white/80 shadow-2xl">
              <div className="absolute left-0 top-0 h-6 w-6 border-l-4 border-t-4 border-teal-400 rounded-tl-lg" />
              <div className="absolute right-0 top-0 h-6 w-6 border-r-4 border-t-4 border-teal-400 rounded-tr-lg" />
              <div className="absolute left-0 bottom-0 h-6 w-6 border-l-4 border-b-4 border-teal-400 rounded-bl-lg" />
              <div className="absolute right-0 bottom-0 h-6 w-6 border-r-4 border-b-4 border-teal-400 rounded-br-lg" />
              <div className="absolute left-2 right-2 top-1/2 h-0.5 bg-teal-400 animate-pulse" style={{ animation: 'scanline 2s ease-in-out infinite' }} />
            </div>
          </div>
        )}

        {/* Last scan result */}
        {lastScan && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-white shadow-lg">
            <Check size={18} />
            <span className="font-mono text-sm font-medium">{lastScan}</span>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <Camera size={48} className="text-slate-500" />
            <p className="text-sm text-slate-300">{error}</p>
            <button onClick={() => window.location.reload()} className="btn-primary px-4 py-2 text-sm">
              Tekrar Dene
            </button>
          </div>
        )}
      </div>

      {/* Camera switcher */}
      {devices.length > 1 && (
        <div className="bg-slate-800 px-4 py-3">
          <div className="flex gap-2 overflow-x-auto">
            {devices.map((device) => (
              <button
                key={device.deviceId}
                onClick={() => switchCamera(device.deviceId)}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  selectedDeviceId === device.deviceId
                    ? 'bg-teal-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {device.label || `Kamera ${device.deviceId.slice(0, 8)}`}
              </button>
            ))}
          </div>
        </div>
      )}

      <style>{`
        @keyframes scanline {
          0% { top: 10%; }
          50% { top: 90%; }
          100% { top: 10%; }
        }
      `}</style>
    </div>
  );
}
