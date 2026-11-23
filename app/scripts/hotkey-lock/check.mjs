#!/usr/bin/env node
/**
 * Windows-only check of the shortcut path against a page that locks the keyboard (fullscreen +
 * navigator.keyboard.lock()). Run after `npm run build`: node scripts/hotkey-lock/check.mjs
 *
 * Scenarios (each injects Ctrl+Shift+F24, a chord no app reacts to):
 *   baseline      RegisterHotKey alone fires                           (harness sanity)
 *   locked        a Chromium-style hook swallows Ctrl: no hotkey        (the bug)
 *   hook-after    Meetingly's hook installed after the lock: fires      (the fix)
 *   hook-before   lock engaged after Meetingly's hook: fires after the
 *                 next reinstall                                        (the fix, real-world order)
 */
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Worker, MessageChannel } from "node:worker_threads"

const here = path.dirname(fileURLToPath(import.meta.url))
const workerFile = path.resolve(here, "../../dist-electron/hotkey-worker.js")
const REINSTALL_MS = 250
const PROBE = { accelerator: "CommandOrControl+Shift+F24", action: "probe", repeat: false }

if (process.platform !== "win32") {
  console.log("Windows only; skipped.")
  process.exit(0)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function powershell(script, args = []) {
  return ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, script), ...args]
}

/** Starts the stand-in for the locked browser tab; resolves once its hotkey (and hook) are in place. */
async function startLock({ swallow }) {
  const args = powershell("fake-keyboard-lock.ps1", swallow ? ["-SwallowModifiers"] : [])
  const child = spawn("powershell.exe", args, { stdio: ["ignore", "pipe", "pipe"] })
  const lines = []
  let stderr = ""
  child.stderr.on("data", (d) => (stderr += d))
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
        lines.push(line)
        if (line === "READY") resolve()
        if (line.startsWith("ERROR")) reject(new Error(line))
      }
    })
    child.on("exit", (code) => reject(new Error(`fake lock exited early (${code}): ${stderr.trim()}`)))
  })
  await ready
  return {
    hotkeys: () => lines.filter((l) => l === "HOTKEY").length,
    stop: () => child.kill()
  }
}

function sendChord() {
  const result = spawnSync("powershell.exe", powershell("send-chord.ps1"), { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`send-chord failed: ${result.stderr}`)
}

/** Starts Meetingly's low-level hook worker with the probe binding. */
async function startHook() {
  const control = new MessageChannel()
  const worker = new Worker(workerFile, {
    workerData: { bindings: [PROBE], reinstallMs: REINSTALL_MS, control: control.port2 },
    transferList: [control.port2]
  })
  const actions = []
  const errors = []
  worker.on("message", (m) => {
    if (m?.type === "action") actions.push(m.action)
    if (m?.type === "error") errors.push(m.message)
  })
  worker.on("error", (err) => errors.push(err.message))
  const [first] = await Promise.race([once(worker, "message"), wait(5000).then(() => [{ type: "timeout" }])])
  if (first?.type !== "ready") throw new Error(`hook worker did not start: ${JSON.stringify(first)} ${errors.join("; ")}`)
  return {
    actions: () => actions.filter((a) => a === PROBE.action).length,
    errors,
    stop: async () => {
      control.port1.postMessage({ type: "stop" })
      const exited = await Promise.race([once(worker, "exit").then(() => true), wait(2000).then(() => false)])
      if (!exited) await worker.terminate()
      control.port1.close()
    }
  }
}

async function scenario(name, run) {
  try {
    const { ok, detail } = await run()
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(12)} ${detail}`)
    return ok
  } catch (err) {
    console.log(`FAIL  ${name.padEnd(12)} ${err.message}`)
    return false
  }
}

const results = []

results.push(
  await scenario("baseline", async () => {
    const lock = await startLock({ swallow: false })
    sendChord()
    await wait(400)
    lock.stop()
    return { ok: lock.hotkeys() === 1, detail: `hotkeys=${lock.hotkeys()} (expected 1)` }
  })
)

results.push(
  await scenario("locked", async () => {
    const lock = await startLock({ swallow: true })
    sendChord()
    await wait(400)
    lock.stop()
    return { ok: lock.hotkeys() === 0, detail: `hotkeys=${lock.hotkeys()} (expected 0: Ctrl was swallowed)` }
  })
)

results.push(
  await scenario("hook-after", async () => {
    const lock = await startLock({ swallow: true })
    const hook = await startHook()
    sendChord()
    await wait(400)
    const actions = hook.actions()
    await hook.stop()
    lock.stop()
    return { ok: actions === 1 && hook.errors.length === 0, detail: `actions=${actions} (expected 1) ${hook.errors.join("; ")}` }
  })
)

results.push(
  await scenario("hook-before", async () => {
    const hook = await startHook()
    const lock = await startLock({ swallow: true })
    await wait(REINSTALL_MS * 3)
    sendChord()
    await wait(400)
    const actions = hook.actions()
    await hook.stop()
    lock.stop()
    return { ok: actions === 1 && hook.errors.length === 0, detail: `actions=${actions} (expected 1) ${hook.errors.join("; ")}` }
  })
)

const failed = results.filter((ok) => !ok).length
console.log(failed ? `\n${failed} scenario(s) failed` : "\nall scenarios passed")
process.exit(failed ? 1 : 0)
