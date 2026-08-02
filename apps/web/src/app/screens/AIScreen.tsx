import { useId, useState } from "react";
import { Brain, Zap, AlertTriangle, CheckCircle2, TrendingDown } from "lucide-react";
import type { Patient } from "../types";
import { Card, SectionHeader } from "../components/shared";
import { WEEKLY_DATA } from "../data/patients";
import { useLanguage } from "../lib/languageContext";
import { t } from "../lib/language";

interface SparkPoint { day: string; adherence: number }

function SparklineChart({ data, height = 80, fillOpacity = 0.15 }: { data: SparkPoint[]; height?: number; fillOpacity?: number }) {
  const uid = useId();
  const W = 310;
  const H = height;
  const pad = { top: 6, bottom: 20, left: 2, right: 2 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const minV = 0;
  const maxV = 100;

  const xs = data.map((_, i) => pad.left + (i / (data.length - 1)) * plotW);
  const ys = data.map(d => pad.top + plotH - ((d.adherence - minV) / (maxV - minV)) * plotH);

  const linePath = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${xs[xs.length - 1].toFixed(1)},${(pad.top + plotH).toFixed(1)} L${xs[0].toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  const [tooltip, setTooltip] = useState<{ x: number; y: number; label: string; value: number } | null>(null);

  return (
    <div className="relative select-none">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        onMouseLeave={() => setTooltip(null)}
      >
        <defs>
          <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0D5C8A" stopOpacity={fillOpacity * 2} />
            <stop offset="100%" stopColor="#0D5C8A" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Area fill */}
        <path d={areaPath} fill={`url(#${uid})`} />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#0D5C8A" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* Dots + hit areas */}
        {data.map((d, i) => (
          <g key={d.day}>
            <circle cx={xs[i]} cy={ys[i]} r={3} fill="#0D5C8A" />
            <rect
              x={xs[i] - 18} y={pad.top} width={36} height={plotH}
              fill="transparent"
              onMouseEnter={() => setTooltip({ x: xs[i], y: ys[i], label: d.day, value: d.adherence })}
            />
          </g>
        ))}

        {/* Tooltip crosshair */}
        {tooltip && (
          <line
            x1={tooltip.x} y1={pad.top}
            x2={tooltip.x} y2={pad.top + plotH}
            stroke="#0D5C8A" strokeWidth={1} strokeDasharray="3 3" opacity={0.5}
          />
        )}

        {/* X-axis labels */}
        {data.map((d, i) => (
          <text
            key={`lbl-${d.day}`}
            x={xs[i]} y={H - 4}
            textAnchor="middle"
            fontSize={10}
            fill="#6B6455"
          >
            {d.day}
          </text>
        ))}
      </svg>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-white border border-border rounded-xl px-2.5 py-1.5 text-xs shadow-md -translate-x-1/2"
          style={{ left: `${(tooltip.x / W) * 100}%`, top: Math.max(0, tooltip.y - 40) }}
        >
          <span className="font-semibold text-foreground">{tooltip.value}%</span>
          <span className="text-muted-foreground ml-1">{tooltip.label}</span>
        </div>
      )}
    </div>
  );
}

export function AIScreen({ patient }: { patient: Patient }) {
  const { language } = useLanguage();
  return (
    <div className="px-4 py-5 space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 bg-primary rounded-2xl flex items-center justify-center shrink-0">
          <Brain size={20} className="text-white" />
        </div>
        <div>
          <h2 className="font-['Fraunces'] text-xl font-semibold text-foreground">{t(language, "common.weeklySummary")}</h2>
          <p className="text-xs text-muted-foreground">23–29 Jun 2026 · {patient.nickname}</p>
        </div>
      </div>

      {/* Adherence overview */}
      <Card className="p-4">
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-taken-bg border border-taken-border rounded-xl p-3">
            <p className="font-['Fraunces'] text-2xl font-semibold text-taken-fg">{patient.adherenceWeek}%</p>
            <p className="text-[calc(10px*var(--dw-text,1))] text-taken-fg font-medium mt-0.5">{t(language, "summary.adherence")}</p>
          </div>
          <div className="bg-missed-bg border border-missed-border rounded-xl p-3">
            <p className="font-['Fraunces'] text-2xl font-semibold text-missed-fg">3</p>
            <p className="text-[calc(10px*var(--dw-text,1))] text-missed-fg font-medium mt-0.5">{t(language, "summary.missedDoses")}</p>
          </div>
          <div className="bg-upcoming-bg border border-upcoming-border rounded-xl p-3">
            <p className="font-['Fraunces'] text-2xl font-semibold text-upcoming-fg">29</p>
            <p className="text-[calc(10px*var(--dw-text,1))] text-upcoming-fg font-medium mt-0.5">{t(language, "summary.dosesTaken")}</p>
          </div>
        </div>

        <div className="mt-4">
          <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground uppercase tracking-widest font-medium mb-2">{t(language, "summary.dailyBreakdown")}</p>
          <SparklineChart data={WEEKLY_DATA} height={90} fillOpacity={0.2} />
        </div>
      </Card>

      {/* AI insights */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap size={14} className="text-primary" />
          <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground uppercase tracking-widest font-medium">{t(language, "summary.aiInsights")}</p>
        </div>
        <Card className="divide-y divide-border">
          <div className="px-4 py-3">
            <div className="flex items-start gap-3">
              <AlertTriangle size={15} className="text-missed-fg shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">Celecoxib frequently missed at noon</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">The 12:00 PM dose of Celecoxib was missed on 3 out of 7 days this week. This is the most frequently missed medication and may be linked to lunchtime routine disruption.</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-start gap-3">
              <CheckCircle2 size={15} className="text-taken shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">Morning routine well-established</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">Metformin and Amlodipine at 7:00 AM were taken consistently every day, averaging within 12 minutes of scheduled time. Excellent adherence for these doses.</p>
              </div>
            </div>
          </div>
          <div className="px-4 py-3">
            <div className="flex items-start gap-3">
              <TrendingDown size={15} className="text-warn shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-foreground">Slight decline vs last week</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">Week-on-week adherence dropped from 89% to 82%. No significant change in routine noted; may coincide with Mdm Tan's complaint of increased joint discomfort this week.</p>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Discussion points */}
      <div>
        <SectionHeader title={t(language, "summary.discussWithDoctor")} />
        <Card className="p-4 space-y-3">
          <div className="flex gap-3">
            <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 text-[calc(10px*var(--dw-text,1))] font-bold mt-0.5">1</div>
            <p className="text-sm text-foreground leading-snug">Consider moving Celecoxib 200mg to a time linked to an existing routine (e.g. after lunch TV programme) to improve midday adherence.</p>
          </div>
          <div className="flex gap-3">
            <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 text-[calc(10px*var(--dw-text,1))] font-bold mt-0.5">2</div>
            <p className="text-sm text-foreground leading-snug">Discuss Mdm Tan's reported joint pain and whether the missed Celecoxib doses may be contributing to increased discomfort — a feedback loop worth monitoring.</p>
          </div>
          <div className="flex gap-3">
            <div className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 text-[calc(10px*var(--dw-text,1))] font-bold mt-0.5">3</div>
            <p className="text-sm text-foreground leading-snug">Metformin refill is needed within 4 days. Request a prescription at the next Polyclinic visit or via OneDoc / Health Buddy app.</p>
          </div>
          <p className="text-[calc(10px*var(--dw-text,1))] text-muted-foreground pt-1 border-t border-border">{t(language, "summary.disclaimer", { doctor: "Dr Priya Nair" })}</p>
        </Card>
      </div>
    </div>
  );
}
