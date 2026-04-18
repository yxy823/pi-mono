/**
 * `@mariozechner/pi-tui` 的公共入口。
 *
 * 这是一个 **差分渲染** 的终端 UI 框架，重点面向 coding-agent 这类需要长时间流式
 * 输出 + 可交互输入的 CLI。核心思路：
 *
 *  - `TUI` 维护一棵 `Component` 组件树（见 `./tui.ts`），每一帧先把需要重绘的组件
 *    调用 `render(width)` 产出 `string[]`（每一项是一行，可含 ANSI 颜色 / 图像），
 *    再和上一次的输出按行做 diff，仅重写变化的行，避免整屏闪烁。
 *  - `Terminal` 是对 `process.stdin/stdout` 的薄封装（见 `./terminal.ts`），负责 raw
 *    mode、bracketed paste、Kitty 键盘协议协商、窗口尺寸、光标定位等。
 *  - 键盘输入统一成 `Key`（`./keys.ts`），并支持 Kitty 协议下的按键按下 / 释放 /
 *    重复事件区分，以及 Windows 下 VT input 的启用。
 *  - 组件库（`./components/*`）提供输入框、编辑器、选单、Markdown 渲染、图像、
 *    loader 等常用件。
 *  - 键位（`./keybindings.ts`）通过一张可配置的表统一管理，避免在组件里硬编码
 *    `ctrl+x` 之类的逻辑（与仓库 `AGENTS.md` 的规则一致）。
 *  - 终端图像（`./terminal-image.ts`）根据能力探测选择 Kitty / iTerm2 协议或纯
 *    ASCII fallback。
 *
 * 此文件是 barrel：只做命名导出，让消费方可以 `import { TUI, ... } from "@mariozechner/pi-tui"`。
 */

// Core TUI interfaces and classes

// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
// Components
export { Box } from "./components/box.js";
export { CancellableLoader } from "./components/cancellable-loader.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export { type DefaultTextStyle, Markdown, type MarkdownTheme } from "./components/markdown.js";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.js";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { TruncatedText } from "./components/truncated-text.js";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.js";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.js";
// Keybindings
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.js";
// Keyboard input handling
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.js";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.js";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.js";
// Terminal image support
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.js";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type SizeValue,
	TUI,
} from "./tui.js";
// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";
