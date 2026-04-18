/**
 * `@mariozechner/pi-agent-core` 的公共入口。
 *
 * 本包在 `@mariozechner/pi-ai` 的流式 LLM 调用之上提供一个 **有状态的 agent 运行时**，
 * 负责：
 *
 *  - 维护对话 transcript（用户 / 助手 / 工具结果三种消息）。
 *  - 把高层 `AgentMessage` 在发给 LLM 前转换成底层 `Message[]`（即 `convertToLlm`）。
 *  - 调度工具调用（顺序 / 并行 / 按工具声明的 `executionMode`）。
 *  - 暴露生命周期事件流（`agent_start` / `turn_start` / `message_*` /
 *    `tool_execution_*` / `turn_end` / `agent_end`）。
 *  - 支持在 agent 运行过程中插入 **steering**（转向）消息，或在 agent 本该结束时
 *    注入 **follow-up**（后续）消息，以实现交互式驾驶。
 *
 * 此文件只做 barrel re-export，实际实现分散在同级模块里，按职责拆分：
 *
 *  - `./agent.ts`       —— 面向使用方的 `Agent` 类：封装状态、队列、事件订阅。
 *  - `./agent-loop.ts`  —— 无状态的底层 loop（`runAgentLoop` /
 *                            `runAgentLoopContinue`）；可不借助 `Agent` 单独使用。
 *  - `./proxy.ts`       —— HTTP(S) 代理工具：在 Node 侧解析 `*_PROXY` 等环境变量。
 *  - `./types.ts`       —— 所有公共类型（`AgentMessage`、`AgentEvent`、
 *                            `AgentTool`、`AgentState`、`AgentLoopConfig` 等）。
 */

// 核心 Agent 类（有状态包装、事件订阅、steering / follow-up 队列）
export * from "./agent.js";
// 无状态的 agent loop，以及用于继续已有上下文的 continue 版本
export * from "./agent-loop.js";
// HTTP(S) 代理解析工具
export * from "./proxy.js";
// 公共类型定义
export * from "./types.js";
