import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

/**
 * 模型覆写的三处调用点**不得再被 `isAgentTurn` 挡住**。
 *
 * ## 为什么要有这条守卫
 *
 * 代码里曾有一个假设：「agent 模式的模型由服务端按 `general_agent` 装配，覆写无效」。
 * 于是三处调用点都写成 `if (!isAgentTurn) applyZaiModelOverrideForRoute(...)`。
 * **真机实测推翻了这个假设**：agent 的 completion body 带顶层 `model`，且同一会话
 * 不同轮次带不同 id ⇒ 模型字段是活的，门是多余的，而它让「自动化选了模型」在
 * agent 下**静默失效**（表单能选、请求里没有）。
 *
 * ## 为什么是源码级断言
 *
 * `zai.content.ts` 加载即执行 `defineContentScript(...)`，**不能被测试 import**
 * ⇒ 这三处调用点没有行为测试可写。按 [[zai-code-guardrails]] B21：能写行为测试就写，
 * 写不了才退回 AST；这里属于后者，且断言对象是**语法位置**（调用点有没有被 if 包住），
 * 不是「名字有没有出现过」。
 *
 * ⚠️ 它拦不住「把门挪进别的形式」（例如先算一个布尔再包一层）——
 * 那类绕过由 `zai-code-guardrails` B21 的六族绕过清单覆盖，这里只钉最常见的一种。
 */

const SOURCE = readFileSync('entrypoints/zai.content.ts', 'utf8');

function readProgram() {
  return parse(SOURCE, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
}

/** 找到顶层函数声明 / 变量声明里的函数体。 */
function findFunctionBody(program: ReturnType<typeof readProgram>, name: string): t.Node | null {
  for (const node of program.program.body) {
    if (t.isFunctionDeclaration(node) && node.id?.name === name) return node.body;
    if (t.isVariableDeclaration(node)) {
      for (const declarator of node.declarations) {
        if (t.isIdentifier(declarator.id) && declarator.id.name === name) {
          return declarator.init ?? null;
        }
      }
    }
  }
  return null;
}

function walk(node: t.Node | null, visit: (node: t.Node) => void): void {
  if (!node) return;
  visit(node);
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && 'type' in child) walk(child as t.Node, visit);
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      walk(value as t.Node, visit);
    }
  }
}

/** 收集所有 `applyZaiModelOverrideForRoute(...)` 调用。 */
function collectModelOverrideCalls(root: t.Node | null): t.CallExpression[] {
  const calls: t.CallExpression[] = [];
  walk(root, (node) => {
    if (
      t.isCallExpression(node)
      && t.isIdentifier(node.callee)
      && node.callee.name === 'applyZaiModelOverrideForRoute'
    ) {
      calls.push(node);
    }
  });
  return calls;
}

/**
 * 找出被**模式相关**的 `if (...)` 包住的调用。
 *
 * 判据是 `if` 的**条件里引用了模式标识**（`isAgentTurn` / `isAgentTurnByRequestId` /
 * 任何名字里含 `isAgent` 的标识符）—— 那才是「按模式分叉」的门。
 *
 * ⚠️⚠️ **不能把所有 `if` 都算成门** —— 第一版就是这么写的，结果把
 * `if (route === 'chatNew') { … }`（路由分支）与 `if (parsedBody) { … }`
 * （解析成功才写）也算成违规 ⇒ **基线就红**，是假红（守则 B11 同族）。
 * 真正的缺陷形态只有一种：`if (!isAgentTurn) { apply… }`。
 *
 * 三种包裹形态都要认：
 *   - `if (X) f();`          —— consequent 直接是那条调用的 `ExpressionStatement`
 *   - `if (X) { f(); }`      —— consequent 是 `BlockStatement`，调用在里面
 *   - `if (X) { … f(); … }`  —— 块里还有别的语句，同样算「被这个 if 挡住」
 * `alternate` 与 `test` 不参与。
 */
function findCallsUnderModeIf(root: t.Node): Set<t.CallExpression> {
  const guarded = new Set<t.CallExpression>();

  const referencesModeFlag = (test: t.Node): boolean => {
    let hit = false;
    walk(test, (node) => {
      if (t.isIdentifier(node) && /isAgent/i.test(node.name)) hit = true;
    });
    return hit;
  };

  walk(root, (node) => {
    if (!t.isIfStatement(node)) return;
    if (!referencesModeFlag(node.test)) return;
    const collect = (statement: t.Node | null | undefined): void => {
      if (!statement) return;
      if (t.isExpressionStatement(statement)) {
        const expression = statement.expression;
        if (t.isCallExpression(expression)) guarded.add(expression);
        return;
      }
      if (t.isBlockStatement(statement)) {
        for (const child of statement.body) collect(child);
        return;
      }
      if (t.isIfStatement(statement)) collect(statement.consequent);
    };
    collect(node.consequent);
  });

  return guarded;
}

describe('model override call sites are not gated by mode', () => {
  it('has exactly three applyZaiModelOverrideForRoute call sites', () => {
    // 三处 = chatNew / 原生轮 completion / 续跑轮。数量变化要么是新增落点、
    // 要么是删了一处 —— 两种都该让这条红一次，逼人回来看。
    expect(collectModelOverrideCalls(readProgram())).toHaveLength(3);
  });

  it('none of them is wrapped in a mode-related if statement', () => {
    const program = readProgram();
    const guarded = findCallsUnderModeIf(program);
    const modelCalls = collectModelOverrideCalls(program);
    const offending = modelCalls.filter((call) => guarded.has(call));
    expect(
      offending.length,
      '模型覆写调用点不能再被模式相关的 if 包住（曾经是 if (!isAgentTurn)，agent 下会静默失效）',
    ).toBe(0);
  });

  it('no longer declares a mode-derived modelOverrideEnabled flag', () => {
    // 续跑轮那处曾用 `const modelOverrideEnabled = continuationLoop?.isAgentTurn !== true`
    // 同时决定「要不要 parse body」与「要不要写 model」。删掉它之后不该再出现。
    expect(SOURCE.includes('modelOverrideEnabled')).toBe(false);
  });

  it('does not reintroduce the disproven "agent assembles its own model" comment', () => {
    // 注释里那个前提已被真机推翻，别再写回去（`zai-code-guardrails` C2：作废要留痕，
    // 但留痕指的是「记录它作废了」，不是把结论原样贴回来）。
    expect(SOURCE.includes('agent 轮不碰')).toBe(false);
    expect(SOURCE.includes('agent 模式不碰')).toBe(false);
  });
});
