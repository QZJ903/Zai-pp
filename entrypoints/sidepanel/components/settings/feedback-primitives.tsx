import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';

export function StatusMessage({
  tone,
  children,
  onDismiss,
}: {
  tone: 'success' | 'error' | 'warning' | 'info';
  children: ReactNode;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const palette = {
    success: { color: 'var(--ds-success)', bg: 'var(--ds-success-bg)' },
    error: { color: 'var(--ds-danger)', bg: 'var(--ds-danger-bg)' },
    warning: { color: 'var(--ds-warning, var(--ds-text-secondary))', bg: 'var(--ds-warning-bg, var(--ds-surface))' },
    info: { color: 'var(--ds-text-secondary)', bg: 'var(--ds-surface)' },
  }[tone];
  return (
    <div
      className="text-[11px] px-3 py-2 flex items-start gap-2"
      style={{ color: palette.color, background: palette.bg, border: '1px solid var(--ds-border)', borderRadius: 'var(--radius-ctrl)' }}
    >
      <div className="flex-1 min-w-0">{children}</div>
      {onDismiss && (
        // ⚠️ **`lineHeight: 'inherit'` 不能改成 `leading-none`（或任何固定行高）**。
        // 容器是 `items-start` ⇒ 按钮与正文的**顶边**对齐，而正文的行盒高度由
        // `html,:host` 的 `line-height: 1.5` 决定（11px 字号 ⇒ 16.5px 行盒，
        // 字形在其中垂直居中，上下各留 ~2.75px）。按钮若把行高压到 1，
        // 它的字形就顶在行盒最上沿 ⇒ **× 比正文首行高约 2.75px**，看起来"浮"在上面。
        // 继承同一个行高后两者行盒等高，× 才与首行文字齐平。
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.close')}
          className="shrink-0 opacity-60 hover:opacity-100"
          style={{ color: palette.color, lineHeight: 'inherit' }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * In-app confirm dialog that replaces window.confirm() so destructive actions
 * stay within the extension UI and preserve keyboard focus handling.
 */
export function useConfirm() {
  // 只存渲染用的四段文案。resolver **不**放这里 —— 它由 `pendingRef` 独占，
  // 两份 resolver 并存会让后来的人在其中一处「修」出分叉。
  const [state, setState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  } | null>(null);
  /**
   * 当前那个还没被回答的确认框的 resolver。
   *
   * ⚠️ 没有它的话，第二次 `confirm()` 会把 state 整个覆盖掉 —— 第一个 Promise 的
   * resolver 就此丢失，那个 `await confirm(...)` **永远挂着**，调用方 `await` 之后的
   * 清理动作（清 loading、删 sourceActions 条目）也就永远不跑。
   * 顶掉前一个时以「取消」收尾：用户显然已经转向另一个操作了。
   */
  const pendingRef = useRef<((ok: boolean) => void) | null>(null);
  useEffect(() => () => {
    // 卸载时也要收尾，否则挂着的 await 一样不停。
    pendingRef.current?.(false);
    pendingRef.current = null;
  }, []);

  const confirm = (options: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  }) => new Promise<boolean>((resolve) => {
    pendingRef.current?.(false);
    pendingRef.current = resolve;
    setState(options);
  });

  const settle = (ok: boolean) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    resolve?.(ok);
    setState(null);
  };

  const node = state ? (
    <ConfirmDialog
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  ) : null;

  return { confirm, node };
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // 认领这个键：让其它挂在 window 上的监听（更新公告浮层）看出「Esc 已被对话框
        // 消费掉了」，不要再跟着关一次。
        event.preventDefault();
        onCancel();
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // ⚠️ **必须走捕获阶段**：这个对话框与更新公告浮层都挂在 `window` 上，而同一个
    // EventTarget 上的监听按**注册顺序**调用 —— 公告是 App 启动时挂的，bubble 阶段的
    // 这里永远是第二个跑，看不到「已被消费」。捕获阶段保证它先跑，与注册顺序无关。
    // 效果：一次 Esc 只关对话框，不会顺手把公告永久标记为已读。
    //
    // ⚠️ 清理处必须带同样的 `true` —— capture 标志是 `removeEventListener` 的匹配条件，
    // 漏了它监听删不掉。
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div
      className="ds-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ds-confirm-title"
      onClick={onCancel}
    >
      <div ref={dialogRef} className="ds-modal-card" onClick={(event) => event.stopPropagation()}>
        <h3 id="ds-confirm-title" className="ds-modal-title">{title}</h3>
        <p className="ds-modal-message">{message}</p>
        <div className="ds-modal-actions">
          <button
            type="button"
            className="ds-btn-cancel px-3 py-2 text-[11px] font-medium"
            style={{ borderRadius: 'var(--radius-ctrl)' }}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="ds-btn-danger px-3 py-2 text-[11px] font-medium"
            style={{ borderRadius: 'var(--radius-ctrl)' }}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
