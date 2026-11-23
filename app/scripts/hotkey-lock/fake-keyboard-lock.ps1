<#
  Stands in for a browser tab in fullscreen with navigator.keyboard.lock(): Chromium installs a
  WH_KEYBOARD_LL hook (ui/events/win/modifier_keyboard_hook_win.cc) that swallows Ctrl, Alt and Win
  (returns 1 without CallNextHookEx). Windows then never sees the modifier, so a RegisterHotKey
  hotkey such as Ctrl+Enter arrives as a plain Enter and never fires.

  This process registers a hotkey the way Electron's globalShortcut does (RegisterHotKey) and, with
  -SwallowModifiers, installs the same kind of modifier-swallowing hook. It prints READY, then one
  HOTKEY line per hotkey delivery, then DONE after -DurationMs.
#>
param(
  [switch]$SwallowModifiers,
  [uint32]$Modifiers = 6,      # MOD_CONTROL (2) | MOD_SHIFT (4)
  [uint32]$Key = 0x87,         # VK_F24: no physical key, so nothing else reacts to it
  [uint32]$DurationMs = 4000
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class FakeKeyboardLock {
  [StructLayout(LayoutKind.Sequential)]
  public struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr extra; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int id, HookProc fn, IntPtr mod, uint threadId);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr fn);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr name);

  const int WH_KEYBOARD_LL = 13;
  const uint MOD_NOREPEAT = 0x4000;
  const uint WM_HOTKEY = 0x0312;
  const uint WM_TIMER = 0x0113;

  static HookProc proc;

  static bool IsModifier(uint vk) {
    // Ctrl, Alt and Win, generic and left/right; Shift is not captured (same set as Chromium).
    return vk == 0x11 || vk == 0xA2 || vk == 0xA3 || vk == 0x12 || vk == 0xA4 || vk == 0xA5 || vk == 0x5B || vk == 0x5C;
  }

  static IntPtr Hook(int code, IntPtr wParam, IntPtr lParam) {
    if (code == 0) {
      KBDLLHOOKSTRUCT key = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
      if (IsModifier(key.vkCode)) return (IntPtr)1;
    }
    return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
  }

  public static int Run(bool swallowModifiers, uint modifiers, uint key, uint durationMs) {
    IntPtr hook = IntPtr.Zero;
    if (swallowModifiers) {
      proc = Hook;
      hook = SetWindowsHookExW(WH_KEYBOARD_LL, proc, GetModuleHandleW(IntPtr.Zero), 0);
      if (hook == IntPtr.Zero) { Console.WriteLine("ERROR hook " + Marshal.GetLastWin32Error()); return 1; }
    }
    if (!RegisterHotKey(IntPtr.Zero, 1, modifiers | MOD_NOREPEAT, key)) {
      Console.WriteLine("ERROR hotkey " + Marshal.GetLastWin32Error());
      if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
      return 1;
    }
    SetTimer(IntPtr.Zero, UIntPtr.Zero, durationMs, IntPtr.Zero);
    Console.WriteLine("READY");
    Console.Out.Flush();
    MSG msg;
    while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (msg.message == WM_HOTKEY) { Console.WriteLine("HOTKEY"); Console.Out.Flush(); }
      else if (msg.message == WM_TIMER) break;
    }
    UnregisterHotKey(IntPtr.Zero, 1);
    if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
    Console.WriteLine("DONE");
    return 0;
  }
}
"@

exit [FakeKeyboardLock]::Run($SwallowModifiers.IsPresent, $Modifiers, $Key, $DurationMs)
