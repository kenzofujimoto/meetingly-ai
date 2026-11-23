/**
 * Windows low-level keyboard hook (WH_KEYBOARD_LL), run on its own worker thread (see hotkeys/lowLevel.ts).
 *
 * Why: Electron's globalShortcut uses RegisterHotKey, which only fires when Windows sees the modifiers.
 * A page in fullscreen with navigator.keyboard.lock() makes Chromium install its own WH_KEYBOARD_LL hook
 * that swallows Ctrl/Alt/Win, so every Meetingly shortcut silently stops. Windows calls the most recently
 * installed hook first, so this thread reinstalls its hook on every tick to stay ahead of such hooks,
 * matches shortcuts itself (HotkeyMatcher) and swallows only the shortcut's key.
 *
 * The thread sits in GetMessageW; Windows calls the hook from inside that call, on this same thread.
 * Nothing here logs, stores or sends keys: only the name of a matched action leaves the thread.
 */
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads"
import koffi from "koffi"
import { HotkeyMatcher, type KeyEvent } from "./hotkeys/matcher"
import type { HotkeyWorkerData, HotkeyWorkerMessage } from "./hotkeys/lowLevel"

const WH_KEYBOARD_LL = 13
const HC_ACTION = 0
const WM_KEYDOWN = 0x0100
const WM_SYSKEYDOWN = 0x0104
const WM_TIMER = 0x0113

function post(message: HotkeyWorkerMessage): void {
  parentPort?.postMessage(message)
}

function run(input: HotkeyWorkerData): void {
  const user32 = koffi.load("user32.dll")
  const kernel32 = koffi.load("kernel32.dll")

  const KeyInfo = koffi.struct({ vkCode: "uint32", scanCode: "uint32", flags: "uint32", time: "uint32", dwExtraInfo: "uintptr_t" })
  const Msg = koffi.struct({
    hwnd: "void *",
    message: "uint32",
    wParam: "uintptr_t",
    lParam: "intptr_t",
    time: "uint32",
    ptX: "int32",
    ptY: "int32",
    lPrivate: "uint32"
  })
  const HookProc = koffi.proto("__stdcall", "MeetinglyLowLevelKeyboardProc", "intptr_t", ["int", "uintptr_t", "void *"])
  const SetWindowsHookExW = user32.func("__stdcall", "SetWindowsHookExW", "void *", ["int", koffi.pointer(HookProc), "void *", "uint32"])
  const UnhookWindowsHookEx = user32.func("__stdcall", "UnhookWindowsHookEx", "bool", ["void *"])
  const CallNextHookEx = user32.func("__stdcall", "CallNextHookEx", "intptr_t", ["void *", "int", "uintptr_t", "void *"])
  const GetMessageW = user32.func("__stdcall", "GetMessageW", "int", [koffi.out(koffi.pointer(Msg)), "void *", "uint32", "uint32"])
  const SetTimer = user32.func("__stdcall", "SetTimer", "uintptr_t", ["void *", "uintptr_t", "uint32", "void *"])
  const KillTimer = user32.func("__stdcall", "KillTimer", "bool", ["void *", "uintptr_t"])
  const GetAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "int16_t", ["int"])
  const GetModuleHandleW = kernel32.func("__stdcall", "GetModuleHandleW", "void *", ["void *"])
  const GetLastError = kernel32.func("__stdcall", "GetLastError", "uint32", [])

  const matcher = new HotkeyMatcher(input.bindings, { isDown: (vk) => GetAsyncKeyState(vk) < 0 })
  let reportedFailure = false

  // Runs for every key press on the system: keep it short, and never let an exception block the keyboard.
  const onKey = (code: number, wParam: number | bigint, lParam: unknown): number | bigint => {
    if (code !== HC_ACTION) return CallNextHookEx(null, code, wParam, lParam)
    let event: KeyEvent | null = null
    let swallow = false
    try {
      const info = koffi.decode(lParam, KeyInfo) as { vkCode: number }
      const message = Number(wParam)
      event = { vk: info.vkCode, down: message === WM_KEYDOWN || message === WM_SYSKEYDOWN }
      const decision = matcher.handle(event)
      if (decision.action) post({ type: "action", action: decision.action })
      swallow = decision.swallow
    } catch (err) {
      event = null
      if (!reportedFailure) {
        reportedFailure = true
        post({ type: "error", message: `key handling failed: ${(err as Error).message}` })
      }
    }
    if (swallow) return 1
    const result = CallNextHookEx(null, code, wParam, lParam)
    if (event) matcher.noteDownstream(event, Number(result) !== 0)
    return result
  }

  const callback = koffi.register(onKey, koffi.pointer(HookProc))
  const instance = GetModuleHandleW(null)
  let hook: unknown = null

  /** Puts a fresh hook first in the chain, then drops the previous one (no gap in between). */
  const install = (): boolean => {
    const next = SetWindowsHookExW(WH_KEYBOARD_LL, callback, instance, 0)
    if (!next) {
      post({ type: "error", message: `SetWindowsHookExW failed (${GetLastError()})` })
      return false
    }
    if (hook) UnhookWindowsHookEx(hook)
    hook = next
    return true
  }

  /** Applies queued requests from the main process; true when asked to stop. */
  const readControl = (): boolean => {
    for (let m = receiveMessageOnPort(input.control); m; m = receiveMessageOnPort(input.control)) {
      const request = m.message as { type?: unknown; bindings?: unknown } | null
      if (request?.type === "stop") return true
      if (request?.type === "bindings" && Array.isArray(request.bindings)) matcher.setBindings(request.bindings)
    }
    return false
  }

  if (!install()) {
    koffi.unregister(callback)
    return
  }
  post({ type: "ready" })
  const timer = SetTimer(null, 0, input.reinstallMs, null)
  const msg = {} as { message?: number }
  try {
    // GetMessageW returns 0 on WM_QUIT and -1 on error.
    while (GetMessageW(msg, null, 0, 0) > 0) {
      if (msg.message !== WM_TIMER) continue
      if (readControl()) break
      install()
    }
  } finally {
    KillTimer(null, timer)
    if (hook) UnhookWindowsHookEx(hook)
    koffi.unregister(callback)
  }
}

if (process.platform === "win32" && parentPort) {
  try {
    run(workerData as HotkeyWorkerData)
  } catch (err) {
    post({ type: "error", message: `hook thread failed: ${(err as Error).message}` })
    process.exitCode = 1
  }
}
