/**
 * `read` 工具 —— 让 LLM 读本地文件。
 *
 * 职责：
 *  1. 把 LLM 给的路径（可能相对可能绝对）解析成绝对路径、检查可读性；
 *  2. 自动区分“图像 vs 文本”：
 *     - 图像：读成 Buffer → base64 → 可选再 resize 到 2000x2000 以内 → 作为
 *       `image` content 返回给模型（provider 会按各自规则打进 prompt）；
 *     - 文本：UTF-8 解码，按 offset / limit 切片，再应用 head 截断（最多
 *       `DEFAULT_MAX_LINES` 行或 `DEFAULT_MAX_BYTES` 字节），截断后在尾部追加
 *       可执行的“continuation 提示”告诉 LLM 用什么 offset 读下一段。
 *  3. 通过 `ReadOperations` 抽象：默认走 Node `fs/promises`，扩展可换成 SSH 等。
 *  4. 全程支持 AbortSignal；已经 abort 的读写不会 resolve。
 *
 * 这个工具和 bash 的关键区别：**没有流式 onUpdate**。文件读一次就出结果，
 * 不需要在中间刷屏，所以实现只是一个 Promise。
 */
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { getLanguageFromPath, highlightCode } from "../../modes/interactive/theme/theme.js";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.js";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function formatReadCall(
	args: { path?: string; file_path?: string; offset?: number; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath) : null;
	const offset = args?.offset;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	if (offset !== undefined || limit !== undefined) {
		const startLine = offset ?? 1;
		const endLine = limit !== undefined ? startLine + limit - 1 : "";
		pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
	}
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

function formatReadResult(
	args: { path?: string; file_path?: string; offset?: number; limit?: number } | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.js").theme,
	showImages: boolean,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result as any, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			// 把 LLM 给的相对路径按 cwd 解析成绝对路径。`resolveReadPath` 会处理
			// `~`、纯绝对路径、以及 `./` 前缀等多种写法。
			const absolutePath = resolveReadPath(path, cwd);
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					// (0) signal 已经 abort 就直接不做事。
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					// aborted 标志：一旦 abort 事件到来，后续的异步步骤就不再 resolve。
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							// (1) 先 access 校验存在且可读。抛 EACCES / ENOENT 会进 catch，
							//     以工具错误形式返回给 LLM，它能看到原始错误信息自行处理。
							await ops.access(absolutePath);
							if (aborted) return;

							// (2) 如果实现了 detectImageMimeType，就探测一下是不是支持的图像格式。
							//     mimeType=undefined/null 表示按文本处理。
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;

							if (mimeType) {
								// -------- 图像分支 --------
								// 整个文件读成 Buffer → base64（后面 provider 要 inline 图像都要的形式）。
								const buffer = await ops.readFile(absolutePath);
								const base64 = buffer.toString("base64");
								if (autoResizeImages) {
									// 如果配置允许，自动 resize 到 provider 允许的尺寸上限以内。
									const resized = await resizeImage({ type: "image", data: base64, mimeType });
									if (!resized) {
										// resize 失败：不丢异常，而是返回一个只含文本说明的结果，
										// LLM 能看懂这是哪张图、为什么没带上。
										content = [
											{
												type: "text",
												text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
											},
										];
									} else {
										// 成功：text + image 两段，text 里带尺寸信息方便模型理解上下文。
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									// 不做 resize：直接把原图喂回去（调用方自己保证大小合规）。
									content = [
										{ type: "text", text: `Read image file [${mimeType}]` },
										{ type: "image", data: base64, mimeType },
									];
								}
							} else {
								// -------- 文本分支 --------
								// 整个文件先读成 string，按 \n 切成行数组。即使最后一行没换行也算一行。
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;

								// (3a) 解析 offset。LLM 看到的是 1-indexed，内部切片要换成 0-indexed。
								//      未传 offset 时从 0 开始；负数当 0。
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// offset 越界：主动报错，比默默返回空数组更利于 LLM 发现问题。
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}

								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// (3b) 用户传了 limit 就先按 limit 切；没传就把 offset 之后全部拿出来，
								//      让下面的 truncateHead 决定是否再砍。
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}

								// (3c) 对这个切片做 head 截断（最多 N 行 / N 字节，从头保留）。
								//      结果里包含：截断后的文本、实际行数、是否触发了截断、按什么维度截断等。
								const truncation = truncateHead(selectedContent);

								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// 边界情况：单行就比字节上限还大。此时返回一条提示 + 一个可直接执行
									// 的 bash fallback 让 LLM 退回去用 bash 自己取那一行。
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// 普通截断：LLM 只拿到一段，但我们在尾部附上“下一次应传什么 offset”，
									// 这样它不需要猜，直接再调一次 read 就能顺着读下去。
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// 用户自己的 limit 提前切完了，但后面文件其实还有。
									// 提示模型：还有多少行 + 下一个 offset。
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// 无截断 + 已到文件尾部：直接原文返回。
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							// abort 保护：即便异步里我们都 await 完了，只要中途 abort 过就不 resolve。
							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							// 正常错误（ENOENT / 权限 / offset 越界等）：摘监听、reject 给上层。
							// abort 情况下 onAbort 已经 reject 过，这里不再重复。
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatReadCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatReadResult(context.args, result as any, options, theme, context.showImages));
			return text;
		},
	};
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}

/** Default read tool using process.cwd() for backwards compatibility. */
export const readToolDefinition = createReadToolDefinition(process.cwd());
export const readTool = createReadTool(process.cwd());
