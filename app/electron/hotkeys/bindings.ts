import type { ShortcutAction, Shortcuts } from "../../shared/types"
import type { HotkeyBinding } from "./matcher"

export const REPEATING_ACTIONS: ReadonlySet<string> = new Set(["moveLeft", "moveRight", "moveUp", "moveDown"])

/** The configured shortcuts as keyboard-hook bindings; cleared ones are skipped. */
export function hookBindings(shortcuts: Shortcuts): HotkeyBinding[] {
  const bindings: HotkeyBinding[] = []
  for (const [action, value] of Object.entries(shortcuts) as [ShortcutAction, string | undefined][]) {
    const accelerator = value?.trim()
    if (accelerator) bindings.push({ accelerator, action, repeat: REPEATING_ACTIONS.has(action) })
  }
  return bindings
}
