/**
 * 跨 provider 的流式 / 一次性调用入口。
 *
 * 本模块故意保持很薄：它只做“按 `model.api` 到注册表里查 provider，再把参数透传过去”
 * 这一件事。真正的差异（消息格式、鉴权、SSE / WebSocket / JSON 块解码、工具调用协议
 * 等）都封装在 `./providers/*` 的具体 provider 实现里。
 *
 * 两对并列的 API：
 *
 *  - `stream` / `complete`             —— 透传 provider 的原生 `StreamOptions`
 *                                          （`ProviderStreamOptions` 是所有原生
 *                                          options 类型的联合），对应 provider 的
 *                                          `stream` 实现。
 *  - `streamSimple` / `completeSimple` —— 使用 `SimpleStreamOptions` 的通用子集，
 *                                          provider 负责把它映射成原生参数（见
 *                                          `./providers/simple-options.ts`）；
 *                                          面向“跨 provider 切换”的上层使用方。
 *
 * 顶部的 `import "./providers/register-builtins.js"` 是为了让内置 provider 注册
 * 一次（模块级副作用），即使调用方没有显式导入 `register-builtins`。
 */

import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

/**
 * 在 provider 注册表里查找 `api` 对应的实现；找不到则直接抛异常，避免调用方
 * 自己做冗长的存在性检查。
 */
function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 以流式方式调用指定模型，返回 `AssistantMessageEventStream`，可迭代其增量事件
 * （text / tool call / thinking / usage / stop）。使用 provider 的原生选项类型。
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

/**
 * `stream()` 的非流式封装：一次性 await 流结束后返回最终 `AssistantMessage`。
 */
export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

/**
 * 使用通用 `SimpleStreamOptions` 的流式调用。各 provider 内部负责把它翻译成
 * 自己的原生请求；适合在不关心 provider 差异的上层使用（例如 agent loop）。
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

/**
 * `streamSimple()` 的非流式封装：等价于读到流结束后返回最终 `AssistantMessage`。
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
