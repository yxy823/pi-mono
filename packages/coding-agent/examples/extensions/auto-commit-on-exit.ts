/**
 * Auto-Commit on Exit —— 在 agent 退出时自动 `git commit` 的扩展示例。
 *
 * 这个扩展演示 pi 扩展系统的另一核心面：**订阅生命周期事件**（Event Bus）。
 * 它不注册新工具，而是挂一个 `session_shutdown` 监听器 —— 只要 pi session
 * 正常结束（用户退出、/exit、shutdown command 等），都会跑一次这个 handler。
 *
 * ——————————————————————————————————————————————————————
 * 关于 `pi.on(event, handler)`（事件总线）
 * ——————————————————————————————————————————————————————
 * coding-agent 把所有“外部可订阅的时刻”抽象成一组事件，扩展通过 `pi.on` 注册。
 * 典型事件：
 *   - `input`               用户输入到来（扩展可 transform/handled，见 input-transform.ts）
 *   - `before_agent_start`  每轮 LLM 开始前（可注入 system prompt / messages）
 *   - `after_agent_end`     每轮 LLM 结束后（可以读完整 transcript）
 *   - `before_tool_call`    工具执行前（权限门 / 二次确认）
 *   - `after_tool_call`     工具执行后（结果改写、截断）
 *   - `session_start`       session 初始化完成
 *   - `session_shutdown`    session 关闭（本例订阅的）
 *
 * 每个 handler 的签名一致：`(event, ctx) => Promise<void | result>`。
 *   - `event` —— 事件本身的 payload（字段因 event 而异）；
 *   - `ctx`   —— 上下文对象，暴露 sessionManager、hasUI、ui、extensionRunner 等。
 *
 * ——————————————————————————————————————————————————————
 * 本扩展具体在做什么
 * ——————————————————————————————————————————————————————
 *  1. shutdown 时先 `git status --porcelain` 判断当前 cwd 是不是 git 仓库、
 *     并且是否有未提交改动。不是仓库或没改动则直接返回。
 *  2. 从 `ctx.sessionManager.getEntries()` 倒序找最后一条 assistant 消息的文本
 *     —— 作为 commit message 的“灵感”。
 *  3. 取文本第一行，截断到 50 字符，前面加 `[pi]` 前缀，作为 commit 信息。
 *  4. `git add -A` + `git commit -m <msg>` —— 全量提交所有改动。
 *  5. 如果有 UI（interactive 模式而不是 print 模式），通过 `ctx.ui.notify` 弹
 *     一个 info 级别的提示告诉用户“已经自动 commit 了”。
 *
 * 注意：这是示例，不是默认启用。用户把它放到自己的 `.pi/extensions/` 目录下
 * 才会被加载。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// 扩展入口：pi 会在加载阶段 import default export 并调用它，把 ExtensionAPI 传进来。
export default function (pi: ExtensionAPI) {
	// 订阅 session_shutdown 事件。handler 必须是 async，因为要 await git 命令。
	// 返回值被忽略 —— shutdown 事件不支持 transform，它纯粹是一个“收尾 hook”。
	pi.on("session_shutdown", async (_event, ctx) => {
		// 1) 查 git 状态。使用扩展自带的 `pi.exec`：它会在 cwd 下启子进程、
		//    自动捕获 stdout/stderr 和退出码，比自己 spawn 方便。
		const { stdout: status, code } = await pi.exec("git", ["status", "--porcelain"]);

		// 退出码非 0 → 不是 git 仓库，或 git 本身出错；stdout 空 → 没有改动要提交。
		// 两种情况都不需要我们动手，直接 return。
		if (code !== 0 || status.trim().length === 0) {
			return;
		}

		// 2) 从 sessionManager 回捞 transcript 条目，倒序找最后一条 assistant 消息。
		//    SessionManager 里每条消息以 `{ type: "message", message: {...} }` 的形式存。
		//    只要找到一条就 break，不需要把所有都翻完。
		const entries = ctx.sessionManager.getEntries();
		let lastAssistantText = "";
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				// assistant 的 content 是 (TextContent | ToolCallContent | ...)[]
				// —— 只取 text 部分拼起来做 commit message 素材。
				const content = entry.message.content;
				if (Array.isArray(content)) {
					lastAssistantText = content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				}
				break;
			}
		}

		// 3) 生成 commit 信息：取第 1 行、截 50 字、加 `[pi]` 前缀。
		//    如果 agent 一句话都没有说，用占位 "Work in progress"，避免空 commit message。
		const firstLine = lastAssistantText.split("\n")[0] || "Work in progress";
		const commitMessage = `[pi] ${firstLine.slice(0, 50)}${firstLine.length > 50 ? "..." : ""}`;

		// 4) 实际执行 git add -A + git commit -m <msg>。注意这里故意 **忽略 add 的失败**
		//    —— 即便部分文件因权限等原因 add 不进来，commit 还是会尝试；commit 自身
		//    才是真正要看 exit code 的一步。
		await pi.exec("git", ["add", "-A"]);
		const { code: commitCode } = await pi.exec("git", ["commit", "-m", commitMessage]);

		// 5) commit 成功 + 当前有 UI（interactive 模式下才会为 true），
		//    通过 ctx.ui.notify 弹一条 info。在 print 模式（无 UI）下就静默。
		if (commitCode === 0 && ctx.hasUI) {
			ctx.ui.notify(`Auto-committed: ${commitMessage}`, "info");
		}
	});
}
