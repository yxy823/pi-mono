#!/usr/bin/env node
/**
 * `pi` 可执行脚本的薄壳层。
 *
 * 做三件事：
 *  1. 把进程名改成 `pi`，方便在 `ps` / 任务管理器里辨识；设置 `PI_CODING_AGENT=true`，
 *     供子进程和一些默认配置判断当前上下文。
 *  2. 屏蔽 `process.emitWarning`：避免依赖（如 undici）吐到 stderr 的 warning 打乱
 *     TUI 的差分渲染（TUI 对 stdout/stderr 非常敏感）。
 *  3. 为 undici 安装 `EnvHttpProxyAgent`，让 `HTTP(S)_PROXY` / `NO_PROXY` 等环境变量
 *     对本进程所有基于 undici 的 fetch 生效，随后把命令行参数交给 `main.ts`。
 *
 * 真实的参数解析、会话管理、模式派发等都在 `./main.ts` 里完成。
 */
process.title = "pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());

main(process.argv.slice(2));
