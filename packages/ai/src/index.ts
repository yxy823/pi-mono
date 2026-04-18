/**
 * `@mariozechner/pi-ai` 的公共入口。
 *
 * 这个包提供 **“一个接口，多家 LLM”** 的抽象：
 *
 *  - 统一的 `Context` / `Message` / `Model` 类型（见 `./types.ts`）。
 *  - 运行时 provider 注册表（`./api-registry.ts`）：按 `model.api` 字段路由到具体
 *    provider 的实现（anthropic / openai-responses / google / bedrock / ... ）。
 *  - 两套流式接口：
 *      * `stream` / `complete`                 —— 暴露 provider 原生选项的
 *                                                  “底层”接口（`ProviderStreamOptions`）。
 *      * `streamSimple` / `completeSimple`     —— 各 provider 把原生参数映射成
 *                                                  `SimpleStreamOptions` 的通用子集，
 *                                                  方便 `@mariozechner/pi-agent-core`
 *                                                  这种上层做跨 provider 切换。
 *  - 模型元数据（`./models.ts` 与生成产物 `./models.generated.ts`），含上下文窗口、
 *    token 成本、输入模态等，用于做 token / 成本统计和能力判定。
 *  - 环境变量 → API key 的查找表（`./env-api-keys.ts`），方便运行时按 provider 解析。
 *  - 类型/参数工具（`./utils/*`）：事件流、JSON 流解析、TypeBox schema 辅助、
 *    Unicode 安全化、token 溢出裁剪、OAuth 流程等。
 *
 * 默认 import 的 provider 实现通过 `./providers/register-builtins.js` 做
 * **懒加载注册**（只有第一次用到某个 `api` 时才会动态加载对应 provider 模块），
 * 减少不使用的 provider 带来的体积和副作用。各 provider 的 options 类型也在此
 * 文件里做了针对性 re-export，方便在不触发 provider 实现加载的前提下引用类型。
 */

export type { Static, TSchema } from "@sinclair/typebox";
export { Type } from "@sinclair/typebox";

export * from "./api-registry.js";
export * from "./env-api-keys.js";
export * from "./models.js";
export type { BedrockOptions, BedrockThinkingDisplay } from "./providers/amazon-bedrock.js";
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./providers/anthropic.js";
export type { AzureOpenAIResponsesOptions } from "./providers/azure-openai-responses.js";
export * from "./providers/faux.js";
export type { GoogleOptions } from "./providers/google.js";
export type { GoogleGeminiCliOptions, GoogleThinkingLevel } from "./providers/google-gemini-cli.js";
export type { GoogleVertexOptions } from "./providers/google-vertex.js";
export type { MistralOptions } from "./providers/mistral.js";
export type { OpenAICodexResponsesOptions } from "./providers/openai-codex-responses.js";
export type { OpenAICompletionsOptions } from "./providers/openai-completions.js";
export type { OpenAIResponsesOptions } from "./providers/openai-responses.js";
export * from "./providers/register-builtins.js";
export * from "./stream.js";
export * from "./types.js";
export * from "./utils/event-stream.js";
export * from "./utils/json-parse.js";
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./utils/oauth/types.js";
export * from "./utils/overflow.js";
export * from "./utils/typebox-helpers.js";
export * from "./utils/validation.js";
