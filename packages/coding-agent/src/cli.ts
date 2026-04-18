#!/usr/bin/env node
/**
 * `pi` 可执行脚本的 **薄壳层**（shim）。
 *
 * 这个文件是 npm bin 入口，被 `pi` 命令直接 exec。它本身 **不解析参数**、
 * **不启 agent**，只负责把“进入用户代码前必须完成的一次性全局配置”做掉：
 *
 *   1. `process.title = "pi"`
 *      —— 让 `ps`, `htop`, macOS 活动监视器看到的进程名是 `pi` 而不是 `node`，
 *         方便用户识别/kill 自己的 agent。
 *
 *   2. `PI_CODING_AGENT=true`
 *      —— 写进环境变量，是给两类消费者用的：
 *         (a) 本进程里的代码判断“我是不是在 coding-agent CLI 上下文”，
 *         (b) bash 工具启子进程时继承这个变量，使子脚本能感知自己是 agent 里跑的。
 *
 *   3. 屏蔽 `process.emitWarning`
 *      —— Node 自己 / undici / 第三方依赖会用它往 stderr 打 deprecation / experimental
 *         warning；TUI 渲染靠精确控制 stdout/stderr 光标，这些 warning 会把画面弄花。
 *         这里直接替换成 no-op（类型断言保留原签名避免 TS 报错）。
 *
 *   4. `setGlobalDispatcher(new EnvHttpProxyAgent())`
 *      —— undici 是 Node 内置 fetch 底层。默认它 **不读** `HTTP_PROXY` / `HTTPS_PROXY`
 *         这些传统 env；装上 `EnvHttpProxyAgent` 后才会按环境变量走代理。
 *         对需要科学上网 / 企业内网的用户非常关键。必须在任何 fetch 前设置。
 *
 *   5. `main(process.argv.slice(2))`
 *      —— 把真正的 CLI 参数（去掉 `node` 和脚本路径自身）交给 `./main.ts`。
 *         那里才是“解析 args → 读配置 → 选模式（interactive/print/server）→ 跑 agent”的主线。
 *
 * 顺序很重要：`process.title`、env、emitWarning 必须在任何业务 import 之前执行；
 * `setGlobalDispatcher` 必须在任何走 undici 的请求之前执行。所以这几行排在 `main` 调用之前。
 */

// (1) 进程标题：影响 ps/htop 显示。
process.title = "pi";
// (2) 给子进程和自身代码一个“我在 pi 里跑”的信号。
process.env.PI_CODING_AGENT = "true";
// (3) 静默所有 Node warning，避免破坏 TUI 差分渲染。
process.emitWarning = (() => {}) as typeof process.emitWarning;

// (4) 在这里而不是 main.ts 里 import，是因为下面 setGlobalDispatcher 必须
//     在任何 fetch 发生前执行 —— main.ts 里 import 链一旦触发某些 http 调用就晚了。
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

// 让 undici 全局遵从 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 环境变量。
setGlobalDispatcher(new EnvHttpProxyAgent());

// (5) 进入正题：把除 node 和脚本自身以外的参数交给 main。
//     main 返回的是 Promise<void>，这里故意不 await —— Node 会保持进程存活直到
//     所有异步任务（包括 TUI 主循环）自然结束；没必要 top-level await 挡住 import 顺序。
main(process.argv.slice(2));
