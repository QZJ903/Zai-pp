import { DEFAULT_LOCALE, type SupportedLocale } from '../i18n/background';
import { SHELL_MCP_NATIVE_HOST, EXPOSED_SHELL_TOOL_NAMES } from '../shell';
import { createMemoryToolDescriptors } from '../tool/memory';
import type { Skill } from '../types';

type BuiltinSkillText = Pick<Skill, 'description' | 'instructions'>;

function renderMemoryToolSchemas(locale: SupportedLocale): string {
  return ['memory_update', 'memory_delete']
    .map((name) => {
      const descriptor = createMemoryToolDescriptors(locale).find((tool) => tool.name === name);
      if (!descriptor) throw new Error(`Missing memory tool descriptor: ${name}`);
      return JSON.stringify({
        type: 'function',
        function: {
          name: descriptor.name,
          description: descriptor.description,
          parameters: descriptor.inputSchema,
        },
      });
    })
    .join('\n');
}

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'shell',
    description: '本地命令行助手：通过 Native Messaging 在用户本机执行 shell 命令。适用于文件操作、脚本运行、系统管理等任何需要命令行的场景。',
    instructions: `你正在通过 Zai++ Shell MCP 扩展执行本地命令。可用工具：${EXPOSED_SHELL_TOOL_NAMES.join('、')}。

## 执行边界

- Shell 工具通过 Chrome Native Messaging 与本机 host (${SHELL_MCP_NATIVE_HOST}) 通信。
- 只有在工具列表中出现对应 Shell MCP 工具时才调用；不要编造执行结果。
- 如果 shell 工具已出现在「可用工具」列表中，直接输出对应 XML 工具标签调用。
- 不要用原生 tool_call 调这些本地工具 —— 服务端不认识它们，会返回 tool call failed。
- 不要输出伪 JSON 调用；Zai++ 只执行 <shell_exec>{"command":"..."}</shell_exec> 这种 XML 标签格式。
- 不要猜测文件路径，先用 shell_status 判断平台和 shell，再用对应 shell 的目录命令确认实际路径。
- Windows 默认 shell 是 PowerShell：列目录用 Get-ChildItem -LiteralPath "D:\\Documents\\Downloads\\CN" -File | Select-Object -ExpandProperty FullName，不要把 CMD 的 dir /b 直接当 PowerShell 命令；确实需要 CMD 语法时显式运行 cmd.exe /c "..."。
- Windows 路径在 JSON 中使用双反斜杠或正斜杠，并在命令字符串里只包一层引号。

## 使用流程

1. 先了解环境：首次使用时调用 shell_status 获取平台、shell 类型和工作目录。
2. 分步执行：复杂任务拆分为多个简单命令逐步执行，每步确认结果后再继续。
3. 检查返回：关注 exitCode（0=成功）和 stderr 内容，非零退出码需说明原因。
4. 报告结果：只报告工具实际返回的内容，不要编造或假设输出。

## 最佳实践

- 长时间命令设置合理的 timeout_ms（默认 120 秒，最长 600 秒）。
- 输出过长时使用 head/tail/grep 过滤，或重定向到文件后分段读取。
- 破坏性操作（rm、格式化等）前提醒用户确认。
- 可以通过 cwd 参数指定工作目录，通过 env 参数设置环境变量。`,
    source: 'builtin',
    memoryEnabled: false,
  },
  {
    name: 'memory',
    description: '记忆管理：/memory save <内容> | /memory list | /memory update | /memory delete',
    instructions: `用户请求管理记忆。每条记忆的格式为 "#ID [type] 标题: 内容"，ID 是唯一标识。

### Additional Tool Schemas

${renderMemoryToolSchemas('zh-CN')}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

## 操作类型

根据用户输入判断操作类型，然后在回复末尾调用对应的工具。

### 保存（用户想记住新内容）
分析用户提供的内容，确定合适的 type 和标签，在回复末尾调用 memory_save 工具。

### 修改（用户想更新已有记忆）
找到目标记忆的 ID，在回复末尾调用 memory_update 工具。所有字段均为必填，未变更的字段保持原值。

### 删除（用户想移除某条记忆）
确认目标记忆的 ID，在回复末尾调用 memory_delete 工具。

### 列出
列出"已有记忆"中的所有条目（含 ID），无需调用工具。

## 规则
- 先正常回复用户，工具调用块附在回复最末尾
- 支持一次操作多条记忆：在回复末尾连续输出多个 <memory_save>{...}</memory_save> / <memory_update>{...}</memory_update> / <memory_delete>{...}</memory_delete> 标签块
- 如果用户意图模糊，先确认再操作`,
    source: 'builtin',
    memoryEnabled: true,
  },
];

const ENGLISH_BUILTIN_SKILL_TEXT: Record<string, BuiltinSkillText> = {
  shell: {
    description: 'Local command-line assistant: run shell commands on the user machine through Native Messaging. Use for file operations, script execution, system inspection, and any task that requires a terminal.',
    instructions: `You are executing local shell commands through the Zai++ Shell MCP extension. Available tools: ${EXPOSED_SHELL_TOOL_NAMES.join(', ')}.

## Execution Boundaries

- Shell tools communicate with the local host (${SHELL_MCP_NATIVE_HOST}) through Chrome Native Messaging.
- Only call a Shell MCP tool when it appears in the tool list; never invent command results.
- If shell tools appear in the "Available Tools" list, emit the matching XML tool tag directly.
- Never call these local tools through the native tool_call channel — the server does not know them and returns tool call failed.
- Do not output pseudo JSON calls. Zai++ only executes XML tags such as <shell_exec>{"command":"..."}</shell_exec>.
- Do not guess file paths. First call shell_status to identify the platform and shell, then use the matching shell command to confirm real paths.
- The default Windows shell is PowerShell: list files with Get-ChildItem -LiteralPath "D:\\Documents\\Downloads\\CN" -File | Select-Object -ExpandProperty FullName. Do not treat CMD dir /b as a PowerShell command; explicitly run cmd.exe /c "..." when CMD syntax is needed.
- Use double backslashes or forward slashes for Windows paths in JSON, and wrap the command path in only one layer of quotes.

## Workflow

1. Inspect the environment: on first use, call shell_status to get platform, shell type, and working directory.
2. Execute step by step: split complex work into simple commands and review each result before continuing.
3. Check returned status: pay attention to exitCode (0 means success) and stderr. Explain non-zero exits.
4. Report evidence: only report what the tool actually returned; do not fabricate or assume output.

## Best Practices

- Set a reasonable timeout_ms for long-running commands (default 120 seconds, maximum 600 seconds).
- When output is long, filter with head/tail/grep or redirect to a file and read it in chunks.
- Ask the user to confirm before destructive operations such as rm or formatting.
- Use cwd to choose a working directory and env to set environment variables.`,
  },
  memory: {
    description: 'Memory management: /memory save <content> | /memory list | /memory update | /memory delete',
    instructions: `The user is asking to manage memories. Each memory is shown as "#ID [type] title: content"; the ID is the unique identifier.

### Additional Tool Schemas

${renderMemoryToolSchemas('en')}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.

## Operation Types

Infer the operation from the user input, then call the corresponding tool at the end of the reply.

### Save (the user wants to remember new content)
Analyze the provided content, choose an appropriate type and tags, and call memory_save at the end of the reply.

### Update (the user wants to modify an existing memory)
Find the target memory ID and call memory_update at the end of the reply. All fields are required; preserve unchanged fields exactly.

### Delete (the user wants to remove a memory)
Confirm the target memory ID and call memory_delete at the end of the reply.

### List
List every item from Existing Memories, including IDs. No tool call is needed.

## Rules
- Reply normally first, then place tool call blocks at the very end.
- Multiple memory operations are supported: emit several <memory_save>{...}</memory_save> / <memory_update>{...}</memory_update> / <memory_delete>{...}</memory_delete> tag blocks in a row at the end of the reply.
- If the user's intent is ambiguous, ask a narrow clarification before changing memory.`,
  },
};

export function getLocalizedBuiltinSkills(locale: SupportedLocale = DEFAULT_LOCALE): Skill[] {
  return BUILTIN_SKILLS.map((skill) => {
    if (skill.source !== 'builtin') return { ...skill };
    const localized = locale === 'en' ? ENGLISH_BUILTIN_SKILL_TEXT[skill.name] : undefined;
    return localized ? { ...skill, ...localized } : { ...skill };
  });
}

