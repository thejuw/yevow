"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  DatabaseZap,
  ExternalLink,
  FileText,
  Landmark,
  Lock,
  Network,
  RefreshCcw,
  TrendingUp
} from "lucide-react";
import { readPrivateEquityDeals } from "@/lib/api";
import type { PrivateEquityDeal } from "@/lib/types";

interface EquityMetric {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}

type EquityDealStatus = "LOADING" | "READY" | "ERROR";

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});

const compactNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1
});

const metrics: EquityMetric[] = [
  {
    label: "Direct PE Sources",
    value: "2",
    detail: "Form D plus Form ADV/IAPD",
    icon: <DatabaseZap size={18} />
  },
  {
    label: "Adjacency Feeds",
    value: "3",
    detail: "13F, N-PORT, 13D/G",
    icon: <Network size={18} />
  },
  {
    label: "OCR Targets",
    value: "1+",
    detail: "Public pension reports and packets",
    icon: <FileText size={18} />
  },
  {
    label: "Non-Public Zones",
    value: "4",
    detail: "PF, LPAs, cap tables, calls",
    icon: <Lock size={18} />
  }
];

const schemaPrimitives = [
  "manager",
  "adviser",
  "fund",
  "offering",
  "LP commitment",
  "public holding",
  "portfolio company",
  "document provenance"
];

export default function PrivateEquityTrackerPage() {
  const [deals, setDeals] = useState<PrivateEquityDeal[]>([]);
  const [dealStatus, setDealStatus] = useState<EquityDealStatus>("LOADING");
  const [dealError, setDealError] = useState<string | null>(null);

  const refreshDeals = useCallback(async () => {
    setDealStatus("LOADING");
    setDealError(null);

    try {
      const response = await readPrivateEquityDeals();

      if (!response.ok) {
        throw new Error(response.error ?? "Private equity deal feed unavailable.");
      }

      setDeals(response.deals);
      setDealStatus("READY");
    } catch (error) {
      setDealStatus("ERROR");
      setDealError(
        error instanceof Error ? error.message : "Private equity deal feed unavailable."
      );
    }
  }, []);

  useEffect(() => {
    void refreshDeals();
  }, [refreshDeals]);

  const dealSummary = useMemo(() => summarizeDeals(deals), [deals]);

  return (
    <main className="settings-shell equity-shell">
      <section className="settings-hero glass equity-hero">
        <div className="brand-lockup">
          <div className="sigil">
            <Landmark size={22} />
          </div>
          <div>
            <h1>Sovereign-Sigma</h1>
            <p>Private Equity Public-Record Tracker</p>
          </div>
        </div>
        <div className="settings-nav">
          <a href="/">Command Center</a>
          <a href="/congress">
            <DatabaseZap size={16} />
            Congress
          </a>
          <a href="/congress-alpha">
            <Bot size={16} />
            Alpha Bot
          </a>
          <a href="/settings">Settings</a>
        </div>
      </section>

      <section className="equity-brief glass">
        <div>
          <span>Coverage Discipline</span>
          <strong>Public records only</strong>
        </div>
        <p>
          This dashboard maps what can be ingested for private equity without inventing private
          data. It can track fundraising notices, adviser/fund identities, public sponsor holdings,
          and pension-commitment documents. It cannot see sealed LP economics, Form PF detail, or
          private cap tables.
        </p>
      </section>

      <section className="equity-metrics">
        {metrics.map((metric) => (
          <div className="equity-metric glass" key={metric.label}>
            <div>{metric.icon}</div>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.detail}</small>
          </div>
        ))}
      </section>

      <section className="equity-panel glass equity-panel-wide">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-[rgba(150,165,188,0.16)] pb-3">
          <div className="panel-title mb-0 border-0 p-0">
            <TrendingUp size={16} />
            Private Equity M&A Tape
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                dealStatus === "ERROR"
                  ? "rounded-md border border-red-400/30 bg-red-500/10 px-3 py-2 font-mono text-[11px] uppercase text-red-200"
                  : "rounded-md border border-emerald-300/25 bg-emerald-400/10 px-3 py-2 font-mono text-[11px] uppercase text-emerald-200"
              }
            >
              {dealStatus === "LOADING"
                ? "Loading"
                : dealStatus === "ERROR"
                  ? "Feed Error"
                  : "Live Feed"}
            </span>
            <button
              className="inline-flex min-h-[34px] items-center gap-2 rounded-md border border-[#d8c68f66] bg-[#d8c68f1a] px-3 py-2 text-[12px] text-[#f3eee6]"
              disabled={dealStatus === "LOADING"}
              onClick={() => void refreshDeals()}
            >
              <RefreshCcw size={14} />
              Refresh
            </button>
          </div>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
          <div className="rounded-lg border border-slate-400/15 bg-white/[0.025] p-3">
            <span className="font-mono text-[10px] uppercase text-slate-400">Latest Deals</span>
            <strong className="mt-2 block font-mono text-[20px] text-[#f3eee6]">
              {deals.length}
            </strong>
          </div>
          <div className="rounded-lg border border-slate-400/15 bg-white/[0.025] p-3">
            <span className="font-mono text-[10px] uppercase text-slate-400">Known Value</span>
            <strong className="mt-2 block font-mono text-[20px] text-[#f3eee6]">
              {formatAggregateValue(dealSummary.knownDealValue)}
            </strong>
          </div>
          <div className="rounded-lg border border-slate-400/15 bg-white/[0.025] p-3">
            <span className="font-mono text-[10px] uppercase text-slate-400">Undisclosed</span>
            <strong className="mt-2 block font-mono text-[20px] text-[#f3eee6]">
              {dealSummary.undisclosedCount}
            </strong>
          </div>
          <div className="rounded-lg border border-slate-400/15 bg-white/[0.025] p-3">
            <span className="font-mono text-[10px] uppercase text-slate-400">Sectors</span>
            <strong className="mt-2 block font-mono text-[20px] text-[#f3eee6]">
              {dealSummary.sectorCount}
            </strong>
          </div>
        </div>

        {dealError ? (
          <div className="mb-3 rounded-lg border border-red-400/25 bg-red-500/10 p-3 font-mono text-[12px] text-red-100">
            {dealError}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-slate-400/15 bg-[#07090c99]">
          <table className="min-w-full border-collapse text-left text-[12px]">
            <thead className="border-b border-slate-400/15 bg-white/[0.035]">
              <tr className="font-mono uppercase text-slate-400">
                <th className="whitespace-nowrap px-3 py-3 font-medium">Published</th>
                <th className="whitespace-nowrap px-3 py-3 font-medium">Buyer</th>
                <th className="whitespace-nowrap px-3 py-3 font-medium">Target</th>
                <th className="whitespace-nowrap px-3 py-3 font-medium">Sector</th>
                <th className="whitespace-nowrap px-3 py-3 text-right font-medium">Deal Size</th>
                <th className="whitespace-nowrap px-3 py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-400/10">
              {dealStatus === "LOADING" && deals.length === 0 ? (
                <tr>
                  <td className="px-3 py-5 font-mono text-slate-400" colSpan={6}>
                    Loading private equity M&A feed...
                  </td>
                </tr>
              ) : deals.length === 0 ? (
                <tr>
                  <td className="px-3 py-5 font-mono text-slate-400" colSpan={6}>
                    No private equity M&A deals have been extracted yet.
                  </td>
                </tr>
              ) : (
                deals.map((deal) => (
                  <tr className="align-top hover:bg-white/[0.035]" key={deal.id}>
                    <td className="whitespace-nowrap px-3 py-3 font-mono text-slate-300">
                      {formatDate(deal.published_date)}
                    </td>
                    <td className="max-w-[260px] px-3 py-3 font-semibold text-[#f3eee6]">
                      {deal.buyer}
                    </td>
                    <td className="max-w-[280px] px-3 py-3 text-slate-200">
                      {deal.target_company}
                    </td>
                    <td className="px-3 py-3">
                      <span className="inline-flex rounded-md border border-[#d8c68f33] bg-[#d8c68f14] px-2 py-1 font-mono text-[11px] text-[#d8c68f]">
                        {deal.sector ?? "Unclassified"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right font-mono text-slate-100">
                      {deal.deal_size === null ? (
                        <span className="rounded-md border border-slate-400/20 px-2 py-1 text-slate-400">
                          Undisclosed
                        </span>
                      ) : (
                        formatDealSize(deal.deal_size)
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <a
                        className="inline-flex items-center gap-1 rounded-md border border-slate-400/20 px-2 py-1 font-mono text-[11px] text-[#bcd8ff] no-underline hover:border-[#d8c68f66] hover:text-[#d8c68f]"
                        href={deal.source_url}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {sourceHost(deal.source_url)}
                        <ExternalLink size={12} />
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="equity-panel glass">
        <div className="panel-title">
          <Network size={16} />
          Data Model
        </div>
        <div className="equity-schema-grid">
          {schemaPrimitives.map((primitive) => (
            <code key={primitive}>{primitive}</code>
          ))}
        </div>
        <div className="equity-schema-note">
          <strong>Core rule:</strong>
          <span>
            every row needs document provenance, source URL, filing/report date, extraction method,
            parser confidence, and whether the value is observed or inferred.
          </span>
        </div>
      </section>
    </main>
  );
}

function summarizeDeals(deals: PrivateEquityDeal[]): {
  knownDealValue: number;
  undisclosedCount: number;
  sectorCount: number;
} {
  const sectors = new Set<string>();
  let knownDealValue = 0;
  let undisclosedCount = 0;

  for (const deal of deals) {
    if (deal.deal_size === null) {
      undisclosedCount += 1;
    } else {
      knownDealValue += deal.deal_size;
    }

    if (deal.sector) {
      sectors.add(deal.sector.toLowerCase());
    }
  }

  return {
    knownDealValue,
    undisclosedCount,
    sectorCount: sectors.size
  };
}

function formatDealSize(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${compactNumber.format(value / 1_000_000_000)}B`;
  }

  if (value >= 1_000_000) {
    return `$${compactNumber.format(value / 1_000_000)}M`;
  }

  return currency.format(value);
}

function formatAggregateValue(value: number): string {
  return value > 0 ? formatDealSize(value) : "$0";
}

function formatDate(value: string): string {
  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value || "n/a";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric"
  }).format(new Date(timestamp));
}

function sourceHost(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}
