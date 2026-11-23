<#
  Types one chord with injected key events (they pass through every WH_KEYBOARD_LL hook like real keys):
  modifiers down in order, the key down and up, modifiers up in reverse order.
  Defaults to Left Ctrl + Left Shift + F24 (F24 has no physical key, so no app reacts to it).
  Each event carries the key's real scan code, as a physical key press does: Chromium's keyboard lock
  decides what to capture from the scan code and lets scan code 0 through.
#>
param(
  [uint32[]]$Modifiers = @(0xA2, 0xA0),  # VK_LCONTROL, VK_LSHIFT
  [uint32]$Key = 0x87                     # VK_F24
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ChordSender {
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint MAPVK_VK_TO_VSC = 0;

  static void Key(uint vk, bool up) {
    byte scan = (byte)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
    keybd_event((byte)vk, scan, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
  }

  public static void Send(uint[] modifiers, uint key) {
    foreach (uint m in modifiers) Key(m, false);
    Key(key, false);
    Key(key, true);
    for (int i = modifiers.Length - 1; i >= 0; i--) Key(modifiers[i], true);
  }
}
"@

[ChordSender]::Send($Modifiers, $Key)
