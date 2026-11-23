/**
 * Electron accelerator strings ("CommandOrControl+Shift+C") as the Windows keyboard hook sees them:
 * which modifiers are held plus one virtual-key code. Only layout-independent keys are mapped; anything
 * else returns null and stays with the OS-level shortcut (globalShortcut), which handles it as before.
 */
export interface Chord {
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** The Windows key: Electron's Super, Meta, Command and Cmd on Windows. */
  win: boolean
  vk: number
}

type Modifier = "ctrl" | "shift" | "alt" | "win"

const MODIFIERS: Record<string, Modifier> = {
  commandorcontrol: "ctrl",
  cmdorctrl: "ctrl",
  control: "ctrl",
  ctrl: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  super: "win",
  meta: "win",
  command: "win",
  cmd: "win"
}

const NAMED_KEYS: Record<string, number> = {
  space: 0x20,
  enter: 0x0d,
  return: 0x0d,
  tab: 0x09,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  esc: 0x1b,
  escape: 0x1b,
  capslock: 0x14,
  numlock: 0x90,
  scrolllock: 0x91,
  printscreen: 0x2c,
  volumeup: 0xaf,
  volumedown: 0xae,
  volumemute: 0xad,
  medianexttrack: 0xb0,
  mediaprevioustrack: 0xb1,
  mediastop: 0xb2,
  mediaplaypause: 0xb3,
  numdec: 0x6e,
  numadd: 0x6b,
  numsub: 0x6d,
  nummult: 0x6a,
  numdiv: 0x6f,
  // VK_OEM_PLUS/MINUS/COMMA/PERIOD are the same key on every layout; the other VK_OEM_* codes are not.
  plus: 0xbb,
  "=": 0xbb,
  "-": 0xbd,
  ",": 0xbc,
  ".": 0xbe
}

function keyCode(name: string): number | null {
  const key = name.toLowerCase()
  if (key in NAMED_KEYS) return NAMED_KEYS[key]
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key)
  if (fn) return 0x6f + Number(fn[1])
  const num = /^num([0-9])$/.exec(key)
  if (num) return 0x60 + Number(num[1])
  return null
}

export function parseAccelerator(accelerator: string): Chord | null {
  const parts = accelerator.split("+").map((p) => p.trim())
  // "Ctrl+" or "Ctrl++" leave an empty part; Electron spells the plus key "Plus".
  if (parts.length === 0 || parts.some((p) => p === "")) return null
  const chord: Chord = { ctrl: false, shift: false, alt: false, win: false, vk: 0 }
  let key: number | null = null
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()]
    if (modifier) {
      chord[modifier] = true
      continue
    }
    if (key !== null) return null
    key = keyCode(part)
    if (key === null) return null
  }
  if (key === null) return null
  chord.vk = key
  return chord
}

/** The same chord always gives the same id, however it was written. */
export function chordId(chord: Chord): string {
  return `${chord.ctrl ? "C" : ""}${chord.shift ? "S" : ""}${chord.alt ? "A" : ""}${chord.win ? "W" : ""}:${chord.vk}`
}
