import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { CLOUD_SETTING_KEYS } from "../shared/cloud"
import { Llm } from "../electron/services/llm"
import { reasoningFor } from "../electron/services/ownKey"
import { SettingsStore } from "../electron/services/settings"

const dirs: string[] = []
function store(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetingly-fallback-"))
  dirs.push(dir)
  return new SettingsStore(path.join(dir, "settings.json"), { version: "1.3.1", platform: "win32" })
}

/** What a fake endpoint does with the next requests. */
type Behavior = { kind: "ok"; text: string } | { kind: "status"; status: number } | { kind: "die-mid-stream" }

interface Seen {
  path: string
  auth: string | undefined
  headers: http.IncomingHttpHeaders
  body: Record<string, unknown>
}

/** A tiny OpenAI-compatible endpoint that records what it receives. */
class FakeEndpoint {
  readonly seen: Seen[] = []
  behavior: Behavior = { kind: "ok", text: "OK" }
  base = ""
  private server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      this.seen.push({ path: req.url ?? "", auth: req.headers.authorization, headers: req.headers, body })
      const b = this.behavior
      if (b.kind === "status") {
        res.writeHead(b.status, { "Content-Type": "application/json" })
        return res.end(JSON.stringify({ error: { message: `fake ${b.status}` } }))
      }
      if (b.kind === "die-mid-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify(chunk(body, "Hal"))}\n\n`)
        return setTimeout(() => res.destroy(), 20)
      }
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        for (const part of [b.text.slice(0, 2), b.text.slice(2)]) res.write(`data: ${JSON.stringify(chunk(body, part))}\n\n`)
        res.write(`data: ${JSON.stringify({ ...chunk(body, ""), choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: b.text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        })
      )
    })
  })

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop(): void {
    this.server.close()
  }

  reset(): void {
    this.seen.length = 0
    this.behavior = { kind: "ok", text: "OK" }
  }
}

function chunk(body: Record<string, unknown>, content: string) {
  return { id: "1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content }, finish_reason: null }] }
}

/** Stands in for DeepSeek (the user's own key) and, in the relay case, for the relay. */
const primary = new FakeEndpoint()
/** Stands in for Ollama on this computer. */
const local = new FakeEndpoint()
const UNREACHABLE = "http://127.0.0.1:1/v1"

beforeAll(async () => {
  await primary.start()
  await local.start()
})
afterAll(() => {
  primary.stop()
  local.stop()
})
afterEach(() => {
  primary.reset()
  local.reset()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** DeepSeek as the own key, a local qwen as the fallback. */
function setup(primaryBase = primary.base): { llm: Llm; settings: SettingsStore } {
  const settings = store()
  settings.update({
    ownKey: { baseUrl: primaryBase, model: "deepseek-flash", key: "sk-deepseek" },
    fallback: { baseUrl: local.base, model: "qwen3.5-meet:latest" }
  })
  return { llm: new Llm(settings, UNREACHABLE.replace("/v1", "")), settings }
}

const ask = [{ role: "user" as const, content: "hi" }]

describe("reasoningFor on DeepSeek", () => {
  it("turns thinking off, since DeepSeek thinks by default and answers would be slow and costly", () => {
    expect(reasoningFor("deepseek-flash", "https://api.deepseek.com")).toEqual({ reasoning_effort: "none" })
    expect(reasoningFor("deepseek-v4-pro", "https://api.deepseek.com/v1")).toEqual({ reasoning_effort: "none" })
    // The same models through another provider are left alone.
    expect(reasoningFor("deepseek/deepseek-v4-pro", "https://openrouter.ai/api/v1")).toEqual({})
  })
})

describe("the fallback setting", () => {
  it("is off by default", () => {
    expect(store().get().fallback).toBeNull()
  })

  it("keeps an http(s) address and a model, nothing else", () => {
    const settings = store()
    settings.update({ fallback: { baseUrl: "http://localhost:11434/v1", model: "qwen3.5-meet:latest", extra: 1 } as never })
    expect(settings.get().fallback).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3.5-meet:latest" })
    expect(settings.view().fallback).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3.5-meet:latest" })
  })

  it("drops an invalid value", () => {
    const settings = store()
    settings.update({ fallback: { baseUrl: "file:///etc", model: "qwen" } })
    expect(settings.get().fallback).toBeNull()
    settings.update({ fallback: { baseUrl: "http://localhost:11434/v1", model: " " } })
    expect(settings.get().fallback).toBeNull()
  })

  it("stays on this computer: it never syncs to the account", () => {
    expect(CLOUD_SETTING_KEYS as readonly string[]).not.toContain("fallback")
  })
})

describe("Llm with a fallback model", () => {
  it("never calls the fallback while the primary answers", async () => {
    const { llm } = setup()
    primary.behavior = { kind: "ok", text: "from deepseek" }
    expect((await llm.chat(ask)).text).toBe("from deepseek")
    expect(local.seen).toHaveLength(0)
  })

  it("answers with the local model when the primary is unreachable, without sending it the API key", async () => {
    const { llm } = setup(UNREACHABLE)
    local.behavior = { kind: "ok", text: "from qwen" }
    expect((await llm.chat(ask)).text).toBe("from qwen")
    expect(local.seen).toHaveLength(1)
    expect(local.seen[0].body.model).toBe("qwen3.5-meet:latest")
    expect(local.seen[0].auth).not.toContain("sk-deepseek")
  })

  it("streams the local answer when the primary refuses before answering (out of credits)", async () => {
    const { llm } = setup()
    primary.behavior = { kind: "status", status: 402 }
    local.behavior = { kind: "ok", text: "Hello" }
    const chunks: string[] = []
    const res = await llm.chat(ask, (d) => chunks.push(d))
    expect(chunks.join("")).toBe("Hello")
    expect(res.text).toBe("Hello")
    expect(primary.seen).toHaveLength(1)
  })

  it("analyzes the screen locally when the primary rejects the image", async () => {
    const { llm } = setup()
    primary.behavior = { kind: "status", status: 400 }
    local.behavior = { kind: "ok", text: "a code editor" }
    const res = await llm.vision("QUJD", "What is on screen?", "system prompt")
    expect(res.text).toBe("a code editor")
    const messages = local.seen[0].body.messages as { role: string; content: unknown }[]
    expect(JSON.stringify(messages)).toContain("data:image/jpeg;base64,QUJD")
  })

  it("does not fall back once the primary has started streaming, so two answers never mix", async () => {
    const { llm } = setup()
    primary.behavior = { kind: "die-mid-stream" }
    const chunks: string[] = []
    await expect(llm.chat(ask, (d) => chunks.push(d))).rejects.toBeTruthy()
    expect(chunks.join("")).toBe("Hal")
    expect(local.seen).toHaveLength(0)
  })

  it("reports the primary's problem when the fallback fails too", async () => {
    const { llm } = setup()
    primary.behavior = { kind: "status", status: 402 }
    local.behavior = { kind: "status", status: 500 }
    await expect(llm.chat(ask)).rejects.toMatchObject({ ownKey: true, message: expect.stringContaining(new URL(primary.base).host) })
    expect(local.seen.length).toBeGreaterThan(0)
  })

  it("does not ask the same model twice when the fallback is the primary itself", async () => {
    const settings = store()
    settings.update({
      ownKey: { baseUrl: primary.base, model: "qwen3.5-meet:latest", key: "" },
      fallback: { baseUrl: primary.base, model: "qwen3.5-meet:latest" }
    })
    primary.behavior = { kind: "status", status: 400 }
    await expect(new Llm(settings, UNREACHABLE.replace("/v1", "")).chat(ask)).rejects.toMatchObject({ ownKey: true })
    expect(primary.seen).toHaveLength(1)
  })

  it("also covers the relay: a used-up daily quota is answered locally", async () => {
    const settings = store()
    settings.update({ fallback: { baseUrl: local.base, model: "qwen3.5-meet:latest" } })
    primary.behavior = { kind: "status", status: 429 }
    local.behavior = { kind: "ok", text: "from qwen" }
    const llm = new Llm(settings, primary.base.replace("/v1", ""))
    expect((await llm.chat(ask, undefined, "answer")).text).toBe("from qwen")
    expect(primary.seen[0].headers["x-meetingly-task"]).toBe("answer")
    expect(local.seen[0].headers["x-meetingly-task"]).toBeUndefined()
  })
})
