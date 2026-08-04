/**
 * ExportService — turns a `report:export_requested` event into a document
 * the user can actually read and keep.
 *
 * Flow: ChatInterface emits `report:export_requested` with { type, report, context }
 * → ExportService builds a self-contained HTML document → shows it in an
 * in-app modal (sandboxed iframe, so report content can never execute script
 * or touch the host page) → the modal's Download button saves that exact
 * HTML to disk via a Blob URL.
 *
 * No server round-trip, no PDF library dependency. The downloaded .html file
 * opens in any browser and can be printed to PDF from there if the user wants
 * a PDF — the print stylesheet below is tuned for that.
 *
 * Supported `type` values: 'empowerment_report' (quiz report card),
 * 'resilience_plan'. Anything else falls back to a generic JSON dump so the
 * UI never silently swallows an export request.
 */

import { EventBus } from '../core/EventBus.js';

/** Escape user/Claude-origin strings before injection into the document HTML. */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(d = new Date()) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Shared stylesheet for every generated document — light, print-friendly. */
const DOC_STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; padding:40px 48px; font-family:'Inter', system-ui, sans-serif; background:#fff; color:#1a2733; line-height:1.5; }
  .doc { max-width:720px; margin:0 auto; }
  header { border-bottom:2px solid #4aa8e8; padding-bottom:16px; margin-bottom:24px; }
  .doc-kicker { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#4aa8e8; font-weight:600; margin-bottom:6px; }
  h1 { font-size:26px; margin:0 0 6px; color:#0d2433; }
  .doc-meta { font-size:12px; color:#5a7282; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.04em; color:#1c5d85; margin:28px 0 10px; border-bottom:1px solid #dbe6ee; padding-bottom:6px; }
  p { font-size:13px; color:#33495a; }
  .grade-block { display:flex; align-items:center; gap:18px; margin-bottom:18px; }
  .grade { font-size:54px; font-weight:800; line-height:1; width:72px; text-align:center; }
  .grade-A { color:#1f9d55; } .grade-B { color:#2f8fc4; } .grade-C { color:#d99a1b; } .grade-D { color:#e2772f; } .grade-F { color:#cf3a2c; }
  .grade-label { font-size:16px; font-weight:700; color:#0d2433; }
  .key-insight { font-size:14px; color:#33495a; background:#f3f8fb; border-left:3px solid #4aa8e8; padding:12px 16px; border-radius:4px; }
  .metrics-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:10px; }
  .metric { background:#f6f9fb; border:1px solid #e3ecf2; border-radius:6px; padding:10px 12px; }
  .metric-label { font-size:11px; color:#5a7282; text-transform:uppercase; letter-spacing:.03em; }
  .metric-value { font-size:16px; font-weight:700; color:#0d2433; margin-top:2px; }
  .metric-basis { font-size:11px; color:#7a8e9a; margin-top:4px; }
  .steps { padding-left:20px; margin:0; }
  .steps li { margin-bottom:8px; font-size:13px; }
  .data-table { width:100%; border-collapse:collapse; margin-bottom:8px; font-size:12.5px; }
  .data-table th, .data-table td { text-align:left; padding:8px 10px; border-bottom:1px solid #e3ecf2; }
  .data-table th { font-size:11px; text-transform:uppercase; letter-spacing:.03em; color:#5a7282; }
  .tier { font-weight:700; padding:2px 8px; border-radius:10px; font-size:11px; white-space:nowrap; }
  .tier-high { background:#fde2de; color:#b3261e; }
  .tier-moderate { background:#fdf0d5; color:#9a6a05; }
  .tier-low { background:#dff3e3; color:#1d7a3c; }
  .mitigation { margin-bottom:14px; padding:12px 14px; background:#f9fbfc; border:1px solid #e8eef2; border-radius:6px; }
  .mitigation h3 { margin:0 0 6px; font-size:14px; color:#0d2433; }
  .mitigation dl { margin:8px 0 0; display:grid; grid-template-columns:110px 1fr; gap:4px 10px; font-size:12px; }
  .mitigation dt { color:#5a7282; font-weight:600; }
  .mitigation dd { margin:0; color:#33495a; }
  ul { font-size:13px; color:#33495a; padding-left:20px; }
  .disclaimer {
    font-size:11px; color:#4a6070; background:#f3f8fb; border:1px solid #d5e3ec;
    border-radius:4px; padding:12px 14px; margin:0 0 20px; line-height:1.45;
  }
  .disclaimer strong { color:#0d2433; }
  footer.doc-footer {
    margin-top:32px; padding-top:14px; border-top:1px solid #e3ecf2;
    font-size:11px; color:#4a6070; line-height:1.45;
  }
  footer.doc-footer p { margin:0 0 8px; font-size:11px; color:#4a6070; }
  @media print { body { padding:0; } .doc { max-width:none; } .disclaimer, footer.doc-footer { break-inside: avoid; } }
`;

/** Structural disclaimer — always injected by _wrap into every export artifact. */
const SOURCE_URL = 'https://joenalism.netlify.app';

function buildDisclaimerHtml(generated) {
  return {
    header: `<aside class="disclaimer" data-export-disclaimer="header">
      <strong>Disclaimer.</strong> Earth Simulator is a free educational tool.
      Narrative text is AI-generated and may contain errors.
      This document is not engineering, financial, insurance, legal, medical, or emergency-planning advice.
      Figures require independent verification against primary sources.
      Source: <a href="${SOURCE_URL}">${SOURCE_URL}</a> · Exported ${escapeHtml(generated)}.
    </aside>`,
    footer: `<footer class="doc-footer" data-export-disclaimer="footer">
      <p><strong>Disclaimer.</strong> Earth Simulator is a free educational tool.
      Narrative text is AI-generated and may contain errors.
      This document is not engineering, financial, insurance, legal, medical, or emergency-planning advice.
      Figures require independent verification against primary sources.</p>
      <p>Source: <a href="${SOURCE_URL}">${SOURCE_URL}</a> · Exported ${escapeHtml(generated)}.</p>
    </footer>`,
  };
}

export class ExportService {
  constructor() {
    this._overlay = null;

    this._onExportRequested = (payload) => this._handleExport(payload);
    this._onKeydown = (e) => { if (e.key === 'Escape') this._closeModal(); };

    EventBus.on('report:export_requested', this._onExportRequested);
  }

  /** Remove all EventBus subscriptions and tear down any open modal. */
  destroy() {
    EventBus.off('report:export_requested', this._onExportRequested);
    this._closeModal();
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  _handleExport({ type, report, context = {} } = {}) {
    if (!report) {
      console.warn('[ExportService] report:export_requested fired with no report payload');
      return;
    }

    let doc;
    if (type === 'empowerment_report')   doc = this._buildEmpowermentDoc(report, context);
    else if (type === 'resilience_plan') doc = this._buildResiliencePlanDoc(report, context);
    else                                  doc = this._buildGenericDoc(type, report, context);

    this._showModal(doc);
  }

  // ── Document builders ─────────────────────────────────────────────────────

  _buildEmpowermentDoc(report, context) {
    const place = this._placeLabel(context);

    const metricsHtml = (report.metrics ?? []).map((m) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(m.label)}</div>
        <div class="metric-value">${escapeHtml(m.value)}</div>
        <div class="metric-basis">${escapeHtml(m.basis)}</div>
      </div>`).join('');

    const stepsHtml = (report.nextSteps ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join('');
    const gradeClass = /^[A-F]$/.test(report.grade) ? `grade-${report.grade}` : '';

    const body = `
      <div class="grade-block">
        <div class="grade ${gradeClass}">${escapeHtml(report.grade ?? '—')}</div>
        <div>
          <div class="grade-label">${escapeHtml(report.gradeLabel ?? '')}</div>
          <div class="doc-kicker">Climate Hazard Readiness Report</div>
        </div>
      </div>
      ${report.keyInsight ? `<p class="key-insight">${escapeHtml(report.keyInsight)}</p>` : ''}
      <h2>What this strategy could achieve</h2>
      <div class="metrics-grid">${metricsHtml}</div>
      ${stepsHtml ? `<h2>Next steps</h2><ol class="steps">${stepsHtml}</ol>` : ''}
    `;

    return this._wrap({
      title: `Climate Readiness Report${place ? ` — ${place}` : ''}`,
      subtitle: 'Empowerment Quiz Report Card',
      body,
      filename: this._filename('empowerment-report', context),
    });
  }

  _buildResiliencePlanDoc(plan, context) {
    const place = this._placeLabel(context);

    const risksHtml = (plan.risks ?? []).map((r) => `
      <tr>
        <td>${escapeHtml(r.hazard)}</td>
        <td><span class="tier tier-${escapeHtml(String(r.tier ?? '').toLowerCase())}">${escapeHtml(r.tier)}</span></td>
        <td>${escapeHtml(r.projection)}</td>
        <td>${escapeHtml(r.economicExposure)}</td>
      </tr>`).join('');

    const mitigationsHtml = (plan.mitigations ?? []).map((m) => `
      <div class="mitigation">
        <h3>${escapeHtml(m.name)}</h3>
        <p>${escapeHtml(m.concept)}</p>
        <dl>
          <dt>Community</dt><dd>${escapeHtml(m.community)}</dd>
          <dt>Policy</dt><dd>${escapeHtml(m.policy)}</dd>
          <dt>Buildout</dt><dd>${escapeHtml(m.buildout)}</dd>
          <dt>Maintenance</dt><dd>${escapeHtml(m.maintenance)}</dd>
        </dl>
      </div>`).join('');

    const financingHtml = (plan.financingMechanisms ?? []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    const jobsHtml = (plan.jobs ?? []).map((j) => `
      <tr><td>${escapeHtml(j.sector)}</td><td>${escapeHtml(j.count)}</td><td>${escapeHtml(j.type)}</td></tr>`).join('');

    const costs = plan.costs ?? {};
    const viability = plan.viability ?? {};

    const body = `
      ${plan.risks?.length ? `
      <h2>Key risks</h2>
      <table class="data-table">
        <thead><tr><th>Hazard</th><th>Tier</th><th>Projection</th><th>Economic exposure</th></tr></thead>
        <tbody>${risksHtml}</tbody>
      </table>` : ''}

      ${plan.mitigations?.length ? `<h2>Mitigation concepts</h2>${mitigationsHtml}` : ''}

      ${plan.costs ? `
      <h2>Cost structure</h2>
      <div class="metrics-grid">
        <div class="metric"><div class="metric-label">Capital</div><div class="metric-value">${escapeHtml(costs.capitalRange)}</div></div>
        <div class="metric"><div class="metric-label">Annual operating</div><div class="metric-value">${escapeHtml(costs.annualOperating)}</div></div>
        <div class="metric"><div class="metric-label">Net local cost</div><div class="metric-value">${escapeHtml(costs.netLocalCost)}</div></div>
      </div>
      ${costs.timeline ? `<p>${escapeHtml(costs.timeline)}</p>` : ''}` : ''}

      ${plan.financingMechanisms?.length ? `<h2>Financing mechanisms</h2><ul>${financingHtml}</ul>` : ''}

      ${plan.jobs?.length ? `
      <h2>Jobs</h2>
      <table class="data-table">
        <thead><tr><th>Sector</th><th>Count</th><th>Type</th></tr></thead>
        <tbody>${jobsHtml}</tbody>
      </table>` : ''}

      ${(viability.profitable != null || viability.sustainable != null || viability.viable != null || viability.justification) ? `
      <h2>Viability</h2>
      <div class="metrics-grid">
        ${viability.profitable != null ? `<div class="metric"><div class="metric-label">Profitable</div><div class="metric-value">${escapeHtml(viability.profitable)}</div></div>` : ''}
        ${viability.sustainable != null ? `<div class="metric"><div class="metric-label">Sustainable</div><div class="metric-value">${escapeHtml(viability.sustainable)}</div></div>` : ''}
        ${viability.viable != null ? `<div class="metric"><div class="metric-label">Viable</div><div class="metric-value">${escapeHtml(viability.viable)}</div></div>` : ''}
      </div>
      ${viability.roi ? `<p><strong>ROI framing:</strong> ${escapeHtml(viability.roi)}</p>` : ''}
      ${viability.justification ? `<p>${escapeHtml(viability.justification)}</p>` : ''}` : ''}
    `;

    return this._wrap({
      title: `Climate Resilience Plan${place ? ` — ${place}` : ''}`,
      subtitle: 'Resilience Plan',
      body,
      filename: this._filename('resilience-plan', context),
    });
  }

  _buildGenericDoc(type, report, context) {
    return this._wrap({
      title: 'Earth Simulator Report',
      subtitle: type ?? 'Report',
      body: `<pre style="white-space:pre-wrap; font-size:12px; color:#33495a;">${escapeHtml(JSON.stringify(report, null, 2))}</pre>`,
      filename: this._filename(type ?? 'report', context),
    });
  }

  // ── Shared helpers ───────────────────────────────────────────────────────

  _placeLabel(context = {}) {
    return [context.city, context.region, context.target].filter(Boolean).join(', ');
  }

  _filename(slug, context = {}) {
    const place = context.city || context.target || 'global';
    const safe = String(place).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'report';
    const date = new Date().toISOString().slice(0, 10);
    return `${slug}-${safe}-${date}.html`;
  }

  _wrap({ title, subtitle, body, filename }) {
    const generated = formatDate();
    const disclaimer = buildDisclaimerHtml(generated);
    // Disclaimer HTML is assembled only here so every builder path (empowerment,
    // resilience, generic) — and therefore srcdoc + Blob download — includes it.
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>${DOC_STYLES}</style>
</head>
<body>
  <div class="doc">
    <header>
      <div class="doc-kicker">Earth Simulator</div>
      <h1>${escapeHtml(title)}</h1>
      <div class="doc-meta">${escapeHtml(subtitle)} · Generated ${escapeHtml(generated)}</div>
    </header>
    ${disclaimer.header}
    <main>${body}</main>
    ${disclaimer.footer}
  </div>
</body>
</html>`;
    return { title, filename, html };
  }

  // ── Modal ─────────────────────────────────────────────────────────────────

  _showModal({ title, filename, html }) {
    this._closeModal();

    const overlay = document.createElement('div');
    overlay.id = 'export-modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this._closeModal(); });

    const modal = document.createElement('div');
    modal.id = 'export-modal';

    const bar = document.createElement('div');
    bar.id = 'export-modal-bar';

    const titleEl = document.createElement('span');
    titleEl.className = 'export-modal-title';
    titleEl.textContent = title;

    const actions = document.createElement('div');
    actions.id = 'export-modal-actions';

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'export-btn export-btn--primary';
    downloadBtn.textContent = '⬇ Download';
    downloadBtn.addEventListener('click', () => this._download({ filename, html }));

    // Fallback for strict CSP environments where the srcdoc iframe preview is
    // blocked (frame-src): a top-level Blob URL navigation always renders.
    const openTabBtn = document.createElement('button');
    openTabBtn.className = 'export-btn';
    openTabBtn.textContent = '↗ Open in tab';
    openTabBtn.addEventListener('click', () => {
      const blob = new Blob([html], { type: 'text/html' });
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'export-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this._closeModal());

    actions.append(downloadBtn, openTabBtn, closeBtn);
    bar.append(titleEl, actions);

    const frame = document.createElement('iframe');
    frame.id = 'export-modal-frame';
    frame.setAttribute('sandbox', ''); // static render only — no scripts, no same-origin access
    frame.srcdoc = html;

    modal.append(bar, frame);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', this._onKeydown);

    this._overlay = overlay;
  }

  _closeModal() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    document.removeEventListener('keydown', this._onKeydown);
  }

  _download({ filename, html }) {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}
