<#
  Types one chord with injected key events (they pass through every WH_KEYBOARD_LL hook like real keys):
  modifiers down in order, the key down and up, modifiers up in reverse order.
  Defaults to Left Ctrl + Left Shift + F24 (F24 has no physical key, so no app reacts to it).
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
  const uint KEYEVENTF_KEYUP = 0x0002;

  public static void Send(uint[] modifiers, uint key) {
    foreach (uint m in modifiers) keybd_event((byte)m, 0, 0, UIntPtr.Zero);
    keybd_event((byte)key, 0, 0, UIntPtr.Zero);
    keybd_event((byte)key, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    for (int i = modifiers.Length - 1; i >= 0; i--) keybd_event((byte)modifiers[i], 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
  }
}
"@

[ChordSender]::Send($Modifiers, $Key)
