/**
 * ⚠️ 这一条只断言**接线形态**（导航函数必须收「本页站点」这个实参）。
 * 它的行为判据在 `tests/zai-project-nav.test.ts`（真调导航函数）。
 * 留在 AST 层的原因与 `zai-content-startup-wiring-contract.test.ts` 里那几条同源：
 * `entrypoints/zai.content.ts` 不能被测试 import（模块顶层执行 `defineContentScript`）。
 */
import { readFileSync } from 'node:fs';
import * as t from '@babel/types';
import { describe, expect, it } from 'vitest';
import { parseTypeScriptSource, walkSourceAst } from './helpers/typescript-source';

const CONTENT_SCRIPT = 'entrypoints/zai.content.ts';

function callArgsOf(file: string, calleeName: string): (t.Node | null | undefined)[][] {
  const program = parseTypeScriptSource(file, readFileSync(file, 'utf8'));
  const calls: t.CallExpression[] = [];
  walkSourceAst(program, (node) => {
    if (!t.isCallExpression(node)) return;
    const callee = node.callee;
    if (t.isIdentifier(callee) && callee.name === calleeName) calls.push(node);
  });
  return calls.map((call) => call.arguments);
}

describe('project panel navigation wiring', () => {
  it('routes every panel navigation through the shared resolver', () => {
    // ⚠️ **面板里点一条会话必须走 `navigateToZaiConversation`** —— 那里才做
    // 「站点取自记录本身」的判定。直接 `location.assign` / 自己拼 URL 会把跨站会话
    // 打到当前站（跳转失败），而那正是这条守卫要拦的缺陷。
    const calls = callArgsOf('entrypoints/zai.content.ts', 'navigateToZaiConversation');
    expect(calls.length, 'the panel should navigate through the shared resolver').toBeGreaterThan(0);
  });

  it('passes the current page site so the resolver has a fallback', () => {
    // 记录里没有可用 url 时，兜底要按「本页是哪一站」拼 —— 少了这个实参，
    // 兜底只能吃默认站（国区站），在国际站上会把用户支到另一站。
    // ⚠️ 判据同时排除**字符串字面量**：站点必须来自就地判定的值
    //（内容脚本是 `currentSiteOrigin()`），写死一个站等于让另一站的兜底永远错。
    for (const args of callArgsOf(CONTENT_SCRIPT, 'navigateToZaiConversation')) {
      const deps = args[1];
      expect(t.isObjectExpression(deps), 'navigation deps must be an object literal').toBe(true);
      const property = (deps as t.ObjectExpression).properties
        .filter((item): item is t.ObjectProperty => t.isObjectProperty(item))
        .find((item) => t.isIdentifier(item.key, { name: 'currentOrigin' }));
      expect(property, 'deps must carry the current site origin').toBeDefined();
      expect(
        t.isStringLiteral(property!.value),
        'the current site must be resolved on the spot, not hard-coded',
      ).toBe(false);
    }
  });

  it('does not re-inline the same-origin check in the panel wiring', () => {
    // ⚠️ 缺陷复发点：把判定抄回面板里（`parsed.origin === location.origin` 之类）。
    // 面板里的导航只该走上面的共用函数，自己再判一次就等于把它绕过。
    const source = readFileSync(CONTENT_SCRIPT, 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(
      /\.origin\s*===\s*location\.origin/.test(code),
      'the panel must not compare against location.origin on its own',
    ).toBe(false);
  });
});