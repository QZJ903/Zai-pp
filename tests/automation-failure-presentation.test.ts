import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  automationErrorKey,
  formatAutomationError,
} from '../entrypoints/sidepanel/automation-error-message';
import { createTranslator } from '../core/i18n';
import { decodeAutomationStorageState } from '../core/automation/storage-codec';

/**
 * 自动化失败的**呈现层契约**。
 *
 * 两条独立的东西合在一个文件里，因为它们共同构成「失败信息怎么到用户眼前」：
 *  ① `formatAutomationError` 的三级回退（错误码 → 文案 / 英文句子原样 / 裸码套通用文案）
 *  ② 失败记录的 `phase` **宽容读回**（不认识的档位归 `unknown`，不判 corrupt）
 *
 * ⚠️ 这两条都是**静默失效**型的：没有测试时，改坏了也不会红 ——
 * ① 改坏了用户看到 `composer_inject_failed`（正是本次要修的表现）；
 * ② 改坏了升级后整份自动化存储抛 `AutomationStorageContractError`、全部任务打不开。
 */

const t = createTranslator('zh-CN').t;

function failure(code: string, message: string) {
  return { code, message };
}

describe('formatAutomationError', () => {
  it('translates a mapped error code instead of showing the raw identifier', () => {
    const text = formatAutomationError(
      failure('dom_automation_composer_inject_failed', 'composer_inject_failed'),
      t,
    );

    expect(text).not.toContain('composer_inject_failed');
    expect(text).toContain('输入框');
  });

  it('covers every code the page-execution chain can produce', () => {
    // ⚠️ 这份清单来自实测的发送点，不是照抄类型 —— 见
    // `entrypoints/zai.content.ts` 的 `ok: false, error:` 与
    // `core/zai/dom-task-coordinator.ts` 的 handshake 拒绝分支。
    // 带 `dom_automation_` 前缀是 `background.ts` 拼的。
    const pageCodes = [
      'dom_automation_failed',
      'dom_automation_composer_inject_failed',
      'dom_automation_no_textarea',
      'dom_automation_prompt_input_not_found',
      'dom_automation_form_not_connected',
      'dom_automation_agent_not_idle',
      'dom_automation_busy',
      'dom_automation_wrong_conversation',
      'dom_automation_dom_task_handshake_timeout',
      // 该标签页里没有活着的内容脚本（扩展重载后的孤儿页面）。
      // ⚠️ 与上一条分开：那个说「页面没应答」，这个说「页面里没有我们的脚本」。
      'dom_automation_dom_task_content_script_missing',
      'dom_automation_cancelled',
      'dom_automation_continuation_loop_missing',
      'dom_automation_continuation_loop_superseded',
      'dom_automation_continuation_session_id_missing',
      // 续跑这一发「没拿到发出证据」—— 可能已发出、也可能没有。
      // ⚠️ 与 `continuation_loop_missing` / `superseded` 不同：那两个说「循环没了」，
      // 这个说「循环还在但这一发可能没出去」，用户能做的事不同（后者该先看对话再重试）。
      'dom_automation_continuation_send_unconfirmed',
      'dom_automation_no_current_conversation',
      'dom_automation_missing_task_id_or_prompt',
      'dom_automation_empty_prompt_text',
      'dom_automation_task_already_registered',
      // 协调器的两个兜底字面量（`record.error ?? 'dom_task_rejected'` /
      // `event.error || 'dom_task_failed'`）经前缀拼装后的形状。
      // ⚠️ **它们可达但概率低**（见映射表里的说明），补上是为了给出可诊断的那一句，
      // 不是因为有真实流量命中。**加这条断言是为了「将来有人把兜底字面量改名时不静默」**。
      'dom_automation_dom_task_rejected',
      'dom_automation_dom_task_failed',
    ];
    for (const code of pageCodes) {
      expect(automationErrorKey(code), `${code} 应当有文案`).not.toBeNull();
    }
  });

  it('keeps the coordinator fallback literals in sync with the map', () => {
    // ⚠️ 这条守的是**生产端与判定端同源**：映射表里的键是「`dom_automation_` + 协调器的兜底字面量」
    // 拼出来的，而那两个字面量写在 `dom-task-coordinator.ts` 里。
    // 协调器若改了名，映射表不会报错 —— 只会**静默退回通用文案**。
    // 所以直接读源码断言那两个字面量仍在（它们就是键名的来源）。
    const source = readFileSync(
      resolve(process.cwd(), 'core/zai/dom-task-coordinator.ts'),
      'utf8',
    );

    expect(source).toContain("?? 'dom_task_rejected'");
    expect(source).toContain("|| 'dom_task_failed'");
    // 「该页面里没有活着的内容脚本」也是裸字面量，同样经 `dom_automation_` 前缀拼装。
    expect(source).toContain("'dom_task_content_script_missing'");
  });

  it('covers the scheduler and reconcile codes too', () => {
    // 这几条上游是英文句子（`Automation run exceeded 300 seconds.`），
    // 中文界面下同样该被覆盖 —— 它们才是「另一半」。
    for (const code of [
      'automation_run_timeout',
      'automation_run_cancelled',
      'automation_run_lease_lost',
      'automation_executor_failed',
      'automation_run_interrupted',
    ]) {
      expect(automationErrorKey(code), `${code} 应当有文案`).not.toBeNull();
    }
  });

  it('covers every schedule validation code', () => {
    for (const code of [
      'schedule_too_frequent',
      'schedule_too_sparse',
      'cron_no_next_run',
      'invalid_cron',
      'invalid_cron_field',
      'invalid_cron_range',
      'invalid_cron_step',
      'invalid_rrule',
      'invalid_rrule_frequency',
      'invalid_rrule_interval',
      'unsupported_rrule_part',
      'unsupported_schedule',
      'missing_expression',
      'invalid_timezone',
    ]) {
      expect(automationErrorKey(code), `${code} 应当有文案`).not.toBeNull();
    }
  });

  it('keeps a human-written message instead of replacing it with a generic one', () => {
    // 没映射但 message 是自然语言 ⇒ **原样用**。换成通用文案是信息降级。
    const text = formatAutomationError(
      failure('some_future_code', 'Automation run exceeded 300 seconds.'),
      t,
    );

    expect(text).toBe('Automation run exceeded 300 seconds.');
  });

  it('wraps an unmapped raw identifier so the user never sees a snake_case token alone', () => {
    // 没映射、message 又是裸码 ⇒ 套通用文案 + 把码附在里面（便于报障时对上日志）
    const text = formatAutomationError(
      failure('some_future_code', 'brand_new_failure_mode'),
      t,
    );

    expect(text).not.toBe('brand_new_failure_mode');
    expect(text).toContain('brand_new_failure_mode');
    expect(text).toContain('运行失败');
  });

  it('treats a single lowercase word as a code, not as prose', () => {
    // 边界：「一个词、没有下划线」既不是句子也不是典型蛇形码 —— 按码处理（套通用文案）。
    const text = formatAutomationError(failure('unmapped', 'cancelled'), t);

    expect(text).not.toBe('cancelled');
    expect(text).toContain('cancelled');
  });

  it('passes through a message that merely contains underscores but reads as prose', () => {
    // 句子里的下划线不该让整句被当成码
    const text = formatAutomationError(
      failure('unmapped', 'Failed to reach chat_session endpoint.'),
      t,
    );

    expect(text).toBe('Failed to reach chat_session endpoint.');
  });
});

describe('failure phase tolerant read-back', () => {
  const baseState = (phase: unknown) => ({
    version: 1,
    automations: [
      {
        id: 'automation-1',
        name: 'Tolerant',
        prompt: 'Run.',
        status: 'active',
        schedule: { kind: 'manual', expression: null, timezone: 'UTC', enabled: false, minimumIntervalMinutes: 0 },
        promptOptions: { model: null, fixedSession: false },
        zai: { chatSessionId: null, sessionUrl: null },
        createdAt: 1,
        updatedAt: 1,
        lastRunAt: null,
        nextRunAt: null,
        lastError: { code: 'legacy', message: 'legacy', phase, retryable: false, at: 1 },
        version: 1,
      },
    ],
    runs: [],
  });

  it('maps a phase this version no longer knows to unknown instead of failing the whole store', () => {
    // ⚠️ 这是**升级场景**：上游那六档（auth/session/pow/completion/history/storage）
    // 在本项目被删了，而已落库的旧记录不会跟着改。判 corrupt 会让**全部任务打不开**。
    for (const legacy of ['auth', 'session', 'pow', 'completion', 'history', 'storage']) {
      const decoded = decodeAutomationStorageState(baseState(legacy));
      expect(decoded.automations[0]!.lastError?.phase, `${legacy} 应归 unknown`).toBe('unknown');
    }
  });

  it('keeps every phase this version does know', () => {
    for (const known of ['schedule', 'tab', 'bridge', 'runner', 'cancelled', 'unknown']) {
      const decoded = decodeAutomationStorageState(baseState(known));
      expect(decoded.automations[0]!.lastError?.phase).toBe(known);
    }
  });

  it('still rejects a non-string phase as corrupt data', () => {
    // 宽容只针对「我们不认识的字符串」（版本差异）；数字 / 对象是真的数据损坏。
    expect(() => decodeAutomationStorageState(baseState(7))).toThrow();
    expect(() => decodeAutomationStorageState(baseState({ kind: 'pow' }))).toThrow();
  });
});