/**
 * `@mariozechner/pi-web-ui` 的公共入口。
 *
 * 这个包把 `pi-ai` / `pi-agent-core` 的 agent 能力包装成一组 **Lit 组件**，用于在
 * 浏览器里跑 chat 界面，核心亮点：
 *
 *  - `ChatPanel`：最顶层、拎包即用的聊天面板。它内部组合 `AgentInterface`（对话
 *    主体）和 `ArtifactsPanel`（artifacts 预览），并根据断点自动在 overlay /
 *    并排两种布局间切换。
 *  - `AgentInterface`：消息列表 + 输入框 + 模型选择 / 思考等级 / 附件的集成件，
 *    直接消费一个 `Agent` 实例。
 *  - 消息渲染：`registerMessageRenderer` / `renderMessage` 用 role →
 *    renderer 的映射，让上层可以注入自己的消息组件（例如带富文本的用户消息）。
 *  - 工具渲染：`registerToolRenderer` / `renderTool` 同上，负责把各种 tool call
 *    的结果渲染成合适的 UI（artifacts / console / image / download ...）。
 *  - 存储：基于 IndexedDB 的 `Store` 体系（会话、API key、自定义 provider、
 *    设置等），提供跨 tab 持久化与版本迁移。
 *  - Artifacts：HTML / 图片 / Markdown / SVG / 文本 / JS REPL 等，通过统一的
 *    `SandboxRuntimeProvider` 接口与 sandboxed iframe 对话，保持主站安全。
 *  - Dialogs：模型选择、API key 配置、会话列表、自定义 provider、设置等弹窗。
 *
 * 本文件只做 barrel re-export。具体实现按照 `components/` / `dialogs/` /
 * `storage/` / `tools/` 分模块组织。
 */

// Main chat interface

export type { Agent, AgentMessage, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";
export type { Model } from "@mariozechner/pi-ai";
export { ChatPanel } from "./ChatPanel.js";
// Components
export { AgentInterface } from "./components/AgentInterface.js";
export { AttachmentTile } from "./components/AttachmentTile.js";
export { ConsoleBlock } from "./components/ConsoleBlock.js";
export { CustomProviderCard } from "./components/CustomProviderCard.js";
export { ExpandableSection } from "./components/ExpandableSection.js";
export { Input } from "./components/Input.js";
export { MessageEditor } from "./components/MessageEditor.js";
export { MessageList } from "./components/MessageList.js";
// Message components
export type { ArtifactMessage, UserMessageWithAttachments } from "./components/Messages.js";
export {
	AbortedMessage,
	AssistantMessage,
	convertAttachments,
	defaultConvertToLlm,
	isArtifactMessage,
	isUserMessageWithAttachments,
	ToolMessage,
	ToolMessageDebugView,
	UserMessage,
} from "./components/Messages.js";
// Message renderer registry
export {
	getMessageRenderer,
	type MessageRenderer,
	type MessageRole,
	registerMessageRenderer,
	renderMessage,
} from "./components/message-renderer-registry.js";
export { ProviderKeyInput } from "./components/ProviderKeyInput.js";
export {
	type SandboxFile,
	SandboxIframe,
	type SandboxResult,
	type SandboxUrlProvider,
} from "./components/SandboxedIframe.js";
export { StreamingMessageContainer } from "./components/StreamingMessageContainer.js";
// Sandbox Runtime Providers
export { ArtifactsRuntimeProvider } from "./components/sandbox/ArtifactsRuntimeProvider.js";
export { AttachmentsRuntimeProvider } from "./components/sandbox/AttachmentsRuntimeProvider.js";
export { type ConsoleLog, ConsoleRuntimeProvider } from "./components/sandbox/ConsoleRuntimeProvider.js";
export {
	type DownloadableFile,
	FileDownloadRuntimeProvider,
} from "./components/sandbox/FileDownloadRuntimeProvider.js";
export { RuntimeMessageBridge } from "./components/sandbox/RuntimeMessageBridge.js";
export { RUNTIME_MESSAGE_ROUTER } from "./components/sandbox/RuntimeMessageRouter.js";
export type { SandboxRuntimeProvider } from "./components/sandbox/SandboxRuntimeProvider.js";
export { ThinkingBlock } from "./components/ThinkingBlock.js";
export { ApiKeyPromptDialog } from "./dialogs/ApiKeyPromptDialog.js";
export { AttachmentOverlay } from "./dialogs/AttachmentOverlay.js";
export { CustomProviderDialog } from "./dialogs/CustomProviderDialog.js";
// Dialogs
export { ModelSelector } from "./dialogs/ModelSelector.js";
export { PersistentStorageDialog } from "./dialogs/PersistentStorageDialog.js";
export { ProvidersModelsTab } from "./dialogs/ProvidersModelsTab.js";
export { SessionListDialog } from "./dialogs/SessionListDialog.js";
export { ApiKeysTab, ProxyTab, SettingsDialog, SettingsTab } from "./dialogs/SettingsDialog.js";
// Prompts
export {
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO,
	ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW,
	ATTACHMENTS_RUNTIME_DESCRIPTION,
} from "./prompts/prompts.js";
// Storage
export { AppStorage, getAppStorage, setAppStorage } from "./storage/app-storage.js";
export { IndexedDBStorageBackend } from "./storage/backends/indexeddb-storage-backend.js";
export { Store } from "./storage/store.js";
export type {
	AutoDiscoveryProviderType,
	CustomProvider,
	CustomProviderType,
} from "./storage/stores/custom-providers-store.js";
export { CustomProvidersStore } from "./storage/stores/custom-providers-store.js";
export { ProviderKeysStore } from "./storage/stores/provider-keys-store.js";
export { SessionsStore } from "./storage/stores/sessions-store.js";
export { SettingsStore } from "./storage/stores/settings-store.js";
export type {
	IndexConfig,
	IndexedDBConfig,
	SessionData,
	SessionMetadata,
	StorageBackend,
	StorageTransaction,
	StoreConfig,
} from "./storage/types.js";
// Artifacts
export { ArtifactElement } from "./tools/artifacts/ArtifactElement.js";
export { ArtifactPill } from "./tools/artifacts/ArtifactPill.js";
export { type Artifact, ArtifactsPanel, type ArtifactsParams } from "./tools/artifacts/artifacts.js";
export { ArtifactsToolRenderer } from "./tools/artifacts/artifacts-tool-renderer.js";
export { HtmlArtifact } from "./tools/artifacts/HtmlArtifact.js";
export { ImageArtifact } from "./tools/artifacts/ImageArtifact.js";
export { MarkdownArtifact } from "./tools/artifacts/MarkdownArtifact.js";
export { SvgArtifact } from "./tools/artifacts/SvgArtifact.js";
export { TextArtifact } from "./tools/artifacts/TextArtifact.js";
export { createExtractDocumentTool, extractDocumentTool } from "./tools/extract-document.js";
// Tools
export { getToolRenderer, registerToolRenderer, renderTool, setShowJsonMode } from "./tools/index.js";
export { createJavaScriptReplTool, javascriptReplTool } from "./tools/javascript-repl.js";
export { renderCollapsibleHeader, renderHeader } from "./tools/renderer-registry.js";
export { BashRenderer } from "./tools/renderers/BashRenderer.js";
export { CalculateRenderer } from "./tools/renderers/CalculateRenderer.js";
// Tool renderers
export { DefaultRenderer } from "./tools/renderers/DefaultRenderer.js";
export { GetCurrentTimeRenderer } from "./tools/renderers/GetCurrentTimeRenderer.js";
export type { ToolRenderer, ToolRenderResult } from "./tools/types.js";
export type { Attachment } from "./utils/attachment-utils.js";
// Utils
export { loadAttachment } from "./utils/attachment-utils.js";
export { clearAuthToken, getAuthToken } from "./utils/auth-token.js";
export { formatCost, formatModelCost, formatTokenCount, formatUsage } from "./utils/format.js";
export { i18n, setLanguage, translations } from "./utils/i18n.js";
export { applyProxyIfNeeded, createStreamFn, isCorsError, shouldUseProxyForProvider } from "./utils/proxy-utils.js";
