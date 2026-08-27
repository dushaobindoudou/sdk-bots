/**
 * Gateway console log tap.
 *
 * Captures host-process console output (log/info/warn/error) into a bounded
 * ring buffer and fans it out to live subscribers, backing the console's
 * logs panel (GET /logs backlog + GET /logs/stream SSE).
 *
 * The console wrap is module-level refcounted so overlapping gateway servers
 * in one process (tests) neither double-capture nor restore too early.
 * Installation is owned by startGatewayServer; dispose() unwinds exactly.
 */

export interface GatewayLogEntry {
  readonly seq: number;
  readonly ts: number;
  readonly level: "info" | "log" | "warn" | "error";
  readonly text: string;
}

export interface GatewayLogTap {
  recent(limit?: number): readonly GatewayLogEntry[];
  subscribe(listener: (entry: GatewayLogEntry) => void): () => void;
  dispose(): void;
}

const DEFAULT_CAPACITY = 1_000;
const MAX_ENTRY_CHARS = 2_000;

/** Render a single console.* argument: strings as-is, errors as stack, objects JSON-ified. */
function renderArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "object" && value !== null) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function formatArgs(args: readonly unknown[]): string {
  const text = args.map(renderArg).join(" ");
  return text.length > MAX_ENTRY_CHARS ? text.slice(0, MAX_ENTRY_CHARS) + " …[truncated]" : text;
}

interface RefcountedTap {
  readonly tap: GatewayLogTap;
  refs: number;
}

let installed: RefcountedTap | undefined;
/** Pristine console bindings, memoized at first install: dispose always restores these exact functions. */
let pristine: {
  readonly log: typeof console.log;
  readonly info: typeof console.info;
  readonly warn: typeof console.warn;
  readonly error: typeof console.error;
} | undefined;

export function createGatewayLogTap(options: { readonly capacity?: number } = {}): GatewayLogTap {
  if (installed != null) {
    // Reuse the existing tap: a second console wrap would double-capture, and
    // capturing bindings now would snapshot the *wrapped* functions.
    installed.refs += 1;
    return installed.tap;
  }
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const ring: GatewayLogEntry[] = [];
  const listeners = new Set<(entry: GatewayLogEntry) => void>();
  let seq = 0;
  if (pristine == null) {
    pristine = {
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };
  }
  const original = pristine;

  const capture = (level: GatewayLogEntry["level"]) => (...args: unknown[]) => {
    original[level](...args);
    try {
      const entry: GatewayLogEntry = { seq: (seq += 1), ts: Date.now(), level, text: formatArgs(args) };
      if (ring.length >= capacity) ring.splice(0, ring.length - capacity + 1);
      ring.push(entry);
      for (const listener of listeners) {
        try { listener(entry); } catch { /* a broken SSE sink must not kill logging */ }
      }
    } catch { /* never let the tap break the host */ }
  };

  const ref: RefcountedTap = {
    refs: 1,
    tap: {
      recent(limit = 200) { return ring.slice(Math.max(0, ring.length - Math.max(0, limit))); },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      dispose() {
        ref.refs -= 1;
        if (ref.refs > 0 || installed !== ref) return;
        installed = undefined;
        console.log = original.log; console.info = original.info; console.warn = original.warn; console.error = original.error;
      },
    },
  };

  installed = ref;
  console.log = capture("log"); console.info = capture("info"); console.warn = capture("warn"); console.error = capture("error");
  return ref.tap;
}
