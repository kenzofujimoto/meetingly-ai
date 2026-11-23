import { EventEmitter } from "node:events"
import { receiveMessageOnPort, type MessagePort } from "node:worker_threads"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseAccelerator } from "../electron/hotkeys/accelerator"
import { hookBindings } from "../electron/hotkeys/bindings"
import { LowLevelHotkeys, type HotkeyWorker } from "../electron/hotkeys/lowLevel"
import { HotkeyMatcher, type HotkeyBinding } from "../electron/hotkeys/matcher"
import { DEFAULT_SHORTCUTS } from "../shared/types"

const VK = {
  CONTROL: 0x11,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LSHIFT: 0xa0,
  LMENU: 0xa4,
  LWIN: 0x5b,
  B: 0x42,
  C: 0x43,
  V: 0x56,
  ENTER: 0x0d,
  LEFT: 0x25
}

describe("reading a shortcut the way the keyboard hook sees it", () => {
  it("understands every default shortcut", () => {
    for (const accelerator of Object.values(DEFAULT_SHORTCUTS)) expect(parseAccelerator(accelerator), accelerator).not.toBeNull()
    expect(parseAccelerator("CommandOrControl+Space")).toEqual({ ctrl: true, shift: false, alt: false, win: false, vk: 0x20 })
    expect(parseAccelerator("CommandOrControl+Shift+C")).toEqual({ ctrl: true, shift: true, alt: false, win: false, vk: VK.C })
    expect(parseAccelerator("CommandOrControl+Enter")?.vk).toBe(VK.ENTER)
    expect(parseAccelerator("CommandOrControl+Left")?.vk).toBe(VK.LEFT)
    expect(parseAccelerator("CommandOrControl+Right")?.vk).toBe(0x27)
    expect(parseAccelerator("CommandOrControl+Up")?.vk).toBe(0x26)
    expect(parseAccelerator("CommandOrControl+Down")?.vk).toBe(0x28)
  })

  it("accepts the modifier names Electron accepts, in any case and spacing", () => {
    for (const a of ["CmdOrCtrl+B", "Ctrl+B", "Control + b", "commandorcontrol+B"]) {
      expect(parseAccelerator(a), a).toEqual({ ctrl: true, shift: false, alt: false, win: false, vk: VK.B })
    }
    expect(parseAccelerator("Alt+B")).toMatchObject({ alt: true, ctrl: false })
    expect(parseAccelerator("Option+B")).toMatchObject({ alt: true })
    for (const a of ["Super+B", "Meta+B", "Command+B", "Cmd+B"]) expect(parseAccelerator(a), a).toMatchObject({ win: true, ctrl: false })
  })

  it("maps named, function, digit and numpad keys", () => {
    const cases: Record<string, number> = {
      "Ctrl+Return": 0x0d,
      "Ctrl+Esc": 0x1b,
      "Ctrl+Escape": 0x1b,
      "Ctrl+Tab": 0x09,
      "Ctrl+Backspace": 0x08,
      "Ctrl+Delete": 0x2e,
      "Ctrl+Insert": 0x2d,
      "Ctrl+Home": 0x24,
      "Ctrl+End": 0x23,
      "Ctrl+PageUp": 0x21,
      "Ctrl+PageDown": 0x22,
      "Ctrl+F1": 0x70,
      "Ctrl+F12": 0x7b,
      "Ctrl+F24": 0x87,
      "Ctrl+0": 0x30,
      "Ctrl+9": 0x39,
      "Ctrl+num0": 0x60,
      "Ctrl+num9": 0x69,
      "Ctrl+numadd": 0x6b,
      "Ctrl+numsub": 0x6d,
      "Ctrl+nummult": 0x6a,
      "Ctrl+numdiv": 0x6f,
      "Ctrl+numdec": 0x6e,
      "Ctrl+Plus": 0xbb,
      "Ctrl+=": 0xbb,
      "Ctrl+-": 0xbd,
      "Ctrl+,": 0xbc,
      "Ctrl+.": 0xbe
    }
    for (const [accelerator, vk] of Object.entries(cases)) expect(parseAccelerator(accelerator)?.vk, accelerator).toBe(vk)
  })

  it("gives up on what it cannot match reliably (the OS shortcut still handles those)", () => {
    for (const a of ["", "   ", "CommandOrControl+", "Foo+B", "CommandOrControl+Shift", "Ctrl+B+C", "Ctrl+;", "Ctrl+[", "AltGr+E", "Ctrl+F25"]) {
      expect(parseAccelerator(a), JSON.stringify(a)).toBeNull()
    }
  })
})

describe("which shortcuts the keyboard hook watches", () => {
  it("watches every configured shortcut, and repeats only the moves while the key is held", () => {
    const bindings = hookBindings(DEFAULT_SHORTCUTS)
    expect(bindings).toHaveLength(Object.keys(DEFAULT_SHORTCUTS).length)
    for (const b of bindings) expect(b.repeat, b.action).toBe(b.action.startsWith("move"))
    expect(bindings.find((b) => b.action === "screenshot")?.accelerator).toBe("CommandOrControl+Enter")
  })

  it("skips shortcuts the user cleared", () => {
    const bindings = hookBindings({ ...DEFAULT_SHORTCUTS, dashboard: "", listen: "   " })
    expect(bindings.map((b) => b.action)).not.toContain("dashboard")
    expect(bindings.map((b) => b.action)).not.toContain("listen")
  })
})

/** Feeds key events the way the hook does: each event first goes through the matcher, then (unless swallowed) down the chain. */
function keyboard(bindings: HotkeyBinding[], opts: { lockSwallowsModifiers?: boolean } = {}) {
  const physicallyDown = new Set<number>()
  const matcher = new HotkeyMatcher(bindings, { isDown: (vk) => physicallyDown.has(vk) })
  const isModifier = (vk: number) => [0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c].includes(vk)
  const actions: string[] = []
  const reachedApps: string[] = []
  const event = (vk: number, down: boolean) => {
    const d = matcher.handle({ vk, down })
    if (d.action) actions.push(d.action)
    if (d.swallow) return
    // A Chromium keyboard lock below us swallows Ctrl/Alt/Win: Windows never records them as pressed.
    const swallowedBelow = Boolean(opts.lockSwallowsModifiers && isModifier(vk) && vk !== 0xa0 && vk !== 0xa1 && vk !== 0x10)
    matcher.noteDownstream({ vk, down }, swallowedBelow)
    if (!swallowedBelow) {
      if (down) physicallyDown.add(vk)
      else physicallyDown.delete(vk)
    }
    reachedApps.push(`${down ? "+" : "-"}${vk.toString(16)}`)
  }
  return {
    matcher,
    actions,
    reachedApps,
    down: (vk: number) => event(vk, true),
    up: (vk: number) => event(vk, false),
    press: (...vks: number[]) => {
      for (const vk of vks) event(vk, true)
      for (const vk of [...vks].reverse()) event(vk, false)
    },
    /** Simulates losing a key-up (another hook took it while we were not first in the chain). */
    loseKeyUp: (vk: number) => physicallyDown.delete(vk)
  }
}

const CHAT: HotkeyBinding = { accelerator: "CommandOrControl+Shift+C", action: "chat", repeat: false }
const SCREENSHOT: HotkeyBinding = { accelerator: "CommandOrControl+Enter", action: "screenshot", repeat: false }
const TOGGLE: HotkeyBinding = { accelerator: "CommandOrControl+B", action: "toggleAll", repeat: false }
const MOVE_LEFT: HotkeyBinding = { accelerator: "CommandOrControl+Left", action: "moveLeft", repeat: true }

describe("the keyboard hook", () => {
  it("runs the action and hides the key from the page, but never the modifiers", () => {
    const kb = keyboard([CHAT])
    kb.press(VK.LCONTROL, VK.LSHIFT, VK.C)
    expect(kb.actions).toEqual(["chat"])
    expect(kb.reachedApps).toEqual(["+a2", "+a0", "-a0", "-a2"])
  })

  it("matches the modifiers exactly", () => {
    const kb = keyboard([CHAT, TOGGLE])
    kb.press(VK.LCONTROL, VK.C)
    kb.press(VK.LSHIFT, VK.C)
    kb.press(VK.C)
    kb.press(VK.LCONTROL, VK.LSHIFT, VK.B)
    kb.press(VK.LCONTROL, VK.LMENU, VK.B)
    expect(kb.actions).toEqual([])
    expect(kb.reachedApps).toContain("+43")
    expect(kb.reachedApps).toContain("+42")
  })

  it("lets unbound chords through untouched", () => {
    const kb = keyboard([CHAT])
    kb.press(VK.LCONTROL, VK.V)
    expect(kb.actions).toEqual([])
    expect(kb.reachedApps).toEqual(["+a2", "+56", "-56", "-a2"])
  })

  it("works with the right Ctrl and with the generic Ctrl code", () => {
    const kb = keyboard([SCREENSHOT])
    kb.press(VK.RCONTROL, VK.ENTER)
    kb.press(VK.CONTROL, VK.ENTER)
    expect(kb.actions).toEqual(["screenshot", "screenshot"])
  })

  it("still fires when a fullscreen page's keyboard lock swallows Ctrl (the bug this fixes)", () => {
    const kb = keyboard([SCREENSHOT, CHAT, TOGGLE], { lockSwallowsModifiers: true })
    kb.press(VK.LCONTROL, VK.ENTER)
    kb.press(VK.LCONTROL, VK.LSHIFT, VK.C)
    kb.press(VK.LCONTROL, VK.B)
    expect(kb.actions).toEqual(["screenshot", "chat", "toggleAll"])
  })

  it("forgets a modifier whose release it missed, so typing is never eaten", () => {
    const kb = keyboard([TOGGLE])
    kb.down(VK.LCONTROL)
    kb.loseKeyUp(VK.LCONTROL)
    kb.press(VK.B)
    expect(kb.actions).toEqual([])
    expect(kb.reachedApps).toContain("+42")
    // The next real press works again.
    kb.press(VK.LCONTROL, VK.B)
    expect(kb.actions).toEqual(["toggleAll"])
  })

  it("fires a toggle once per press, even when the key auto-repeats", () => {
    const kb = keyboard([TOGGLE])
    kb.down(VK.LCONTROL)
    kb.down(VK.B)
    kb.down(VK.B)
    kb.down(VK.B)
    kb.up(VK.B)
    kb.up(VK.LCONTROL)
    expect(kb.actions).toEqual(["toggleAll"])
    expect(kb.reachedApps).toEqual(["+a2", "-a2"])
  })

  it("keeps moving while an arrow is held", () => {
    const kb = keyboard([MOVE_LEFT])
    kb.down(VK.LCONTROL)
    kb.down(VK.LEFT)
    kb.down(VK.LEFT)
    kb.down(VK.LEFT)
    kb.up(VK.LEFT)
    kb.up(VK.LCONTROL)
    expect(kb.actions).toEqual(["moveLeft", "moveLeft", "moveLeft"])
  })

  it("hides the key-up of a shortcut even when Ctrl was released first", () => {
    const kb = keyboard([TOGGLE])
    kb.down(VK.LCONTROL)
    kb.down(VK.B)
    kb.up(VK.LCONTROL)
    kb.up(VK.B)
    expect(kb.reachedApps).toEqual(["+a2", "-a2"])
  })

  it("switches to new shortcuts and reports the ones it cannot watch", () => {
    const kb = keyboard([TOGGLE])
    const { unsupported } = kb.matcher.setBindings([CHAT, { accelerator: "Ctrl+;", action: "listen", repeat: false }])
    expect(unsupported).toEqual(["Ctrl+;"])
    kb.press(VK.LCONTROL, VK.B)
    kb.press(VK.LCONTROL, VK.LSHIFT, VK.C)
    expect(kb.actions).toEqual(["chat"])
  })
})

class FakeWorker extends EventEmitter implements HotkeyWorker {
  terminated = false
  constructor(readonly control: MessagePort, readonly data: { bindings: HotkeyBinding[]; reinstallMs: number }) {
    super()
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(1)
  }
  /** Messages the main process sent on the control port. */
  received(): unknown[] {
    const out: unknown[] = []
    for (let m = receiveMessageOnPort(this.control); m; m = receiveMessageOnPort(this.control)) out.push(m.message)
    return out
  }
}

describe("the keyboard hook's thread", () => {
  let workers: FakeWorker[]
  let actions: string[]
  let warnings: string[]
  let hotkeys: LowLevelHotkeys

  beforeEach(() => {
    vi.useFakeTimers()
    workers = []
    actions = []
    warnings = []
    hotkeys = new LowLevelHotkeys({
      workerFile: "hotkey-worker.js",
      onAction: (a) => actions.push(a),
      log: { info: () => {}, warn: (m) => warnings.push(m) },
      spawn: (_file, workerData) => {
        const w = new FakeWorker(workerData.control, workerData)
        workers.push(w)
        return w
      }
    })
  })

  afterEach(() => {
    hotkeys.stop()
    for (const w of workers) w.control.close()
    vi.useRealTimers()
  })

  it("starts with the shortcuts and runs the actions it reports", () => {
    hotkeys.start([TOGGLE])
    expect(workers).toHaveLength(1)
    expect(workers[0].data.bindings).toEqual([TOGGLE])
    workers[0].emit("message", { type: "ready" })
    workers[0].emit("message", { type: "action", action: "toggleAll" })
    expect(actions).toEqual(["toggleAll"])
  })

  it("ignores actions it never bound and malformed messages", () => {
    hotkeys.start([TOGGLE])
    workers[0].emit("message", { type: "action", action: "rm -rf" })
    workers[0].emit("message", null)
    workers[0].emit("message", "action")
    expect(actions).toEqual([])
  })

  it("sends new shortcuts to the running thread instead of restarting it", () => {
    hotkeys.start([TOGGLE])
    hotkeys.update([CHAT])
    expect(workers).toHaveLength(1)
    expect(workers[0].received()).toEqual([{ type: "bindings", bindings: [CHAT] }])
    workers[0].emit("message", { type: "action", action: "chat" })
    expect(actions).toEqual(["chat"])
  })

  it("restarts the thread when it dies, and gives up after repeated crashes", () => {
    hotkeys.start([TOGGLE])
    for (let i = 0; i < 5; i++) {
      workers[workers.length - 1].emit("exit", 1)
      vi.advanceTimersByTime(1500)
    }
    expect(workers).toHaveLength(6)
    workers[workers.length - 1].emit("exit", 1)
    vi.advanceTimersByTime(60_000)
    expect(workers).toHaveLength(6)
    expect(warnings.some((w) => /giving up/i.test(w))).toBe(true)
  })

  it("stops cleanly and does not come back", () => {
    hotkeys.start([TOGGLE])
    hotkeys.stop()
    expect(workers[0].received()).toEqual([{ type: "stop" }])
    workers[0].emit("exit", 0)
    vi.advanceTimersByTime(5000)
    expect(workers).toHaveLength(1)
    expect(hotkeys.running).toBe(false)
  })
})
