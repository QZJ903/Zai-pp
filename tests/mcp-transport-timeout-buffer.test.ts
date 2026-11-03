import { describe, expect, it } from 'vitest';
import { resolveMcpTransportTimeoutMs } from '../core/mcp/discovery';
import { MCP_DEFAULT_TIMEOUTS } from '../core/mcp/constants';

/**
 * **传输层超时必须早于外层运行时超时到期。**
 *
 * ⚠️⚠️ 这条守的是一个「错误码被遮蔽」的缺陷形态：
 * `core/tool/runtime.ts` 的 `executeWithTimeout` 在 `providerRegistry.execute(...)`
 * **之前**就建 `AbortScope`，而 MCP 在 `transports/common.ts` 的 `fetchWithTimeout` 里
 * 又建一个，**时长同值**（描述符的 `execution.timeoutMs` 就是 `server.timeouts.requestMs`）。
 * 同值定时器先建者先到期 ⇒ 外层赢；而 `common.ts` 的 catch **第一个分支**是
 * `if (callerSignal?.aborted) throwSignalReason(callerSignal)`
 * ⇒ 内层根本走不到 `mcp_transport_timeout`，那个 `retryable: true` 也一起丢掉。
 *
 * ⇒ 传输层拿到的时长必须**严格小于**外层那一档。
 */
describe('MCP transport timeout leaves room for the inner timer to fire first', () => {
  it('always returns strictly less than the outer budget', () => {
    // ⚠️ **锚点取生产默认值，不自己编** —— 用 60_000 这种真实量级才看得出缓冲的量级对不对。
    for (const budget of [
      MCP_DEFAULT_TIMEOUTS.requestMs,
      120_000, // Shell Local 的 requestMs
      65_000,  // browser_wait_for
      10_000,  // browser_* 其余
      5_000,
    ]) {
      const transport = resolveMcpTransportTimeoutMs(budget);
      expect(transport, `预算 ${budget}：传输层必须严格更短`).toBeLessThan(budget);
      // 反向：不能短太多 —— 缓冲是 500ms 量级，不是把预算砍半。
      expect(budget - transport, `预算 ${budget}：缓冲不该超过 1 秒`).toBeLessThanOrEqual(1_000);
    }
  });

  it('keeps a floor so tiny declared timeouts do not collapse', () => {
    // ⚠️ 描述符声明了很小的超时（< 1.5 秒）时，直接减 500 会贴地甚至变负。
    // 现在取地板 1 秒 —— **这一档是「内层晚于外层」的已知例外**，理由是
    // 小于 1 秒的 MCP 调用本来就没有实际意义（initialize 的 connectMs 是 1 秒起）。
    expect(resolveMcpTransportTimeoutMs(1_400)).toBe(1_000);
    expect(resolveMcpTransportTimeoutMs(1_000)).toBe(1_000);
    expect(resolveMcpTransportTimeoutMs(200)).toBe(1_000);
  });

  it('uses exactly one half-second step above the floor', () => {
    // 钉住「缓冲就是 500ms」这个量级 —— 改成 100ms 或 2000ms 要能看出来是有意改的。
    expect(resolveMcpTransportTimeoutMs(2_000)).toBe(1_500);
    expect(resolveMcpTransportTimeoutMs(MCP_DEFAULT_TIMEOUTS.requestMs)).toBe(
      MCP_DEFAULT_TIMEOUTS.requestMs - 500,
    );
  });
});
