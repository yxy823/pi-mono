/**
 * `bash` 工具 —— coding-agent 最常被 LLM 调用的工具之一。
 *
 * 职责：
 *  1. 在工作目录下启动一个 shell 子进程执行命令；
 *  2. 实时把 stdout / stderr 以 `onUpdate` 回调方式流式回传（驱动 TUI 卡片实时刷新）；
 *  3. 对长输出做 **rolling tail 截断**（默认保留最后 ~200 行 / 50KB），
 *     超出的部分同步写到 `/tmp/pi-bash-<id>.log` 文件，最终结果里指明路径；
 *  4. 支持 timeout / AbortSignal：命中就杀掉整个进程组（`killProcessTree`），
 *     以免 shell 下面派生的子孙进程“逃逸”；
 *  5. 通过 `BashOperations` 抽象，外部可以换掉本地 exec 走 SSH / 容器等。
 *
 * 关键不变量：
 *  - 子进程是 `detached: true` 启动的（见 `createLocalBashOperations`）：
 *    这样 shell 的所有子孙进程会进入同一个进程组，一次杀组就能全部干掉。
 *  - stdio: ["ignore", "pipe", "pipe"] —— 我们不接管 stdin，所以交互式命令会
 *    看到 EOF 立刻结束；这是有意设计，避免 agent 被 `read` / `passwd` 类命令挂住。
 *  - 同时维护“进程级”PID 跟踪（`trackDetachedChildPid`），为的是 agent 整体退出
 *    时还能清理掉残留子进程。
 */
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from "./truncate.js";

/**
 * Generate a unique temp file path for bash output.
 */
function getTempFilePath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-bash-${id}.log`);
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * 默认的本地 exec 实现（命令 → 本机 shell）。
 *
 * 提供两条“外部接入 pi 标准本地 shell 行为”的路径：
 *  1) 直接用作 `BashOperations`；
 *  2) 被扩展包装：扩展拦截 `user_bash`、改写 / 加 prefix，然后仍委托到这里跑。
 *
 * 这个函数是整个 bash 工具和操作系统进程模型交互的 **唯一地方**，后面流程里
 * 任何“为什么要这么写”的问题基本都指向这段。
 */
export function createLocalBashOperations(): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			// 用 Promise 包裹整个进程生命周期：resolve=进程正常结束（带 exitCode），
			// reject=aborted / timeout / spawn 错误。
			return new Promise((resolve, reject) => {
				// 从 ~/.pi-shellrc / PATH / SHELL 等处推导“用哪个 shell + 哪些参数”。
				const { shell, args } = getShellConfig();
				// 提前校验 cwd：spawn 在 cwd 不存在时会发一个比较隐晦的 ENOENT，
				// 这里直接抛结构化错误让 LLM 一眼能懂。
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				// ========== 真正 spawn 子进程 ==========
				// shell = bash/zsh/sh 等；args 通常包括 -c 之类；命令作为最后一个 arg
				// 让 shell 负责解析。detached=true 让子进程成为新进程组的 leader —— 这样
				// 后面能用 `killProcessTree(pid)`（本质是 `kill -SIGKILL -pid`）一次性干
				// 掉整个子孙树，避免 shell 启起来的后台进程变孤儿。
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: true,
					env: env ?? getShellEnv(),
					// stdin 被 ignore：交互式命令看到 EOF 立即退出，agent 不会卡住。
					// stdout/stderr pipe：我们要流式读取它们的数据。
					stdio: ["ignore", "pipe", "pipe"],
				});
				// 把 pid 记录到全局表，coding-agent 整体退出时可以挨个清理。
				if (child.pid) trackDetachedChildPid(child.pid);

				// 标记 timeout 是否已触发（跟 abort 区分，最后 reject 的消息不同）。
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// ========== 可选 timeout ==========
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						// 直接杀整个进程组，不再等孩子“自愿”退出。
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}

				// ========== 输出流订阅 ==========
				// stdout + stderr 统一走 onData，上层拿到的是 *未区分两条流* 的合并流，
				// 和用户在真 shell 里看到的顺序最接近。
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				// ========== AbortSignal 链路 ==========
				// agent 端取消（用户按 Esc / 上游 abort）就走这里杀进程组。
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					// 可能进函数时 signal 已经是 aborted 状态：同步先杀一次。
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				// ========== 等进程收尾 ==========
				// 不直接用 child.on("exit"/"close")：`detached` 子进程的孙子如果还持有
				// stdout 句柄，close 会被一直 hang 住。`waitForChildProcess` 做了超时 /
				// fallback 处理，保证总会 resolve 出一个 exit code。
				waitForChildProcess(child)
					.then((code) => {
						// 进程真的退出：先做收尾（取消 pid 跟踪、清 timer、摘 abort 监听）。
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						// 优先级：abort > timeout > 正常退出。上层用错误消息关键字分派行为。
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						// spawn 本身失败（例如 shell 可执行找不到）：同样做清理再 reject。
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations();
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			// 1) 如果配置了全局 prefix（例如先 `source ~/.zshrc` 或先 `conda activate`），
			//    拼到命令最前面。用换行分隔，哪怕 prefix 最后没分号也不会把命令粘成一行。
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			// 2) spawnHook 允许扩展最终改写 command/cwd/env（例如走远程 SSH / 容器）。
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			// 3) 先 emit 一个“空 update”让 UI 把工具卡片显示成“运行中”状态，
			//    即使命令第一行输出还没来，用户也能看到进度。
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			return new Promise((resolve, reject) => {
				// ---------- 输出缓冲策略 ----------
				// `tempFilePath` / `tempFileStream`：一旦总输出超过内存阈值，
				// 就开始同步写到 /tmp 下的日志文件，事后结果里会告诉 LLM 全量路径。
				let tempFilePath: string | undefined;
				let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
				// `totalBytes`：进程启动以来累计输出字节数（永远不减）。
				let totalBytes = 0;
				// `chunks` + `chunksBytes`：**rolling tail 缓冲** —— 只留最后 2×MAX 字节
				// 的原始 buffer，后面做 tail 截断就够了；老的 chunk 会被丢弃以防内存爆炸。
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

				// “按需开 temp 文件”：第一次调用时创建，并把已缓冲的 chunks 全部补写进去，
				// 之后再有新数据就边来边写。保证文件内容 = 进程完整输出。
				const ensureTempFile = () => {
					if (tempFilePath) return;
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				// 真正的 stdout/stderr 数据回调：每收到一段就走这里。
				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					// (a) 累计字节数过阈值 → 开 temp 文件（后面所有数据双写）。
					if (totalBytes > DEFAULT_MAX_BYTES) {
						ensureTempFile();
					}
					// (b) 如果已经开了 temp 文件，新数据直接写一份进去。
					if (tempFileStream) tempFileStream.write(data);
					// (c) 先把这段 append 进 rolling buffer。
					chunks.push(data);
					chunksBytes += data.length;
					// (d) 滚掉最老的 chunk 直到不超阈值；至少保留一段（避免一次大 chunk 被丢光）。
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift()!;
						chunksBytes -= removed.length;
					}
					// (e) 把当前 tail 快照走 `truncateTail` 截断成“最后 N 行 / N 字节”，
					//     通过 onUpdate 回给 agent-loop，TUI 卡片就能实时渲染。
					//     注意这里可能也是第一次判定“超过行数上限”，所以也需要 ensureTempFile。
					if (onUpdate) {
						const fullBuffer = Buffer.concat(chunks);
						const fullText = fullBuffer.toString("utf-8");
						const truncation = truncateTail(fullText);
						if (truncation.truncated) {
							ensureTempFile();
						}
						onUpdate({
							content: [{ type: "text", text: truncation.content || "" }],
							details: {
								truncation: truncation.truncated ? truncation : undefined,
								fullOutputPath: tempFilePath,
							},
						});
					}
				};

				// ============ 真正启动子进程 ============
				ops.exec(spawnContext.command, spawnContext.cwd, {
					onData: handleData,
					signal,
					timeout,
					env: spawnContext.env,
				})
					// ============ 进程正常结束 ============
					.then(({ exitCode }) => {
						// 把 rolling buffer 拼成完整 tail 字符串（注意：已经滚掉的老数据不在这里）。
						const fullBuffer = Buffer.concat(chunks);
						const fullOutput = fullBuffer.toString("utf-8");
						// 最终再跑一次 truncateTail，确保返回给 LLM 的是 stable 的“最后 N 行”。
						const truncation = truncateTail(fullOutput);
						if (truncation.truncated) {
							ensureTempFile();
						}
						// temp 文件先关，保证下面提到路径时已经 flush 完。
						if (tempFileStream) tempFileStream.end();
						// 如果命令真没输出任何东西，给一个占位串，避免 LLM 看到空字符串懵。
						let outputText = truncation.content || "(no output)";
						let details: BashToolDetails | undefined;
						// 有截断：附上范围信息 + 全量文件路径，让 LLM 能主动再去 read 全文。
						if (truncation.truncated) {
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								// 边界情况：一行本身就比字节上限长，只能截断这一行。
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}
						// 非零退出码：以“错误工具结果”的形式 reject，LLM 会看到退出码并决定下一步。
						// 等于 0 或 null（被杀但还没触发 reject 路径的边界情况）视为成功。
						if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					// ============ 进程异常（abort / timeout / spawn 失败）============
					.catch((err: Error) => {
						// 同样先关 temp 文件。拼接“已收集的 tail 输出 + 错误原因”一起返给 LLM，
						// 这样哪怕进程是被杀的，前半部分输出也不会丢，LLM 可以基于它继续诊断。
						if (tempFileStream) tempFileStream.end();
						const fullBuffer = Buffer.concat(chunks);
						let output = fullBuffer.toString("utf-8");
						if (err.message === "aborted") {
							if (output) output += "\n\n";
							output += "Command aborted";
							reject(new Error(output));
						} else if (err.message.startsWith("timeout:")) {
							// timeout:秒数 —— 从错误消息里解出秒数，给 LLM 更可读的文本。
							const timeoutSecs = err.message.split(":")[1];
							if (output) output += "\n\n";
							output += `Command timed out after ${timeoutSecs} seconds`;
							reject(new Error(output));
						} else {
							// 其它路径（如 cwd 不存在、shell 找不到）：原样抛。
							reject(err);
						}
					});
			});
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

/** Default bash tool using process.cwd() for backwards compatibility. */
export const bashToolDefinition = createBashToolDefinition(process.cwd());
export const bashTool = createBashTool(process.cwd());
