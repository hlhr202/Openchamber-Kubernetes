import { hasWellFormedUnicode } from './identity.ts';
// Thompson NFA: user patterns never reach the JS backtracking RegExp engine.
// UTF-16/code-unit matching (no flags), regular subset only; no captures, backrefs, lookaround or counted repetition.
export type LogFilterError = 'FILTER_INVALID' | 'FILTER_UNSUPPORTED' | 'FILTER_BUDGET';
export class LogFilterFailure extends Error { readonly code: LogFilterError; constructor(code: LogFilterError) { super(code); this.code = code; } }
type Test = { kind: 'char'; accepts: (code: number) => boolean; out: number };
type State = Test | { kind: 'split'; left: number; right: number } | { kind: 'start' | 'end'; out: number } | { kind: 'match' };
type Patch = { index: number; slot: 'out' | 'left' | 'right' };
type Fragment = { start: number; ends: Patch[] };
export const logFilterPatternLimit = 128;
export const logFilterStepLimit = 2_000_000;
export function compileLogFilter(pattern: string) {
  if (pattern.length > logFilterPatternLimit) throw new LogFilterFailure('FILTER_BUDGET');
  if (!hasWellFormedUnicode(pattern)) throw new LogFilterFailure('FILTER_INVALID');
  const states: State[] = []; let at = 0;
  const add = (state: State) => { if (states.length >= 192) throw new LogFilterFailure('FILTER_BUDGET'); states.push(state); return states.length - 1; };
  const link = (ends: Patch[], target: number) => { for (const end of ends) { const state = states[end.index]; if (state && end.slot === 'out' && 'out' in state) state.out = target;
    else if (state?.kind === 'split' && end.slot === 'left') state.left = target; else if (state?.kind === 'split' && end.slot === 'right') state.right = target; else throw new LogFilterFailure('FILTER_INVALID'); } };
  const escaped = (): ((code: number) => boolean) => {
    const char = pattern[at++]; if (!char) throw new LogFilterFailure('FILTER_INVALID');
    const digit = (code: number) => code >= 48 && code <= 57;
    const word = (code: number) => digit(code) || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
    const space = (code: number) => code >= 9 && code <= 13 || code === 32 || code === 160 || code === 5760 || code >= 8192 && code <= 8202
      || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
    if (char === 'd') return digit; if (char === 'D') return code => !digit(code);
    if (char === 'w') return word; if (char === 'W') return code => !word(code);
    if (char === 's') return space; if (char === 'S') return code => !space(code);
    if ('bB0123456789pPkxu'.includes(char)) throw new LogFilterFailure('FILTER_UNSUPPORTED');
    const code = char.charCodeAt(0);
    if ((code >= 65 && code <= 90 || code >= 97 && code <= 122) && !'nrtvf'.includes(char)) throw new LogFilterFailure('FILTER_UNSUPPORTED');
    const value = char === 'n' ? 10 : char === 'r' ? 13 : char === 't' ? 9 : char === 'v' ? 11 : char === 'f' ? 12 : char.charCodeAt(0); return code => code === value;
  };
  const atom = (): Fragment => {
    const char = pattern[at++]; if (!char) throw new LogFilterFailure('FILTER_INVALID');
    if (char === '(') { if (pattern[at] === '?') throw new LogFilterFailure('FILTER_UNSUPPORTED'); const result = alternate(); if (pattern[at++] !== ')') throw new LogFilterFailure('FILTER_INVALID'); return result; }
    if ('*+?){|}'.includes(char)) throw new LogFilterFailure('FILTER_INVALID');
    let state: State;
    if (char === '^' || char === '$') state = { kind: char === '^' ? 'start' : 'end', out: -1 };
    else if (char === '[') {
      const negate = pattern[at] === '^'; if (negate) at++;
      const tests: Array<(code: number) => boolean> = [];
      while (at < pattern.length && pattern[at] !== ']') {
        if (pattern[at] === '\\') { at++; tests.push(escaped()); if (pattern[at] === '-' && pattern[at + 1] !== ']') throw new LogFilterFailure('FILTER_UNSUPPORTED'); continue; }
        const first = pattern.charCodeAt(at++);
        if (pattern[at] === '-' && pattern[at + 1] !== ']' && at + 1 < pattern.length) {
          at++; if (pattern[at] === '\\') throw new LogFilterFailure('FILTER_UNSUPPORTED'); const last = pattern.charCodeAt(at++);
          if (last < first) throw new LogFilterFailure('FILTER_INVALID'); tests.push(code => code >= first && code <= last);
        } else tests.push(code => code === first);
      }
      if (!tests.length || pattern[at++] !== ']') throw new LogFilterFailure('FILTER_INVALID');
      state = { kind: 'char', accepts: code => tests.some(test => test(code)) !== negate, out: -1 };
    } else state = { kind: 'char', accepts: char === '.' ? code => code !== 10 && code !== 13 : char === '\\' ? escaped() : code => code === char.charCodeAt(0), out: -1 };
    const index = add(state); return { start: index, ends: [{ index, slot: 'out' }] };
  };
  const sequence = (): Fragment => {
    let result: Fragment | undefined;
    while (at < pattern.length && pattern[at] !== '|' && pattern[at] !== ')') {
      let value = atom(); const quantifier = pattern[at];
      if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
        at++; const split = add({ kind: 'split', left: value.start, right: -1 });
        if (quantifier !== '?') link(value.ends, split);
        value = { start: quantifier === '+' ? value.start : split, ends: [...(quantifier === '?' ? value.ends : []), { index: split, slot: 'right' }] };
        if (pattern[at] === '?' || pattern[at] === '+' || pattern[at] === '*' || pattern[at] === '{') throw new LogFilterFailure('FILTER_UNSUPPORTED');
      } else if (quantifier === '{') throw new LogFilterFailure('FILTER_UNSUPPORTED');
      if (result) { link(result.ends, value.start); result = { start: result.start, ends: value.ends }; } else result = value;
    }
    if (result) return result;
    const index = add({ kind: 'split', left: -1, right: -1 }); return { start: index, ends: [{ index, slot: 'left' }, { index, slot: 'right' }] };
  };
  function alternate(): Fragment { let value = sequence(); while (pattern[at] === '|') { at++; const right = sequence(); value = { start: add({ kind: 'split', left: value.start, right: right.start }), ends: [...value.ends, ...right.ends] }; } return value; }
  const fragment = alternate(); if (at !== pattern.length) throw new LogFilterFailure('FILTER_INVALID'); link(fragment.ends, add({ kind: 'match' }));
  return (text: string, budget: { remaining: number }): boolean => {
    // Epsilon closure and fresh search starts share the same visited set at each position.
    let active: number[] = [];
    for (let pos = 0; pos <= text.length; pos++) {
      const seen = new Uint8Array(states.length), ready: number[] = [], pending = [...active, fragment.start];
      while (pending.length) {
        if (--budget.remaining < 0) throw new LogFilterFailure('FILTER_BUDGET');
        const index = pending.pop(); if (index === undefined || seen[index]) continue; seen[index] = 1; const state = states[index];
        if (!state) throw new LogFilterFailure('FILTER_INVALID');
        if (state.kind === 'match') return true;
        if (state.kind === 'split') pending.push(state.left, state.right);
        else if (state.kind === 'start') { if (pos === 0) pending.push(state.out); }
        else if (state.kind === 'end') { if (pos === text.length) pending.push(state.out); }
        else ready.push(index);
      }
      active = []; if (pos === text.length) break;
      const code = text.charCodeAt(pos);
      for (const index of ready) { if (--budget.remaining < 0) throw new LogFilterFailure('FILTER_BUDGET'); const state = states[index]; if (state?.kind === 'char' && state.accepts(code)) active.push(state.out); }
    }
    return false;
  };
}
