/**
 * AttributionModal — "About the data" dialog (launch blocker #2).
 *
 * Renders /data/attribution.json (the CC BY 4.0 attribution record checked by
 * validate.py) into #attribution-modal. CC BY 4.0 sources (CMIP6, World Bank)
 * require visible attribution in the product, not just a repo file.
 *
 * All content is rendered with textContent/createElement — no innerHTML with
 * data-origin strings (see CLAUDE.md security section).
 */

const ATTRIBUTION_URL = '/data/attribution.json';

export class AttributionModal {
  constructor() {
    this._overlay = document.getElementById('attribution-overlay');
    this._modal = document.getElementById('attribution-modal');
    this._link = document.getElementById('attribution-link');
    /** @type {Promise<object> | null} lazy fetch, cached */
    this._dataPromise = null;

    this._onOpen = () => this.open();
    this._onOverlayClick = (e) => { if (e.target === this._overlay) this.close(); };
    this._onKeydown = (e) => { if (e.key === 'Escape' && this._isOpen()) this.close(); };

    this._link?.addEventListener('click', this._onOpen);
    this._overlay?.addEventListener('click', this._onOverlayClick);
    document.addEventListener('keydown', this._onKeydown);
  }

  destroy() {
    this._link?.removeEventListener('click', this._onOpen);
    this._overlay?.removeEventListener('click', this._onOverlayClick);
    document.removeEventListener('keydown', this._onKeydown);
  }

  _isOpen() {
    return this._overlay?.classList.contains('visible') ?? false;
  }

  async open() {
    if (!this._overlay || !this._modal) return;
    this._overlay.classList.add('visible');
    this._renderLoading();

    try {
      const data = await this._loadData();
      if (this._isOpen()) this._render(data);
    } catch (err) {
      console.error('[AttributionModal] Failed to load attribution.json:', err);
      if (this._isOpen()) this._renderError();
    }
  }

  close() {
    this._overlay?.classList.remove('visible');
  }

  _loadData() {
    if (!this._dataPromise) {
      this._dataPromise = fetch(ATTRIBUTION_URL).then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${ATTRIBUTION_URL}`);
        return r.json();
      }).catch((err) => {
        this._dataPromise = null; // allow retry on next open
        throw err;
      });
    }
    return this._dataPromise;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _renderHeader() {
    this._modal.replaceChildren();
    const header = el('div', 'attr-header');
    const title = el('h2', 'attr-title', 'About the data');
    title.id = 'attribution-title';
    const closeBtn = el('button', 'cp-close', '✕');
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', () => this.close());
    header.append(title, closeBtn);
    this._modal.appendChild(header);
  }

  _renderLoading() {
    this._renderHeader();
    this._modal.appendChild(el('div', 'attr-intro', 'Loading attribution…'));
  }

  _renderError() {
    this._renderHeader();
    this._modal.appendChild(el('div', 'attr-intro',
      'Could not load the attribution record. The sources are: CMIP6 (CC BY 4.0), ' +
      'World Bank Open Data (CC BY 4.0), Natural Earth (public domain), ' +
      'NOAA LOCA2 (US Government public domain).'));
  }

  /** @param {Record<string, {full_name?: string, license?: string, citation?: string, accessed_via?: string, url?: string}>} data */
  _render(data) {
    this._renderHeader();

    this._modal.appendChild(el('div', 'attr-intro',
      'Every statistic shown in this simulator comes from the openly licensed ' +
      'datasets below, baked into the app at build time. Visual renders are ' +
      'stylized; the numbers are not.'));

    for (const [key, src] of Object.entries(data)) {
      const card = el('div', 'attr-source');
      card.appendChild(el('div', 'attr-source-name', src.full_name ?? key));
      if (src.license) card.appendChild(el('span', 'attr-source-license', src.license));

      if (src.citation) {
        card.appendChild(el('div', 'attr-source-detail', `Citation: ${src.citation}`));
      }
      if (src.accessed_via) {
        card.appendChild(el('div', 'attr-source-detail', `Accessed via: ${src.accessed_via}`));
      }
      if (src.url) {
        const detail = el('div', 'attr-source-detail');
        const a = document.createElement('a');
        a.href = src.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = src.url;
        detail.appendChild(a);
        card.appendChild(detail);
      }
      this._modal.appendChild(card);
    }

    this._modal.appendChild(el('div', 'attr-intro',
      'CC BY 4.0 sources are used with attribution as required by the license. ' +
      'NASA GIBS imagery (globe tiles) is US Government public domain.'));
  }
}

// ── Tiny DOM helpers (module-private) ──────────────────────────────────────

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
