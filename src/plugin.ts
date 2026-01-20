import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { loadConfig, parseModel } from "./config"
import { createLogger } from "./log"

interface SessionState {
  fallbackActive: boolean
  cooldownEndTime: number
}

interface MessageInfo {
  id: string
  role: "user" | "assistant"
  sessionID: string
  model?: {
    providerID: string
    modelID: string
  }
  agent?: string
}

interface MessagePart {
  id: string
  type: string
  text?: string
  mime?: string
  filename?: string
  url?: string
  name?: string
}

interface MessageWithParts {
  info: MessageInfo
  parts: MessagePart[]
}

const sessionStates = new Map<string, SessionState>()

function createPatternMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some(pattern => lower.includes(pattern.toLowerCase()))
  }
}

export async function createPlugin(context: PluginInput): Promise<Hooks> {
  const config = loadConfig()
  const logger = createLogger(config.logging)
  const isRateLimitMessage = createPatternMatcher(config.patterns)
  const fallbackModel = parseModel(config.fallbackModel)

  await logger.info("Plugin initialized", {
    enabled: config.enabled,
    fallbackModel: config.fallbackModel,
    patterns: config.patterns,
    cooldownMs: config.cooldownMs,
  })

  if (!config.enabled) {
    await logger.info("Plugin disabled via config")
    return {}
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const props = event.properties as {
          sessionID: string
          status: {
            type: "idle" | "retry" | "busy"
            attempt?: number
            message?: string
            next?: number
          }
        }

        if (props.status.type === "retry" && props.status.message) {
          if (isRateLimitMessage(props.status.message)) {
            const sessionID = props.sessionID
            const existingState = sessionStates.get(sessionID)

            if (existingState?.fallbackActive && Date.now() < existingState.cooldownEndTime) {
              await logger.info("Skipping fallback, cooldown active", {
                sessionID,
                cooldownRemaining: existingState.cooldownEndTime - Date.now(),
              })
              return
            }

            await logger.info("Rate limit detected, switching to fallback", {
              sessionID,
              message: props.status.message,
              fallbackModel: config.fallbackModel,
            })

            sessionStates.set(sessionID, {
              fallbackActive: true,
              cooldownEndTime: Date.now() + config.cooldownMs,
            })

            try {
              await context.client.session.abort({ path: { id: sessionID } })
              await new Promise(resolve => setTimeout(resolve, 100))

              const messagesResponse = await context.client.session.messages({ path: { id: sessionID } })
              const messages = messagesResponse.data as MessageWithParts[] | undefined

              if (!messages || messages.length === 0) {
                await logger.error("No messages found in session", { sessionID })
                return
              }

              const lastUserMessage = [...messages].reverse().find(m => m.info.role === "user")
              if (!lastUserMessage) {
                await logger.error("No user message found in session", { sessionID })
                return
              }

              const lastUserIndex = messages.findIndex(m => m.info.id === lastUserMessage.info.id)
              const revertToMessage = lastUserIndex > 0 ? messages[lastUserIndex - 1] : null

              await logger.info("Found last user message", {
                sessionID,
                messageId: lastUserMessage.info.id,
                revertToId: revertToMessage?.info.id ?? "none",
              })

              if (revertToMessage) {
                await context.client.session.revert({
                  path: { id: sessionID },
                  body: { messageID: revertToMessage.info.id },
                })
                await new Promise(resolve => setTimeout(resolve, 100))
              }

              const originalParts = lastUserMessage.parts
                .filter(p => !isSyntheticPart(p))
                .map(p => convertToPromptPart(p))
                .filter((p): p is NonNullable<typeof p> => p !== null)

              if (originalParts.length === 0) {
                await logger.error("No valid parts found in user message", { sessionID })
                return
              }

              await context.client.session.prompt({
                path: { id: sessionID },
                body: {
                  model: fallbackModel,
                  agent: lastUserMessage.info.agent,
                  parts: originalParts,
                },
              })

              await logger.info("Fallback prompt sent successfully", {
                sessionID,
                partsCount: originalParts.length,
              })
            } catch (err) {
              await logger.error("Failed to send fallback prompt", {
                sessionID,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }

        if (props.status.type === "idle") {
          const sessionID = props.sessionID
          const state = sessionStates.get(sessionID)
          if (state && state.fallbackActive && Date.now() >= state.cooldownEndTime) {
            state.fallbackActive = false
            await logger.info("Cooldown expired, fallback reset", { sessionID })
          }
        }
      }

      if (event.type === "session.deleted") {
        const props = event.properties as { info?: { id?: string } }
        if (props.info?.id) {
          sessionStates.delete(props.info.id)
          await logger.info("Session cleaned up", { sessionID: props.info.id })
        }
      }
    },
  }
}

function isSyntheticPart(part: MessagePart): boolean {
  return (part as any).synthetic === true
}

function convertToPromptPart(part: MessagePart): { type: "text"; text: string } | { type: "file"; mime: string; filename?: string; url: string } | { type: "agent"; name: string } | null {
  switch (part.type) {
    case "text":
      if (part.text) {
        return { type: "text", text: part.text }
      }
      return null
    case "file":
      if (part.url && part.mime) {
        return { type: "file", mime: part.mime, filename: part.filename, url: part.url }
      }
      return null
    case "agent":
      if (part.name) {
        return { type: "agent", name: part.name }
      }
      return null
    default:
      return null
  }
}
