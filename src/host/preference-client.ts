import { BoundaryError } from '../shared/errors.ts';
import type { ErrorCode } from '../shared/errors.ts';
import { readConfigSelection } from '../shared/configuration.ts';
import type { ConfigSelection } from '../shared/configuration.ts';
import { configPageSchema, healthSchema } from '../shared/protocol.ts';
import { utf8ByteLength } from '../shared/identity.ts';
import { preferenceRevisionSchema, preferenceStateSchema } from '../shared/preference-protocol.ts';
import type { PreferenceAppendRequest, PreferenceLedger, SourcePreferences } from '../shared/preference-protocol.ts';
import { PreferenceReader } from './preference-reader.ts';
import type { PreferenceReadStorage } from './preference-reader.ts';
import type { PreferenceServiceTransport } from './preference-transport.ts';

type Step = 'planned' | 'skipped' | 'storing' | 'stored' | 'blocked' | 'unknown';
export type PreferenceOutcome = { readonly id: string; readonly serviceGeneration: string; readonly kind: 'add-use' | 'use' | 'remove' | 'resolve'; readonly selection: ConfigSelection; readonly phase: 'prepared' | 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'conflict'; readonly known: Step; readonly active: Step; readonly revisions: readonly string[]; readonly code?: ErrorCode };
export type PreferenceState = { readonly phase: 'idle' | 'reading' | 'ready' | 'confirm' | 'running' | 'error'; readonly ledger?: PreferenceLedger; readonly outcome?: PreferenceOutcome; readonly expiresAt?: number; readonly error?: ErrorCode; readonly history: readonly PreferenceOutcome[] };
type Intent = { outcome: PreferenceOutcome; readonly ledger: PreferenceLedger; readonly preferences: SourcePreferences; readonly expiresAt: number; readonly epoch: number; readonly source?: { generation: string; identity: string }; readonly sourceCode?: ErrorCode; cancelled: boolean };
const equal = (a: ConfigSelection, b: ConfigSelection) => JSON.stringify(a) === JSON.stringify(b);
const codeOf = (error: unknown): ErrorCode => error instanceof BoundaryError ? error.code : 'STATE_UNAVAILABLE';

// WRITE preference controller. Never imported/constructed/called by automatic tests, even with mock storage.
// Unique immutable revision keys prevent a read-modify-set lost update; siblings remain explicit conflicts.
export class PreferenceClient {
  readonly #reader: PreferenceReader; readonly #set: (request: PreferenceAppendRequest) => Promise<void>; readonly #request: PreferenceServiceTransport;
  readonly #show: (state: PreferenceState) => void; readonly #activate: (selection: ConfigSelection) => Promise<void>;
  #ledger: PreferenceLedger | undefined; #intent: Intent | undefined; #history: readonly PreferenceOutcome[] = []; #epoch = 0; #readRevision = 0; #busy = false; #disposed = false;
  constructor(storage: PreferenceReadStorage & { append: (request: PreferenceAppendRequest) => Promise<void> }, request: PreferenceServiceTransport, show: (state: PreferenceState) => void, activate: (selection: ConfigSelection) => Promise<void>) {
    this.#reader = new PreferenceReader(storage); this.#set = value => storage.append(value); this.#request = request; this.#show = show; this.#activate = activate;
  }
  #emit(phase: PreferenceState['phase'], error?: ErrorCode) {
    if (!this.#disposed) this.#show({ phase, history: this.#history, ...(this.#ledger ? { ledger: this.#ledger } : {}), ...(this.#intent?.epoch === this.#epoch ? { outcome: this.#intent.outcome } : {}),
      ...(phase === 'confirm' && this.#intent ? { expiresAt: this.#intent.expiresAt } : {}), ...(error ? { error } : {}) });
  }
  #update(intent: Intent, values: Partial<PreferenceOutcome>) { intent.outcome = Object.freeze({ ...intent.outcome, ...values }); }
  #current(intent: Intent) {
    if (this.#disposed || intent.cancelled || intent.epoch !== this.#epoch) throw new BoundaryError('QUERY_CANCELLED');
    if (Date.now() >= intent.expiresAt) throw new BoundaryError('CONFIRMATION_EXPIRED');
  }
  async #inspect(selection: ConfigSelection) {
    const decode = (body: string): unknown => { if (utf8ByteLength(body) > 512_000) throw new BoundaryError('BUDGET_EXCEEDED'); try { return JSON.parse(body) as unknown; } catch { throw new BoundaryError('STATE_UNAVAILABLE'); } };
    const health = await this.#request({ method: 'GET', path: '/health' });
    const alive = healthSchema.safeParse(decode(health.body)); if (health.status !== 200 || !alive.success) throw new BoundaryError('STATE_UNAVAILABLE');
    const body = JSON.stringify({ protocol: 2, selection, page: { offset: 0, limit: 1 } });
    if (utf8ByteLength(body) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    const response = await this.#request({ method: 'POST', path: '/v2/configuration/read', body });
    if (response.status !== 200) throw new BoundaryError(response.status === 404 ? 'CONFIG_NOT_FOUND' : 'CONFIG_UNREADABLE');
    const parsed = configPageSchema.safeParse(decode(response.body)); if (!parsed.success || parsed.data.serviceGeneration !== alive.data.serviceGeneration || parsed.data.sources.mode !== selection.mode) throw new BoundaryError('STALE_TARGET');
    if (parsed.data.status !== 'ready' || parsed.data.sources.missingCount) throw new BoundaryError('CONFIG_NOT_FOUND');
    return { generation: parsed.data.serviceGeneration, identity: parsed.data.configIdentity };
  }
  async read(restore = false) {
    if (this.#disposed || this.#busy) return; this.reset(); const revision = ++this.#readRevision, epoch = this.#epoch; this.#emit('reading');
    try {
      const ledger = await this.#reader.read(); if (this.#disposed || epoch !== this.#epoch || revision !== this.#readRevision) return;
      this.#ledger = ledger; this.#emit('ready');
      // Read-only restore: no storage/configuration write, no authentication or cluster request.
      if (restore && ledger.preferences && !ledger.conflict) {
        const source = await this.#inspect(ledger.preferences.active);
        if (source.generation !== ledger.serviceGeneration || this.#disposed || epoch !== this.#epoch || revision !== this.#readRevision) throw new BoundaryError('STALE_TARGET');
        await this.#activate(ledger.preferences.active);
      }
    } catch (error) { if (!this.#disposed && epoch === this.#epoch && revision === this.#readRevision) this.#emit('error', codeOf(error)); }
  }
  async prepare(kind: PreferenceOutcome['kind'], input?: unknown, headId?: string) {
    if (this.#disposed || this.#busy) return; this.reset(); const epoch = this.#epoch; this.#busy = true; this.#emit('reading');
    try {
      const ledger = await this.#reader.read();
      if (this.#disposed || epoch !== this.#epoch) return;
      if (ledger.revisions.length >= 64) throw new BoundaryError('QUERY_LIMIT');
      const branch = headId ? ledger.heads.find(value => value.id === headId) : undefined;
      if (ledger.conflict && kind !== 'resolve') throw new BoundaryError('CONFLICT');
      if (kind === 'resolve' && (!ledger.conflict || !branch)) throw new BoundaryError('INVALID_INPUT');
      const preferences = preferenceStateSchema.parse(branch?.preferences ?? ledger.preferences ?? { active: { mode: 'default' }, known: [] });
      const selection = readConfigSelection(kind === 'resolve' ? preferences.active : input);
      let source: Intent['source'], sourceCode: ErrorCode | undefined;
      if (kind !== 'remove') try { source = await this.#inspect(selection); } catch (error) { sourceCode = codeOf(error); }
      if (kind !== 'add-use' && sourceCode) throw new BoundaryError(sourceCode);
      if (this.#disposed || epoch !== this.#epoch) return;
      const needsKnown = kind === 'add-use' && !preferences.known.some(value => equal(value, selection));
      if (!ledger.serviceGeneration || (source && source.generation !== ledger.serviceGeneration)) throw new BoundaryError('STALE_TARGET');
      const outcome: PreferenceOutcome = Object.freeze({ id: crypto.randomUUID(), serviceGeneration: ledger.serviceGeneration, kind, selection, phase: 'prepared', known: needsKnown || kind === 'remove' ? 'planned' : 'skipped', active: kind === 'remove' ? 'skipped' : 'planned', revisions: [] });
      this.#intent = { outcome, ledger, preferences, expiresAt: Date.now() + 60_000, epoch, cancelled: false, ...(source ? { source } : {}), ...(sourceCode ? { sourceCode } : {}) };
      this.#ledger = ledger; this.#emit('confirm', sourceCode);
    } catch (error) { if (!this.#disposed && epoch === this.#epoch) this.#emit('error', codeOf(error)); }
    finally { this.#busy = false; }
  }
  async #publish(intent: Intent, base: PreferenceLedger, preferences: SourcePreferences, step: 'known' | 'active') {
    this.#current(intent); const fresh = await this.#reader.read(); this.#current(intent);
    if (fresh.serviceGeneration !== intent.outcome.serviceGeneration) throw new BoundaryError('STALE_TARGET');
    if (fresh.identity !== base.identity) throw new BoundaryError('CONFLICT');
    if (fresh.revisions.length >= 64) throw new BoundaryError('QUERY_LIMIT');
    const event = preferenceRevisionSchema.parse({ schemaVersion: 1, id: crypto.randomUUID(), parents: fresh.heads.map(value => value.id).sort(), preferences });
    if (utf8ByteLength(JSON.stringify(event)) > 48_000 || utf8ByteLength(fresh.identity) + utf8ByteLength(JSON.stringify(event)) > 1_499_900) throw new BoundaryError('BUDGET_EXCEEDED');
    const request: PreferenceAppendRequest = step === 'known' ? { protocol: 2, serviceGeneration: intent.outcome.serviceGeneration, notAfter: intent.expiresAt, step, revision: event }
      : { protocol: 2, serviceGeneration: intent.outcome.serviceGeneration, notAfter: intent.expiresAt, step, revision: event, selection: event.preferences.active, configIdentity: intent.source?.identity ?? '' };
    if (utf8ByteLength(JSON.stringify(request)) > 48_000) throw new BoundaryError('BUDGET_EXCEEDED');
    this.#current(intent); this.#update(intent, { [step]: 'storing', revisions: Object.freeze([...intent.outcome.revisions, event.id]) }); this.#emit('running');
    try { await this.#set(request); } catch { this.#update(intent, { [step]: 'unknown' }); throw new BoundaryError('OPERATION_UNKNOWN'); }
    this.#update(intent, { [step]: 'stored' }); // A settled original storage result is recorded even after view cancellation/disposal.
    let after: PreferenceLedger;
    try { after = await this.#reader.read(); } catch { throw new BoundaryError('OPERATION_UNKNOWN'); }
    if (after.serviceGeneration !== intent.outcome.serviceGeneration) throw new BoundaryError('STALE_TARGET');
    if (!this.#disposed && intent.epoch === this.#epoch) this.#ledger = after;
    if (after.conflict || after.heads[0]?.id !== event.id) throw new BoundaryError('CONFLICT');
    return after;
  }
  async submit() {
    const intent = this.#intent; if (this.#disposed || this.#busy || !intent || intent.outcome.phase !== 'prepared') return;
    this.#busy = true; this.#update(intent, { phase: 'running' }); this.#emit('running');
    try {
      this.#current(intent); let base = intent.ledger, preferences = intent.preferences;
      if (intent.outcome.kind === 'remove') {
        preferences = preferenceStateSchema.parse({ ...preferences, known: preferences.known.filter(value => !equal(value, intent.outcome.selection)) });
        base = await this.#publish(intent, base, preferences, 'known');
      } else {
        if (intent.outcome.known === 'planned') {
          preferences = preferenceStateSchema.parse({ ...preferences, known: [...preferences.known, intent.outcome.selection] });
          base = await this.#publish(intent, base, preferences, 'known');
        }
        this.#current(intent);
        if (!intent.source) throw new BoundaryError(intent.sourceCode ?? 'CONFIG_UNREADABLE');
        const source = await this.#inspect(intent.outcome.selection); this.#current(intent);
        if (source.generation !== intent.source.generation || source.identity !== intent.source.identity) throw new BoundaryError('CONFIG_CHANGED');
        preferences = preferenceStateSchema.parse({ ...preferences, active: intent.outcome.selection });
        base = await this.#publish(intent, base, preferences, 'active');
      }
      this.#update(intent, { phase: 'succeeded' });
      if (intent.outcome.active === 'stored' && !this.#disposed && !intent.cancelled && intent.epoch === this.#epoch && base.preferences) await this.#activate(base.preferences.active);
    } catch (error) {
      const code = codeOf(error), storing = intent.outcome.known === 'storing' || intent.outcome.active === 'storing';
      this.#update(intent, { phase: storing || code === 'OPERATION_UNKNOWN' ? 'unknown' : code === 'CONFLICT' ? 'conflict' : code === 'QUERY_CANCELLED' ? 'cancelled' : 'failed',
        ...(intent.outcome.known === 'planned' ? { known: 'blocked' as const } : {}),
        ...(intent.outcome.active === 'planned' ? { active: 'blocked' as const } : {}), code });
    } finally {
      this.#history = Object.freeze([intent.outcome, ...this.#history].slice(0, 32)); this.#busy = false;
      if (intent.epoch !== this.#epoch) this.#intent = undefined;
      this.#emit('ready');
    }
  }
  reset() { ++this.#epoch; ++this.#readRevision; this.#ledger = undefined; if (this.#intent) this.#intent.cancelled = true; if (!this.#busy) this.#intent = undefined; this.#emit(this.#busy ? 'running' : 'idle'); }
  dispose() { this.reset(); this.#disposed = true; }
}
