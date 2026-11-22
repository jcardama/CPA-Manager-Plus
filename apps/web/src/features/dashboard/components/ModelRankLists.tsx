import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelRankRow, ModelRanks } from '../usageDashboardModel';
import {
  formatCompact,
  formatMoney,
  formatShare,
  type UsageFormatters,
} from '../usageDashboardFormat';
import styles from '../DashboardPage.module.scss';

const TOP = 8;

interface ModelRankListsProps {
  ranks: ModelRanks;
  format: UsageFormatters;
}

export function ModelRankLists({ ranks, format }: ModelRankListsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const count = ranks.byTokens.length;
  // Two more rows are cheaper to show than a control that hides them.
  const collapsible = count > TOP + 2;
  const limit = collapsible && !expanded ? TOP : count;

  const detail = (row: ModelRankRow) =>
    t('dashboard.model_detail', {
      model: row.model,
      input: format.exact(row.inputTokens),
      output: format.exact(row.outputTokens),
      calls: format.exact(row.calls),
    });

  const list = (rows: ModelRankRow[], byCost: boolean) => {
    const rest = rows.slice(limit);
    const pricedRest = rest.filter((row) => row.cost > 0);
    const restTokens = rest.reduce((sum, row) => sum + row.totalTokens, 0);
    const allTokens = rows.reduce((sum, row) => sum + row.totalTokens, 0);
    const summary = expanded
      ? t('dashboard.models_all', { count })
      : byCost
        ? [
            pricedRest.length > 0 &&
              t('dashboard.models_more_cost', {
                count: pricedRest.length,
                cost: formatMoney(pricedRest.reduce((sum, row) => sum + row.cost, 0)),
              }),
            rest.length > pricedRest.length &&
              t('dashboard.models_more_unpriced', { count: rest.length - pricedRest.length }),
          ]
            .filter(Boolean)
            .join(' · ')
        : t('dashboard.models_more_tokens', {
            count: rest.length,
            tokens: formatCompact(restTokens),
            share: formatShare(allTokens > 0 ? restTokens / allTokens : 0),
          });

    return (
      <ol>
        {rows.slice(0, limit).map((row, index) => {
          const unpriced = byCost && row.share === null;
          return (
            <li
              key={row.model}
              className={`${styles.row} ${unpriced ? styles.unpricedRow : ''}`}
              title={detail(row)}
            >
              <span className={styles.rank}>{unpriced ? '–' : index + 1}</span>
              <span className={styles.name}>{row.model}</span>
              <span
                className={styles.value}
                title={
                  byCost
                    ? unpriced
                      ? t('dashboard.unpriced_title')
                      : format.exactMoney(row.cost)
                    : t('dashboard.exact_tokens', { value: format.exact(row.totalTokens) })
                }
              >
                {byCost
                  ? unpriced
                    ? t('dashboard.unpriced')
                    : formatMoney(row.cost)
                  : formatCompact(row.totalTokens)}
              </span>
              <span className={styles.share}>
                {row.share === null ? '—' : formatShare(row.share)}
              </span>
              {row.share === null ? null : (
                <span className={styles.bar}>
                  <i style={{ width: `${(row.share * 100).toFixed(2)}%` }} />
                </span>
              )}
            </li>
          );
        })}
        {collapsible ? (
          <li>
            <button
              type="button"
              className={styles.more}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              <span>{summary}</span>
              <span>
                {expanded
                  ? t('dashboard.models_show_top', { count: TOP })
                  : t('dashboard.models_show_all', { count })}
              </span>
            </button>
          </li>
        ) : null}
      </ol>
    );
  };

  return (
    <section aria-labelledby="usage-models-title">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle} id="usage-models-title">
          {t('dashboard.models_title')}
        </h2>
        <span className={styles.hint}>
          {t('dashboard.models_hint', { count, priced: ranks.pricedCount })}
        </span>
      </div>
      <div className={styles.columns}>
        <div>
          <div className={styles.listHead}>
            <span>{t('dashboard.models_by_tokens')}</span>
            <span>{t('dashboard.share')}</span>
          </div>
          {list(ranks.byTokens, false)}
        </div>
        <div className={styles.byCost}>
          <div className={styles.listHead}>
            <span>{t('dashboard.models_by_cost')}</span>
            <span>{t('dashboard.share')}</span>
          </div>
          {list(ranks.byCost, true)}
        </div>
      </div>
    </section>
  );
}
