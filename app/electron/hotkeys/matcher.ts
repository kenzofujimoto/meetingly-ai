import { chordId, parseAccelerator, type Chord } from "./accelerator"

export interface HotkeyBinding {
  accelerator: string
  action: string
  /** Fire again on every auto-repeat while the key is held (moving the toolbar); otherwise once per press. */
  repeat: boolean
}

export interface KeyEvent {
  vk: number
  down: boolean
}

export interface Decision {
  /** Keep the key from every app below (the page never sees the shortcut's key). */
  swallow: boolean
  action: string | null
}

/** Windows' view of the keyboard (GetAsyncKeyState). */
export interface KeyState {
  isDown(vk: number): boolean
}

const GROUPS: Record<Exclude<keyof Chord, "vk">, readonly number[]> = {
  ctrl: [0x11, 0xa2, 0xa3],
  shift: [0x10, 0xa0, 0xa1],
  alt: [0x12, 0xa4, 0xa5],
  win: [0x5b, 0x5c]
}
const MODIFIER_KEYS = new Set(Object.values(GROUPS).flat())

export function isModifierKey(vk: number): boolean {
  return MODIFIER_KEYS.has(vk)
}

const PASS: Decision = { swallow: false, action: null }

/**
 * Decides, key event by key event, whether a shortcut was pressed. It keeps its own record of the held
 * modifiers because a fullscreen page's keyboard lock swallows Ctrl/Alt/Win further down the hook chain,
 * so Windows (and RegisterHotKey) never learns they are down. Modifiers are always passed on.
 *
 * Never logs or stores keys: it only remembers which modifiers are held and which shortcut key is down.
 */
export class HotkeyMatcher {
  private bindings = new Map<string, HotkeyBinding>()
  /** Held modifiers, and whether a hook below us swallowed their key-down (a keyboard lock). */
  private held = new Map<number, { swallowedBelow: boolean }>()
  /** Shortcut keys we swallowed on the way down: their repeats and key-up are swallowed too. */
  private triggered = new Map<number, HotkeyBinding>()

  constructor(
    bindings: HotkeyBinding[],
    private readonly keyState: KeyState
  ) {
    this.setBindings(bindings)
  }

  /** Replaces the shortcuts. Returns the accelerators the hook cannot watch (left to the OS shortcut). */
  setBindings(bindings: HotkeyBinding[]): { unsupported: string[] } {
    const next = new Map<string, HotkeyBinding>()
    const unsupported: string[] = []
    for (const binding of bindings) {
      const chord = parseAccelerator(binding.accelerator)
      if (chord) next.set(chordId(chord), binding)
      else unsupported.push(binding.accelerator)
    }
    this.bindings = next
    return { unsupported }
  }

  handle({ vk, down }: KeyEvent): Decision {
    if (isModifierKey(vk)) {
      if (down) this.held.set(vk, this.held.get(vk) ?? { swallowedBelow: false })
      else this.held.delete(vk)
      return PASS
    }
    if (!down) {
      if (!this.triggered.delete(vk)) return PASS
      return { swallow: true, action: null }
    }
    const repeating = this.triggered.get(vk)
    if (repeating) return { swallow: true, action: repeating.repeat ? repeating.action : null }

    this.pruneStaleModifiers()
    const binding = this.bindings.get(chordId({ ...this.modifiers(), vk }))
    if (!binding) return PASS
    this.triggered.set(vk, binding)
    return { swallow: true, action: binding.action }
  }

  /** Called after a passed-on event went down the chain: did a hook below swallow it? */
  noteDownstream({ vk, down }: KeyEvent, swallowed: boolean): void {
    if (!down || !isModifierKey(vk)) return
    const entry = this.held.get(vk)
    if (entry) entry.swallowedBelow = swallowed
  }

  /**
   * A modifier we think is held but Windows says is up, and that no keyboard lock swallowed, is one whose
   * key-up we missed (another hook was first in the chain for a moment). Dropping it keeps a stuck Ctrl
   * from turning plain typing into shortcuts.
   */
  private pruneStaleModifiers(): void {
    for (const [vk, entry] of this.held) {
      if (!entry.swallowedBelow && !this.keyState.isDown(vk)) this.held.delete(vk)
    }
  }

  private modifiers(): Omit<Chord, "vk"> {
    const any = (group: readonly number[]) => group.some((vk) => this.held.has(vk))
    return { ctrl: any(GROUPS.ctrl), shift: any(GROUPS.shift), alt: any(GROUPS.alt), win: any(GROUPS.win) }
  }
}
