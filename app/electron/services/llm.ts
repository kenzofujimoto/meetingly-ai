import OpenAI from "openai"
import { APP_TOKEN, relayHttpUrl } from "../../shared/relay"
import { getLanguage, type LanguageCode } from "../../shared/types"
import { describeOwnKeyError, hostOf, normalizeBaseUrl, PLAIN_BOX, reasoningFor, type SecretBox } from "./ownKey"
import { relayIdentity } from "./relayAuth"
import type { SettingsStore } from "./settings"
import { t } from "../../shared/i18n"

export interface LlmMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LlmResult {
  text: string
  tokens: number
}

/**
 * What a request is for. The relay picks the model for each task from its own config
 * (and falls back on its own), so changing models never needs an app release.
 */
export type LlmTask = "answer" | "auto" | "suggest" | "vision" | "report"

/** The wire format needs a model name; the relay ignores it. */
const RELAY_MODEL = "relay"

/** An endpoint the app calls directly (the own key or the fallback model), for request options and error wording. */
interface Endpoint {
  baseUrl: string
  model: string
}

interface Route {
  client: OpenAI
  model: string
  headers: Record<string, string>
  /** Set when the request goes straight to an endpoint instead of the relay. */
  endpoint: Endpoint | null
}

type Messages = OpenAI.Chat.ChatCompletionMessageParam[]

/**
 * Chat and vision through the relay, or straight to the user's own OpenAI-compatible endpoint when one
 * is set. Both speak the OpenAI wire format, so the official client works unchanged. When a fallback model
 * is set (Ollama on this computer), it answers whatever the primary route fails to.
 */
export class Llm {
  private readonly relay: OpenAI
  private own: { signature: string; client: OpenAI } | null = null
  private local: { signature: string; client: OpenAI } | null = null

  constructor(
    private readonly settings: Pick<SettingsStore, "get" | "deviceId" | "appVersion">,
    relayUrl = process.env.IGPT_RELAY_URL || undefined,
    private readonly box: SecretBox = PLAIN_BOX
  ) {
    this.relay = new OpenAI({
      apiKey: APP_TOKEN,
      baseURL: `${relayHttpUrl(relayUrl)}/v1`,
      maxRetries: 1,
      timeout: 90_000
    })
  }

  languageInstruction(code?: LanguageCode): string {
    return getLanguage(code ?? this.settings.get().outputLanguage).instruction
  }

  /** Read per request: the own key can be set or removed at any time. */
  private route(task: LlmTask): Route {
    const own = this.settings.get().ownKey
    if (!own) return { client: this.relay, model: RELAY_MODEL, headers: { ...relayIdentity(this.settings), "X-Meetingly-Task": task }, endpoint: null }
    const key = own.key ? this.box.decrypt(own.key) : ""
    const signature = `${own.baseUrl}
${key}`
    if (this.own?.signature !== signature) {
      this.own = { signature, client: new OpenAI({ apiKey: key || "none", baseURL: own.baseUrl, maxRetries: 1, timeout: 90_000 }) }
    }
    return { client: this.own.client, model: own.model, headers: {}, endpoint: { baseUrl: own.baseUrl, model: own.model } }
  }

  /** The keyless fallback model, unless it is the very model that just failed. Read per request, like the own key. */
  private fallbackRoute(primary: Route): Route | null {
    const fallback = this.settings.get().fallback
    if (!fallback) return null
    const same =
      primary.endpoint !== null &&
      normalizeBaseUrl(primary.endpoint.baseUrl) === normalizeBaseUrl(fallback.baseUrl) &&
      primary.endpoint.model === fallback.model
    if (same) return null
    if (this.local?.signature !== fallback.baseUrl) {
      // No retries: it only runs after the primary failed. A long timeout: a local model may need to load first.
      this.local = { signature: fallback.baseUrl, client: new OpenAI({ apiKey: "none", baseURL: fallback.baseUrl, maxRetries: 0, timeout: 120_000 }) }
    }
    return { client: this.local.client, model: fallback.model, headers: {}, endpoint: fallback }
  }

  /** Chat completion; streams through `onChunk` when provided. */
  async chat(messages: LlmMessage[], onChunk?: (delta: string) => void, task: LlmTask = "answer"): Promise<LlmResult> {
    return this.withFallback(task, messages, onChunk)
  }

  /** Describe a JPEG screenshot. */
  async vision(base64Jpeg: string, prompt: string, system?: string): Promise<LlmResult> {
    return this.withFallback("vision", [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Jpeg}` } }
        ]
      }
    ])
  }

  /**
   * One request on the primary route; when it fails before any text reached the user and a fallback model is set,
   * the same request goes there. Once text has streamed, a second answer would mix with the first, so the error
   * stands. When both fail, the primary's error is the one reported: that is what the user needs to fix.
   */
  private async withFallback(task: LlmTask, messages: Messages, onChunk?: (delta: string) => void): Promise<LlmResult> {
    const primary = this.route(task)
    let streamed = false
    const emit = onChunk
      ? (delta: string) => {
          streamed = true
          onChunk(delta)
        }
      : undefined
    try {
      return await this.complete(primary, messages, emit)
    } catch (err) {
      const failure = primary.endpoint ? describeOwnKeyError(err, primary.endpoint) : err
      const fallback = streamed ? null : this.fallbackRoute(primary)
      if (!fallback) throw failure
      console.warn(`[llm] ${routeLabel(primary)} failed (${errorSummary(err)}); ${task} goes to ${routeLabel(fallback)}`)
      try {
        return await this.complete(fallback, messages, onChunk)
      } catch (fallbackErr) {
        console.warn(`[llm] fallback ${routeLabel(fallback)} failed too (${errorSummary(fallbackErr)})`)
        throw failure
      }
    }
  }

  private async complete(route: Route, messages: Messages, onChunk?: (delta: string) => void): Promise<LlmResult> {
    const params = { model: route.model, messages, ...(route.endpoint ? reasoningFor(route.model, route.endpoint.baseUrl) : {}) }
    if (!onChunk) {
      const res = await route.client.chat.completions.create(params, { headers: route.headers })
      return { text: res.choices[0]?.message?.content ?? "", tokens: res.usage?.total_tokens ?? 0 }
    }
    const stream = await route.client.chat.completions.create(
      { ...params, stream: true, stream_options: { include_usage: true } },
      { headers: route.headers }
    )
    let text = ""
    let tokens = 0
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        text += delta
        onChunk(delta)
      }
      if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens
    }
    return { text, tokens }
  }
}

/** For the log: which model answered, never the key. */
function routeLabel(route: Route): string {
  return route.endpoint ? `${route.endpoint.model} at ${hostOf(route.endpoint.baseUrl)}` : "the relay"
}

function errorSummary(err: unknown): string {
  const status = (err as { status?: number })?.status
  const message = err instanceof Error ? err.message : String(err)
  return (status ? `${status} ${message}` : message).replace(/\s+/g, " ").slice(0, 160)
}

/** Turn relay / network failures into something a person can act on. */
export function describeRelayError(err: unknown): string {
  // Errors from the user's own endpoint are already worded (see describeOwnKeyError).
  if (err instanceof Error && (err as { ownKey?: boolean }).ownKey) return err.message
  const status = (err as { status?: number })?.status
  // Limits, sign-in and plan errors come with a code; word them in the interface language.
  const relay = (err as { error?: RelayError })?.error
  if (relay?.code && relay.message) return relayMessage(relay)
  const message = err instanceof Error ? err.message : String(err)
  if (status === 401) return t("This build of Meetingly is no longer accepted by the server. Please update the app.")
  if (status === 429) return /transcription/i.test(message) ? t("Daily transcription limit reached. Try again tomorrow.") : t("Daily limit reached. Try again tomorrow.")
  if (status === 402) return t("The service is temporarily out of credits. Try again later.")
  if (status && status >= 500) return t("The Meetingly server is having trouble. Try again in a minute.")
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|Connection error/i.test(message)) return t("Cannot reach the Meetingly server. Check your internet connection.")
  return message
}

interface RelayError {
  code: string
  message: string
  plan?: string | null
  limit?: number
  hours?: number
}

/** The relay's limit and sign-in errors in the interface language (its own English words otherwise). */
function relayMessage(e: RelayError): string {
  const upgrade =
    e.plan === "free"
      ? ` ${t("Upgrade for more.")}`
      : e.plan === "lite"
        ? ` ${t("Upgrade to Pro for more.")}`
        : e.plan === "pro"
        ? ` ${t("Upgrade to Unlimited for more.")}`
        : e.plan === "guest"
          ? ` ${t("Update Meetingly and sign in to keep going.")}`
          : ""
  const n = e.limit ?? 0
  switch (e.code) {
    case "account_required":
      return t("Create a free Meetingly account to use AI answers: click Sign up free at the bottom of the panel.")
    case "account_unavailable":
      return t("The account service is unavailable. Try again in a minute.")
    case "answers_limit":
      if (e.plan === "unlimited") return t("You've reached today's fair-use limit of answers. It resets at midnight UTC.")
      return (e.plan === "pro" || e.plan === "lite" ? t("You've used today's {n} answers.", { n }) : t("You've used today's {n} free answers.", { n })) + upgrade
    case "listening_limit":
      return t("Live suggestions and auto-answer are paused: today's {hours} hours are used up. Questions you ask still work.", { hours: e.hours ?? "" }) + upgrade
    case "vision_limit":
      return t("You've used today's {n} screen analyses.", { n }) + upgrade
    case "reports_limit":
      return t("You've used today's {n} meeting reports.", { n }) + upgrade
    case "daily_limit":
      return t("Today's usage limit is reached. It resets at midnight UTC.") + upgrade
    case "busy":
      return t("Another request is still running. Try again in a moment.")
    case "rate_limit":
      return t("Too many requests at once. Slow down a little.")
    case "network_limit":
      return t("Too many free answers from this network today. It resets at midnight UTC.")
    default:
      return e.message
  }
}
