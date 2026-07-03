/**
 * CountryPanel — the slide-in inspector for a selected country.
 *
 * Consumes the baked data pipeline directly:
 *   /data/climate.json    — CMIP6 record for the current chapter + SSP
 *   /data/worldbank.json  — population, GDP, HDI, urban share
 *
 * EventBus contract:
 *   Listens: region:selected { iso, name, coords }   — opens/refreshes panel
 *            time:changed    { year, ssp }           — re-renders if open
 *   Emits:   region:cleared                          — on close (RegionPicker
 *            uses this to drop the selection highlight)
 *
 * All content is rendered with textContent/createElement — no innerHTML with
 * data-origin strings (see CLAUDE.md security section).
 */

import { EventBus } from '../core/EventBus.js';
import { isoDisplayName } from '../core/ISONormalizer.js';

const CLIMATE_URL = '/data/climate.json';
const WORLDBANK_URL = '/data/worldbank.json';

const SSP_LABELS = {
  'SSP2-4.5': 'SSP2-4.5 · "If we act"',
  'SSP5-8.5': 'SSP5-8.5 · "If we don\'t"',
};

const nfCompact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

function fmtPop(n)   { return n == null ? '—' : nfCompact.format(n); }
function fmtMoney(n) { return n == null ? '—' : `$${nfCompact.format(n)}`; }
function fmtNum(n, digits = 1, suffix = '') {
  return (n == null || Number.isNaN(n)) ? '—' : `${Number(n).toFixed(digits)}${suffix}`;
}
function fmtSigned(n, digits = 1, suffix = '') {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Number(n);
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

export class CountryPanel {
  /**
   * @param {{ timeController: import('../core/TimeController.js').TimeController }} deps
   */
  constructor({ timeController }) {
    this._time = timeController;
    this._panel = document.getElementById('country-panel');
    this._iso = null;
    this._name = null;

    /** @type {Promise<void> | null} lazy data fetch, cached */
    this._dataPromise = null;
    this._climate = null;
    this._worldbank = null;

    this._onSelected = ({ iso, name }) => this.open(iso, name);
    this._onTimeChanged = () => { if (this._iso) this._render(); };
    this._onKeydown = (e) => { if (e.key === 'Escape' && this._iso) this.close(); };

    EventBus.on('region:selected', this._onSelected);
    EventBus.on('time:changed', this._onTimeChanged);
    document.addEventListener('keydown', this._onKeydown);
  }

  destroy() {
    EventBus.off('region:selected', this._onSelected);
    EventBus.off('time:changed', this._onTimeChanged);
    document.removeEventListener('keydown', this._onKeydown);
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  async open(iso, name = null) {
    if (!this._panel || !iso) return;
    this._iso = iso;
    this._name = name ?? isoDisplayName(iso) ?? iso;
    this._panel.classList.add('open');
    this._panel.setAttribute('aria-hidden', 'false');

    try {
      await this._loadData();
    } catch (err) {
      console.error('[CountryPanel] Data load failed:', err);
    }
    // Selection may have changed while data was loading
    if (this._iso === iso) this._render();
  }

  close() {
    if (!this._panel) return;
    this._iso = null;
    this._name = null;
    this._panel.classList.remove('open');
    this._panel.setAttribute('aria-hidden', 'true');
    EventBus.emit('region:cleared', {});
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  _loadData() {
    if (!this._dataPromise) {
      this._dataPromise = Promise.all([
        fetch(CLIMATE_URL).then((r) => {
          if (!r.ok) throw new Error(`Failed to load ${CLIMATE_URL}`);
          return r.json();
        }),
        fetch(WORLDBANK_URL).then((r) => {
          if (!r.ok) throw new Error(`Failed to load ${WORLDBANK_URL}`);
          return r.json();
        }),
      ]).then(([climate, worldbank]) => {
        this._climate = climate;
        this._worldbank = worldbank;
      }).catch((err) => {
        this._dataPromise = null; // allow retry on next open
        throw err;
      });
    }
    return this._dataPromise;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    if (!this._panel || !this._iso) return;
    const iso = this._iso;
    const year = this._time.year;
    const ssp = this._time.ssp;

    const climate = this._climate?.[iso]?.[String(year)]?.[ssp] ?? null;
    const wb = this._worldbank?.[iso] ?? null;

    this._panel.replaceChildren();

    // ── Header ──
    const header = el('div', 'cp-header');
    const titleWrap = el('div');
    titleWrap.appendChild(el('h2', 'cp-title', this._name));
    titleWrap.appendChild(el('div', 'cp-subtitle', `${iso} · ${year} · ${SSP_LABELS[ssp] ?? ssp}`));
    const closeBtn = el('button', 'cp-close', '✕');
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.close());
    header.append(titleWrap, closeBtn);
    this._panel.appendChild(header);

    // ── Climate projection ──
    this._panel.appendChild(el('div', 'cp-section-title', `Climate projection — ${year}`));
    if (climate) {
      const grid = el('div', 'cp-grid');
      grid.append(
        stat('Temp anomaly', fmtSigned(climate.temperature_anomaly_c, 1, ' °C'), 'vs 1995–2014 baseline'),
        stat('Sea level rise', fmtSigned(climate.sea_level_rise_m, 2, ' m'), 'regional mean'),
        stat('Precipitation', fmtSigned(climate.precipitation_change_pct, 1, ' %'), 'annual change'),
        stat('Days over 35 °C', fmtNum(climate.heat_days_gt35c, 0), 'per year'),
        stat('Drought index', fmtNum(climate.drought_index, 2), '0 = none, 1 = extreme'),
        stat('Exposed population', fmtNum(
          climate.exposed_population_pct != null ? climate.exposed_population_pct * 100 : null, 1, ' %'),
          'to climate hazards'),
      );
      this._panel.appendChild(grid);

      const conf = el('div', 'cp-note');
      const tier = climate.coverage_tier ?? 'high';
      conf.textContent = tier === 'sparse'
        ? '⚠ Sparse CMIP6 coverage for this country — projections are low-confidence.'
        : `Model confidence: ${fmtNum((climate.confidence ?? 0) * 100, 0, '%')} · CMIP6 ensemble`;
      this._panel.appendChild(conf);
    } else {
      this._panel.appendChild(el('div', 'cp-note', 'No CMIP6 record for this country in the current bake.'));
    }

    // ── Socioeconomic ──
    this._panel.appendChild(el('div', 'cp-section-title', 'Socioeconomic (World Bank)'));
    if (wb) {
      const grid = el('div', 'cp-grid');
      grid.append(
        stat('Population', fmtPop(wb.population), 'latest vintage'),
        stat('GDP', fmtMoney(wb.gdp_usd), 'current US$'),
        stat('HDI', fmtNum(wb.hdi, 3), 'Human Development Index'),
        stat('Urban share', fmtNum(wb.urban_pct, 0, ' %'), 'of population'),
      );
      this._panel.appendChild(grid);
    } else {
      this._panel.appendChild(el('div', 'cp-note', 'No World Bank record for this country.'));
    }

    // ── Footer ──
    this._panel.appendChild(el('div', 'cp-footer',
      'Sources: CMIP6 ensemble (CC BY 4.0), World Bank Open Data (CC BY 4.0). ' +
      'Ask in chat for hazards, scenarios, or what you can do here.'));
  }
}

// ── Tiny DOM helpers (module-private) ──────────────────────────────────────

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stat(label, value, basis) {
  const wrap = el('div', 'cp-stat');
  wrap.appendChild(el('div', 'cp-stat-label', label));
  wrap.appendChild(el('div', 'cp-stat-value', value));
  if (basis) wrap.appendChild(el('div', 'cp-stat-basis', basis));
  return wrap;
}
