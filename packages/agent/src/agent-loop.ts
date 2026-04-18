/**
 * 无状态的 agent loop 实现。
 *
 * 设计原则：**在整个 loop 内部统一使用 `AgentMessage`**，仅在与 `@mariozechner/pi-ai`
 * 的 `streamSimple` / `stream` 交互的那一个边界上，通过 `config.convertToLlm` 把
 * `AgentMessage[]` 转成 `Message[]`。这样使用方可以在 transcript 中携带 LLM 无法
 * 理解的角色（例如 UI 专用的 system / note 消息），同时保证发给模型的仅是
 * 它能看懂的子集。
 *
 * 对外暴露三种调用方式：
 *
 *  - `agentLoop(prompts, ...)`               —— 新增一批用户 / 工具输入并启动 loop，
 *                                                返回 `EventStream`（交互式流式消费）。
 *  - `agentLoopContinue(context, ...)`       —— 基于现有 context 继续跑，最后一条消息
 *                                                经 `convertToLlm` 转换后必须是 `user` 或
 *                                                `toolResult`。
 *  - `runAgentLoop` / `runAgentLoopContinue` —— 底层 async 版本，接受一个 `emit` 回调
 *                                                直接推送事件（被 `Agent` 类使用）。
 *
 * 事件顺序从高层看是：
 *
 *   agent_start → [turn_start → message_* (包含流式 delta) →
 *                  tool_execution_* (可选) → turn_end]×N → agent_end
 *
 * 其中每轮文本 / 思考 / tool call 的中间态都有并驱的 `partial` 消息，方便 UI 做
 * 流式渲染。tool 执行可以并行或串行，由 `config.toolExecution` 以及单个 `AgentTool`
 * 的 `executionMode` 共同决定。
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 以一批新 prompt 启动一个 agent loop。
 *
 * prompts 会先被附加到 context 后面，并对每一条推送 `message_start` / `message_end`
 * 事件；随后进入正常的内部 loop。结果通过返回的 `EventStream` 以流式方式提供
 * 所有中间事件，并在 `agent_end` 时给出本次追加的新消息数组。
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 不添加新消息的情况下继续一个 agent loop（例如出错后的重试场景）。
 *
 * **重要：** `context.messages` 的最后一条经 `convertToLlm` 转换后必须是
 * `user` 或 `toolResult`，否则上游 provider 会拒绝请求。这一点无法在这里预先
 * 校验（`convertToLlm` 每轮只调一次），所以仅在进入时做一个 `assistant` 的
 * 快速检查，剩下由调用方保证。
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * `agentLoop` 的底层 async 版本。直接接收一个 `emit` 回调把事件推出去，
 * `Agent` 类就是通过这个函数驱动 loop 并把事件镜像到自己的订阅者。
 *
 * 与 `agentLoop` 相比，它不创建 `EventStream`，也不返回它；发事件更灵活。
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	// `newMessages` —— 这次 loop 产生 / 追加到 transcript 的全部消息，最后作为返回值
	// 交给调用方。以 `prompts` 作起点意味着用户新消息本身也计入“这次 loop 产出”。
	const newMessages: AgentMessage[] = [...prompts];

	// 对原 context 做浅拷贝，只替换 `messages`：把用户的新 prompts 拼到历史末尾作为
	// LLM 要看到的上下文。这里特意拷贝外层对象，避免 loop 中途 push 工具结果时
	// 把引用传入的 `context` 也修改掉（外部可能还在使用它）。
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	// 先广播“agent 已启动”，再广播“第一个 turn 开始”。UI 层可以据此显示 spinner。
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	// 把 prompts 当作已经“完成”的用户消息推一轮 start/end —— 这样 UI 能立刻看到用户
	// 自己刚发出的消息，不用等到 runLoop 里第一个助手回复才回显。
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	// 进入真正的主循环（内循环 + 外循环），运行结束后 `newMessages` 里就包含本次
	// 追加的所有消息（用户输入 + 助手回复 + 工具结果 + 可能的 steering/follow-up）。
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * `agentLoopContinue` 的底层 async 版本，语义见 `agentLoopContinue`：
 * 不添加新 prompt，以现有 context 继续跑一轮。
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	// 空 context 无法“继续”——下游 LLM 连一条能回应的消息都没有。
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	// 末尾是助手消息说明上一轮刚回完就要继续，这不是 provider 接受的状态
	// （Anthropic / OpenAI 都要求以 user / tool result 结尾才能再次生成）。
	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	// 这里 newMessages 从空开始：没有 prompt 要追加；完全由 runLoop 内部产生。
	const newMessages: AgentMessage[] = [];
	// 浅拷一层以免外部 context 被 runLoop 里的 push 污染。
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

/**
 * 为对外的两个 `*Loop` 函数创建统一的 `EventStream`：
 *  - 终结条件：收到 `agent_end` 事件；
 *  - 结果提取：从 `agent_end.messages` 拿到本次追加的消息数组。
 *
 * `EventStream` 是 `pi-ai` 里的抽象，支持 `for await` 遍历也支持 `.result()`
 * 一次性拿最终结果，所以这里可以兼顾流式消费 + Promise 化两种用法。
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * `agentLoop` 和 `agentLoopContinue` 共用的主循环。
 *
 * 两层循环的静态结构：
 *
 *  - **内循环**：只要上一次助手回复产生了 tool call，或队列中还有待注入的
 *    steering 消息，就继续交替“注入消息 → 流式产生 assistant 回复 → 执行工具”。
 *  - **外循环**：内循环自然结束后，检查 follow-up 队列是否有消息；有则再进入
 *    新一轮内循环，否则推送 `agent_end` 退出。
 *
 * 这么设计是为了同时支持两种交互：运行中用户插入的 steering 以及 agent 本来
 * 要停了才轮到的 follow-up。
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	// `firstTurn` —— 标记是否是“本次 loop 的第一个 turn”。
	// 第一个 `turn_start` 已经由上层（runAgentLoop / runAgentLoopContinue）发过，
	// 这里不再重复；从第 2 个 turn 起每次循环主动发，UI 才能做分段渲染。
	let firstTurn = true;

	// 在进入主循环前先抓一次 steering 队列：用户可能在上一次 assistant 还在流式
	// 输出时就已经敲了回车，这些消息应作为“先于下一次 LLM 调用”的上下文插入。
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// ============================================================
	// 外循环 —— 只有当 agent 认为“自己要停了”时才起作用：
	// 检查 follow-up 队列，有就灌进 pendingMessages 再转回内循环；没有就 break。
	// ============================================================
	while (true) {
		// 初始为 true 保证至少进内循环一次（哪怕 pendingMessages 为空也要调一次 LLM）。
		let hasMoreToolCalls = true;

		// ============================================================
		// 内循环 —— loop 的主体。只要：
		//   (a) 上一轮 assistant 产生了 tool_call 需要执行并回给 LLM，或
		//   (b) pendingMessages 里还有待注入的用户 / 系统消息，
		// 就继续下一个 turn。两者都空时退出到外循环。
		// ============================================================
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// 除了首个 turn 由上层已发过 `turn_start`，其余每个 turn 都自己发一次。
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// ---- 第 1 步：把排队消息注入到下一次 LLM 调用之前 ----
			// 同时发 message_start/message_end 让 UI 立即回显这些被插入的消息。
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message); // 进入发给 LLM 的上下文
					newMessages.push(message); // 同时纳入本次 loop 的产出
				}
				pendingMessages = [];
			}

			// ---- 第 2 步：调用 LLM，流式获得一条助手消息 ----
			// 这是整个 loop 中 **唯一** 真正向模型发请求的地方；
			// streamAssistantResponse 内部负责：
			//   - 调用 transformContext（可选）
			//   - 通过 convertToLlm 把 AgentMessage[] 折叠成 LLM Message[]
			//   - 解析 apiKey（支持过期 token 重新获取）
			//   - 消费 provider 流式事件并把它们映射成本层 message_* 事件
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
			newMessages.push(message);

			// 模型显式报错或被取消：立刻收尾并 agent_end 退出，不再走 tool 流程。
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// ---- 第 3 步：识别 assistant 返回里的 tool_call ----
			// assistant.content 是一串 part（text / thinking / toolCall），
			// 只挑出 toolCall。非空就说明需要再来一轮“执行工具 → 回给 LLM”。
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			// ---- 第 4 步：执行工具并把结果回写到 context ----
			// 这些 toolResult 是 **下一轮 LLM 的必需输入**，必须 push 进 currentContext。
			// 具体串行 / 并行策略在 executeToolCalls 内部决定（见其注释）。
			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				toolResults.push(...(await executeToolCalls(currentContext, message, config, signal, emit)));

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			// ---- 第 5 步：发 turn_end，UI 结束当前 turn 的分组渲染 ----
			await emit({ type: "turn_end", message, toolResults });

			// 每个 turn 结束后再拉一次 steering 队列 ——
			// 用户在上一条流式输出 / 工具执行期间按的回车，会在此时被收进 pendingMessages，
			// 下一轮 turn 的开头将把它们注入到 LLM 上下文。
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// ---- 内循环自然退出：agent 没再调工具、队列也空了 ----
		// 在彻底退出前最后看一眼 follow-up 队列（专门为“本来要结束但还想继续问”设计）。
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 有 follow-up：转成 pendingMessages，continue 让内循环再跑一圈。
			pendingMessages = followUpMessages;
			continue;
		}

		// 真的没话可说了：跳出外循环。
		break;
	}

	// 整个 loop 的终点事件，`messages` 为本次 loop 产生 / 追加的所有消息。
	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 从 LLM 流式读取一个助手回复。这是 **唯一** 把 `AgentMessage[]` 折叠成
 * `Message[]` 的边界。
 *
 * 关键步骤：
 *  1. 如有设置 `transformContext`，先做一次 `AgentMessage[] → AgentMessage[]`
 *     的改写（例如裁剪、压缩、注入记忆等）。
 *  2. 再用 `convertToLlm` 折叠为 LLM 可理解的 `Message[]`。
 *  3. 如配置了 `getApiKey`，每轮实时取一次密钥（配合会过期的 OAuth token
 *     或需要刷新的 Bedrock 权证）。
 *  4. 将上游的流式事件映射成本层 `message_start` / `message_update` /
 *     `message_end`；流结束时拿最终 `AssistantMessage` 回填到 context 和
 *     `newMessages` 中。
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// ---- (1) 可选：同层上下文改写（AgentMessage[] → AgentMessage[]）----
	// 用于裁剪历史、压缩、注入长期记忆等；不改变对外可见的 transcript。
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// ---- (2) 跨层格式转换：AgentMessage[] → LLM 能懂的 Message[] ----
	// 这是 AgentMessage 与 LLM Message 的 **唯一桥梁**。上层可以在 AgentMessage
	// 里放 LLM 看不懂的结构（如 UI 专属 note），在这里被过滤 / 折叠掉。
	const llmMessages = await config.convertToLlm(messages);

	// ---- (3) 组装给 LLM 的 Context ----
	// systemPrompt / tools 来自 AgentContext，messages 用刚刚折叠好的 LLM 格式。
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// 默认走 `streamSimple`（跨 provider 通用）；测试时可注入 fake streamFn。
	const streamFunction = streamFn || streamSimple;

	// ---- (4) 每轮实时解析 API key ----
	// 某些 provider token 会过期（OAuth、Bedrock STS、Azure AD 等），所以每次
	// 调用 LLM 前都重新取一次 key，让长跑的 Agent 不会在中途掉线；
	// 没给 `getApiKey` 回调则退回到静态 `config.apiKey`。
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// ---- (5) 发起流式请求 ----
	// 把 config 原样透传（温度、最大 token、思考预算等），只覆盖 apiKey & signal。
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	// `partialMessage` —— 正在拼装的助手消息（流式模式下每个 delta 都会更新它）。
	// `addedPartial`   —— 是否已经把 partialMessage 推进 context.messages。
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	// ---- (6) 逐条消费 provider 送来的事件 ----
	for await (const event of response) {
		switch (event.type) {
			case "start":
				// 首个事件：provider 把一个空壳 AssistantMessage 抛出来，
				// 我们把它 push 到 context.messages 末尾，后续 delta 原地替换。
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				// 所有中间态（文本 / 思考 / 工具调用参数的流式拼装）：
				//  - 用最新 partial 替换 context 末尾的占位消息；
				//  - 转发 message_update 给外层订阅者，附带原始 assistant 事件，
				//    方便 UI 做细粒度增量渲染。
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				// 终态事件：从 response.result() 拿最终落稿的 AssistantMessage，
				// 用它覆盖 partial 占位（或直接 push，如果之前没有 partial 阶段），
				// 然后发 message_end 并返回。
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 兜底分支：迭代器结束但没看到 done/error（非流式 provider 或异常提前关闭时）。
	// 逻辑与 done 分支相同：拿最终消息、覆盖或 push 到 context、发 start/end。
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 执行助手消息里包含的所有 tool call。
 *
 * 如果 `config.toolExecution === "sequential"`，或任一 tool 声明自己的
 * `executionMode` 为 `"sequential"`，则走串行分支；否则并行分支会先同时
 * 跳出 `tool_execution_start`，再按顺序 await 每个工具的 `execute()`。
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	// 从 assistant 消息里只挑出 toolCall part（文本 / 思考跳过）。
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");

	// 只要任一工具声明 executionMode="sequential"，整批就降级成串行。
	// 这是“最严格者胜”策略：例如 bash 想要严格顺序，就不能被并行 read 打乱。
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);

	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 串行执行 tool call：一个一个地 prepare + execute + finalize。
 *
 * 语义上保证前一个工具的副作用（例如 bash 改了工作目录、写了文件）对后续
 * 工具可见。被选中时机：config.toolExecution === "sequential"，或批次中任一
 * 工具自己声明 executionMode === "sequential"。
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		// 每个工具调用都先发 tool_execution_start；即使后面 prepare 就失败，UI 也
		// 能看到该 toolCallId 一对完整的“开始 → 结束”事件。
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		// prepareToolCall：参数改写 → JSON schema 校验 → beforeToolCall hook。
		// immediate 表示结果已经定了（通常是错误：工具不存在 / 参数非法 / 被阻断）。
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			// 真正执行：tool 内部通过 `emit tool_execution_update` 推增量结果。
			const executed = await executePreparedToolCall(preparation, signal, emit);
			// finalize：跑 afterToolCall hook（可改写 content / 标记错误），再发 end。
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

/**
 * 并行执行 tool call：
 *  1) 顺序走 prepare（其中 immediate 结果直接收尾，不进入并行批次）；
 *  2) 把剩下的准备好的 call 一次性启动 execute，返回 Promise 数组；
 *  3) 按原顺序 await 并 finalize —— transcript 里 toolResult 的排列顺序与
 *     toolCalls 一致（LLM 通常需要稳定顺序），而实际执行是并行的。
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	// —— 阶段 1：发 start + prepare ——
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			// 立即可得的结果（校验失败 / 被 hook 阻断等），直接收尾。
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	// —— 阶段 2：并行启动所有准备好的工具 ——
	// 这里只构造 Promise，不 await；`map` 已经让 node 事件循环开始同时推进所有工具。
	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	// —— 阶段 3：按原顺序 await + finalize ——
	// 顺序 await 不会阻止后续工具继续执行（它们已并行启动），只会按顺序收尾。
	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 可选的工具级参数改写：
 * 工具可以通过 `prepareArguments(args)` 把 LLM 给的参数规范化 / 填充默认值，
 * 返回同一个对象引用则表示没有改写，直接复用原 toolCall。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * 把一次 toolCall 从“LLM 刚吐出来的原始样子”变成“可以直接 execute 的状态”。
 *
 * 流程：
 *  1. 在 `currentContext.tools` 中按名字找到对应的 `AgentTool`；找不到直接返
 *     回 immediate 错误。
 *  2. 可选的 `prepareArguments`：工具自行规范化参数（例如去除多余空白）。
 *  3. `validateToolArguments`：根据工具的 JSON schema 校验参数；抛异常视为
 *     用户（LLM）错，包一层 immediate error 交给 LLM 自己改正。
 *  4. 可选的 `beforeToolCall` hook：允许外部（extension / permission 系统）
 *     在工具执行前阻止它（block=true）或放行。
 *
 * 返回：
 *  - `prepared`   ：一切就绪，可以 execute。
 *  - `immediate`  ：已经有最终结果（错误 / 被阻断），直接走 emit 收尾。
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// (1) 工具查找 —— LLM 偶尔会幻觉一个不存在的工具，返错给它让它重试。
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		// (2) 参数改写
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		// (3) JSON schema 校验。抛出即判错，下面 catch 统一处理。
		const validatedArgs = validateToolArguments(tool, preparedToolCall);

		// (4) beforeToolCall hook：外部系统（例如 coding-agent 的 permission-gate）
		//     可以拿到完整上下文决定是否阻止这次调用。
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				// 被阻断：把原因作为错误结果返给 LLM，让它知道“这次不行”。
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}

		// 全部通过 —— 返回 prepared，让上层去跑 execute。
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		// 任何准备阶段的异常都统一转成 immediate 错误，保证 loop 不会因工具
		// 的参数问题而崩溃。
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 执行一个已经 prepare 过的 tool call。
 *
 * `tool.execute(id, args, signal, reportPartial)` 的第 4 个参数允许工具在运行
 * 过程中上报“增量结果”（例如 bash 的逐行输出、图像生成的中间帧）。这里把
 * 增量回调转成 `tool_execution_update` 事件推给上层；为了不破坏事件顺序，
 * 把它们的 emit Promise 收集到 `updateEvents` 最后统一 await。
 *
 * 任一异常都会被捕获并转成 isError=true 的结果；loop 永远不会被一个工具
 * 的崩溃打断。
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	// 把 tool 上报的所有 partial 回调对应的 emit Promise 都收集到这里。
	const updateEvents: Promise<void>[] = [];

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				// 工具每上报一次增量就立即产生一个 `tool_execution_update` 事件。
				// 不 await，保证工具自己不会被事件订阅者的慢处理阻塞；
				// 但 emit 的 Promise 会放进 `updateEvents` 等最后一起 flush。
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// 等全部 update 事件 flush 完，避免 update 出现在 end 之后造成 UI 顺序错乱。
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		// 异常路径同样先 flush update，再返回包装好的错误结果。
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 执行完工具后的收尾：运行 `afterToolCall` hook、把可能改写后的结果 emit 出去。
 *
 * afterToolCall 允许外部在结果回给 LLM 前做后处理，例如：
 *  - 截断超长输出；
 *  - 把敏感字段擦除；
 *  - 根据结果改变 isError（让 LLM 把某些“成功但不符合预期”视作错误并重试）。
 * hook 自身抛异常视作处理失败，整个工具就变成错误结果返回给 LLM。
 */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			// hook 可以只返回部分字段，用 ?? 合并回原结果；未返回则保持原样。
			if (afterResult) {
				result = {
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			// hook 异常：包装成错误结果，别让 loop 被异常穿透。
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

/**
 * 把一段字符串包成标准的“工具错误结果”结构。
 * 只有一个 text part，details 留空；LLM 在下一轮看到的就是 text 里的错误说明。
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * 统一“工具调用结束”的收尾：
 *  1) 发 `tool_execution_end`（供 UI 关闭当前工具卡片）；
 *  2) 构造 `toolResult` 消息 —— 这是 **LLM 能看到的** 角色，loop 下一轮
 *     会把它作为 LLM 输入；
 *  3) 再发一对 message_start/message_end，让它在 transcript 时间线里正常显示。
 */
async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	// 注意 role="toolResult"：agent 内部的特殊角色，convertToLlm 时会按 provider
	// 需要的格式（Anthropic: tool_result；OpenAI: tool message）折叠进去。
	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
