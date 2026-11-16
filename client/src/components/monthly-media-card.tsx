import { useI18n } from '@/i18n'
import { platformColors } from '@/lib/routing'

export interface MonthlyMediaData {
  monthStart: string
  totalUsed: number
  totalFailed: number
  rows: {
    platform: string
    used: number
    failed: number
    limit: number | null
    remaining: number | null
    connected: boolean
  }[]
  keyless: string[]
}

// Exact "this month" usage for the image, audio and video tabs. Media calls log
// no tokens, so the unit is calls. A remaining figure shows only for providers
// with a published cap (an estimate, flagged); the rest show usage with
// "no published limit" rather than an invented total.
// Server side: server/src/services/monthly-media-usage.ts.
export function MonthlyMediaCard({ data }: { data: MonthlyMediaData }) {
  const { t } = useI18n()
  const { rows, totalUsed, totalFailed } = data
  const hasLimit = rows.some(r => r.limit !== null)
  const brokenLimited = rows.some(r => r.limit !== null && r.used === 0 && r.failed > 0)
  const keyless = data.keyless.filter(p => !rows.some(r => r.platform === p && r.used + r.failed > 0))

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-sm font-medium">
          {t('monthlyUsage.title')}
          <span
            className="ml-2 cursor-help text-xs font-normal text-muted-foreground underline decoration-dotted underline-offset-2"
            title={t('monthlyUsage.exactHint')}
          >
            {t('monthlyUsage.exact')}
          </span>
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{totalUsed}</span> {t('monthlyUsage.used')}
          {totalFailed > 0 && (
            <>
              <span className="mx-1.5">·</span>
              <span className="text-foreground font-medium">{totalFailed}</span> {t('monthlyUsage.failed')}
            </>
          )}
        </span>
      </div>

      <div className="space-y-1.5 text-xs tabular-nums">
        {rows.map(r => (
          <div key={r.platform} className="flex items-center gap-2 min-w-0">
            <span className="size-2 rounded-sm flex-shrink-0" style={{ backgroundColor: platformColors[r.platform] ?? '#94a3b8' }} />
            <span className="truncate">{r.platform}</span>
            <span className="flex-1" />
            <span className="font-mono text-muted-foreground whitespace-nowrap">
              <span className="text-foreground">{r.used}</span> {t('monthlyUsage.used')}
              {r.failed > 0 && <> · {r.failed} {t('monthlyUsage.failed')}</>}
              <span className="mx-1.5">·</span>
              {r.limit !== null && r.remaining !== null ? (
                <>
                  <span className="text-foreground">{r.remaining}</span> {t('monthlyUsage.left')} {t('monthlyUsage.of')} {r.limit}
                </>
              ) : (
                t('monthlyUsage.noLimit')
              )}
            </span>
          </div>
        ))}
      </div>

      {hasLimit && <p className="mt-2 text-xs text-muted-foreground">{t('monthlyUsage.limitEstimate')}</p>}
      {brokenLimited && <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">{t('monthlyUsage.allFailed')}</p>}
      {keyless.length > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">{t('monthlyUsage.keyless', { providers: keyless.join(', ') })}</p>
      )}
      {rows.length === 0 && keyless.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">{t('monthlyUsage.empty')}</p>
      )}
    </section>
  )
}
