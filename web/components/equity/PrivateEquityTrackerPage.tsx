import type { ReactNode } from "react";
import {
  Archive,
  DatabaseZap,
  ExternalLink,
  FileText,
  Landmark,
  Lock,
  Network,
  RadioTower,
  Search,
  ShieldAlert,
  TrendingUp
} from "lucide-react";

type SourceTier = "structured" | "semiStructured" | "ocr" | "boundary";

interface EquitySource {
  title: string;
  record: string;
  tier: SourceTier;
  priority: string;
  ingestMode: string;
  cadence: string;
  status: string;
  tracks: string;
  fields: string[];
  limitations: string;
  sourceUrl?: string;
}

interface EquityMetric {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
}

interface PipelineStep {
  title: string;
  detail: string;
  status: string;
}

const sourceCatalog: EquitySource[] = [
  {
    title: "Form D",
    record: "Notices of exempt offerings",
    tier: "structured",
    priority: "P0",
    ingestMode: "SEC data set",
    cadence: "Rolling SEC release",
    status: "Ready for Cloudflare ingestion",
    tracks:
      "Private placements, pooled investment vehicles, amount offered, amount sold, industry group, related persons, and offering exemptions.",
    fields: ["issuer", "CIK", "industry", "amount_sold", "investor_count", "exemption"],
    limitations:
      "Shows fundraising notices, not the exact LP identity, fund performance, realized exits, or investor-level returns.",
    sourceUrl: "https://www.sec.gov/data-research/sec-markets-data/form-d-data-sets"
  },
  {
    title: "Form ADV / IAPD",
    record: "Registered advisers and exempt reporting advisers",
    tier: "structured",
    priority: "P0",
    ingestMode: "SEC/IAPD CSV and profile pages",
    cadence: "Periodic adviser updates",
    status: "Ready for entity graph",
    tracks:
      "Adviser registration, exempt reporting adviser status, RAUM, private fund adviser profiles, disciplinary disclosures, and business operations.",
    fields: ["adviser", "CRD", "SEC file", "RAUM", "private_fund_count", "disciplinary_flags"],
    limitations:
      "Useful for manager mapping, but it is not a live fund ledger and does not expose private LP cashflow books.",
    sourceUrl:
      "https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers"
  },
  {
    title: "Form 13F",
    record: "Institutional public holdings",
    tier: "structured",
    priority: "P1",
    ingestMode: "SEC XML data set",
    cadence: "Quarterly",
    status: "Adjacency feed",
    tracks:
      "Public equity holdings reported by larger institutional managers, including PE sponsors that manage public securities.",
    fields: ["manager", "CUSIP", "issuer", "shares", "value", "put_call"],
    limitations:
      "Covers reportable public securities only. It does not reveal private portfolio company marks or fund-level PnL.",
    sourceUrl: "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
  },
  {
    title: "Form N-PORT",
    record: "Registered fund portfolio holdings",
    tier: "structured",
    priority: "P1",
    ingestMode: "SEC data set",
    cadence: "Publicly disseminated fund reports",
    status: "Adjacency feed",
    tracks:
      "Portfolio holdings of registered management funds where public dissemination is available.",
    fields: ["fund", "holding", "asset_class", "value", "issuer", "country"],
    limitations:
      "Mostly tracks registered fund exposures, not closed-end private fund books unless they appear through public filings.",
    sourceUrl: "https://www.sec.gov/data-research/sec-markets-data/form-n-port-data-sets"
  },
  {
    title: "Schedule 13D / 13G",
    record: "Beneficial ownership and control positions",
    tier: "semiStructured",
    priority: "P2",
    ingestMode: "EDGAR search + filing parser",
    cadence: "Event-driven",
    status: "Build parser",
    tracks:
      "Control stakes, sponsor-led accumulation, activist positions, acquisition intent, and public company ownership changes.",
    fields: ["filer", "issuer", "percent_owned", "purpose", "event_date", "source_doc"],
    limitations:
      "Applies to public companies. It is a strong signal for sponsor behavior, not a complete private equity investment list.",
    sourceUrl: "https://www.sec.gov/search-filings"
  },
  {
    title: "Public pension documents",
    record: "Board packets, ACFRs, investment reports",
    tier: "ocr",
    priority: "P1",
    ingestMode: "Playwright + R2 + OCR",
    cadence: "Monthly/quarterly by plan",
    status: "Crawler needed",
    tracks:
      "LP commitments to PE funds, target allocations, manager selections, sometimes performance tables and fee disclosures.",
    fields: ["plan", "manager", "fund", "commitment", "vintage", "IRR", "multiple"],
    limitations:
      "No single federal feed. Documents are fragmented, often PDFs, and require source-by-source provenance checks."
  },
  {
    title: "Non-public boundary",
    record: "Form PF, LPAs, capital calls, cap tables",
    tier: "boundary",
    priority: "BLOCKED",
    ingestMode: "Unavailable from public records",
    cadence: "None",
    status: "Do not infer",
    tracks:
      "The economics people usually want most: private fund cashflows, exact LP ownership, fund marks, and private company cap tables.",
    fields: ["private_cashflows", "capital_accounts", "LP_identity", "private_marks"],
    limitations:
      "These are not public records in normal conditions. The dashboard should mark them as unavailable instead of fabricating coverage."
  }
];

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

const pipeline: PipelineStep[] = [
  {
    title: "Acquire",
    detail: "SEC data sets, EDGAR filings, public pension PDFs, and adviser profile pages are archived with source timestamps.",
    status: "Reuse R2 raw archive"
  },
  {
    title: "Normalize",
    detail: "Convert issuers, advisers, funds, tickers, commitments, and public holdings into a consistent private-market schema.",
    status: "New PE schema required"
  },
  {
    title: "Resolve",
    detail: "Link sponsors, adviser entities, funds, CIKs, CRDs, public companies, and pension plans into one graph.",
    status: "Entity resolver required"
  },
  {
    title: "Score",
    detail: "Flag fundraising velocity, concentration, public sponsor exposure, LP commitment changes, and document-quality risk.",
    status: "Analytics layer"
  },
  {
    title: "Publish",
    detail: "Serve source-backed manager, fund, pension, and sector dashboards through the existing yevow command center.",
    status: "This page is the map"
  }
];

const currentStack = [
  "Cloudflare Pages command center with `/congress`, `/settings`, and authenticated Worker APIs.",
  "D1-backed audit/storage pattern already used for congressional transactions and runner logs.",
  "GitHub Actions runner pattern for scheduled scraping, backfill, and price-mark refresh work.",
  "R2 raw archive path for source documents, screenshots, PDFs, and parser artifacts.",
  "Existing Playwright + parser discipline from the Congress tracker can be reused for public pension PDFs."
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

function tierLabel(tier: SourceTier) {
  switch (tier) {
    case "structured":
      return "Structured";
    case "semiStructured":
      return "Semi-structured";
    case "ocr":
      return "OCR";
    case "boundary":
      return "Not public";
  }
}

function tierIcon(tier: SourceTier) {
  switch (tier) {
    case "structured":
      return <DatabaseZap size={16} />;
    case "semiStructured":
      return <Search size={16} />;
    case "ocr":
      return <Archive size={16} />;
    case "boundary":
      return <ShieldAlert size={16} />;
  }
}

export default function PrivateEquityTrackerPage() {
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
        <div className="panel-title">
          <RadioTower size={16} />
          Public Source Coverage Matrix
        </div>
        <div className="equity-source-grid">
          {sourceCatalog.map((source) => (
            <article className={`equity-source-card ${source.tier}`} key={source.title}>
              <header>
                <div>
                  <span>
                    {tierIcon(source.tier)}
                    {tierLabel(source.tier)}
                  </span>
                  <h2>{source.title}</h2>
                  <p>{source.record}</p>
                </div>
                <strong>{source.priority}</strong>
              </header>
              <div className="equity-source-meta">
                <code>{source.ingestMode}</code>
                <code>{source.cadence}</code>
                <code>{source.status}</code>
              </div>
              <p>{source.tracks}</p>
              <div className="equity-tag-row">
                {source.fields.map((field) => (
                  <span key={`${source.title}-${field}`}>{field}</span>
                ))}
              </div>
              <div className="equity-limit">
                <ShieldAlert size={14} />
                <span>{source.limitations}</span>
              </div>
              {source.sourceUrl ? (
                <a className="equity-source-link" href={source.sourceUrl}>
                  Official source
                  <ExternalLink size={13} />
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="equity-panel glass">
        <div className="panel-title">
          <TrendingUp size={16} />
          What We Have So Far
        </div>
        <div className="equity-stack">
          {currentStack.map((item) => (
            <div className="equity-stack-row" key={item}>
              <span />
              <p>{item}</p>
            </div>
          ))}
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

      <section className="equity-panel glass equity-panel-wide">
        <div className="panel-title">
          <Archive size={16} />
          Ingestion Pipeline Map
        </div>
        <div className="equity-flow">
          {pipeline.map((step, index) => (
            <div className="equity-flow-step" key={step.title}>
              <code>{String(index + 1).padStart(2, "0")}</code>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
              <span>{step.status}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="equity-panel glass">
        <div className="panel-title">
          <ShieldAlert size={16} />
          First Build Order
        </div>
        <ol className="equity-roadmap">
          <li>
            <strong>Form D loader</strong>
            <span>Build the first D1 table from SEC structured filings and detect fundraising velocity.</span>
          </li>
          <li>
            <strong>ADV/IAPD linker</strong>
            <span>Resolve advisers, exempt reporters, private fund adviser records, and sponsor aliases.</span>
          </li>
          <li>
            <strong>13F sponsor lens</strong>
            <span>Track public holdings for Blackstone, KKR, Apollo, Carlyle, Brookfield, Ares, and peers.</span>
          </li>
          <li>
            <strong>Pension OCR crawler</strong>
            <span>Target one public plan first, then scale plan-by-plan with confidence scoring.</span>
          </li>
        </ol>
      </section>
    </main>
  );
}
