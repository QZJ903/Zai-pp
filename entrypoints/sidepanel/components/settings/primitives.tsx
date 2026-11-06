import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { StatusMessage } from './feedback-primitives';

export { StatusMessage, useConfirm } from './feedback-primitives';

/**
 * Shared building blocks for the settings sub-pages.
 *
 * These replace the hand-copied toggle/slider/section/status markup that was
 * duplicated across SettingsPage and PromptControlPanel so
 * every settings surface looks and behaves identically.
 */

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div className="space-y-0.5">
        <h2 className="ds-settings-section-title">{title}</h2>
        {description && (
          <p className="ds-settings-section-description">{description}</p>
        )}
      </div>
      <div className="ds-surface-panel p-4 space-y-3">{children}</div>
    </section>
  );
}

export function ToggleRow({
  title,
  description,
  enabled,
  disabled,
  onToggle,
  trailing,
}: {
  title: string;
  description?: string;
  enabled: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex justify-between items-center gap-3">
      <div className="min-w-0">
        <div className="text-xs font-medium" style={{ color: 'var(--ds-text)' }}>
          {title}
        </div>
        {description && (
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--ds-text-tertiary)' }}>
            {description}
          </div>
        )}
        {trailing}
      </div>
      <button
        type="button"
        onClick={() => !disabled && onToggle(!enabled)}
        disabled={disabled}
        aria-pressed={enabled}
        className="ds-switch relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200 disabled:opacity-40"
        style={{ background: enabled ? 'var(--ds-blue)' : 'var(--ds-border)' }}
      >
        <span
          className="ds-switch-thumb absolute top-[3px] left-[3px] w-4 h-4 rounded-full transition-transform duration-200"
          style={{ transform: enabled ? 'translateX(18px)' : 'translateX(0)' }}
        />
      </button>
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  format,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  format?: (value: number) => string;
  /**
   * 每次 `input` 触发 —— 拖动时每过一格就一次。只在调用方**不落库**时用。
   *
   * ⚠️ range 控件拖动过程中每格发 `input`，`change` 只在松手时发一次。
   */
  onChange?: (value: number) => void;
  /**
   * 松手（或键盘步进）时触发一次 —— 落库走这个。
   *
   * 返回 Promise 时，落库期间滑块保持松手位置；reject 会丢掉草稿值、回弹到已存的值。
   */
  onCommit?: (value: number) => void | Promise<void>;
}) {
  const inputId = useId();
  // 只提交的滑块要留一份草稿，否则松手前 `value` 不会变、滑块拖不动。
  // 草稿在松手后释放：万一保存失败，滑块回弹到库里真正存着的值，
  // 而不是停在一个从未写入过的数字上。
  const [draft, setDraft] = useState<number | null>(null);
  const shown = onCommit ? (draft ?? value) : value;
  const pct = ((shown - min) / (max - min)) * 100;
  const commitRef = useRef<HTMLInputElement | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // 落库的值追上来之后释放草稿，免得成功时闪一帧旧值。
  useEffect(() => {
    if (draft !== null && draft === value) setDraft(null);
  }, [draft, value]);
  // `onCommit` 被撤掉时也要释放：那时 `shown` 已经回到 `value`，草稿留着只会在
  // 下次把 `onCommit` 加回来时先显示一帧旧数字。
  useEffect(() => {
    if (!onCommit) setDraft(null);
  }, [onCommit]);
  // React 的 `onChange` 对 range 就是原生 `input`，原生 `change`（松手一次）只能直接挂。
  useEffect(() => {
    const el = commitRef.current;
    if (!el || !onCommit) return;
    const commit = () => {
      const committed = parseFloat(el.value);
      const result = onCommitRef.current?.(committed);
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => setDraft(null));
      }
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, [onCommit]);
  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <label htmlFor={inputId} className="text-[11px]" style={{ color: 'var(--ds-text-secondary)' }}>
          {label}
        </label>
        <span className="text-[11px] font-mono" style={{ color: 'var(--ds-text-tertiary)' }}>
          {format ? format(shown) : shown}
        </span>
      </div>
      <input
        id={inputId}
        ref={commitRef}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        onChange={(e) => {
          const next = parseFloat(e.target.value);
          if (onCommit) setDraft(next);
          onChange?.(next);
        }}
        className="ds-range w-full h-1.5 rounded-full appearance-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
        style={{
          background: `linear-gradient(to right, var(--ds-blue) ${pct}%, var(--ds-border) ${pct}%)`,
        }}
      />
    </div>
  );
}

/**
 * Tab strip that replaces the hand-rolled `sub-tabs`/`sub-tab` markup in
 * LibraryPage / CapabilitiesPage / SettingsPage. Adds the ARIA tab semantics
 * (`role="tablist"`/`role="tab"`/`aria-selected`) and left/right keyboard
 * navigation that the duplicated markup was missing.
 *
 * When the strip overflows its container, chevron buttons appear at the
 * edges (hidden while there is nothing to scroll in that direction):
 * clicking scrolls by roughly the visible width, the active tab is kept in
 * view on selection/keyboard change, and arrow visibility is recomputed on
 * resize and when the tab set or its labels change. Reduced-motion users
 * get instant scrolling instead of smooth animation.
 */
export function SubTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  // Stable key for the tab set: label changes (e.g. locale switch) or a
  // different tab count re-run the layout effects without depending on the
  // identity of the caller-provided array.
  // ⚠️ `key` 也要进去：只按 label 拼的话，「文案相同、key 不同」的集合（例如两种语言
  // 下恰好同名的项）不会让 key 变化 ⇒ 布局 effect 不重算。
  const tabsKey = tabs.map((tab) => `${tab.key}\u0001${tab.label}`).join('\u0000');

  const updateArrows = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    updateArrows();
    const el = listRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateArrows);
    observer.observe(el);
    el.addEventListener('scroll', updateArrows, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateArrows);
    };
  }, [updateArrows, tabsKey]);

  // Keep the selected tab fully visible when the selection changes or the
  // tab set is rebuilt (labels/locale), scrolling the strip the minimum
  // amount needed.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (left < el.scrollLeft) {
      el.scrollTo({ left, behavior });
    } else if (right > el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: right - el.clientWidth, behavior });
    }
    updateArrows();
  }, [value, tabsKey, updateArrows]);

  /**
   * Roving focus. Arrow keys must MOVE FOCUS, not just the selection: `tabIndex` is
   * driven by `value`, but React does not move DOM focus when it flips, so a
   * selection-only handler leaves the focus ring on the old tab. The next keypress then
   * reads the OLD tab's index again — pressing Right a second time recomputes the same
   * target and does nothing, while Left jumps to the last tab.
   *
   * Focus has to move inside this event rather than from an effect on `value`: two
   * presses batched into one render would make such an effect fire only once.
   */
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const isRight = e.key === 'ArrowRight';
    const isLeft = e.key === 'ArrowLeft';
    const isEdge = e.key === 'Home' || e.key === 'End';
    if (!isRight && !isLeft && !isEdge) return;
    e.preventDefault();
    const next = isEdge
      ? (e.key === 'Home' ? 0 : tabs.length - 1)
      : isRight
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
    onChange(tabs[next].key);
    // `preventScroll` keeps the layout effect above as the single owner of scrolling.
    const buttons = listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
    buttons?.[next]?.focus({ preventScroll: true });
  };

  const scrollByPage = (direction: 1 | -1) => {
    const el = listRef.current;
    if (!el) return;
    const amount = Math.max(el.clientWidth * 0.7, 120);
    el.scrollBy({ left: direction * amount, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <div className="sub-tabs-shell">
      <button
        type="button"
        className="sub-tabs-arrow sub-tabs-arrow-left"
        aria-label={t('sidepanel.subTabs.scrollLeft')}
        disabled={!canScrollLeft}
        tabIndex={-1}
        onClick={() => scrollByPage(-1)}
      >
        <svg className="sub-tabs-arrow-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <nav ref={listRef} className="sub-tabs" aria-label={ariaLabel} role="tablist">
        {tabs.map((tab, index) => {
          const active = tab.key === value;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={`sub-tab${active ? ' sub-tab-active' : ''}`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        className="sub-tabs-arrow sub-tabs-arrow-right"
        aria-label={t('sidepanel.subTabs.scrollRight')}
        disabled={!canScrollRight}
        tabIndex={-1}
        onClick={() => scrollByPage(1)}
      >
        <svg className="sub-tabs-arrow-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Single-select chip group (radio semantics) for compact choices like memory
 * type filters, transport kinds, saved-item kind. Replaces the bespoke pill
 * rows that were duplicated across MemoryPage / MemoryForm / SavedPage / McpPage.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  disabled = false,
}: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const padding = size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1.5 text-[11px]';
  const groupRef = useRef<HTMLDivElement | null>(null);
  // Same contract as SubTabs: one Tab stop for the whole group, and the arrow keys move
  // focus AND selection (radio semantics, per ARIA's Radio Group pattern). Without the
  // roving tabIndex every option is tabbable, so Tab walks through all of them.
  const onKeyDown = (e: React.KeyboardEvent, index: number) => {
    const isForward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const isBackward = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    const isEdge = e.key === 'Home' || e.key === 'End';
    if (!isForward && !isBackward && !isEdge) return;
    e.preventDefault();
    const next = isEdge
      ? (e.key === 'Home' ? 0 : options.length - 1)
      : isForward
        ? (index + 1) % options.length
        : (index - 1 + options.length) % options.length;
    onChange(options[next].key);
    groupRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div ref={groupRef} className="ds-segmented flex flex-wrap gap-1.5" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option, index) => {
        const active = option.key === value;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, index)}
            disabled={disabled}
            onClick={() => onChange(option.key)}
            className={`${padding} font-medium border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50`}
            style={{
              borderRadius: 'var(--radius-ctrl)',
              background: active ? 'var(--ds-blue)' : 'transparent',
              color: active ? 'var(--ds-text-on-primary)' : 'var(--ds-text-secondary)',
              borderColor: active ? 'var(--ds-blue)' : 'var(--ds-border)',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Unified empty state. Replaces `ds-empty-state` hand-usage and the bespoke
 * inline `text-[11px]` boxes that each page used to hand-roll.
 */
export function EmptyState({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="ds-empty-state">
      <div className="ds-empty-state-icon">
        {icon ?? (
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0H4" />
          </svg>
        )}
      </div>
      <p className="ds-empty-state-title">{title}</p>
      {description && <p className="ds-empty-state-description">{description}</p>}
      {actions && <div className="flex flex-wrap gap-2 justify-center mt-1">{actions}</div>}
    </div>
  );
}

/**
 * Loading skeleton bar. Used for first-paint placeholders on every page that
 * runs `load()` on mount, so the list area never flashes blank or shows a
 * false empty-state while data is in flight.
 */
export function Skeleton({ className = '', width }: { className?: string; width?: string }) {
  return (
    <div
      className={`ds-skeleton rounded ${className}`}
      style={width ? { width } : undefined}
    />
  );
}

/** A vertical stack of skeleton rows for list placeholders. */
export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="ds-surface-panel p-3 space-y-2">
          <Skeleton className="h-3" width="60%" />
          <Skeleton className="h-2.5" width="85%" />
        </div>
      ))}
    </div>
  );
}

/** Metric cell — a labeled value tile. Promoted from 4 duplicated definitions. */
export function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2" style={{ background: 'var(--ds-bg)', border: '1px solid var(--ds-border)' }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--ds-text-tertiary)' }}>{label}</div>
      <div className="mt-0.5 truncate text-[12px] font-mono" style={{ color: 'var(--ds-text)' }}>{value}</div>
    </div>
  );
}

/** Small inline spinner. Promoted from 2 duplicated definitions + ad-hoc markup. */
export function Spinner({ className = 'w-3 h-3', label }: { className?: string; label?: string }) {
  const { t } = useI18n();
  return (
    <span
      className={`inline-block border-2 border-current border-t-transparent rounded-full animate-spin ${className}`}
      role="status"
      aria-label={label ?? t('common.loading')}
    />
  );
}

/**
 * Banner state hook: a single transient message with tone + auto-dismiss.
 * Lifted from McpPage's `dismissTimer` pattern so every page can show a
 * success banner that fades after `dismissMs` while errors stay until cleared.
 */
export function useBanner(dismissMs = 4000) {
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'warning' | 'info'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时把定时器清掉。React 18 对已卸载组件的 setState 是 no-op，所以这不是「修 bug」，
  // 是为了与 `useMcpPageController` 里那份同款 `dismissTimer` 保持同一个口径 ——
  // 一个清一个不清，下次改的人不知道该照哪个抄。
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const show = (tone: 'success' | 'error' | 'warning' | 'info', text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setBanner({ tone, text });
    if (tone === 'success') {
      timer.current = setTimeout(() => setBanner(null), dismissMs);
    }
  };
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    setBanner(null);
  };

  const node = banner ? (
    <StatusMessage tone={banner.tone} onDismiss={clear}>
      {banner.text}
    </StatusMessage>
  ) : null;

  return { banner, show, clear, node };
}
