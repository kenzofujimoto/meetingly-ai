import { globalShortcut } from "electron"
import path from "node:path"
import type { ShortcutAction, Shortcuts } from "../shared/types"
import type { ChatService } from "./services/chat"
import type { RecordingSession } from "./services/session"
import type { SettingsStore } from "./services/settings"
import type { WindowManager } from "./windows/WindowManager"
import { copyFocusedSelection } from "./copy"
import { isCopyChord } from "./copy-menu"
import { parseAccelerator } from "./hotkeys/accelerator"
import { hookBindings, REPEATING_ACTIONS } from "./hotkeys/bindings"
import { LowLevelHotkeys } from "./hotkeys/lowLevel"

interface Deps {
  settings: SettingsStore
  windows: WindowManager
  session: RecordingSession
  chat: ChatService
  /** Opens the web dashboard in the browser, signed in. */
  openWeb: () => void
}

/**
 * Global shortcuts, read from settings and re-registered whenever they change.
 * Conflicts (another app already owns the key) are recorded on the settings
 * store so the Settings page can show them.
 *
 * On Windows a low-level keyboard hook (hotkeys/lowLevel.ts) watches the same shortcuts: it still works
 * when a fullscreen page locks the keyboard (Chromium then swallows Ctrl, and RegisterHotKey never fires).
 * The OS shortcuts stay registered as the fallback; MEETINGLY_DISABLE_KEYBOARD_HOOK=1 turns the hook off.
 */
export class ShortcutManager {
  private readonly actions: Record<ShortcutAction, () => void>
  private readonly hook: LowLevelHotkeys | null

  constructor(private readonly deps: Deps) {
    const { windows, session, chat } = deps
    this.actions = {
      showToolbar: () => windows.centerMain(),
      toggleAll: () => windows.toggleAll(),
      chat: () => windows.togglePanel("answers"),
      dashboard: () => deps.openWeb(),
      screenshot: () => {
        windows.showPanel("answers")
        void chat.screenshot().catch(() => {})
      },
      listen: () => {
        const { status } = session.state()
        if (status === "idle") {
          windows.showPanel("transcript")
          void session.start().catch(() => {})
        } else if (status === "recording") session.pause()
        else if (status === "paused") session.resume()
      },
      moveLeft: () => windows.moveMain(-1, 0),
      moveRight: () => windows.moveMain(1, 0),
      moveUp: () => windows.moveMain(0, -1),
      moveDown: () => windows.moveMain(0, 1)
    }
    const hookEnabled = process.platform === "win32" && !process.env.MEETINGLY_DISABLE_KEYBOARD_HOOK
    this.hook = hookEnabled
      ? new LowLevelHotkeys({
          workerFile: path.join(__dirname, "hotkey-worker.js"),
          onAction: (action) => this.runFromHook(action),
          log: { info: (m) => console.info(`[shortcuts] ${m}`), warn: (m) => console.warn(`[shortcuts] ${m}`) }
        })
      : null
  }

  /** (Re)register everything from the current settings. Returns the actions that failed. */
  register(): ShortcutAction[] {
    globalShortcut.unregisterAll()
    const shortcuts = this.deps.settings.get().shortcuts
    const failed: ShortcutAction[] = []
    for (const action of Object.keys(this.actions) as ShortcutAction[]) {
      const accelerator = shortcuts[action]?.trim()
      if (!accelerator) continue
      let ok = false
      try {
        ok = globalShortcut.register(accelerator, this.handlerFor(action, accelerator))
      } catch {
        ok = false
      }
      if (!ok) {
        failed.push(action)
        console.warn(`[shortcuts] could not register ${action} = ${accelerator}`)
      }
    }
    this.deps.settings.setShortcutConflicts(failed)
    this.syncHook(shortcuts)
    return failed
  }

  unregister(): void {
    globalShortcut.unregisterAll()
    this.hook?.stop()
  }

  /**
   * Bound to Ctrl+C: selected text in a Meetingly window is copied instead (Windows gives the key to
   * the shortcut, never to the window).
   */
  private handlerFor(action: ShortcutAction, accelerator: string): () => void {
    const run = this.actions[action]
    return isCopyChord(accelerator) ? () => void copyFocusedSelection().then((copied) => copied || run()) : run
  }

  private runFromHook(action: string): void {
    if (!(action in this.actions)) return
    const shortcutAction = action as ShortcutAction
    const accelerator = this.deps.settings.get().shortcuts[shortcutAction]?.trim()
    if (!accelerator) return
    // Moves repeat while the key is held; logging each one would flood the log.
    if (!REPEATING_ACTIONS.has(action)) console.info(`[shortcuts] ${action} (keyboard hook)`)
    this.handlerFor(shortcutAction, accelerator)()
  }

  private syncHook(shortcuts: Shortcuts): void {
    if (!this.hook) return
    const bindings = hookBindings(shortcuts)
    const unwatched = bindings.filter((b) => !parseAccelerator(b.accelerator)).map((b) => `${b.action} = ${b.accelerator}`)
    if (unwatched.length) console.info(`[shortcuts] left to the OS shortcut only: ${unwatched.join(", ")}`)
    if (this.hook.running) this.hook.update(bindings)
    else this.hook.start(bindings)
  }
}

export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+").map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return false
  const modifiers = new Set(["CommandOrControl", "Command", "Control", "Ctrl", "Cmd", "Alt", "Option", "Shift", "Super", "Meta"])
  const key = parts[parts.length - 1]
  return parts.slice(0, -1).every((p) => modifiers.has(p)) && !modifiers.has(key) && key.length > 0
}

export type { Shortcuts }
