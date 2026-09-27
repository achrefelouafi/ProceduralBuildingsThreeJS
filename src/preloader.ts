/**
 * The loading screen (markup + CSS in index.html): a white massing model that
 * assembles itself with the progress (the building first, then the city
 * around it), a progress bar, a percentage and the current step. Its idle
 * animations are compositor-only, so they keep moving while the main thread is
 * busy evaluating a building graph.
 *
 * Progress is split into weighted steps; a step can report sub-progress
 * (network items loaded, …). The shown value eases towards the target.
 */
import { DefaultLoadingManager } from "three";

/** lets the browser paint (e.g. a new step label) before a blocking task; never hangs in a hidden tab */
export function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 80);
  });
}

export class Preloader {
  private el = document.getElementById("preloader");
  private fill = document.getElementById("pl-fill");
  private pctEl = document.getElementById("pl-pct");
  private stepEl = document.getElementById("pl-step");
  private target = 0;
  private shown = 0;
  private last = performance.now();
  private running = true;

  constructor() {
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.shown += (this.target - this.shown) * Math.min(1, dt * 6);
      if (this.target - this.shown < 0.001) this.shown = this.target;
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** overall progress 0..1 (never goes backwards) and, optionally, the step label */
  set(progress: number, label?: string): void {
    this.target = Math.max(this.target, Math.min(1, progress));
    if (label !== undefined && this.stepEl) this.stepEl.textContent = label;
    this.el?.setAttribute("aria-valuenow", String(Math.round(this.target * 100)));
  }

  /**
   * a step spanning [from, to] of the bar; `fn` may report its own 0..1
   * progress. The label is painted before `fn` runs (it may block).
   */
  async step<T>(label: string, from: number, to: number, fn: (sub: (f: number) => void) => T | Promise<T>): Promise<T> {
    this.set(from, label);
    this.draw();
    await nextFrame();
    const result = await fn(f => this.set(from + (to - from) * Math.min(Math.max(f, 0), 1)));
    this.set(to);
    return result;
  }

  /** complete the model, then fade out; resolves once the scene is revealed */
  async done(): Promise<void> {
    this.set(1, "ready");
    this.shown = 1;
    this.draw();
    await new Promise(r => setTimeout(r, 700));
    this.el?.classList.add("pl-out");
    await new Promise(r => setTimeout(r, 1100));
    this.running = false;
    this.el?.remove();
  }

  fail(message: string): void {
    this.el?.classList.add("pl-fail");
    if (this.stepEl) this.stepEl.textContent = message;
  }

  private draw(): void {
    const p = this.shown;
    this.el?.style.setProperty("--p", p.toFixed(4));
    if (this.fill) this.fill.style.transform = `scaleX(${p.toFixed(4)})`;
    if (this.pctEl) this.pctEl.firstChild!.textContent = String(Math.floor(p * 100));
  }
}

/**
 * Count network loads while `cb` is set: three's loaders (textures, GLB) via
 * the default LoadingManager, and plain fetch() calls (the graph JSON / kit
 * buffers). Returns a function that stops tracking.
 */
export function trackNetwork(cb: (done: number, total: number) => void): () => void {
  const m = DefaultLoadingManager;
  const prev = { onStart: m.onStart, onProgress: m.onProgress, onError: m.onError };
  let managerDone = 0, managerTotal = 0, fetchDone = 0, fetchTotal = 0;
  const report = () => cb(managerDone + fetchDone, managerTotal + fetchTotal);
  m.onStart = (_url, loaded, total) => { managerDone = loaded; managerTotal = total; report(); };
  m.onProgress = (_url, loaded, total) => { managerDone = loaded; managerTotal = total; report(); };
  m.onError = () => { managerDone++; report(); };
  const origFetch = window.fetch;
  window.fetch = (...args: Parameters<typeof fetch>) => {
    fetchTotal++;
    report();
    return origFetch(...args).finally(() => { fetchDone++; report(); });
  };
  return () => {
    window.fetch = origFetch;
    Object.assign(m, prev);
  };
}

/** "evaluating…" pill, shown while a graph building re-evaluates after a slider change */
export class BusyPill {
  private el = document.getElementById("busy");
  private label = this.el?.querySelector("span") ?? null;
  private depth = 0;

  /** run a (blocking) task with the pill up; the pill is painted first */
  async run<T>(label: string, fn: () => T): Promise<T> {
    this.depth++;
    this.show(label);
    await nextFrame();
    try {
      return fn();
    } finally {
      if (--this.depth === 0) this.hide();
    }
  }

  show(label: string): void {
    if (this.label) this.label.textContent = label;
    this.el?.classList.add("on");
  }

  hide(): void {
    this.el?.classList.remove("on");
  }
}
