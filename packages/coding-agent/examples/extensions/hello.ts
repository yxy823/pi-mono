/**
 * Hello Tool —— 最小可运行的 **自定义工具** 扩展示例。
 *
 * 这个文件演示 pi 的扩展系统里最基础的一种能力：**给 LLM 新增一个工具**。
 * 运行起来后，LLM 在本次 session 里看到的 tools 列表里会多出一项叫 `hello`
 * 的工具，描述为 "A simple greeting tool"，参数只有一个字符串 `name`。
 *
 * 关键概念对照：
 *  - `ExtensionAPI` —— 扩展入口函数拿到的全局对象（`pi`），相当于“扩展版的 SDK”：
 *        它提供 `registerTool` / `on(event, handler)` / `exec(cmd, args)` / `ui.*`
 *        等一系列能力。扩展文件的 `default export` **必须是一个函数**，
 *        接收 `pi: ExtensionAPI`。
 *  - `defineTool` —— 把一份“工具定义”（name/label/description/参数 schema/execute
 *        函数）包装成 `AgentTool`。底层和 pi-agent-core 里的 Tool 一致，
 *        只是多了一层对 TypeBox schema 的类型推导方便。
 *  - `parameters: Type.Object(...)` —— 使用 @sinclair/typebox 声明 JSON schema；
 *        同一份声明既做“给 LLM 看的 schema（告诉它参数形状）”，也做“运行时校验
 *        (agent-loop 在 prepareToolCall 里 validate)”。
 *  - `execute(toolCallId, params, signal, onUpdate, ctx)` —— 工具实际执行。
 *        参数 5 个：调用 ID（很少用）、参数对象（LLM 传入，schema 校验后）、
 *        AbortSignal（长命令可以用来响应取消）、`onUpdate` partial 回调（用来
 *        流式上报进度，这个 demo 不需要）、ctx 上下文（cwd、agent state 等）。
 *        返回 `{ content, details }`：content 是 LLM 看到的内容数组，details 是
 *        纯结构化对象只给 UI 渲染 / 记录用，不进 LLM prompt。
 *
 * 一句话总结：这是最低限度的“加工具”模板，复制它可以做任何自定义命令。
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

// --- 定义工具本身 ---
const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	// 声明参数 schema：一个对象，只有 name 字段（string）。
	// `description` 会被写进 LLM 看到的 tool spec，所以务必写清楚。
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	// 实际执行函数。这里逻辑非常简单：拼一句 "Hello, X!" 返回去。
	// 注意第 2 个参数 `params` 类型已经被 TypeBox 的 Static 推导成 { name: string }。
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			// content：LLM 下一轮看到的工具结果内容。
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			// details：不进 LLM prompt，只给 UI/日志用的结构化数据。
			details: { greeted: params.name },
		};
	},
});

// --- 扩展入口函数 ---
// pi-coding-agent 在加载 .pi/extensions/*.ts 时会 import default export 并调用它，
// 传入 ExtensionAPI。这里唯一做的事就是把上面定义好的 tool 注册进去。
// 注册之后：LLM 在 tools 列表里能看到它；UI 会按 label 渲染调用卡片。
export default function (pi: ExtensionAPI) {
	pi.registerTool(helloTool);
}
