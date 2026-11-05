/** How far a teleport has gotten, and the line that should sit under the bar. */
export interface ProgressState {
  /** What is happening now, for example "Sending  2/9". */
  status: string;
  done: number;
  /** Omit while the total is still unknown. */
  total?: number;
  /** Path or label of the file currently being handled. */
  file?: string;
  peer?: string;
}

export interface ProgressView {
  title: string;
  /** Cells to draw, out of `width`. */
  filled: number;
  width: number;
  /** 0..1 once `total` is known. */
  fraction?: number;
  percent?: string;
  amounts?: string;
  /** Widget line: status plus the full current path. */
  detail: string;
  /** Footer line: status plus a shortened path. */
  status: string;
}

const BAR_WIDTH = 28;

export function listingState(done: number, file: string | undefined, peer: string): ProgressState {
  const count = done > 0 ? `  ${done} files` : "";
  return { peer, status: `Listing project files${count}`, file, done: 0 };
}

export function readingState(
  event: { done: number; total?: number; file?: string; fileIndex: number; fileCount?: number },
  peer: string,
): ProgressState {
  const count = event.fileCount && event.fileCount > 0
    ? `  ${Math.min(event.fileCount, event.fileIndex + 1)}/${event.fileCount}`
    : "";
  return {
    peer,
    status: `Reading project files${count}`,
    done: event.done,
    total: event.total,
    file: event.file,
  };
}

export function sendingState(
  event: { phase: "sending" | "writing"; done: number; total: number; fileIndex: number; fileCount: number; file?: string },
  peer: string,
): ProgressState {
  if (event.phase === "writing") {
    return { peer, status: "Writing the session on the other computer", done: event.done, total: event.total };
  }
  const count = event.fileCount > 0 ? `  ${Math.min(event.fileCount, event.fileIndex + 1)}/${event.fileCount}` : "";
  return { peer, status: `Sending${count}`, done: event.done, total: event.total, file: event.file };
}

export function retryState(previous: ProgressState, attempt: number): ProgressState {
  return { ...previous, status: `Connection dropped, resuming (${attempt})` };
}

/**
 * Filled cells for a 0..1 fraction.
 * Any progress shows at least one cell. The last cell fills only at 100%,
 * so a bar that still has work left does not look finished.
 */
export function barFilled(fraction: number | undefined, width: number): number {
  if (width <= 0 || fraction === undefined || fraction <= 0) return 0;
  if (fraction >= 1) return width;
  return Math.min(width - 1, Math.max(1, Math.floor(fraction * width)));
}

export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < 1024) return `${Math.round(safe)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = safe / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 ? 1 : 2;
  const text = value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  return `${text} ${units[unit]}`;
}

export function formatProgress(state: ProgressState): ProgressView {
  const fraction = state.total === undefined ? undefined : fractionOf(state.done, state.total);
  const shown = state.total === undefined ? Math.max(0, state.done) : Math.min(state.total, Math.max(0, state.done));
  const file = state.file?.trim();
  const detail = file ? `${state.status}  ${file}` : state.status;
  const status = file ? `${state.status}  ${clipEnd(file, 36)}` : state.status;
  return {
    title: state.peer ? `Teleporting to ${state.peer}` : "Teleporting",
    width: BAR_WIDTH,
    filled: barFilled(fraction, BAR_WIDTH),
    fraction,
    percent: fraction === undefined ? undefined : `${Math.floor(fraction * 100)}%`,
    amounts: state.total === undefined || state.total <= 0 ? undefined : `${formatBytes(shown)} / ${formatBytes(state.total)}`,
    detail,
    status,
  };
}

function fractionOf(done: number, total: number): number {
  if (total <= 0) return 1;
  if (done <= 0) return 0;
  if (done >= total) return 1;
  return done / total;
}

function clipEnd(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - (max - 1))}`;
}

/**
 * Coalesce progress paints. File chunks arrive much faster than the terminal
 * should redraw.
 */
export function createProgressThrottle(emit: (state: ProgressState) => void, intervalMs = 80): {
  push(state: ProgressState): void;
  flush(): void;
  stop(): void;
} {
  let last = 0;
  let pending: ProgressState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const emitPending = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (stopped || pending === undefined) return;
    const state = pending;
    pending = undefined;
    last = Date.now();
    emit(state);
  };

  return {
    push(state) {
      if (stopped) return;
      pending = state;
      const wait = intervalMs - (Date.now() - last);
      if (wait <= 0) {
        emitPending();
        return;
      }
      if (!timer) timer = setTimeout(emitPending, wait);
    },
    flush() {
      emitPending();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}
