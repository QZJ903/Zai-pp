import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import type { UsageModelSummary, UsageRangeDays, UsageSummary } from '../../../../core/types';
import { createZaiModelLabelLookup, decodeZaiModelListResponse } from '../../../../core/zai/models';
import { createRequestGenerationFence } from '../../async-state';
import { usageController } from '../../controllers/usage-controller';
import { useI18n } from '../../i18n';
import { formatRuntimeError } from '../../runtime-response';
import { SidepanelRuntimeError, sidepanelRuntimeClient } from '../../runtime-client';
import {
  EmptyState,
  SegmentedControl,
  SkeletonList,
  StatusMessage,
  useBanner,
  useConfirm,
} from './primitives';

type RangeKey = '7' | '30';

const MODEL_COLORS = [
  'var(--ds-blue)',
  'var(--ds-success)',
  'var(--ds-warning)',
  'var(--ds-purple)',
  'var(--ds-danger)',
  'var(--ds-info)',
];

export default function UsageSubPage() {
  const { t, locale } = useI18n();
  const [rangeKey, setRangeKey] = useState<RangeKey>('30');
  const [summaries, setSummaries] = useState<Partial<Record<RangeKey, UsageSummary>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(createRequestGenerationFence());
  const rangeKeyRef = useRef(rangeKey);
  rangeKeyRef.current = rangeKey;
  const { confirm, node: confirmNode } = useConfirm();
  const banner = useBanner();
  // 模型 id → 显示名。用量记录里存的是接口 id（如 `x-preview-l`），
  // 直接渲染会把内部 id 显示给用户。清单由后台带 5 分钟缓存与内置兜底。
  const [modelLabel, setModelLabel] = useState<(id: string | null | undefined) => string | null>(
    () => () => null,
  );

  const summary = summaries[rangeKey] ?? null;
  const rangeOptions = useMemo(() => [
    { key: '7' as const, label: t('sidepanel.settings.usage.last7Days') },
    { key: '30' as const, label: t('sidepanel.settings.usage.last30Days') },
  ], [t]);

  const load = useCallback(async (requestedRangeKey: RangeKey) => {
    const generation = requestGeneration.current.begin();
    const requestedRangeDays = Number(requestedRangeKey) as UsageRangeDays;
    setLoading(true);
    setError(null);
    try {
      const result = await usageController.getSummary(requestedRangeDays);
      if (!requestGeneration.current.isCurrent(generation)) return;
      setSummaries((current) => ({ ...current, [requestedRangeKey]: result }));
    } catch (err) {
      if (!requestGeneration.current.isCurrent(generation)) return;
      setError(
        err instanceof SidepanelRuntimeError && err.kind === 'protocol'
          ? t('sidepanel.settings.usage.loadFailed')
          : formatRuntimeError(err, t) || t('sidepanel.settings.usage.loadFailed'),
      );
    } finally {
      if (requestGeneration.current.isCurrent(generation)) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(rangeKey);
    return () => requestGeneration.current.invalidate();
  }, [load, rangeKey]);

  // 模型显示名：挂载时拉一次清单（后台带 5 分钟缓存）。
  // ⚠️ **失败一律静默** —— 这只是显示层的锦上添花，拿不到清单就退回记录里原有的
  // `modelLabel`（即原始 id），不该因此给用量面板挂一条错误横幅。
  useEffect(() => {
    let cancelled = false;
    void sidepanelRuntimeClient
      .request(
        { type: 'GET_ZAI_MODELS' },
        { decode: (value) => decodeZaiModelListResponse(value, 'GET_ZAI_MODELS response') },
      )
      .then((list) => {
        if (cancelled) return;
        const lookup = createZaiModelLabelLookup(list.models);
        setModelLabel(() => lookup);
      })
      .catch(() => {
        /* 拿不到清单就用原始 id，见上 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const clearStats = async () => {
    const ok = await confirm({
      title: t('sidepanel.settings.usage.clearStats'),
      message: t('sidepanel.settings.usage.clearConfirm'),
      confirmLabel: t('sidepanel.settings.usage.clearStats'),
      cancelLabel: t('common.cancel'),
    });
    if (!ok) return;

    try {
      await usageController.clear();
      requestGeneration.current.invalidate();
      setSummaries({});
      banner.show('success', t('sidepanel.settings.usage.clearSuccess'));
      await load(rangeKeyRef.current);
    } catch (err) {
      banner.show('error', formatRuntimeError(err, t) || t('sidepanel.settings.usage.clearFailed'));
    }
  };

  const hasUsage = Boolean(summary && summary.turnCount > 0);

  return (
    <div className="usage-dashboard space-y-4">
      {confirmNode}
      {banner.node}

      <div className="usage-toolbar">
        <div className="min-w-0">
          <div className="usage-toolbar-label">{t('sidepanel.settings.usage.rangeLabel')}</div>
          <SegmentedControl
            options={rangeOptions}
            value={rangeKey}
            onChange={setRangeKey}
            ariaLabel={t('sidepanel.settings.usage.rangeLabel')}
            size="sm"
          />
        </div>
        {hasUsage && (
          <button
            type="button"
            className="ds-btn-cancel usage-clear-button"
            onClick={clearStats}
          >
            {t('sidepanel.settings.usage.clearStats')}
          </button>
        )}
      </div>

      {error && <StatusMessage tone="error">{error}</StatusMessage>}

      {loading && !summary ? (
        <SkeletonList rows={4} />
      ) : !summary ? null : !hasUsage ? (
        <EmptyState
          title={t('sidepanel.settings.usage.emptyTitle')}
          description={t('sidepanel.settings.usage.emptyDescription')}
        />
      ) : (
        <>
          <UsageMetricGrid summary={summary} locale={locale} modelLabel={modelLabel} />
          <UsageHeatmap summary={summary} locale={locale} />
          <UsageDailyTrend summary={summary} locale={locale} />
          <UsageModelSplit summary={summary} locale={locale} modelLabel={modelLabel} />
        </>
      )}
    </div>
  );
}

type ModelLabelLookup = (id: string | null | undefined) => string | null;

/**
 * 优先用清单里的显示名；清单里没有（已下架 / 非对话模型）就退回记录里原有的值。
 *
 * ⚠️ 查的是 `modelKey` 而不是原始 `modelType` —— 用量汇总里只带 `modelKey`
 * （= `modelType` 的小写形态，`core/usage/stats.ts` 的 `getUsageModelKey`）。
 * 清单侧的查找键同样做了小写归一，所以两边对得上。
 */
function resolveModelLabel(model: UsageModelSummary, lookup: ModelLabelLookup): string {
  return lookup(model.modelKey) ?? model.modelLabel;
}

function UsageMetricGrid({
  summary,
  locale,
  modelLabel,
}: {
  summary: UsageSummary;
  locale: string;
  modelLabel: ModelLabelLookup;
}) {
  const { t } = useI18n();
  const mostUsedModel = summary.mostUsedModel;
  return (
    <div className="usage-metric-grid">
      <MetricCell
        label={t('sidepanel.settings.usage.totalTokens')}
        value={formatCompactTokens(summary.totalTokens, locale)}
        detail={t('sidepanel.settings.usage.serverSamples', {
          server: summary.serverTokenRecordCount,
          total: summary.turnCount,
        })}
      />
      <MetricCell
        label={t('sidepanel.settings.usage.sessions')}
        value={formatInteger(summary.sessionCount, locale)}
        detail={t('sidepanel.settings.usage.turns', { count: summary.turnCount })}
      />
      <MetricCell
        label={t('sidepanel.settings.usage.messages')}
        value={formatInteger(summary.messageCount, locale)}
        detail={t('sidepanel.settings.usage.activeDays', { count: summary.activeDays })}
      />
      <MetricCell
        label={t('sidepanel.settings.usage.currentStreak')}
        value={formatInteger(summary.currentStreak, locale)}
        detail={t('sidepanel.settings.usage.daysUnit')}
      />
      <MetricCell
        label={t('sidepanel.settings.usage.mostUsedModel')}
        value={mostUsedModel
          ? resolveModelLabel(mostUsedModel, modelLabel)
          : t('sidepanel.settings.usage.noModel')}
        detail={mostUsedModel
          ? t('sidepanel.settings.usage.share', { percent: formatPercent(mostUsedModel.share, locale) })
          : t('sidepanel.settings.usage.noModel')}
      />
    </div>
  );
}

function MetricCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="usage-metric-cell">
      <div className="usage-metric-label">{label}</div>
      <div className="usage-metric-value">{value}</div>
      <div className="usage-metric-detail">{detail}</div>
    </div>
  );
}

function UsageHeatmap({ summary, locale }: { summary: UsageSummary; locale: string }) {
  const { t } = useI18n();
  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <h2>{t('sidepanel.settings.usage.heatmapTitle')}</h2>
        <div className="usage-legend" aria-hidden="true">
          <span>{t('sidepanel.settings.usage.less')}</span>
          {[0, 1, 2, 3, 4, 5].map((level) => (
            <span key={level} className="usage-heat-cell usage-legend-cell" data-level={level} />
          ))}
          <span>{t('sidepanel.settings.usage.more')}</span>
        </div>
      </div>
      <div className="usage-heatmap-grid" role="list" aria-label={t('sidepanel.settings.usage.heatmapTitle')}>
        {summary.heatmap.map((cell) => (
          <span
            key={cell.day}
            role="listitem"
            className="usage-heat-cell"
            data-level={cell.level}
            title={`${formatDate(cell.timestamp, locale)} · ${t('sidepanel.settings.usage.tokenCount', { count: formatInteger(cell.tokens, locale) })}`}
          />
        ))}
      </div>
    </section>
  );
}

function UsageDailyTrend({ summary, locale }: { summary: UsageSummary; locale: string }) {
  const { t } = useI18n();
  const maxTokens = Math.max(1, ...summary.days.map((day) => day.tokens));
  const labelStep = summary.rangeDays === 30 ? 6 : 1;
  const lastDayIndex = summary.days.length - 1;

  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <h2>{t('sidepanel.settings.usage.dailyTrendTitle')}</h2>
      </div>
      <div
        className="usage-bars"
        aria-label={t('sidepanel.settings.usage.dailyTrendTitle')}
        style={{
          '--usage-day-count': summary.rangeDays,
          // 30-day charts use a tighter gap so columns keep usable width once
          // the grid is allowed to shrink to the panel width.
          '--usage-bar-gap': summary.rangeDays === 30 ? '2px' : '4px',
        } as CSSProperties}
      >
        {summary.days.map((day, dayIndex) => {
          const height = day.tokens > 0 ? Math.max(5, (day.tokens / maxTokens) * 100) : 0;
          const showLabel = dayIndex % labelStep === 0 || dayIndex === lastDayIndex;
          // Anchor the first/last labels inward so they never spill past the
          // chart edges; intermediate labels stay centered.
          const labelClass = dayIndex === 0
            ? 'usage-bar-label usage-bar-label-first'
            : dayIndex === lastDayIndex
              ? 'usage-bar-label usage-bar-label-last'
              : 'usage-bar-label';
          return (
            <div
              key={day.day}
              className="usage-bar-column"
              title={`${formatDate(day.timestamp, locale)} · ${t('sidepanel.settings.usage.tokenCount', { count: formatInteger(day.tokens, locale) })}`}
            >
              <div className="usage-bar-track">
                <div className="usage-bar-stack" style={{ height: `${height}%` }}>
                  {day.models.map((model) => (
                    <span
                      key={model.modelKey}
                      className="usage-bar-segment"
                      style={{
                        '--usage-model-color': getModelColor(model.modelKey, summary.modelUsage),
                        flexGrow: Math.max(model.tokens, 1),
                      } as CSSProperties}
                    />
                  ))}
                </div>
              </div>
              <span className={labelClass}>
                {showLabel ? formatShortDate(day.timestamp, locale, summary.rangeDays === 30) : ''}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function UsageModelSplit({
  summary,
  locale,
  modelLabel,
}: {
  summary: UsageSummary;
  locale: string;
  modelLabel: ModelLabelLookup;
}) {
  const { t } = useI18n();
  const donutStyle = {
    background: buildDonutGradient(summary.modelUsage),
  };

  return (
    <section className="usage-panel">
      <div className="usage-panel-heading">
        <h2>{t('sidepanel.settings.usage.modelUsageTitle')}</h2>
      </div>
      <div className="usage-model-layout">
        <div className="usage-donut" style={donutStyle}>
          <div className="usage-donut-hole">
            <strong>{formatCompactTokens(summary.totalTokens, locale)}</strong>
            <span>{t('sidepanel.settings.usage.tokensUnit')}</span>
          </div>
        </div>
        <div className="usage-model-list">
          {summary.modelUsage.map((model) => (
            <div key={model.modelKey} className="usage-model-row">
              <span
                className="usage-model-dot"
                style={{ background: getModelColor(model.modelKey, summary.modelUsage) }}
              />
              <div className="min-w-0 flex-1">
                <div className="usage-model-name">{resolveModelLabel(model, modelLabel)}</div>
                <div className="usage-model-tokens">
                  {t('sidepanel.settings.usage.tokenCount', { count: formatCompactTokens(model.totalTokens, locale) })}
                </div>
              </div>
              <div className="usage-model-share">{formatPercent(model.share, locale)}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function getModelColor(modelKey: string, models: readonly UsageModelSummary[]): string {
  const index = Math.max(0, models.findIndex((model) => model.modelKey === modelKey));
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

function buildDonutGradient(models: readonly UsageModelSummary[]): string {
  if (models.length === 0) return 'var(--ds-border)';
  let cursor = 0;
  const stops = models.map((model, index) => {
    const start = cursor;
    cursor += model.share * 100;
    const end = Math.max(cursor, start + 0.6);
    return `${MODEL_COLORS[index % MODEL_COLORS.length]} ${start.toFixed(2)}% ${end.toFixed(2)}%`;
  });
  return `conic-gradient(${stops.join(', ')})`;
}

function formatInteger(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Number.isFinite(value) ? Math.round(value) : 0);
}

function formatCompactTokens(value: number, locale: string): string {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  return new Intl.NumberFormat(locale, {
    notation: safeValue >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(safeValue);
}

function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

function formatShortDate(timestamp: number, locale: string, dayOnly = false): string {
  return new Intl.DateTimeFormat(locale, dayOnly
    ? { day: 'numeric' }
    : { month: 'numeric', day: 'numeric' },
  ).format(new Date(timestamp));
}
