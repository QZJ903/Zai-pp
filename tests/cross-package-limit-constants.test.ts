// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * **跨包数值常量只能有一个值，虽然它物理上必然有多份拷贝。**
 *
 * ⚠️⚠️ 它没法收敛成一份 import：宿主 `packages/shell-host` 是**独立的 npm 包**
 * （会被拷到安装目录），扩展侧是 TS、宿主侧是纯 `.mjs`，跨包 import 不成立。
 * 所以「改一处忘另一处」是结构性风险 —— 而失配的表现是**静默的**：
 *
 * - `MAX_LOCAL_FILE_WRITE_BYTES` 扩展放行、宿主拒收 ⇒ 用户看到一句
 *   「Content exceeds the local file write limit」，而他写的文件并不大；
 * - `MAX_SKILL_BYTES` / `MAX_LOCAL_SKILL_BYTES` 扩展拒收、宿主本来能收 ⇒
 *   用户被拦在一个其实合法的技能文件夹外面。
 *
 * ⚠️ 两种方向都不报错、都不崩，只是「功能比预期弱」或「报一句看不懂的错」。
 *
 * ⚠️ **读的是源码字面量而不是 import 值** —— 扩展侧这几个常量未导出
 * （它们是传输层内部实现细节，导出会扩大模块的公开面）。这也意味着
 * 「改成引用了别的常量」会让它红：那正是要的，说明有人动过。
 */

interface Literal {
  /** 读取的文件（相对仓库根）。 */
  file: string;
  /** 定位用的前缀，值取前缀之后到第一个 `;` 之前。 */
  prefix: string;
  /** 人类可读的常量名。 */
  name: string;
}

const HOST = 'packages/shell-host/native/contracts.mjs';

/**
 * 每一组是「同一个事实的扩展侧实现 + 宿主侧实现」。
 *
 * ⚠️ **加新行之前先问：这两处真的是同一个事实吗？** 名字相同但语义不同的
 * （如扩展侧的 `requestMs` 默认值与宿主的 `DEFAULT_TIMEOUT_MS`）不要往这里塞 ——
 * 那会造出一条「为了绿而改数」的假约束。
 */
const PAIRS: ReadonlyArray<{ label: string; extension: Literal; host: Literal }> = [
  {
    label: 'native 帧上限（extension → host 方向）',
    extension: {
      file: 'core/mcp/transports/native.ts',
      prefix: 'const MAX_NATIVE_REQUEST_BYTES = ',
      name: 'MAX_NATIVE_REQUEST_BYTES',
    },
    host: {
      file: HOST,
      prefix: 'const MAX_NATIVE_REQUEST_BYTES = ',
      name: 'MAX_NATIVE_REQUEST_BYTES',
    },
  },
  {
    label: 'local_file_write 的正文上限',
    extension: {
      file: 'core/mcp/transports/native.ts',
      prefix: 'const MAX_LOCAL_FILE_WRITE_BYTES = ',
      name: 'MAX_LOCAL_FILE_WRITE_BYTES',
    },
    host: {
      file: HOST,
      prefix: 'const MAX_LOCAL_FILE_WRITE_BYTES = ',
      name: 'MAX_LOCAL_FILE_WRITE_BYTES',
    },
  },
  {
    label: '单个 SKILL.md 的体积上限（GitHub 导入侧）',
    extension: {
      file: 'core/skill/github-importer.ts',
      prefix: 'const MAX_SKILL_BYTES = ',
      name: 'MAX_SKILL_BYTES',
    },
    host: {
      file: HOST,
      prefix: 'const MAX_LOCAL_SKILL_BYTES = ',
      name: 'MAX_LOCAL_SKILL_BYTES',
    },
  },
  {
    label: '单个 SKILL.md 的体积上限（本地导入侧）',
    extension: {
      file: 'core/skill/local-importer.ts',
      prefix: 'const MAX_SKILL_BYTES = ',
      name: 'MAX_SKILL_BYTES',
    },
    host: {
      file: HOST,
      prefix: 'const MAX_LOCAL_SKILL_BYTES = ',
      name: 'MAX_LOCAL_SKILL_BYTES',
    },
  },
];

/** 取出 `prefix` 之后到 `;` 之前的表达式文本，去掉数字分隔符后比较。 */
function literalOf({ file, prefix, name }: Literal): string {
  const source = readFileSync(file, 'utf8');
  const start = source.indexOf(prefix);
  expect(start, `${file} 里应当有 ${name} 的定义（前缀：${prefix.trim()}）`).toBeGreaterThanOrEqual(0);
  const valueStart = start + prefix.length;
  const valueEnd = source.indexOf(';', valueStart);
  expect(valueEnd, `${file} 的 ${name} 定义没有以 ; 结尾`).toBeGreaterThan(valueStart);
  const raw = source.slice(valueStart, valueEnd).trim();
  expect(raw.length, `${file} 的 ${name} 值是空的`).toBeGreaterThan(0);
  // ⚠️ **只归一数字分隔符与空白，不求值** —— 所以「`1 * 1024 * 1024` 与 `1_048_576`」
  // 仍会被判成不一致（实测确认）。那是有意的：这条测的是**两侧写成同一个算式**，
  // 不是「算出来等于同一个数」。真要放宽得引入求值，而求值会让一句手滑的
  // `1 * 1024` 也能过 —— 对账的价值就没了。
  return raw.replace(/_/g, '').replace(/\s+/g, ' ');
}

describe('跨包数值常量对账', () => {
  it.each(PAIRS.map((pair) => [pair.label, pair] as const))(
    '扩展侧与宿主侧的 %s 一致',
    (_label, pair) => {
      expect(
        literalOf(pair.extension),
        `${pair.extension.file} 与 ${pair.host.file} 的 ${pair.extension.name} 不一致 —— `
        + '改一侧必须同改另一侧，否则上限会在其中一侧静默失效',
      ).toBe(literalOf(pair.host));
    },
  );

  it('宿主仍然导出这两组常量（导出面被删时给出明确失败）', async () => {
    // @ts-expect-error 宿主 contracts.mjs 为纯 JS 实现，无类型声明文件
    const contracts = await import('../packages/shell-host/native/contracts.mjs') as {
      MAX_NATIVE_REQUEST_BYTES?: number;
      MAX_LOCAL_FILE_WRITE_BYTES?: number;
      MAX_LOCAL_SKILL_BYTES?: number;
    };
    expect(contracts.MAX_NATIVE_REQUEST_BYTES).toBeTypeOf('number');
    expect(contracts.MAX_LOCAL_FILE_WRITE_BYTES).toBeTypeOf('number');
    expect(contracts.MAX_LOCAL_SKILL_BYTES).toBeTypeOf('number');
  });
});
