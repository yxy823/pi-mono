/**
 * Provider 注册表。
 *
 * `stream` / `complete` 的核心路由依赖的中枢：每个具体 provider（anthropic /
 * openai-responses / google / bedrock / mistral / ...）在模块加载时调用
 * `registerApiProvider(...)` 把自己挂进表里。上游只需知道 `model.api`，就
 * 能用 `getApiProvider(api)` 取到正确的实现。
 *
 * 每项注册还会绑定一个可选的 `sourceId`，用于 `unregisterApiProviders(sourceId)`
 * 批量注销同一来源的 provider（例如自定义拓展卸载时用）。
 *
 * 为了解决 **注册时的泛型 `TApi`/`TOptions` 与运行时统一调用签名的冲突**，这里
 * 用 `wrapStream` / `wrapStreamSimple` 做了一层切片：在调用前先校验 `model.api`
 * 是否与注册时声明的 api 一致（避免调用方误把另一家 provider 的模型丢给这个
 * provider 实现），然后再以不安全转换的方式向下传给 provider。
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.js";

/** 内部统一后的 `stream` 签名，擦除了泛型参数。 */
export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

/** 内部统一后的 `streamSimple` 签名。 */
export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * 供用户实现 / 注册的 provider 描述：一对流式实现，分别对应原生和 `SimpleStreamOptions`。
 * 注册时的泛型信息仅用于对外提供类型检查，最终会被擦除存到 `ApiProviderInternal` 里。
 */
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

/**
 * 将带泛型的 `StreamFunction` 包装成统一签名 `ApiStreamFunction`。
 *
 * 运行时的额外检查：传入的 `model.api` 必须和注册时声明的 api 一致，否则直接
 * 抛错，避免 `model` 和 provider 对不上时产生难以排查的底层报错。
 */
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

/** 同 `wrapStream`，但针对 `SimpleStreamOptions` 版本。 */
function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

/**
 * 注册一个 provider 实现。
 *
 * - 同一个 `api` 重复注册会覆盖旧的条目。
 * - 传入 `sourceId` 后，后续可以用 `unregisterApiProviders(sourceId)` 一次性
 *   清理所有同来源的条目（适用于用户自定义的 provider 拓展包不被加载后的
 *   清理场景）。
 */
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

/** 按 `api` 查找已注册的 provider，未注册返回 `undefined`。 */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

/** 返回所有已注册 provider 的快照，主要用于调试 / 能力发现。 */
export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

/** 批量注销所有 `sourceId` 匹配的 provider。 */
export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

/** 清空整个注册表。仅测试 / 极端重置场景使用，在遍历過程中调用会功废自己。 */
export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
