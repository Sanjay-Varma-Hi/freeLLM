import { useI18n } from '@/i18n'
import { formatPercent, formatTokens, platformColors } from '@/lib/routing'

export interface WeeklyBudgetData {
  unit: 'tokens' | 'images'
  weekStart: string
  totalBudget: number
  totalUsed: number
  rows: { platform: string; budget: number; used: number }[]
  unpublished: string[]
  unmetered: string[]
}

// "This week" allowance for the embeddings and image tabs, drawn like the chat
// tab's monthly token budget: remaining out of total, plus what has been used.
// The totals are estimates (see server/src/services/weekly-budget.ts), and the
// card says so rather than presenting them as exact.
export function WeeklyBudgetCard({ data }: { data: WeeklyBudgetData }) {
  const { t } = useI18n()
  const { unit, totalBudget, totalUsed, rows } = data
  const fmt = (n: number) => (unit === 'tokens' ? formatTokens(n) : String(Math.round(n)))
  const remaining = Math.max(0, totalBudget - totalUsed)
  const usedPct = totalBudget > 0 ? Math.min(100, (totalUsed / totalBudget) * 100) : 0
  const names = (platforms: string[]) => platforms.join(', ')

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-medium">
          {t('weeklyBudget.title')}
          <span
            className="ml-2 cursor-help text-xs font-normal text-muted-foreground underline decoration-dotted underline-offset-2"
            title={t('weeklyBudget.estimateHint')}
          >
            {t('weeklyBudget.estimated')}
          </span>
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalBudget > 0 ? (
            <>
              <span className="text-foreground font-medium">{fmt(remaining)}</span> {t('weeklyBudget.remaining')}
              <span className="mx-1.5">·</span>
              {formatPercent(remaining / totalBudget)} {t('weeklyBudget.of')} {fmt(totalBudget)}
              <span className="mx-1.5">·</span>
            </>
          ) : null}
          <span className="text-foreground font-medium">{fmt(totalUsed)}</span> {t('weeklyBudget.used')}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {rows.map(r => (
          <div
            key={r.platform}
            title={`${r.platform}: ${fmt(Math.max(0, r.budget - r.used))} ${t('weeklyBudget.remaining')}, ${fmt(r.used)} ${t('weeklyBudget.used')}`}
            style={{
              width: `${totalBudget > 0 ? (Math.max(0, r.budget - r.used) / totalBudget) * 100 : 0}%`,
              backgroundColor: platformColors[r.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div className="bg-muted-foreground/30" style={{ width: `${usedPct}%` }} title={`${fmt(totalUsed)} ${t('weeklyBudget.used')}`} />
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
        {rows.map(r => (
          <div key={r.platform} className="flex items-center gap-2 min-w-0">
            <span className="size-2 rounded-sm flex-shrink-0" style={{ backgroundColor: platformColors[r.platform] ?? '#94a3b8' }} />
            <span className="truncate">{r.platform}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground" title={t('weeklyBudget.legendTitle', { used: fmt(r.used) })}>
              {fmt(Math.max(0, r.budget - r.used))}<span className="mx-0.5">/</span>{fmt(r.budget)}
            </span>
          </div>
        ))}
      </div>

      {data.unmetered.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t('weeklyBudget.unmetered', { providers: names(data.unmetered) })}
        </p>
      )}
      {data.unpublished.length > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('weeklyBudget.unpublished', { providers: names(data.unpublished) })}
        </p>
      )}
      {rows.length === 0 && data.unmetered.length === 0 && data.unpublished.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{t('weeklyBudget.empty')}</p>
      )}
    </section>
  )
}
