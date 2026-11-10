import type { SupabaseClient } from '@supabase/supabase-js';
import { IS_OWNER_EDITION } from '@/lib/edition';

export type LocalFilter = { column: string; op: string; value?: unknown };
export type LocalQuerySpec = {
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
  columns?: string;
  values?: unknown;
  filters: LocalFilter[];
  orExpression?: string;
  order: Array<{ column: string; ascending?: boolean; nullsFirst?: boolean }>;
  offset?: number;
  limit?: number;
  single?: 'single' | 'maybeSingle';
  returning?: boolean;
  onConflict?: string;
};
type LocalResult = { data: any; error: { message: string; code?: string } | null; count?: number };
type DesktopDb = NonNullable<NonNullable<Window['proposDesktop']>['db']>;
type FunctionInvoke = (name: string, options?: { body?: Record<string, unknown>; headers?: Record<string, string> }) => Promise<any>;

function api() {
  const db = window.proposDesktop?.db;
  if (!db) throw new Error('Yerel Silopi Dijital - ProPOS veritabanı hazır değil.');
  return db;
}

function emitLocalChange(table: string, action: string) {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new CustomEvent('propos-local-data-change', { detail: { table, action } })); } catch {}
}

const RPC_CHANGED_TABLES: Record<string, string[]> = {
  increment_customer_balance: ['customers'],
  record_stock_movement: ['products', 'stock_movements'],
  complete_sale_atomic: ['sales','sale_items','sale_payments','products','stock_movements','customers','staff_earnings','staff_daily_earnings'],
  pay_customer_debt: ['customers','customer_payments','staff_earnings','staff_daily_earnings','cash_sessions','sales'],
  move_sale_to_trash_v2: ['sales','products','stock_movements','customers'],
  restore_sale_from_trash: ['sales','products','stock_movements','customers'],
  permanently_delete_sale: ['sales','sale_items','sale_payments','sale_returns'],
  record_partial_return: ['sale_returns','sales','products','stock_movements','customers','cash_sessions'],
  process_sale_return: ['sale_returns','sales','products','stock_movements','customers','cash_sessions','customer_payments','staff_earnings','staff_daily_earnings'],
  reverse_customer_payment: ['customer_payments','customers','staff_earnings','staff_daily_earnings','sales','cash_sessions'],
  restore_sale_excess_debt_payment: ['customer_payments','customers','staff_earnings','staff_daily_earnings','sales'],
  record_cash_count: ['cash_counts'],
  record_shop_product_expense_batch: ['cash_sessions','products','stock_movements'],
  receive_purchase_atomic: ['purchase_receipts','purchase_receipt_items','products','stock_movements'],
  pay_supplier_atomic: ['supplier_payments','purchase_receipts'],
  record_staff_consumption: ['staff_consumptions','products','stock_movements'],
  record_staff_consumption_batch: ['staff_consumptions','products','stock_movements'],
  record_staff_payout: ['staff_payouts','cash_sessions'],
  add_cash_manual_entry: ['cash_sessions'],
  cancel_cash_manual_entry: ['cash_sessions','cash_iban_exchanges'],
  create_cash_iban_exchange: ['cash_iban_exchanges','cash_sessions'],
  mark_cash_iban_received: ['cash_iban_exchanges'],
  close_cash_session_reconciled: ['cash_sessions','cash_reconciliations'],
  complete_stock_count: ['stock_counts','stock_count_items','products','stock_movements'],
};

function localChannel(channelName: string) {
  const subscriptions: Array<{ table?: string; event?: string; callback: (payload: any) => void }> = [];
  let listening = false;
  const onChange = (event: Event) => {
    const detail = (event as CustomEvent).detail || {};
    for (const sub of subscriptions) {
      if (sub.table && detail.table && sub.table !== detail.table) continue;
      if (sub.event && sub.event !== '*' && detail.action && sub.event.toLowerCase() !== String(detail.action).toLowerCase()) continue;
      try { sub.callback({ schema: 'public', table: detail.table, eventType: String(detail.action || '*').toUpperCase(), new: detail.row || {}, old: {} }); } catch (error) { console.error('[ProPOS] Local listener failed:', error); }
    }
  };
  const channel: any = {
    on(type: string, filter: any, callback: (payload: any) => void) {
      if (type === 'postgres_changes' && typeof callback === 'function') subscriptions.push({ table: filter?.table, event: filter?.event || '*', callback });
      return channel;
    },
    subscribe() {
      if (!listening && typeof window !== 'undefined') { window.addEventListener('propos-local-data-change', onChange); listening = true; }
      return channel;
    },
    async unsubscribe() {
      if (listening && typeof window !== 'undefined') window.removeEventListener('propos-local-data-change', onChange);
      listening = false; return 'ok';
    },
    topic: channelName,
  };
  return channel;
}

export class LocalQueryBuilder implements PromiseLike<LocalResult> {
  private spec: LocalQuerySpec;
  constructor(table: string) {
    this.spec = { table, action: 'select', columns: '*', filters: [], order: [] };
  }
  select(columns = '*', _options?: unknown) {
    this.spec.columns = columns;
    if (this.spec.action !== 'select') this.spec.returning = true;
    return this;
  }
  insert(values: unknown) { this.spec.action = 'insert'; this.spec.values = values; return this; }
  upsert(values: unknown, options?: { onConflict?: string }) { this.spec.action = 'upsert'; this.spec.values = values; this.spec.onConflict = options?.onConflict || 'id'; return this; }
  update(values: unknown) { this.spec.action = 'update'; this.spec.values = values; return this; }
  delete() { this.spec.action = 'delete'; return this; }
  eq(column: string, value: unknown) { this.spec.filters.push({ column, op: 'eq', value }); return this; }
  neq(column: string, value: unknown) { this.spec.filters.push({ column, op: 'neq', value }); return this; }
  is(column: string, value: unknown) { this.spec.filters.push({ column, op: 'is', value }); return this; }
  not(column: string, operator: string, value: unknown) {
    const op = operator === 'is' ? 'not_is' : operator === 'eq' ? 'not_eq' : operator === 'in' ? 'not_in' : operator === 'cs' ? 'not_contains' : `not_${operator}`;
    this.spec.filters.push({ column, op, value }); return this;
  }
  in(column: string, values: unknown[]) { this.spec.filters.push({ column, op: 'in', value: values }); return this; }
  gt(column: string, value: unknown) { this.spec.filters.push({ column, op: 'gt', value }); return this; }
  gte(column: string, value: unknown) { this.spec.filters.push({ column, op: 'gte', value }); return this; }
  lt(column: string, value: unknown) { this.spec.filters.push({ column, op: 'lt', value }); return this; }
  lte(column: string, value: unknown) { this.spec.filters.push({ column, op: 'lte', value }); return this; }
  like(column: string, value: string) { this.spec.filters.push({ column, op: 'like', value }); return this; }
  ilike(column: string, value: string) { this.spec.filters.push({ column, op: 'ilike', value }); return this; }
  contains(column: string, value: unknown) { this.spec.filters.push({ column, op: 'contains', value }); return this; }
  filter(column: string, operator: string, value: unknown) { this.spec.filters.push({ column, op: operator, value }); return this; }
  match(values: Record<string, unknown>) { for (const [column, value] of Object.entries(values)) this.eq(column, value); return this; }
  or(expression: string) { this.spec.orExpression = expression; return this; }
  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) { this.spec.order.push({ column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst }); return this; }
  limit(count: number) { this.spec.limit = Math.max(0, count); return this; }
  range(from: number, to: number) { this.spec.offset = Math.max(0, from); this.spec.limit = Math.max(0, to - from + 1); return this; }
  single() { this.spec.single = 'single'; return this.execute(); }
  maybeSingle() { this.spec.single = 'maybeSingle'; return this.execute(); }
  throwOnError() { return this.execute().then((r) => { if (r.error) throw Object.assign(new Error(r.error.message), r.error); return r; }); }
  abortSignal(_signal: AbortSignal) { return this; }
  private async execute(): Promise<LocalResult> {
    try {
      const result: any = await api().query(this.spec);
      if (result?.ok === false) return { data: null, error: { message: String(result.error || 'Yerel sorgu başarısız.'), code: result.code || 'LOCAL_DB_ERROR' } };
      if (!result?.error && this.spec.action !== 'select') emitLocalChange(this.spec.table, this.spec.action);
      return { data: result?.data ?? null, error: result?.error || null, count: result?.count };
    } catch (e) { return { data: null, error: { message: e instanceof Error ? e.message : String(e), code: 'LOCAL_DB_ERROR' } }; }
  }
  then<TResult1 = LocalResult, TResult2 = never>(onfulfilled?: ((value: LocalResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export async function localRpc(name: string, args: Record<string, unknown> = {}) {
  try {
    const result: any = await api().rpc(name, args);
    if (result?.ok === false || result?.error) return { data: null, error: { message: result.error || 'Yerel işlem başarısız.', code: result.code || 'LOCAL_RPC_ERROR' } };
    // RPCs may update more than one table; notify existing UI hooks after commit.
    for (const table of RPC_CHANGED_TABLES[name] || []) emitLocalChange(table, 'rpc');
    // Preserve a legitimate null result. Using `?? result` would turn it into the IPC wrapper.
    if (result && Object.prototype.hasOwnProperty.call(result, 'data') && Object.prototype.hasOwnProperty.call(result, 'error')) {
      return { data: result.data, error: result.error };
    }
    return { data: result, error: null };
  } catch (e: unknown) {
    return { data: null, error: { message: e instanceof Error ? e.message : String(e), code: 'LOCAL_RPC_ERROR' } };
  }
}
function localFailure(message: string, code = 'LOCAL_STAFF_ERROR') {
  return { data: { error: code, message }, error: { message, code } };
}
function businessIdFromBrowser() {
  try { return localStorage.getItem('propos-business-id'); } catch { return null; }
}
async function localStatus(db: DesktopDb) {
  try { return await db.status(); } catch { return { ok: false, initialized: false }; }
}
async function cacheStaffRows(db: DesktopDb, input: unknown) {
  if (!Array.isArray(input) || input.length === 0) return;
  const businessId = businessIdFromBrowser();
  const rows = input.filter((x): x is Record<string, any> => Boolean(x && typeof x === 'object' && typeof x.id === 'string'))
    .map(row => ({ ...row, business_id: row.business_id || businessId, pin: null, pin_hash: null }));
  if (!rows.length) return;
  const result = await db.query({ table: 'staff', action: 'upsert', values: rows, onConflict: 'id', filters: [], order: [], columns: '*', returning: false });
  if (result?.error) throw new Error(result.error.message || 'Personel yerel önbelleğe yazılamadı.');
}
async function cacheStaffPassword(db: DesktopDb, staff: any, pin: unknown) {
  if (typeof staff?.id === 'string' && typeof pin === 'string' && pin.length >= 4) {
    await cacheStaffRows(db, [{ ...staff, business_id: staff.business_id || businessIdFromBrowser() }]);
    await db.saveStaffPassword(staff.id, pin);
  }
}
function staffEnvelope(action: string, result: any) {
  if (result?.ok === false) return localFailure(result.error || 'Personel işlemi başarısız.', result.code || 'LOCAL_STAFF_ERROR');
  if (action === 'list') return { data: { data: Array.isArray(result?.data) ? result.data : [] }, error: null };
  if (action === 'verify_pin') return { data: { valid: result?.valid === true }, error: null };
  if (action === 'bootstrap_admin' || action === 'set_initial_admin_pin' || action === 'add_staff') return { data: { data: result?.data || result?.staff || null }, error: null };
  if (action === 'set_pin' || action === 'update_staff' || action === 'delete_staff') return { data: { success: result?.success === true }, error: null };
  return { data: result, error: null };
}
async function desktopStaffInvoke(invokeRemote: FunctionInvoke, db: DesktopDb, name: string, options?: { body?: Record<string, unknown>; headers?: Record<string, string> }) {
  const body = options?.body || {};
  const action = String(body.action || '');
  const status = await localStatus(db);
  if (status.ok === false) return localFailure('Yerel Silopi Dijital - ProPOS veritabanı başlatılamadı.', 'LOCAL_DB_NOT_READY');
  const initialized = status.initialized === true;

  // The private owner edition owns its staff/PIN ledger locally. Never fall back
  // to a customer backend or customer license endpoint for these actions.
  if (IS_OWNER_EDITION && ['list','bootstrap_admin','set_initial_admin_pin','verify_pin','set_pin','add_staff','update_staff','delete_staff'].includes(action)) {
    const local = await db.staffAction(action, body);
    if (local?.ok !== false && action !== 'list') emitLocalChange('staff', action);
    return staffEnvelope(action, local);
  }

  if (initialized && ['list','set_pin','add_staff','update_staff','delete_staff'].includes(action)) {
    const local = await db.staffAction(action, body);
    if (local?.ok !== false && action !== 'list') emitLocalChange('staff', action);
    return staffEnvelope(action, local);
  }
  if (action === 'verify_pin') {
    if (initialized) {
      const local = await db.staffAction('verify_pin', body);
      if (local?.ok === false) return staffEnvelope(action, local);
      if (local?.notStored !== true) return staffEnvelope(action, local);
      // PINs are never downloaded from the server. The first successful online
      // verification seeds a salted local hash; subsequent logins can work offline.
    } else {
      const local = await db.verifyStaffPassword(String(body.staff_id || ''), String(body.pin || ''));
      if (!local?.notStored) return { data: { valid: local?.valid === true }, error: null };
    }
    try {
      const remote = await invokeRemote(name, options);
      if (!remote.error && remote.data?.valid === true) await db.saveStaffPassword(String(body.staff_id || ''), String(body.pin || ''));
      return remote;
    } catch (e) { return localFailure(e instanceof Error ? e.message : 'PIN doğrulanamadı; internet bağlantısını kontrol edin.', 'STAFF_VERIFY_OFFLINE'); }
  }

  // License activation and first-admin setup must remain server-authoritative.
  // Before local data has been initialized, keep staff management online too.
  try {
    const remote = await invokeRemote(name, options);
    if (remote.error || remote.data?.error) return remote;
    if (action === 'list') await cacheStaffRows(db, remote.data?.data);
    const staffRow = remote.data?.data;
    if (['bootstrap_admin','set_initial_admin_pin'].includes(action) && staffRow?.id) await cacheStaffPassword(db, staffRow, body.pin);
    if (action === 'add_staff' && staffRow?.id) await cacheStaffPassword(db, staffRow, body.pin);
    if (action === 'set_pin' && body.staff_id) await db.saveStaffPassword(String(body.staff_id), String(body.pin || ''));
    return remote;
  } catch (e) {
    return localFailure(e instanceof Error ? e.message : 'Personel servisine ulaşılamadı.', 'STAFF_REMOTE_ERROR');
  }
}

export function createSupabaseDesktopProxy<T extends SupabaseClient>(remote: T): T {
  return new Proxy(remote, {
    get(target, property, receiver) {
      if (typeof window !== 'undefined' && window.proposDesktop?.db) {
        if (property === 'from') return (table: string) => new LocalQueryBuilder(table);
        if (property === 'rpc') return (name: string, args?: Record<string, unknown>) => localRpc(name, args);
        if (property === 'functions') {
          const functions = Reflect.get(target, property, receiver);
          return new Proxy(functions, {
            get(functionTarget, functionProperty, functionReceiver) {
              if (functionProperty === 'invoke') {
                const original = Reflect.get(functionTarget, functionProperty, functionReceiver).bind(functionTarget) as FunctionInvoke;
                return (name: string, options?: { body?: Record<string, unknown>; headers?: Record<string, string> }) => {
                  if (name === 'propos-staff-api' && window.proposDesktop?.db) return desktopStaffInvoke(original, window.proposDesktop.db, name, options);
                  return original(name, options);
                };
              }
              const value = Reflect.get(functionTarget, functionProperty, functionReceiver);
              return typeof value === 'function' ? value.bind(functionTarget) : value;
            },
          });
        }
        if (property === 'channel') return (channelName: string) => localChannel(channelName);
        if (property === 'removeChannel') return async (channel: any) => { try { await channel?.unsubscribe?.(); } catch {} return { error: null }; };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as T;
}
