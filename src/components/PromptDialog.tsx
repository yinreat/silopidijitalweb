import { useCallback, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

type PromptOptions = {
  title?: string;
  placeholder?: string;
  defaultValue?: string;
  inputType?: 'text' | 'password';
  confirmLabel?: string;
  cancelLabel?: string;
  required?: boolean;
  helpText?: string;
};

type ActivePrompt = PromptOptions & { message: string };

/** Browser/Electron-safe replacement for window.prompt, which Electron does not support. */
export function usePromptDialog() {
  const [options, setOptions] = useState<ActivePrompt | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const prompt = useCallback((message: string, promptOptions: PromptOptions = {}) => {
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setValue(promptOptions.defaultValue ?? '');
      setOptions({
        title: promptOptions.title ?? 'Silopi Dijital - ProPOS',
        placeholder: promptOptions.placeholder ?? '',
        confirmLabel: promptOptions.confirmLabel ?? 'Onayla',
        cancelLabel: promptOptions.cancelLabel ?? 'Vazgeç',
        inputType: promptOptions.inputType ?? 'text',
        required: promptOptions.required ?? false,
        helpText: promptOptions.helpText,
        message,
      });
    });
  }, []);

  const finish = useCallback((result: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setOptions(null);
    if (resolve) resolve(result);
  }, []);

  let dialog: ReactNode = null;
  if (options) {
    dialog = (
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/60 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) finish(null); }}>
        <form
          role="dialog"
          aria-modal="true"
          aria-labelledby="propos-prompt-title"
          onSubmit={(event: FormEvent) => { event.preventDefault(); if (options.required && !value.trim()) return; finish(value); }}
          className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
        >
          <h2 id="propos-prompt-title" className="text-lg font-black text-slate-900">{options.title}</h2>
          <p className="mt-2 whitespace-pre-line text-sm leading-6 text-slate-600">{options.message}</p>
          <input
            autoFocus
            type={options.inputType}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={options.placeholder}
            className="mt-4 w-full rounded-lg border border-slate-300 px-3 py-3 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); finish(null); } }}
          />
          {options.helpText && <p className="mt-2 text-xs leading-5 text-slate-500">{options.helpText}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => finish(null)} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">{options.cancelLabel}</button>
            <button type="submit" disabled={Boolean(options.required && !value.trim())} className="rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50">{options.confirmLabel}</button>
          </div>
        </form>
      </div>
    );
  }

  return { prompt, dialog };
}
