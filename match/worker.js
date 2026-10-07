
const __M = {
"web/js/engine.js": [async function(__x, __req){
/* engine.js — the wasm binding.  The web equivalent of pchsynth/graph.py.
 *
 * Runs in TWO places, unchanged:
 *
 *   - inside the AudioWorklet, where it owns the live graph and renders audio
 *   - on the main thread, where a SECOND instance of the same wasm answers
 *     "what does this knob do" — filter responses, envelope shapes, waveform
 *     previews, physical units
 *
 * That second instance is the thing that keeps this project's central rule
 * true on the web.  The rule is: the curve a UI draws is a MEASUREMENT of the
 * DSP, not a second implementation of it.  A browser UI could trivially draw a
 * filter response from a formula in JavaScript, and it would be wrong the first
 * time anyone touched pcks_svf.h.  So the UI asks C, exactly as the Qt one
 * does — it just asks a copy that is not on the audio thread.
 *
 * There is no SharedArrayBuffer anywhere here, and that is deliberate: it needs
 * COOP/COEP headers, which a file:// page and a static host cannot set.  The
 * cost is one postMessage hop for control changes, which is inaudible, and the
 * benefit is that the app opens by double-clicking an HTML file.
 */

/* Field order for pw_status().  Mirrors pcks_web.c — the ONLY other place it is
 * written down.  This project has already shipped a struct-order mismatch that
 * reported MIDI note 1033867454; keeping the two lists adjacent in review is
 * the whole mitigation. */
const STATUS_FIELDS = [
  'active_voices', 'stuck_voices', 'peak_l', 'peak_r',
  'cpu', 'focus_note', 'focus_note_time', 'nonfinite',
];

const SCOPE_VOICE = 0, SCOPE_GLOBAL = 1;
const PORT_AUDIO = 0, PORT_CV = 1, PORT_GATE = 2;
const KNOB = 0, SELECT = 1, TOGGLE = 2;
const LIN = 0, EXP = 1, QUAD = 2, STEP = 3;
const POLY = 0, MONO = 1, LEGATO = 2;

class Wasm {
  /** @param {BufferSource|WebAssembly.Module} bytes */
  static async load(bytes) {
    const w = new Wasm();
    const imports = {
      env: {
        /* Growth invalidates every typed-array view onto the heap.  Silently
         * keeping a stale view is the classic wasm heisenbug: reads succeed and
         * return the wrong memory.  This is the notification, so re-acquire. */
        emscripten_notify_memory_growth: () => w._views(),
      },
    };
    const r = bytes instanceof WebAssembly.Module
      ? { instance: await WebAssembly.instantiate(bytes, imports) }
      : await WebAssembly.instantiate(bytes, imports);
    w.x = r.instance.exports;
    w.memory = w.x.memory;
    w._views();
    if (w.x._initialize) w.x._initialize();
    return w;
  }

  _views() {
    const b = this.memory.buffer;
    this.u8 = new Uint8Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
  }

  /* The heap can grow under any wasm call that allocates, so every accessor
   * checks rather than caching.  One length comparison per access is nothing
   * next to reading freed memory. */
  get U8()  { if (this.u8.buffer !== this.memory.buffer) this._views(); return this.u8; }
  get I32() { if (this.i32.buffer !== this.memory.buffer) this._views(); return this.i32; }
  get F32() { if (this.f32.buffer !== this.memory.buffer) this._views(); return this.f32; }

  /** The borrowed scratch block.  Valid only until the next call that uses it. */
  get scratch() {
    if (this._scr === undefined) {
      this._scr = this.x.pw_scratch();
      this._scrN = this.x.pw_scratch_size();
    }
    return this._scr;
  }
  get scratchSize() { void this.scratch; return this._scrN; }

  /** Write a JS string into wasm memory as NUL-terminated UTF-8. */
  str(s, ptr) {
    const b = new TextEncoder().encode(s);
    const u8 = this.U8;
    u8.set(b, ptr);
    u8[ptr + b.length] = 0;
    return ptr;
  }

  /* Node ids are short and passed constantly (every param set, every viz read).
   * They get a dedicated slice at the END of scratch so that a call taking two
   * ids plus a JSON result does not have them overwrite each other. */
  id(s, slot = 0) {
    const at = this.scratch + this.scratchSize - 128 + slot * 32;
    return this.str(s, at);
  }

  cstr(ptr, max = 1 << 20) {
    const u8 = this.U8;
    let end = ptr;
    while (end < u8.length && end - ptr < max && u8[end]) end++;
    return new TextDecoder().decode(u8.subarray(ptr, end));
  }

  malloc(n) { return this.x.malloc(n); }
  free(p)   { this.x.free(p); }
}

/* ------------------------------------------------------------------ registry
 * Parsed once.  Everything the palette, the inspector and the canvas know about
 * a block comes from here, which comes from the C tables — there is no list of
 * block names in the JavaScript and there must never be one. */
function readRegistry(w) {
  const need = w.x.pw_registry_json(0, 0) + 1;
  const p = need <= w.scratchSize ? w.scratch : w.malloc(need);
  w.x.pw_registry_json(p, need);
  const json = w.cstr(p);
  if (p !== w.scratch) w.free(p);

  const reg = JSON.parse(json);
  for (const t of reg.types) {
    t.isVoice = t.scope === SCOPE_VOICE;
    t.paramByKey = new Map(t.params.map((x, i) => [x.key, i]));
    t.inByKey    = new Map(t.in.map((x, i) => [x.key, i]));
    t.outByKey   = new Map(t.out.map((x, i) => [x.key, i]));
  }
  reg.byType = new Map(reg.types.map(t => [t.type, t]));
  reg.groups = new Map();
  for (const t of reg.types) {
    if (!reg.groups.has(t.group)) reg.groups.set(t.group, []);
    reg.groups.get(t.group).push(t);
  }

  /* EVERY KNOB MUST HAVE A REACHABLE DEFAULT, checked once at boot.
   *
   * inverseCurve(spec, spec.def) is what app.js and the patch loader set a
   * freshly placed block's knobs to, so a spec these laws cannot invert is a
   * knob that starts at NaN — and NaN spreads through the graph without
   * tripping anything (pw_status().nonfinite is a feedback-scrub counter, not a
   * NaN detector, so it kept reporting 0 while 81856 of 81920 samples were not
   * numbers). This is the loud failure that was missing: it caught nothing on
   * the day it was written, because the EXP floor above is what it would have
   * caught, and it costs one pass over 137 params. */
  const bad = [];
  for (const t of reg.types) {
    for (const p of t.params) {
      if (!Number.isFinite(inverseCurve(p, p.def))) bad.push(`${t.type}.${p.key}`);
    }
  }
  if (bad.length) {
    throw new Error(`these knobs have no reachable default — the curve laws in `
                  + `engine.js and pcks_params.c have drifted: ${bad.join(', ')}`);
  }
  return reg;
}

/* Normalised -> physical and back.  Deliberately NOT reimplemented here even
 * though the four curve laws are three lines each: pcks_param_physical is the
 * function the core actually uses, and a JS copy of it is a second source of
 * truth for what every knob readout says. */
function physical(w, spec, norm) {
  return applyCurve(spec, norm);
}

/* ...with one exception, and it is worth being explicit about why.
 *
 * pcks_param_physical() takes a param ID from the FIXED synth's flat table.
 * Node params carry their own {curve,min,max,steps} instead, so there is no id
 * to pass.  The laws are the enum in pcks.h and they are four lines; they are
 * reproduced here because the alternative is a per-node C entry point that
 * would exist only to re-read numbers JS already has.  If a fifth curve is ever
 * added to pcks.h, this must gain it — hence the throw, so that a new curve
 * shows up as a loud failure rather than as a knob that reads wrong. */
/* TWO LAWS WERE COPIED FROM THE COMMENT AND NOT FROM THE CODE, and both are
 * repaired here against pcks_params.c's pcks_param_map/pcks_param_unmap, which
 * is the function the core actually uses.
 *
 *   EXP  the C floors `min` at 1e-6 before taking the ratio. Without the floor
 *        a min of 0 gives 0 * (max/0)^t = 0 * Infinity^t = NaN. env.follow's
 *        `attack` (n_util2.c, NP_KNOB min 0 max 1 def 0.005 PCKS_EXP) is the
 *        one registry param with min == 0, and it read NaN at 200 of 201 grid
 *        points; inverseCurve(spec, spec.def) was NaN where C says
 *        0.6164949536323547. app.js:500 and patch.js:299 set every knob of a
 *        newly placed block to exactly that, so dragging a Follower onto the
 *        canvas was enough: MEASURED end to end (osc.va -> env.follow -> mod
 *        depth 1.0 -> util.amp.gain -> out.stereo, 40960 frames), 81856 of
 *        81920 output samples came back non-finite, and 0 of 81920 with the C
 *        default written over it.
 *   STEP the C returns `min + round(t*(n-1))` — a PHYSICAL value, like every
 *        other law here. The JS returned the bare index. Every one of the 13
 *        STEP params in the registry has min 0, so the two agree today and
 *        nothing shipped moves; the difference is one whole step the first time
 *        a selector is declared from 1. Callers wanting the INDEX go through
 *        selectIndex() below rather than reading a physical value as one.
 *
 * The clamps are the C's too (pcks_param_unmap clamps to [0,1] and refuses a
 * degenerate span), so an out-of-range value typed into a readout cannot set a
 * knob outside its own travel in one host and inside it in the other. */
function applyCurve(spec, t) {
  t = Math.min(1, Math.max(0, t));
  switch (spec.curve) {
    case LIN:  return spec.min + t * (spec.max - spec.min);
    case EXP:  { const lo = Math.max(spec.min, 1e-6);
                 return lo * Math.pow(spec.max / lo, t); }
    case QUAD: return spec.min + t * t * (spec.max - spec.min);
    case STEP: return spec.min + Math.round(t * Math.max(1, spec.steps - 1));
    default:   throw new Error(`unknown param curve ${spec.curve} on ${spec.key}`);
  }
}

function inverseCurve(spec, v) {
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  switch (spec.curve) {
    case LIN:  return spec.max > spec.min
                    ? clamp01((v - spec.min) / (spec.max - spec.min)) : 0;
    case EXP:  { const lo = Math.max(spec.min, 1e-6);
                 return clamp01(Math.log(Math.max(v, lo) / lo)
                                / Math.log(spec.max / lo)); }
    case QUAD: return spec.max > spec.min
                    ? clamp01(Math.sqrt(clamp01((v - spec.min) / (spec.max - spec.min))))
                    : 0;
    case STEP: return clamp01((v - spec.min) / Math.max(1, spec.steps - 1));
    default:   throw new Error(`unknown param curve ${spec.curve} on ${spec.key}`);
  }
}

/** Which entry of `enums` a normalised value names.
 *
 *  applyCurve returns the PHYSICAL value and a STEP's physical value is
 *  `min + index`, so an index is one subtraction away and not the same number.
 *  Every selector in the registry starts at 0 and the two are identical today —
 *  which is exactly why the difference has to be written down somewhere rather
 *  than left to be rediscovered by a face that reads one label late. */
function selectIndex(spec, norm) {
  return Math.round(applyCurve(spec, norm) - spec.min);
}

function enumLabels(spec) {
  return spec.enums ? spec.enums.split('|') : [];
}

/* Human-readable value, in the knob's own units — "3.2 kHz", "250 ms", "lp",
 * "saw → pulse 40%". */
/**
 * WHAT ONE MODULATION LINK DOES, in one line, for a readout.
 *
 * EIGHT PLACES formatted this by hand as `+0.35`, and every one of them called
 * a RANGE link "+0.00" — a macro that completely OWNS a knob reported as a link
 * doing nothing at all, on the board's tooltips, in the wire inspector and in
 * the "driven by" line. The same defect had already been found one layer down,
 * in pcks_graph_effective(), and for the same reason: a second copy of a rule
 * does not learn about a new case.
 *
 * `spec` is optional and only improves a range: with it the ends are shown in
 * the destination's own units, without it as the raw 0..1.
 */
function modLabel(link, spec) {
  const r = link && link.range;
  if (Array.isArray(r) && r.length === 2) {
    return spec ? `sets ${formatValue(spec, r[0])} → ${formatValue(spec, r[1])}`
                : `sets ${(+r[0]).toFixed(2)} → ${(+r[1]).toFixed(2)}`;
  }
  const a = Number(link && link.amount) || 0;
  return `${a >= 0 ? '+' : ''}${a.toFixed(2)}`;
}

function formatValue(spec, norm) {
  if (spec.kind === SELECT) {
    const labels = enumLabels(spec);
    return labels[selectIndex(spec, norm)] ?? '?';
  }
  if (spec.kind === TOGGLE) return applyCurve(spec, norm) >= 0.5 ? 'on' : 'off';
  const v = applyCurve(spec, norm);
  /* A KNOB CARRYING LABELS is a morph: the labels are the positions it passes
   * THROUGH rather than a choice between them, evenly spaced across min..max
   * (n_common.h's NP_MORPH). "0.67" says nothing; "saw" and "saw → pulse 40%"
   * say where you are and which way you are going, from the registry alone —
   * no host needs to know which block it is looking at.
   *
   * A fade that ROUNDS to 100% reads as the next label rather than as the
   * previous one at full. That is not cosmetic: a file stores six significant
   * figures, so an anchor at 1/3 comes back as 0.333333 and lands a millionth
   * short of the triangle — "sine → triangle 100%" would be the readout for
   * every migrated patch. */
  const morph = spec.kind === KNOB ? enumLabels(spec) : [];
  if (morph.length > 1) {
    const span = spec.max - spec.min;
    const u = span ? ((v - spec.min) / span) * (morph.length - 1) : 0;
    const i = Math.min(morph.length - 2, Math.max(0, Math.floor(u)));
    const pct = Math.round((u - i) * 100);
    if (pct <= 0) return morph[i];
    if (pct >= 100) return morph[i + 1];
    return `${morph[i]} → ${morph[i + 1]} ${pct}%`;
  }
  const u = spec.unit;
  if (u === 'Hz' && Math.abs(v) >= 1000) return (v / 1000).toFixed(2) + ' kHz';
  if (u === 's'  && Math.abs(v) < 1)     return (v * 1000).toFixed(0) + ' ms';
  if (u === '%')                          return (v * 100).toFixed(0) + ' %';
  const mag = Math.abs(v);
  const dp = mag >= 100 ? 0 : mag >= 10 ? 1 : mag >= 1 ? 2 : 3;
  return v.toFixed(dp) + (u ? ' ' + u : '');
}

/** A matrix source's label, cut to fit the core's buffer (PCKS_MX_LABEL_MAX
 *  counts the terminator) on a UTF-8 boundary. The worklet marshals a string
 *  into a 32-byte id slot, so an uncut label from a file would write into the
 *  next slot — or past the end of scratch. */
function matrixLabel(s, max = 24) {
  let t = String(s ?? '');
  const enc = new TextEncoder();
  while (t && enc.encode(t).length > max - 1) t = t.slice(0, -1);
  return t;
}

/* --------------------------------------------------------------------- graph */
class Graph {
  constructor(wasm, reg, sr = 48000, maxVoices = 16) {
    this.w = wasm;
    this.reg = reg;
    this.sr = sr;
    this.g = wasm.x.pcks_graph_create(sr, maxVoices);
    if (!this.g) throw new Error(`pcks_graph_create failed at ${sr} Hz`);
    this._out = 0;
    this._outFrames = 0;
    this._scratchF = 0;

    /* Host-side mirror of the BASE parameter values.
     *
     * pcks_graph_set_param() QUEUES an event; pcks_graph_get_param() reads the
     * array that events are drained into. So between setting a knob and the
     * next drain (which happens at compile, or at the top of a render block)
     * the core still reports the OLD value. A UI that read the knob back
     * immediately — as a save, an undo or a redraw does — would get the value
     * from before the user turned it.
     *
     * The Python host does not hit this because it mirrors parameters in its
     * NodeInstance objects. This is that mirror. It holds only what the host
     * itself set; anything MODULATION does is not here and must be read from
     * effective(), which is a live measurement of the running graph. */
    this._base = new Map();

    /* THE MATRIX MIRROR (pcks_matrix.h), for the same reason as `_base`: a
     * cell rides the event ring, so the core reports it only after the next
     * drain, and a host that set one and read it straight back — a save, an
     * undo, the inspector redrawing under the finger — would read the old one.
     * `sources` is the declaration in order ({id, port, label}); that order is
     * the dropdown, the summation order and the lag priority in the core, so
     * it is kept, never sorted. `cells` is `dst\0param` -> [{src, amount}] in
     * declared-source order, as the drain holds them. */
    this._mx = { sources: [], cells: new Map() };
  }

  /* EVERY buffer this object allocated, not just the two the first version
   * remembered. renderDecimated() adds two more — the decimator state and the
   * hi-rate scratch — and they were leaked on every teardown.
   *
   * MEASURED, wrapping malloc/free into a ledger: the renderInto path did 1
   * malloc and 1 free per create->render->destroy cycle and leaked 0 B; the
   * renderDecimated path did 3 mallocs and 1 free and leaked exactly
   * pw_decim_size() + frames*os*2*4 — 9236 B at N=256 os=4, 33812 B at
   * N=1024 os=4, 66580 B at N=2048 os=4, 17428 B at N=1024 os=2. That is
   * ~33 KiB per engine-rate switch in the ScriptProcessor fallback, which is
   * the only caller (audio.js setOversample/start both rebuild the mirror).
   * The worklet never hit it: it reuses one decimator and re-inits it.
   *
   * The LENGTHS have to go back with the pointers. `_hiN` and `_outFrames` are
   * "how big is the block I already have"; leaving one set while its pointer is
   * 0 turns the next render into a write through a null pointer rather than a
   * fresh allocation, so a second destroy() — or a resurrected object — would
   * be worse than the leak it replaced. */
  destroy() {
    if (this.g) this.w.x.pcks_graph_destroy(this.g);
    if (this._out) this.w.free(this._out);
    if (this._scratchF) this.w.free(this._scratchF);
    if (this._dec) this.w.free(this._dec);
    if (this._hi) this.w.free(this._hi);
    this.g = this._out = this._scratchF = this._dec = this._hi = 0;
    this._outFrames = this._hiN = 0;
    this._decOs = 0;
  }

  /* -- building -- */
  add(type, id)  { return this.w.x.pcks_graph_add(this.g, this.w.id(type, 0), this.w.id(id, 1)); }
  remove(id) {
    this._base.delete(id);
    /* The core frees the cells ON a removed block; a removed SOURCE stays
     * declared by id and reads 0 until the host re-declares (app.js does). */
    for (const k of [...this._mx.cells.keys()]) if (k.split('\u0000')[0] === id) this._mx.cells.delete(k);
    return this.w.x.pcks_graph_remove(this.g, this.w.id(id, 0));
  }
  clear() {
    this._base.clear();
    this._mx = { sources: [], cells: new Map() };
    this.w.x.pcks_graph_clear(this.g);
  }

  connect(src, sp, dst, dp) {
    return this.w.x.pcks_graph_connect(this.g, this.w.id(src, 0), sp,
                                               this.w.id(dst, 1), dp);
  }
  disconnect(src, sp, dst, dp) {
    return this.w.x.pcks_graph_disconnect(this.g, this.w.id(src, 0), sp,
                                                  this.w.id(dst, 1), dp);
  }
  modulate(src, sp, dst, param, amount) {
    return this.w.x.pcks_graph_modulate(this.g, this.w.id(src, 0), sp,
                                                this.w.id(dst, 1), param, amount);
  }
  /** The other mode: SET the destination over `lo`..`hi`, both NORMALISED.
   *  Contract and reasoning: pcks_graph_modulate_range in pcks_graph.h. Either
   *  order is allowed — hi < lo runs the destination backwards. */
  modulateRange(src, sp, dst, param, lo, hi) {
    return this.w.x.pcks_graph_modulate_range(this.g, this.w.id(src, 0), sp,
                                              this.w.id(dst, 1), param, lo, hi);
  }
  demodulate(src, sp, dst, param) {
    return this.w.x.pcks_graph_demodulate(this.g, this.w.id(src, 0), sp,
                                                  this.w.id(dst, 1), param);
  }

  /* -- the modulation matrix (pcks_matrix.h) --
   * DECLARING is structural (it clears `compiled`, like adding a link); SETTING
   * cells is live — one event per destination carrying its complete list, no
   * recompile, so a preset can re-aim modulation mid-note. */
  matrixDeclare(id, port, label = '') {
    const lb = matrixLabel(label, this.reg.matrix?.label_max);
    const rc = this.w.x.pcks_graph_matrix_declare(this.g, this.w.id(id, 0), port, this.w.id(lb, 1));
    if (rc === 0) this._mx.sources.push({ id, port, label: String(label ?? '') });
    return rc;
  }
  matrixUndeclareAll() {
    this.w.x.pcks_graph_matrix_undeclare_all(this.g);
    this._mx = { sources: [], cells: new Map() };
  }
  /** `rows`: [{src, amount}] by declared index, at most `reg.matrix.per_dst`
   *  (8 — one per declared source); [] clears. */
  matrixSet(dst, param, rows) {
    const r = (rows ?? []).filter(x => x && x.src >= 0);
    if (r.length > (this.reg.matrix?.per_dst ?? 2)) return 6;          /* PCKS_ERR_FULL */
    for (let i = 1; i < r.length; i++)
      for (let j = 0; j < i; j++) if (r[i].src === r[j].src) return 2;  /* PCKS_ERR_DUPLICATE_ID */
    let rc = 0;
    for (const c of Graph.matrixCalls(dst, param, r)) {
      const [fn, , p, ...nums] = c;
      rc = this.w.x[fn](this.g, this.w.id(dst, 0), p, ...nums);
      if (rc !== 0) break;
    }
    if (rc === 0) {
      const k = dst + '\u0000' + param;
      if (r.length) {
        this._mx.cells.set(k, r.map(x => ({ src: x.src | 0, amount: +x.amount }))
                              .sort((x, y) => x.src - y.src));
      } else this._mx.cells.delete(k);
    }
    return rc;
  }
  /** A destination's COMPLETE list as core calls, pcks_graph_matrix_set_list's
   *  own split spelled out (the worklet marshals numbers, not arrays): the first
   *  two rows are the one event the two-row setter always sent — so a two-row
   *  patch drains exactly as it did — and each further row is one amount. */
  static matrixCalls(dst, param, rows) {
    const a = rows[0] ?? { src: -1, amount: 0 }, b = rows[1] ?? { src: -1, amount: 0 };
    const out = [['pcks_graph_matrix_set', dst, param, a.src, a.amount, b.src, b.amount]];
    for (let k = 2; k < rows.length; k++)
      out.push(['pcks_graph_matrix_set_amount', dst, param, rows[k].src, rows[k].amount]);
    return out;
  }
  /** ONE source's depth on one destination — the modulation grid. 0 removes
   *  that row; anything else adds it or moves it in place (pcks_matrix.h). */
  matrixSetAmount(dst, param, src, amount) {
    const a = Number.isFinite(+amount) ? +amount : 0;
    const rc = this.w.x.pcks_graph_matrix_set_amount(this.g, this.w.id(dst, 0), param, src | 0, a);
    if (rc === 0) {
      const k = dst + '\u0000' + param;
      const rows = (this._mx.cells.get(k) ?? []).filter(x => x.src !== (src | 0));
      if (a !== 0) rows.push({ src: src | 0, amount: a });
      rows.sort((x, y) => x.src - y.src);
      if (rows.length) this._mx.cells.set(k, rows); else this._mx.cells.delete(k);
    }
    return rc;
  }
  /** The declaration, as set — a copy. */
  matrixSources() { return this._mx.sources.map(s => ({ ...s })); }
  /** One destination's cells, as set — a copy, [] for none. */
  matrixCells(dst, param) {
    return (this._mx.cells.get(dst + '\u0000' + param) ?? []).map(x => ({ ...x }));
  }
  /** Every destination holding cells: [{node, index, rows}]. */
  matrixCellList() {
    const out = [];
    for (const [k, rows] of this._mx.cells) {
      const cut = k.indexOf('\u0000');
      out.push({ node: k.slice(0, cut), index: Number(k.slice(cut + 1)),
                 rows: rows.map(x => ({ ...x })) });
    }
    return out;
  }
  /** What the ENGINE holds (the last drained state) — for tests and parity,
   *  never for a UI, which reads the mirror above. */
  matrixGet(dst, param) {
    const w = this.w, p = w.scratch, per = this.reg.matrix?.per_dst ?? 2;   /* per ints, then per floats */
    const n = w.x.pcks_graph_matrix_get(this.g, w.id(dst, 0), param, p, p + 4 * per);
    const I = w.I32, F = w.F32, at = p >> 2;
    const out = [];
    for (let k = 0; k < n; k++) out.push({ src: I[at + k], amount: F[at + per + k] });
    return out;
  }
  /** 1 when declared source `src` is scheduled after `dst`, so a cell between
   *  them reads the previous block (one engine block of lag). */
  matrixLagged(src, dst) { return !!this.w.x.pcks_graph_matrix_lagged(this.g, src, this.w.id(dst, 0)); }
  /* -- the host's world (pcks_graph.h): not part of the patch, plain stores in
   * the core — no event, no recompile — and they survive clear(). */
  setTempo(bpm) { this.w.x.pcks_graph_set_tempo(this.g, +bpm); }
  tempo()       { return this.w.x.pcks_graph_tempo(this.g); }
  /** `kind`: an index or a name from reg.sensors ("compass" …); normalised value. */
  setSensor(kind, v) {
    const k = typeof kind === 'string' ? (this.reg.sensors ?? []).indexOf(kind) : kind | 0;
    if (k >= 0) this.w.x.pcks_graph_set_sensor(this.g, k, +v);
  }
  clearSensor(kind = -1) {
    const k = typeof kind === 'string' ? (this.reg.sensors ?? []).indexOf(kind) : kind | 0;
    this.w.x.pcks_graph_clear_sensor(this.g, k);
  }
  /** Is declared source `i` per-voice (read at the newest held key)? */
  matrixSourceVoice(i) {
    const w = this.w, p = w.scratch;
    if (w.x.pcks_graph_matrix_source_info(this.g, i, 0, 0, 0, p) !== 0) return false;
    return w.I32[p >> 2] !== 0;
  }

  /** @returns {{code:number, ok:boolean, message:string, node:string, ...}} */
  compile() {
    const w = this.w;
    const ints = w.scratch;                 /* 5 ints */
    const id = ints + 32;                   /* PCKS_NODE_ID_MAX */
    const code = w.x.pw_compile(this.g, ints, id);
    const I = w.I32, at = ints >> 2;
    return {
      code,
      ok: code === 0,
      message: this.reg.errors[code] ?? `error ${code}`,
      node: w.cstr(id, this.reg.id_max),
      edgeIndex: I[at + 1],
      outNodes: I[at + 2],
      culled: I[at + 3],
      delayedEdges: I[at + 4],
    };
  }

  /* -- control -- */
  noteOn(midi, vel = 1)   { this.w.x.pcks_graph_note_on(this.g, midi, vel); }
  noteOff(midi)           { this.w.x.pcks_graph_note_off(this.g, midi); }
  allNotesOff()           { this.w.x.pcks_graph_all_notes_off(this.g); }
  pitchBend(b)            { this.w.x.pcks_graph_pitch_bend(this.g, b); }
  setSeed(s)              { this.w.x.pcks_graph_set_seed(this.g, s >>> 0); }
  reset()                 { this.w.x.pcks_graph_reset(this.g); }
  setVoiceMode(mode, glide = 0, bend = 2) {
    this.w.x.pcks_graph_set_voice_mode(this.g, mode, glide, bend);
  }
  /** WHEN portamento applies: 0 = only when a key was already down (the
   *  default, and what "playing legato" means), 1 = on every note. How LONG it
   *  takes is `glide` on setVoiceMode — the two are separate questions. */
  setGlideMode(mode) {
    this.w.x.pcks_graph_set_glide_mode(this.g, mode | 0);
  }
  setParam(id, p, norm) {
    norm = Math.min(1, Math.max(0, norm));
    this.w.x.pcks_graph_set_param(this.g, this.w.id(id), p, norm);
    let m = this._base.get(id);
    if (!m) this._base.set(id, m = new Map());
    m.set(p, norm);
  }

  getParam(id, p) {
    const m = this._base.get(id);
    if (m && m.has(p)) return m.get(p);
    return this.w.x.pcks_graph_get_param(this.g, this.w.id(id), p);
  }
  setBypass(id, on)       { this.w.x.pcks_graph_set_bypass(this.g, this.w.id(id), on ? 1 : 0); }
  getBypass(id)           { return this.w.x.pcks_graph_get_bypass(this.g, this.w.id(id)); }

  /* -- kept blocks (pcks_graph_keep, 2026-10-06) --
   * A kept block is scheduled whatever it reaches: the dashboard's knobs, which a synth's FX graph
   * reads from OUTSIDE the synth (pcks_chain forwards its RATE / DEPTH / SYNC). A property of the
   * schedule — changing it un-compiles, so compile after. keep() is 0 for an unknown id. */
  keep(id, on = true)     { return this.w.x.pcks_graph_keep(this.g, this.w.id(id, 0), on ? 1 : 0); }
  kept(id)                { return !!this.w.x.pcks_graph_kept(this.g, this.w.id(id, 0)); }
  /** THE HOST'S AUDIO for this graph's in.synth during the NEXT render only (pcks_graph_set_input):
   *  `l` / `r` are WASM POINTERS to `frames` frames `stride` floats apart (`r` 0 = mono). */
  setInput(l, r, stride, frames) { this.w.x.pcks_graph_set_input(this.g, l, r, stride | 0, frames | 0); }

  /* -- render --
   * Returns a VIEW into wasm memory, valid until the next render.  The caller
   * copies into the output channels immediately, so a view is right here — but
   * it is the same trap that bit the Python side, where render() handed out a
   * view into scratch and every measurement taken from it was of whatever had
   * been rendered most recently.  Hence the name. */
  /** Render frames*os at this graph's own rate, decimate to frames. The graph
   *  must have been created at deviceRate*os — audio.setOversample() is what
   *  guarantees that pairing, and nothing else calls this. */
  renderDecimated(frames, os) {
    const x = this.w.x;
    if (!this._dec) { this._dec = this.w.malloc(x.pw_decim_size()); this._decOs = 0; }
    if (this._decOs !== os) { x.pw_decim_init(this._dec, os); this._decOs = os; }
    const hn = frames * os;
    if (hn > (this._hiN || 0)) {
      if (this._hi) this.w.free(this._hi);
      this._hi = this.w.malloc(hn * 2 * 4); this._hiN = hn;
    }
    if (frames > this._outFrames) {
      if (this._out) this.w.free(this._out);
      this._out = this.w.malloc(frames * 2 * 4);
      this._outFrames = frames;
    }
    x.pcks_graph_render(this.g, this._hi, hn);
    x.pw_decim_run(this._dec, this._hi, this._out, frames);
    return this.w.F32.subarray(this._out >> 2, (this._out >> 2) + frames * 2);
  }

  renderInto(frames) {
    if (frames > this._outFrames) {
      if (this._out) this.w.free(this._out);
      this._out = this.w.malloc(frames * 2 * 4);
      this._outFrames = frames;
    }
    this.w.x.pcks_graph_render(this.g, this._out, frames);
    return this.w.F32.subarray(this._out >> 2, (this._out >> 2) + frames * 2);
  }

  /* -- introspection -- */
  _f32(n) {
    if (!this._scratchF) this._scratchF = this.w.malloc(4096 * 4);
    return this._scratchF;
  }

  status() {
    const p = this._f32(8);
    this.w.x.pw_status(this.g, p);
    const F = this.w.F32, at = p >> 2;
    const o = {};
    STATUS_FIELDS.forEach((k, i) => { o[k] = F[at + i]; });
    o.focus_note = Math.round(o.focus_note);
    o.active_voices = Math.round(o.active_voices);
    o.stuck_voices = Math.round(o.stuck_voices);
    return o;
  }

  nodeViz(id, n) {
    const p = this._f32(n);
    const got = this.w.x.pcks_graph_node_viz(this.g, this.w.id(id), p, n);
    return this.w.F32.slice(p >> 2, (p >> 2) + got);
  }

  effective(id, n) {
    const p = this._f32(n);
    const got = this.w.x.pcks_graph_effective(this.g, this.w.id(id), p, n);
    return this.w.F32.slice(p >> 2, (p >> 2) + got);
  }

  tap(id, n) {
    const p = this._f32(n);
    const got = this.w.x.pcks_graph_tap(this.g, this.w.id(id), p, n);
    return this.w.F32.slice(p >> 2, (p >> 2) + got);
  }

  order() {
    const p = this.w.scratch;
    this.w.x.pw_order(this.g, p, this.w.scratchSize);
    const s = this.w.cstr(p);
    return s ? s.split('\n') : [];
  }

  edges() {
    const need = this.w.x.pw_edges_json(this.g, 0, 0) + 1;
    const p = need <= this.w.scratchSize ? this.w.scratch : this.w.malloc(need);
    this.w.x.pw_edges_json(this.g, p, need);
    const j = JSON.parse(this.w.cstr(p));
    if (p !== this.w.scratch) this.w.free(p);
    return j;
  }

  arenaUsed() { return this.w.x.pcks_graph_arena_used(this.g); }

  /* False after any edit that invalidated the schedule.  render() is silent
   * while this is false — the UI shows that rather than letting the user hunt
   * for a broken cable that is not broken. */
  get compiled() { return !!this.w.x.pcks_graph_is_compiled(this.g); }
}

/* -------------------------------------------------------------------- chain
 * pcks_chain (pchkraft-core synth/include/pcks_chain.h): a synth played through the FX graph its
 * dashboard's FX TYPE knob picks — the selection, the 10 ms crossfades, the tails, the RATE / DEPTH /
 * SYNC forwarding — in the core, so the browser and a board do it the same way. The worklet keeps the
 * one that makes sound (worklet.js); this wrapper is the same object on THIS thread, for the tests
 * and for anything that renders here. Graphs are passed as Graph objects (or null). */
const CHAIN_TYPE = 0, CHAIN_RATE = 1, CHAIN_DEPTH = 2, CHAIN_SYNC = 3, CHAIN_FOLLOW = -2;
class Chain {
  constructor(wasm, sr) {
    this.w = wasm;
    const n = wasm.x.pcks_chain_sizeof();
    this.mem = wasm.malloc(n);
    this.c = wasm.x.pcks_chain_init(this.mem, n, sr);
    if (!this.c) { wasm.free(this.mem); this.mem = 0; throw new Error('pcks_chain_init refused its block'); }
    this._out = 0;
    this._outFrames = 0;
  }
  destroy() {
    if (this.mem) this.w.free(this.mem);
    if (this._out) this.w.free(this._out);
    this.mem = this.c = this._out = 0;
    this._outFrames = 0;
  }
  setSource(g)            { this.w.x.pcks_chain_set_source(this.c, g ? g.g : 0); }
  /** `which`: CHAIN_TYPE … CHAIN_SYNC; `id` the synth's macro, or null for none. */
  setKnob(which, id)      { return this.w.x.pcks_chain_set_knob(this.c, which, id ? this.w.id(id, 0) : 0); }
  setCount(n)             { this.w.x.pcks_chain_set_count(this.c, n | 0); }
  setSlot(k, g)           { this.w.x.pcks_chain_set_slot(this.c, k | 0, g ? g.g : 0); }
  /** Slot k's own RATE / DEPTH / SYNC macro (`which` CHAIN_RATE … CHAIN_SYNC), by id in ITS graph. */
  setTarget(k, which, id) { return this.w.x.pcks_chain_set_target(this.c, k | 0, which, id ? this.w.id(id, 0) : 0); }
  /** CHAIN_FOLLOW follows the knob; -1 plays off; k ≥ 0 plays slot k and forwards nothing. */
  force(k)                { this.w.x.pcks_chain_force(this.c, k | 0); }
  setTail(seconds)        { this.w.x.pcks_chain_set_tail(this.c, +seconds); }
  forget(g)               { if (g) this.w.x.pcks_chain_forget(this.c, g.g); }
  selected()              { return this.w.x.pcks_chain_selected(this.c); }
  legacy()                { return !!this.w.x.pcks_chain_legacy(this.c); }
  live()                  { return this.w.x.pcks_chain_live(this.c); }
  /** Interleaved stereo, a VIEW into wasm memory valid until the next render (Graph.renderInto). */
  renderInto(frames) {
    if (frames > this._outFrames) {
      if (this._out) this.w.free(this._out);
      this._out = this.w.malloc(frames * 2 * 4);
      this._outFrames = frames;
    }
    this.w.x.pcks_chain_render(this.c, this._out, frames);
    return this.w.F32.subarray(this._out >> 2, (this._out >> 2) + frames * 2);
  }
}

/* ------------------------------------------------------------------- curves
 * Instance-free: evaluates a TYPE's curve from a parameter vector, which is
 * what lets the palette draw a block before you place it and the inspector draw
 * one without disturbing the running graph.  Wants the main-thread wasm. */
function curveEval(w, reg, typeName, which, normParams, sr, x, n) {
  const ti = reg.types.findIndex(t => t.type === typeName);
  if (ti < 0) throw new Error(`unknown type ${typeName}`);
  const t = reg.types[ti];

  const pP = w.malloc(Math.max(1, t.params.length) * 4);
  const yP = w.malloc(n * 4);
  const xP = x ? w.malloc(n * 4) : 0;
  try {
    const F = w.F32;
    for (let i = 0; i < t.params.length; i++) F[(pP >> 2) + i] = normParams[i] ?? 0;
    if (x) w.F32.set(x, xP >> 2);
    const got = w.x.pcks_node_curve_eval(ti, which, pP, sr, xP, yP, n);
    return got ? w.F32.slice(yP >> 2, (yP >> 2) + n) : null;
  } finally {
    w.free(pP); w.free(yP); if (xP) w.free(xP);
  }
}

__x["Wasm"] = Wasm;
__x["readRegistry"] = readRegistry;
__x["physical"] = physical;
__x["applyCurve"] = applyCurve;
__x["inverseCurve"] = inverseCurve;
__x["selectIndex"] = selectIndex;
__x["enumLabels"] = enumLabels;
__x["modLabel"] = modLabel;
__x["formatValue"] = formatValue;
__x["matrixLabel"] = matrixLabel;
__x["Graph"] = Graph;
__x["Chain"] = Chain;
__x["curveEval"] = curveEval;
__x["STATUS_FIELDS"] = STATUS_FIELDS;
__x["SCOPE_VOICE"] = SCOPE_VOICE;
__x["SCOPE_GLOBAL"] = SCOPE_GLOBAL;
__x["PORT_AUDIO"] = PORT_AUDIO;
__x["PORT_CV"] = PORT_CV;
__x["PORT_GATE"] = PORT_GATE;
__x["KNOB"] = KNOB;
__x["SELECT"] = SELECT;
__x["TOGGLE"] = TOGGLE;
__x["LIN"] = LIN;
__x["EXP"] = EXP;
__x["QUAD"] = QUAD;
__x["STEP"] = STEP;
__x["POLY"] = POLY;
__x["MONO"] = MONO;
__x["LEGATO"] = LEGATO;
__x["CHAIN_TYPE"] = CHAIN_TYPE;
__x["CHAIN_RATE"] = CHAIN_RATE;
__x["CHAIN_DEPTH"] = CHAIN_DEPTH;
__x["CHAIN_SYNC"] = CHAIN_SYNC;
__x["CHAIN_FOLLOW"] = CHAIN_FOLLOW;

}, {}],
"web/match/render.js": [async function(__x, __req){
/* render.js — one note of a patch document on the wasm engine, for the matcher.
 *
 * The SAME STEPS as dnasynth/graph/lib.py's render_note natively, so a voice the
 * browser matched sounds the way the native matcher would have heard it: the C
 * patch loader (pcks_patch_load — the device's reader, not js/patch.js, which is
 * the editor's), compile, 2048 frames of silence (the graph's smoothers settle:
 * the first-block trap), note on at the rounded key, held `gate` seconds, note
 * off, the rest of `secs`, mono as (L + R) / 2. The document's own seed is the
 * one the loader applies; nothing here sets another.
 */
const { Graph } = __req("../js/engine.js");

const enc = new TextEncoder();

/** -> Float32Array (mono, round(secs * sr) samples), or a string saying what failed. midi: a note,
 *  or several (an array, or its JSON): a CHORD — every key on at once on a graph of as many voices,
 *  all released at the gate (dnasynth graph/lib.py render_note's chord, 2026-10-06) */
function renderNote(w, reg, docJson, midi, vel, gate, secs, sr, warm = 2048) {
  const keys = (typeof midi === 'string' ? JSON.parse(midi) : Array.isArray(midi) || ArrayBuffer.isView(midi)
    ? Array.from(midi) : [midi]).map((m) => Math.round(m));
  const bytes = enc.encode(docJson);
  const js = w.malloc(bytes.length + 1);
  const res = w.malloc(1024);                       /* larger than any version of the result struct */
  let g = null;
  try {
    w.U8.set(bytes, js);
    w.U8[js + bytes.length] = 0;
    g = new Graph(w, reg, sr, keys.length);
    const rc = w.x.pcks_patch_load(g.g, js, bytes.length, res);
    if (rc !== 0) return `pcks_patch_load: error ${rc}`;
    const c = g.compile();
    if (!c.ok) return `compile: ${c.message}${c.node ? ` at ${c.node}` : ''}`;
    const n = Math.round(secs * sr), on = Math.max(0, Math.min(n, Math.round(gate * sr)));
    const out = new Float32Array(n);
    if (warm > 0) g.renderInto(warm);
    for (const k of keys) g.noteOn(k, vel);
    const take = (from, frames) => {
      if (frames <= 0) return;
      const st = g.renderInto(frames);              /* a view into wasm memory: copied out at once */
      for (let i = 0; i < frames; i++) out[from + i] = 0.5 * (st[2 * i] + st[2 * i + 1]);
    };
    take(0, on);
    for (const k of keys) g.noteOff(k);
    take(on, n - on);
    return out;
  } finally {
    if (g) g.destroy();
    w.free(js);
    w.free(res);
  }
}

__x["renderNote"] = renderNote;

}, {"../js/engine.js":"web/js/engine.js"}],
"web/match/net.js": [async function(__x, __req){
/* net.js — the DASHBOARD NETWORK in the browser: the network the desktop GROW lab's Dashboard GROW
 * starts from (dnasynth checkpoints/dashx), on onnxruntime-web.
 *
 * pack.py exports it (build/match/net/): the audio ENCODER and ONE DECODER STEP as ONNX, and
 * net.json — the sampler's settings, every gene's neutral token and a check. propose() is
 * dnasynth model.propose_many's MaskGIT (sample_tokens), step for step: all genes masked; each
 * step predicts every masked gene, draws a token, keeps the most confident draws (log p, plus
 * Gumbel noise that fades over the steps) and re-masks the rest on a cosine schedule. Row 0 is the
 * GREEDY row (structure first: a gene is off when P(off) >= on_threshold, else its best value
 * token, no noise) — the same tokens torch decodes (net.json's check holds it to that); the other
 * rows are samples (a seeded generator here, torch's there: other draws of the same distribution).
 * The tokens go back to the matcher's Python, which decodes them as the native Model does
 * (match_main.grow: Tokenizer.decode, canonical, eight distinct) and GROW starts from them.
 */

/* a small seeded generator (mulberry32): the same seed, the same proposals */
function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the network: {ort, enc, dec, meta}, or null when this build has none.
 *  bytes(name) -> Promise<Uint8Array> of a file in net/ (fetch in the browser, the disk in tests);
 *  ortModule: the imported onnxruntime-web module */
async function loadNet(bytes, ortModule, threads = 1) {
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(await bytes('net.json')));
  } catch (e) {
    return null;
  }
  const ort = ortModule;
  ort.env.wasm.numThreads = Math.max(1, threads | 0);
  const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const enc = await ort.InferenceSession.create(await bytes('enc.onnx'), opt);
  const dec = await ort.InferenceSession.create(await bytes('dec.onnx'), opt);
  return { ort, enc, dec, meta };
}

/** the network's proposals for one note: feats Float32Array [n_ch * frames], cond Float32Array
 *  [n_cond] (match_main.net_inputs) -> Int32Array [rows * genes] of tokens, row 0 greedy */
async function propose(net, feats, cond, seed = 0) {
  const { ort, enc, dec, meta } = net;
  const S = meta.sampler, G = meta.genes, V = meta.V, n = S.rows, steps = S.steps;
  const e = await enc.run({
    feats: new ort.Tensor('float32', feats, [1, meta.n_ch, meta.frames]),
    cond: new ort.Tensor('float32', cond, [1, meta.n_cond]),
  });
  const mem1 = e.mem.data, c1 = e.c.data, T = meta.mem_t, d = meta.d;
  const mem = new Float32Array(n * T * d), c = new Float32Array(n * d);
  for (let r = 0; r < n; r++) { mem.set(mem1, r * T * d); c.set(c1, r * d); }
  const memT = new ort.Tensor('float32', mem, [n, T, d]), cT = new ort.Tensor('float32', c, [n, d]);
  const neutral = meta.neutral;
  const rand = rng(seed + 1);
  const tokens = new Int32Array(n * G).fill(V);              /* V = masked */
  const greedy = (r) => r < S.greedy_rows;                  /* one target: rows 0 .. greedy_rows-1 */
  let nMasked = G;
  const logp = new Float32Array(V), prob = new Float32Array(V);
  const chosen = new Int32Array(n * G), conf = new Float64Array(n * G);
  for (let s = 0; s < steps; s++) {
    const tk = new BigInt64Array(n * G);
    for (let i = 0; i < n * G; i++) tk[i] = BigInt(tokens[i]);
    const out = await dec.run({ tokens: new ort.Tensor('int64', tk, [n, G]), mem: memT, c: cT });
    const L = out.logits.data;
    const noise = s < steps - 1 ? S.choice_noise * (1 - (s + 1) / steps) : 0;
    for (let r = 0; r < n; r++) {
      for (let g = 0; g < G; g++) {
        const at = (r * G + g) * V;
        let mx = -Infinity;
        for (let v = 0; v < V; v++) if (L[at + v] > mx) mx = L[at + v];
        let sum = 0;
        for (let v = 0; v < V; v++) { prob[v] = Math.exp(L[at + v] - mx); sum += prob[v]; }
        const ls = Math.log(sum);
        for (let v = 0; v < V; v++) { logp[v] = L[at + v] - mx - ls; prob[v] /= sum; }
        const i = r * G + g, masked = tokens[i] >= V;
        let pick;
        if (greedy(r)) {                                     /* greedy_choice: structure first */
          const z = neutral[g];
          if (prob[z] >= S.on_threshold) pick = z;
          else {
            pick = -1;
            let best = -Infinity;
            for (let v = 0; v < V; v++) if (v !== z && L[at + v] > best) { best = L[at + v]; pick = v; }
          }
        } else {                                             /* a draw (temperature 1: the softmax) */
          let u = rand(), acc = 0;
          pick = V - 1;
          for (let v = 0; v < V; v++) { acc += prob[v]; if (u < acc) { pick = v; break; } }
        }
        const ch = masked ? pick : tokens[i];
        chosen[i] = ch;
        let cf = logp[ch];
        if (noise > 0 && !greedy(r)) {
          const u = Math.min(1 - 1e-9, Math.max(1e-9, rand()));
          cf += noise * -Math.log(-Math.log(u));
        }
        conf[i] = masked ? cf : Infinity;
      }
    }
    let nNext = Math.floor(G * Math.cos(Math.PI / 2 * (s + 1) / steps));
    nNext = s < steps - 1 ? Math.max(0, Math.min(nNext, nMasked - 1)) : 0;
    for (let r = 0; r < n; r++) {
      const row = r * G;
      for (let g = 0; g < G; g++) tokens[row + g] = chosen[row + g];
      if (nNext > 0) {                                       /* the least confident go back under the mask */
        const order = Array.from({ length: G }, (_, g) => g).sort((a, b) => conf[row + a] - conf[row + b]);
        for (let j = 0; j < nNext; j++) tokens[row + order[j]] = V;
      }
    }
    nMasked = nNext;
    if (nMasked === 0) break;
  }
  return tokens;
}

__x["loadNet"] = loadNet;
__x["propose"] = propose;

}, {}],
"web/match/worker.js": [async function(__x, __req){
/* worker.js — the in-browser matcher's worker: one file, two roles.
 *
 * THE SEARCH (the page starts one): Pyodide + numpy + the matcher's own Python
 * (matcher.zip, match/pack.py) + the wasm engine. It answers the page's
 * `analyse` and `grow`, and runs a GROW exactly as the lab does — the Python is
 * dnasynth's, unported.
 *
 * THE EVALUATORS (the search starts them, when the page is cross-origin
 * isolated): the same runtime, each holding the fitness's target. A GROW spends
 * its time rendering candidates and scoring them (measured: 10.7 + 8.5 ms a
 * candidate, single-threaded, against 2.4 ms building its document), so the
 * search builds the documents and hands each batch out; every evaluator renders
 * and scores its share. The search's Python is SYNCHRONOUS — the matcher waits
 * for a batch's scores like a function call — so the hand-out is a blocking
 * call: the batch goes out by postMessage, the scores come back through a
 * SharedArrayBuffer, and the search sleeps on Atomics.wait until the last
 * evaluator has written. That needs cross-origin isolation (coi-serviceworker.js
 * gives it to a page GitHub Pages serves); without it there are no evaluators
 * and the search renders and scores alone — the same results, slower.
 *
 * Every render goes through render.js — the C patch loader and the native
 * render_note's steps — so a candidate sounds here as it does natively.
 */
const { Wasm, readRegistry } = __req("../js/engine.js");
const { renderNote } = __req("./render.js");
const { loadNet, propose } = __req("./net.js");

const SR = 44100;
const VEL = 100 / 127;
const SILENT = 1e3;                         /* dnasynth/grow/build.py SILENT: a render with no sound */
/* the control block (Int32Array over a SharedArrayBuffer) the search and its evaluators share */
const DONE = 0, READY = 1, ERRORS = 2, CTL_N = 4;
const WAIT_MS = 120000;                     /* a batch that takes longer has a dead evaluator */

let py = null, M = null, w = null, reg = null;
let role = 'search', ctl = null, pool = [], BASE = '';
let netP = null;                            /* the dashboard network, loaded on its first use */

const post = (m, transfer) => self.postMessage(m, transfer || []);

function bytesOf(b64) {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/* the runtime both roles stand on: the engine, Python + numpy, the matcher's code */
async function boot(m) {
  BASE = m.base;
  /* the page's own engine: the shell decodes its base64 into an ArrayBuffer at startup */
  w = await Wasm.load(m.wasm instanceof ArrayBuffer ? new Uint8Array(m.wasm)
    : m.wasm instanceof Uint8Array ? m.wasm : bytesOf(m.wasm));
  reg = readRegistry(w);
  /* a MODULE worker (Pyodide 314 loads in no other kind): its loader by dynamic import */
  const { loadPyodide } = await import(`${m.base}pyodide/pyodide.mjs`);
  py = await loadPyodide({ indexURL: `${m.base}pyodide/` });
  await py.loadPackage('numpy', { messageCallback: () => {} });
  const zip = await (await fetch(`${m.base}matcher.zip`, { cache: 'no-cache' })).arrayBuffer();
  py.unpackArchive(zip, 'zip', { extractDir: '/match' });
  py.runPython("import sys; sys.path.insert(0, '/match')");
  M = py.pyimport('match_main');
  self.pcksRenderNote = (doc, midi, vel, gate, secs, sr, warm) =>
    renderNote(w, reg, doc, midi, vel, gate, secs, sr, warm);
}

/* ------------------------------------------------------------- the search */

/* Hand a batch out and sleep until every share is back. `fill(k, start, n)`
 * posts share k (items start .. start+n) to evaluator k. */
function scatter(n, fill) {
  Atomics.store(ctl, DONE, 0);
  Atomics.store(ctl, ERRORS, 0);
  const per = Math.ceil(n / pool.length);
  for (let k = 0, at = 0; at < n; k++, at += per) fill(k, at, Math.min(per, n - at));
  for (;;) {
    const d = Atomics.load(ctl, DONE);
    if (d >= n) break;
    if (Atomics.wait(ctl, DONE, d, WAIT_MS) === 'timed-out') throw new Error('an evaluator stopped answering');
  }
  if (Atomics.load(ctl, ERRORS)) throw new Error('an evaluator failed: its console has the reason');
}

function startPool(m, size) {
  ctl = new Int32Array(new SharedArrayBuffer(4 * CTL_N));
  const url = `${m.base}worker.js`;
  pool = Array.from({ length: size }, () => new Worker(url, { type: 'module' }));
  const ready = pool.map((ev) => new Promise((res, rej) => {
    ev.onmessage = (e) => (e.data.type === 'ready' ? res() : e.data.type === 'error' ? rej(new Error(e.data.error)) : 0);
    ev.onerror = (e) => rej(new Error(e.message || 'an evaluator failed to start'));
  }));
  for (const ev of pool) ev.postMessage({ type: 'boot', role: 'eval', base: m.base, wasm: m.wasm, ctl });
  return Promise.all(ready);
}

/* what the matcher's Python calls (match_main.use_pool and the browser engine binding) */
function installPool() {
  /* the target, rebuilt by every evaluator from the search's own (the same audio, the same terms) */
  self.pcksPoolTarget = (audio, cfg) => {
    Atomics.store(ctl, READY, 0);
    const a = audio.slice();
    for (const ev of pool) ev.postMessage({ type: 'target', audio: a, cfg });
    Atomics.store(ctl, ERRORS, 0);
    for (;;) {
      const r = Atomics.load(ctl, READY);
      if (r >= pool.length) break;
      if (Atomics.wait(ctl, READY, r, WAIT_MS) === 'timed-out') throw new Error('an evaluator did not take the target');
    }
    if (Atomics.load(ctl, ERRORS)) throw new Error('an evaluator could not build the target: its console has the reason');
  };
  /* render + score a batch of documents -> Float64Array of distances (SILENT for silence) */
  self.pcksPoolScore = (docsJson, key, vel, gate, secs, sr, n) => {
    const docs = JSON.parse(docsJson);
    const out = new Float64Array(new SharedArrayBuffer(8 * docs.length));
    const keys = typeof key === 'string' ? JSON.parse(key) : key;     /* a chord's keys come as JSON */
    scatter(docs.length, (k, at, cnt) => pool[k].postMessage({
      type: 'score', docs: docs.slice(at, at + cnt), at, key: keys, vel, gate, secs, sr, n, out: out.buffer }));
    return out;
  };
  /* render a batch of documents -> Float32Array [B * n] (the engine binding's render_batch) */
  self.pcksRenderBatch = (docsJson, midiJson, velJson, gate, secs, sr) => {
    const docs = JSON.parse(docsJson), mm = JSON.parse(midiJson), vv = JSON.parse(velJson);
    const n = Math.round(secs * sr);
    const out = new Float32Array(new SharedArrayBuffer(4 * docs.length * n));
    scatter(docs.length, (k, at, cnt) => pool[k].postMessage({
      type: 'render', docs: docs.slice(at, at + cnt), mm: mm.slice(at, at + cnt), vv: vv.slice(at, at + cnt),
      at, gate, secs, sr, n, out: out.buffer }));
    return out;
  };
  M.use_pool();
}

async function bootSearch(m) {
  const t0 = performance.now();
  post({ type: 'status', text: 'loading Python and numpy …' });
  await boot(m);
  post({ type: 'status', text: 'reading the engine\'s registry …' });
  M.setup(JSON.stringify({ types: reg.types }));
  let workers = 0;
  if (self.crossOriginIsolated && m.evaluators > 0) {
    post({ type: 'status', text: `starting ${m.evaluators} evaluators …` });
    try {
      await startPool(m, m.evaluators);
      installPool();
      workers = pool.length;
    } catch (e) {
      for (const ev of pool) ev.terminate();
      pool = [];
      post({ type: 'log', line: `evaluators unavailable (${e.message}): rendering and scoring here` });
    }
  }
  post({ type: 'ready', info: JSON.parse(M.info()), evaluators: workers,
         isolated: !!self.crossOriginIsolated, seconds: (performance.now() - t0) / 1000 });
}

function analyse(m) {
  const r = M.analyse(m.pcm, m.trim);
  const o = r.toJs({ dict_converter: Object.fromEntries });
  r.destroy();
  const note = Float32Array.from(o.note);
  post({ type: 'analysed', id: m.id, result: { ...o, note } }, [note.buffer]);
}

/* THE DASHBOARD NETWORK (net.js): onnxruntime-web and the exported network, once, on first use
 * (63 MB: the browser's cache keeps it) — null when this build has no network */
function theNet() {
  if (!netP) {
    netP = (async () => {
      const probe = await fetch(`${BASE}net/net.json`, { cache: 'no-cache' });
      if (!probe.ok) return null;
      const ort = await import(`${BASE}ort/ort.wasm.min.mjs`);
      ort.env.wasm.wasmPaths = `${BASE}ort/`;
      const bytes = async (f) => {
        const r = await fetch(`${BASE}net/${f}`);
        if (!r.ok) throw new Error(`net/${f}: HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)) : 1;
      return loadNet(bytes, ort, threads);
    })();
    netP.catch(() => { netP = null; });
  }
  return netP;
}

async function grow(m) {
  const progress = (line, frac) => {
    post({ type: 'log', id: m.id, line });
    if (frac >= 0) post({ type: 'progress', id: m.id, frac });
  };
  const params = JSON.stringify(m.params || {});
  let tokens = null, metaJson = null;
  if (M.wants_net(m.builder, params)) {
    try {
      const t0 = performance.now();
      progress('network: loading (the first time 63 MB) …', -1);
      const net = await theNet();
      if (!net) progress('network: none in this build — growing without it', -1);
      else {
        metaJson = JSON.stringify(net.meta);
        const r = M.net_inputs(m.pcm, m.midi, m.gate, metaJson, m.chord ? JSON.stringify(m.chord) : null);
        const [feats, cond] = r.toJs();
        r.destroy();
        const t1 = performance.now();
        tokens = await propose(net, Float32Array.from(feats), Float32Array.from(cond), (m.params && m.params.seed) | 0);
        progress(`network ${net.meta.engine} (step ${net.meta.step}): ${net.meta.sampler.rows} proposals in `
                 + `${((performance.now() - t1) / 1000).toFixed(1)} s (loaded in ${((t1 - t0) / 1000).toFixed(1)} s)`, -1);
      }
    } catch (e) {
      tokens = null;
      progress(`network failed (${e.message}) — growing without it`, -1);
    }
  }
  const r = M.grow(m.pcm, m.midi, m.gate, m.builder, params, progress, tokens, metaJson,
                   m.chord ? JSON.stringify(m.chord) : null);
  const [res, notes] = r.toJs({ dict_converter: Object.fromEntries });
  r.destroy();
  const audio = notes.map((y) => Float32Array.from(y));
  post({ type: 'done', id: m.id, result: { ...res, notes: audio } }, audio.map((a) => a.buffer));
}

/* ---------------------------------------------------------- an evaluator */

function evaluate(m) {
  const out = m.type === 'score' ? new Float64Array(m.out) : new Float32Array(m.out);
  try {
    if (m.type === 'score') {
      const B = m.docs.length, n = m.n;
      const audio = new Float32Array(B * n), ok = new Uint8Array(B);
      for (let i = 0; i < B; i++) {
        const y = renderNote(w, reg, m.docs[i], m.key, m.vel, m.gate, m.secs, m.sr);
        if (typeof y === 'string') continue;
        let peak = 0;
        for (let j = 0; j < n; j++) { const a = Math.abs(y[j]); if (a > peak) peak = a; }
        if (peak > 1e-7) { audio.set(y.subarray(0, n), i * n); ok[i] = 1; }
      }
      const s = M.eval_score(audio, B, n, ok);
      const v = s.toJs();
      s.destroy();
      for (let i = 0; i < B; i++) out[m.at + i] = v[i];
    } else {
      for (let i = 0; i < m.docs.length; i++) {
        const y = renderNote(w, reg, m.docs[i], m.mm[i], m.vv[i], m.gate, m.secs, m.sr);
        if (typeof y !== 'string') out.set(y.subarray(0, m.n), (m.at + i) * m.n);
      }
    }
  } catch (e) {
    console.error('evaluator:', e);
    if (m.type === 'score') for (let i = 0; i < m.docs.length; i++) out[m.at + i] = SILENT;
    Atomics.add(ctl, ERRORS, 1);
  }
  Atomics.add(ctl, DONE, m.docs.length);
  Atomics.notify(ctl, DONE);
}

/* ------------------------------------------------------------- messages */

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'boot') {
      role = m.role || 'search';
      if (role === 'eval') {
        ctl = m.ctl;
        await boot(m);
        post({ type: 'ready' });
      } else {
        await bootSearch(m);
      }
    } else if (m.type === 'target') {
      try {
        M.eval_target(m.audio, m.cfg);
      } catch (err) {
        console.error('evaluator target:', err);
        Atomics.add(ctl, ERRORS, 1);
      } finally {
        Atomics.add(ctl, READY, 1);              /* answered either way: the search must not hang */
        Atomics.notify(ctl, READY);
      }
    } else if (m.type === 'score' || m.type === 'render') {
      evaluate(m);
    } else if (m.type === 'analyse') {
      analyse(m);
    } else if (m.type === 'grow') {
      await grow(m);
    }
  } catch (err) {
    post({ type: 'error', id: m.id, error: String(err && err.message || err) });
  }
};



}, {"../js/engine.js":"web/js/engine.js","./render.js":"web/match/render.js","./net.js":"web/match/net.js"}],
};
const __ORDER = ["web/js/engine.js","web/match/render.js","web/match/net.js","web/match/worker.js"];
const __C = {};
(async () => {
  for (const key of __ORDER) {
    const e = __M[key];
    const x = __C[key] = {};
    await e[0](x, (spec) => {
      const dep = __C[e[1][spec]];
      if (!dep) throw new Error('module ' + key + ' imported ' + spec + ' before it was linked');
      return dep;
    });
  }
})().catch((e) => {
  /* a worker bundle (match/worker.js) has no document: it reports through the throw */
  const doc = typeof document !== 'undefined' ? document : null;
  const el = doc && doc.getElementById('err');
  if (el) el.textContent = String(e && e.stack || e);
  const b = doc && doc.getElementById('go');
  if (b) { b.disabled = true; b.textContent = 'failed to start'; }
  throw e;
});
