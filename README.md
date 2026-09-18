# Zai++

> 占位 README。正式说明文档稍后补充。

<!--
计划内容（待写）：
- 项目定位：基于 DeepSeek++ 的 z.ai（chat.z.ai）移植版
- 功能列表
- 安装 / 构建方式
-->

---

## 致谢

Zai++ 是 [DeepSeek++](https://github.com/zhu1090093659/deepseek-pp)（Apache-2.0）到
[chat.z.ai](https://chat.z.ai) 的移植版。架构骨架、记忆 / Skill / MCP / 自动化分层，
以及 Native Shell Host，均源自该项目。

请求签名算法与协议细节来自公开的逆向分析工作，特别是：

- [zhipu-ai-proxy](https://github.com/petehsu/zhipu-ai-proxy)（CC BY-NC-SA 4.0，附安全研究条款）
  —— 签名算法。该项目记录的是 Web API 的公开可观察行为，不包含 Zhipu AI 的专有源代码。
- [GLM-Free-API](https://github.com/izaart95-jpg/GLM-Free-API)（MIT）—— SSE 流解析
- [zai-openai-proxy](https://github.com/xaoLiu1222/zai-openai-proxy)（MIT）—— tool_calls 解析与会话刷新

`core/zai/sign.ts` 为独立 TypeScript 重写，仅共享算法与公开常量。

## 许可

[Apache-2.0](LICENSE)