import { MessageChannel, Worker, type MessagePort } from "node:worker_threads"
import type { HotkeyBinding } from "./matcher"

/** What the hook thread receives at start (see electron/hotkey-worker.ts). */
export interface HotkeyWorkerData {
  bindings: HotkeyBinding[]
  /** How often the hook reinstalls itself to stay first in Windows' hook chain. */
  reinstallMs: number
  /** Main → thread: { type: "bindings", bindings } | { type: "stop" }. Read on every reinstall tick. */
  control: MessagePort
}

/** Thread → main messages. */
export type HotkeyWorkerMessage = { type: "ready" } | { type: "action"; action: string } | { type: "error"; message: string }

export interface HotkeyWorker {
  on(event: "message", listener: (message: unknown) => void): this
  on(event: "error", listener: (err: Error) => void): this
  on(event: "exit", listener: (code: number) => void): this
  terminate(): Promise<number>
}

interface Options {
  workerFile: string
  onAction: (action: string) => void
  log: { info: (message: string) => void; warn: (message: string) => void }
  spawn?: (file: string, data: HotkeyWorkerData) => HotkeyWorker
  reinstallMs?: number
}

const DEFAULT_REINSTALL_MS = 500
const RESTART_DELAY_MS = 1000
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 60_000
const STOP_TIMEOUT_MS = 2000

function spawnWorker(file: string, data: HotkeyWorkerData): HotkeyWorker {
  return new Worker(file, { workerData: data, transferList: [data.control] })
}

/**
 * Runs the Windows low-level keyboard hook on its own thread, so a busy main process never delays
 * anyone's typing, and restarts it if it dies. The OS-level shortcuts (globalShortcut) stay registered
 * as the fallback: when the hook takes a shortcut's key, RegisterHotKey never sees it, so nothing runs twice.
 */
export class LowLevelHotkeys {
  private worker: HotkeyWorker | null = null
  private control: MessagePort | null = null
  private bindings: HotkeyBinding[] = []
  private stopping = false
  private crashes: number[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: Options) {}

  get running(): boolean {
    return this.worker !== null
  }

  start(bindings: HotkeyBinding[]): void {
    this.bindings = bindings
    this.stopping = false
    if (!this.worker) this.launch()
  }

  /** New shortcuts go to the running thread; it picks them up on its next tick. */
  update(bindings: HotkeyBinding[]): void {
    this.bindings = bindings
    this.control?.postMessage({ type: "bindings", bindings })
  }

  stop(): void {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const worker = this.worker
    if (!worker) return
    this.control?.postMessage({ type: "stop" })
    // The thread reads the stop request on its next tick; terminate() covers a thread that never gets there.
    const fallback = setTimeout(() => void worker.terminate().catch(() => {}), STOP_TIMEOUT_MS)
    worker.on("exit", () => clearTimeout(fallback))
  }

  private launch(): void {
    const channel = new MessageChannel()
    let worker: HotkeyWorker
    try {
      worker = (this.opts.spawn ?? spawnWorker)(this.opts.workerFile, {
        bindings: this.bindings,
        reinstallMs: this.opts.reinstallMs ?? DEFAULT_REINSTALL_MS,
        control: channel.port2
      })
    } catch (err) {
      channel.port1.close()
      this.opts.log.warn(`keyboard hook could not start: ${(err as Error).message}`)
      this.scheduleRestart()
      return
    }
    this.worker = worker
    this.control = channel.port1
    worker.on("message", (message) => this.onMessage(message))
    worker.on("error", (err) => this.opts.log.warn(`keyboard hook thread error: ${err.message}`))
    worker.on("exit", (code) => {
      if (this.worker !== worker) return
      this.worker = null
      this.control = null
      channel.port1.close()
      if (this.stopping) return
      this.opts.log.warn(`keyboard hook thread exited (${code})`)
      this.scheduleRestart()
    })
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return
    const m = message as Partial<HotkeyWorkerMessage> & { action?: unknown; message?: unknown }
    if (m.type === "ready") this.opts.log.info("keyboard hook ready")
    else if (m.type === "error" && typeof m.message === "string") this.opts.log.warn(`keyboard hook: ${m.message}`)
    else if (m.type === "action" && typeof m.action === "string" && this.bindings.some((b) => b.action === m.action)) {
      this.opts.onAction(m.action)
    }
  }

  private scheduleRestart(): void {
    const now = Date.now()
    this.crashes = [...this.crashes, now].filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.crashes.length > MAX_RESTARTS) {
      this.opts.log.warn("keyboard hook keeps failing; giving up until the next launch (OS shortcuts still work)")
      return
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping && !this.worker) this.launch()
    }, RESTART_DELAY_MS)
  }
}
