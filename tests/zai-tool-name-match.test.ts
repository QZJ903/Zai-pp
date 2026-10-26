import { describe, expect, it } from 'vitest';
import { matchCatalogToolName } from '../core/zai/tool-name-match';

/**
 * `delta_name` → 本轮目录里的工具名。
 *
 * ⚠️⚠️ **这一组的存在理由**：判据原先写的是「trim 之后整串相等」，
 * 而真机上 `delta_name` 会带**模型自造的 XML 尾巴** ⇒ 一条都命中不了，
 * 误用纠错整条链静默失效（首轮与续跑轮共用同一处判据）。
 * 下面两组用例就是那两份真机抓包的原文，**别删**。
 */

const CATALOG = [
  'shell_exec',
  'shell_status',
  'shell_session_begin',
  'shell_session_exec',
  'shell_session_end',
  'memory_save',
  'skill_draft_create',
];

describe('matchCatalogToolName: real captures', () => {
  it('matches the tool name in front of a self-invented XML tail', () => {
    // 抓包一：尾巴里带换行，且闭合标签是 `</arg_value>`（不在我们的提示词里）。
    expect(matchCatalogToolName('shell_status>\n{}\n</arg_value>', CATALOG)).toBe('shell_status');
    // 抓包二：同样带尾巴，`delta_arguments` 完整。
    expect(matchCatalogToolName('shell_status>{}</arg_value>', CATALOG)).toBe('shell_status');
  });

  it('still matches a clean name', () => {
    expect(matchCatalogToolName('skill_draft_create', CATALOG)).toBe('skill_draft_create');
  });
});

describe('matchCatalogToolName: boundaries', () => {
  it('accepts trailing whitespace only', () => {
    expect(matchCatalogToolName('  shell_status  ', CATALOG)).toBe('shell_status');
    expect(matchCatalogToolName('shell_status\n', CATALOG)).toBe('shell_status');
  });

  it('rejects a longer name that merely starts with a catalog name', () => {
    // 名字之后紧跟标识符字符 ⇒ 它还是「同一个更长的名字」，不是我们目录里的那个。
    expect(matchCatalogToolName('shell_exec_extra', CATALOG)).toBeNull();
    expect(matchCatalogToolName('shell_statuses', CATALOG)).toBeNull();
    expect(matchCatalogToolName('shell_status.json', CATALOG)).toBeNull();
    expect(matchCatalogToolName('memory_save_v2', CATALOG)).toBeNull();
  });

  it('rejects a name that only appears in the middle', () => {
    // ⚠️ 这两条是「包含匹配」与「前缀匹配」结论不同的最小形态 —— 别改成只在末尾追加
    // 垃圾的写法（那样 `includes` 也会命中，用例就失去区分力）。
    expect(matchCatalogToolName('xxxxxxxxxxxx>shell_status', CATALOG)).toBeNull();
    expect(matchCatalogToolName('<shell_status>{}</shell_status>', CATALOG)).toBeNull();
  });

  it('rejects the server-side sandbox tools', () => {
    // ⚠️ 这是**正常流量**（agent 每轮联网都会发）。它们不在本轮目录里，天然不命中。
    expect(matchCatalogToolName('Bash', CATALOG)).toBeNull();
    expect(matchCatalogToolName('Read', CATALOG)).toBeNull();
    expect(matchCatalogToolName('Write>{}</arg_value>', CATALOG)).toBeNull();
  });

  it('rejects empty and non-string input', () => {
    expect(matchCatalogToolName('', CATALOG)).toBeNull();
    expect(matchCatalogToolName('   ', CATALOG)).toBeNull();
    expect(matchCatalogToolName('>{}', CATALOG)).toBeNull();
    expect(matchCatalogToolName(undefined, CATALOG)).toBeNull();
    expect(matchCatalogToolName(42, CATALOG)).toBeNull();
    expect(matchCatalogToolName({ name: 'shell_exec' }, CATALOG)).toBeNull();
  });
});

describe('matchCatalogToolName: catalog shape', () => {
  it('is not confused when one catalog entry prefixes another, in either order', () => {
    // ⚠️ 这条守的是「边界判据」而不是「最长优先」：短名 `shell` 遇到 `shell_exec…` 时，
    // 会因为下一个字符是 `_`（名字的一部分）被挡掉 ⇒ 只剩长名能命中、与目录顺序无关。
    // 谁把边界检查去掉，这里就会按目录顺序拿到 `shell`（`[short, long]` 那一组）。
    const short = 'shell';
    const long = 'shell_exec';
    const input = 'shell_exec>{}</arg_value>';
    expect(matchCatalogToolName(input, [short, long])).toBe(long);
    expect(matchCatalogToolName(input, [long, short])).toBe(long);
    // 短名自己仍然认得出（后面紧跟的是边界字符）。
    expect(matchCatalogToolName('shell>{}</arg_value>', [short, long])).toBe(short);
  });

  it('handles an empty catalog and skips junk entries', () => {
    expect(matchCatalogToolName('shell_exec', [])).toBeNull();
    expect(matchCatalogToolName('shell_exec', ['', 'shell_exec'])).toBe('shell_exec');
  });

  it('does not match an MCP name that is not in this request catalog', () => {
    // MCP 工具名含每次安装随机生成的 server 段 ⇒ 只能靠「本轮目录」判，不能靠前缀猜。
    expect(matchCatalogToolName('mcp_demo_echo>{}</arg_value>', CATALOG)).toBeNull();
    expect(matchCatalogToolName('mcp_demo_echo>{}', ['mcp_demo_echo'])).toBe('mcp_demo_echo');
  });
});
