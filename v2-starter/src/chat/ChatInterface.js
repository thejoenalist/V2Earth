/**
 * ChatInterface — the conversational UI.
 *
 * Responsibilities:
 *  - Wires the input field → ScenarioParser → SimulationCommand → EventBus
 *  - Renders Claude's narrative response into the message thread
 *  - Shows compound event alerts when EventSimulator detects a stacked relationship
 *  - Shows the EJECT button when simulations are active (clears the stack)
 *  - Renders the empowerment quiz as interactive multiple-choice buttons
 *  - Renders the report card after quiz completion
 *  - Offers the empowerment quiz automatically after resilience_plan responses
 *
 * No persistent chat history — session resets on reload (by design for V2).
 */

import { EventBus } from '../core/EventBus.js';
import { ScenarioParser } from './ScenarioParser.js';

export class ChatInterface {
  /**
   * @param {{ timeController: import('../core/TimeController.js').TimeController }} deps
   */
  constructor({ timeController }) {
    this._timeController = timeController;
    this._parser         = new ScenarioParser();
    this._input          = document.getElementById('chat-input');
    this._submit         = document.getElementById('chat-submit');
    this._messages       = document.getElementById('chat-messages');
    this._ejectBtn       = document.getElementById('chat-eject-btn');
    this._isLoading      = false;

    /** Active quiz state */
    this._activeQuiz     = null;   // { questions, answers: {} }

    this._wire();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  _wire() {
    this._submit?.addEventListener('click', () => this._handleSubmit());
    this._input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._handleSubmit(); }
    });

    // Eject button clears the simulation stack
    this._ejectBtn?.addEventListener('click', () => {
      EventBus.emit('simulation:eject');
      this._addMessage('system', '↩ Simulation cleared. Ready for something new.');
      if (this._ejectBtn) this._ejectBtn.style.display = 'none';
    });

    // Show/hide eject button based on simulation stack depth
    EventBus.on('simulation:stack_changed', ({ stack }) => {
      if (this._ejectBtn) {
        this._ejectBtn.style.display = stack.length > 0 ? 'flex' : 'none';
      }
    });

    EventBus.on('simulation:ejected', () => {
      if (this._ejectBtn) this._ejectBtn.style.display = 'none';
    });

    // Compound event alert from EventSimulator
    EventBus.on('simulation:compound_detected', ({ compound }) => {
      this._renderCompoundAlert(compound);
    });
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async _handleSubmit() {
    const text = this._input?.value?.trim();
    if (!text || this._isLoading) return;

    this._input.value = '';
    this._isLoading   = true;
    this._submit.disabled = true;

    this._addMessage('user', text);
    EventBus.emit('chat:query', { text, sessionId: null });

    const loadingEl = this._addMessage('assistant', '…');

    try {
      const command = await this._parser.parse(text, {
        year: this._timeController.year,
        ssp:  this._timeController.ssp,
      });

      loadingEl.remove();
      EventBus.emit('simulation:requested', command);
      this._renderNarrative(command);

      if (command.params?.year && command.type !== 'explain') {
        const snap = this._timeController.snapToNearest(command.params.year);
        this._timeController.setChapter(snap);
      }

    } catch (err) {
      loadingEl.remove();
      this._addMessage('error', 'Could not process that scenario. Try again.');
      console.error('[ChatInterface]', err);
    }

    this._isLoading       = false;
    this._submit.disabled = false;
    this._input?.focus();
  }

  // ── Narrative routing ─────────────────────────────────────────────────────

  /** @param {import('./SimulationCommand.js').SimulationCommand} command */
  _renderNarrative(command) {
    const { type, narrative } = command;
    if (!narrative) return;

    if (type === 'empowerment_quiz') {
      if (narrative.quiz)   this._renderQuiz(narrative.quiz);
      if (narrative.report) this._renderReportCard(narrative.report);
      return;
    }
    if (narrative.local)    { this._renderLocalAction(narrative);    return; }
    if (narrative.plan)     { this._renderResiliencePlan(narrative); return; }
    if (narrative.research) { this._renderResearchQuery(narrative);  return; }

    // Default
    if (narrative.learned) this._addMessage('assistant', `📊 ${narrative.learned}`);
    if (narrative.action)  this._addMessage('assistant', `🔧 ${narrative.action}`);
    if (narrative.emotion) this._addMessage('assistant', `🌍 ${narrative.emotion}`);
    if (narrative.sources?.length) {
      this._addMessage('assistant', `Sources: ${narrative.sources.join(', ')}`);
    }
  }

  // ── Render: local_action ──────────────────────────────────────────────────

  _renderLocalAction({ local, learned, sources }) {
    if (learned)               this._addMessage('assistant', `🌡️ ${learned}`);
    if (local.whatsComingHere) this._addMessage('assistant', `📍 What's coming here:\n${local.whatsComingHere}`);
    if (local.opportunities?.length) {
      const list = local.opportunities.map((o, i) => `${i + 1}. ${o}`).join('\n');
      this._addMessage('assistant', `✅ What you can do:\n${list}`);
    }
    if (local.whatCityIsDoing) this._addMessage('assistant', `🏙️ What's already happening:\n${local.whatCityIsDoing}`);
    if (local.leverage)        this._addMessage('assistant', `⚡ Your leverage:\n${local.leverage}`);
    if (sources?.length)       this._addMessage('assistant', `Sources: ${sources.join(', ')}`);
  }

  // ── Render: resilience_plan ───────────────────────────────────────────────

  _renderResiliencePlan({ plan, learned, sources }) {
    if (learned) this._addMessage('assistant', `📊 ${learned}`);

    if (plan.risks?.length) {
      const lines = plan.risks.map(r =>
        `• ${r.hazard} [${r.tier}]: ${r.projection} — ${r.economicExposure}`
      ).join('\n');
      this._addMessage('assistant', `⚠️ Key risks:\n${lines}`);
    }
    if (plan.mitigations?.length) {
      const lines = plan.mitigations.map((m, i) => `${i + 1}. ${m.name}: ${m.concept}`).join('\n');
      this._addMessage('assistant', `🔧 Mitigations:\n${lines}`);
    }
    if (plan.costs) {
      const c = plan.costs;
      this._addMessage('assistant',
        `💰 ${c.capitalRange} capital | ${c.annualOperating} operating | ${c.netLocalCost} net local\n${c.timeline}`
      );
    }
    if (plan.financingMechanisms?.length) {
      this._addMessage('assistant', `🏛️ Financing:\n${plan.financingMechanisms.map(f => `• ${f}`).join('\n')}`);
    }
    if (plan.jobs?.length) {
      const lines = plan.jobs.map(j => `• ${j.sector}: ${j.count} (${j.type})`).join('\n');
      this._addMessage('assistant', `👷 Jobs:\n${lines}`);
    }
    if (plan.viability) this._addMessage('assistant', `✅ Viability: ${plan.viability.justification}`);
    if (sources?.length) this._addMessage('assistant', `Sources: ${sources.join(', ')}`);

    // Auto-offer the quiz after a resilience plan
    if (plan.exportable) {
      setTimeout(() => this._offerQuiz(), 1200);
    }
  }

  // ── Render: research_query ────────────────────────────────────────────────

  _renderResearchQuery({ research, learned, sources }) {
    if (learned) this._addMessage('assistant', `📊 ${learned}`);
    if (research.limitations)    this._addMessage('assistant', `⚠️ Limitations: ${research.limitations}`);
    if (research.subNationalNote) this._addMessage('assistant', `🗺️ Sub-national: ${research.subNationalNote}`);
    if (research.causalRelationships?.length) {
      const lines = research.causalRelationships.map(r =>
        `• ${r.from} → ${r.to} (${r.direction}, ${Math.round(r.confidence * 100)}% confidence, lag ${r.lag})`
      ).join('\n');
      this._addMessage('assistant', `🔗 Causal relationships:\n${lines}`);
    }
    if (research.scenarioComparisons?.length) {
      const lines = research.scenarioComparisons.map(s =>
        `• ${s.variable} ${s.year}: SSP2=${s.ssp245Value} vs SSP5=${s.ssp585Value} ${s.unit}${s.uncertaintyRange ? ` (${s.uncertaintyRange})` : ''}`
      ).join('\n');
      this._addMessage('assistant', `📈 SSP comparisons:\n${lines}`);
    }
    if (sources?.length) this._addMessage('assistant', `Sources: ${sources.join(', ')}`);
  }

  // ── Render: compound alert ────────────────────────────────────────────────

  _renderCompoundAlert(compound) {
    const el = this._createMessageEl('compound');
    const newRisks = compound.newRisks?.length
      ? `\n⚡ New risks: ${compound.newRisks.slice(0, 4).join(', ')}`
      : '';
    el.textContent = `🔥 Compound event: ${compound.label}\n${compound.chatPrompt}${newRisks}`;
    el.style.background = 'rgba(255,140,0,0.12)';
    el.style.borderColor = 'rgba(255,140,0,0.4)';
    el.style.color = '#ffd080';
    this._messages?.appendChild(el);
    this._messages?.scrollTo({ top: this._messages.scrollHeight, behavior: 'smooth' });
  }

  // ── Render: empowerment quiz offer ────────────────────────────────────────

  _offerQuiz() {
    const offerEl = this._createMessageEl('assistant');
    offerEl.style.background = 'rgba(74,168,232,0.1)';
    offerEl.style.borderColor = 'rgba(74,168,232,0.35)';
    offerEl.style.color = '#a8d8f0';

    const btn = document.createElement('button');
    btn.style.cssText = `
      display:block; margin-top:10px; padding:8px 18px; border-radius:8px;
      border:1px solid rgba(74,168,232,0.5); background:rgba(74,168,232,0.15);
      color:#7ec8e3; cursor:pointer; font-size:13px;
    `;
    btn.textContent = 'Start the quiz →';
    btn.addEventListener('click', () => {
      offerEl.remove();
      this._input.value = 'Generate an empowerment quiz based on this resilience plan';
      this._handleSubmit();
    });

    offerEl.textContent = '🌱 Want to put your mitigation strategy to the test?';
    offerEl.appendChild(btn);
    this._messages?.appendChild(offerEl);
    this._messages?.scrollTo({ top: this._messages.scrollHeight, behavior: 'smooth' });
  }

  // ── Render: quiz ──────────────────────────────────────────────────────────

  /** @param {import('./SimulationCommand.js').QuizPayload} quiz */
  _renderQuiz(quiz) {
    this._addMessage('assistant',
      `🧭 ${quiz.contextSummary}\n\nAnswer each question — I'll score your strategy and generate a personalized report.`
    );
    this._activeQuiz = { questions: quiz.questions, answers: {} };

    for (const q of quiz.questions) {
      const qEl = this._createMessageEl('assistant');
      qEl.dataset.questionId = q.id;

      const qText = document.createElement('div');
      qText.style.cssText = 'margin-bottom:10px; font-weight:500;';
      qText.textContent = q.question;
      qEl.appendChild(qText);

      for (const choice of q.choices) {
        const btn = document.createElement('button');
        btn.style.cssText = `
          display:block; width:100%; text-align:left; margin:4px 0; padding:8px 12px;
          border-radius:8px; border:1px solid rgba(80,160,220,0.2);
          background:rgba(74,168,232,0.08); color:#a8d8f0; cursor:pointer; font-size:13px;
        `;
        btn.textContent = `${choice.id.toUpperCase()}. ${choice.text}`;
        btn.addEventListener('click', () => this._handleQuizAnswer(q.id, choice, qEl));
        qEl.appendChild(btn);
      }

      this._messages?.appendChild(qEl);
    }
    this._messages?.scrollTo({ top: this._messages.scrollHeight, behavior: 'smooth' });
  }

  _handleQuizAnswer(questionId, choice, questionEl) {
    if (!this._activeQuiz) return;
    this._activeQuiz.answers[questionId] = choice;

    // Lock question and show rationale
    const label = questionEl.querySelector('div')?.textContent ?? '';
    questionEl.innerHTML = '';
    const summary = document.createElement('div');
    summary.style.cssText = 'font-size:12px; color:#7ec8e3; margin-bottom:6px;';
    summary.textContent = label;
    const rationale = document.createElement('div');
    rationale.style.cssText = 'padding:8px; border-radius:6px; background:rgba(74,168,232,0.1); color:#7ec8e3; font-size:12px;';
    rationale.textContent = `✓ ${choice.text} — ${choice.rationale}`;
    questionEl.appendChild(summary);
    questionEl.appendChild(rationale);

    const answered = Object.keys(this._activeQuiz.answers).length;
    const total    = this._activeQuiz.questions.length;

    if (answered === total) {
      const score   = Object.values(this._activeQuiz.answers).reduce((s, c) => s + c.score, 0);
      const maxScore = total * 3;
      const pct     = Math.round((score / maxScore) * 100);
      this._addMessage('assistant', `All questions answered. Score: ${score}/${maxScore} (${pct}%). Generating your report card…`);
      this._activeQuiz = null;
      setTimeout(() => {
        this._input.value = `Generate my empowerment report card. I scored ${pct}% on the quiz.`;
        this._handleSubmit();
      }, 800);
    }
  }

  // ── Render: report card ───────────────────────────────────────────────────

  /** @param {import('./SimulationCommand.js').EmpowermentReport} report */
  _renderReportCard(report) {
    const gradeColors = { A: '#4ae88a', B: '#7ec8e3', C: '#ffd080', D: '#ff9a4a', F: '#e85a4a' };
    const color = gradeColors[report.grade] ?? '#d0e8f5';

    const card = this._createMessageEl('assistant');
    card.style.border = `2px solid ${color}40`;
    card.style.padding = '18px 20px';

    const metricsHtml = (report.metrics ?? []).map(m =>
      `<div style="margin:6px 0; padding:8px 10px; background:rgba(255,255,255,0.04); border-radius:6px;">
        <span style="color:#7ec8e3">${m.label}:</span>
        <strong style="color:#d0e8f5"> ${m.value}</strong>
        <div style="font-size:11px; color:#5a8a9a; margin-top:2px">${m.basis}</div>
      </div>`
    ).join('');

    const stepsHtml = (report.nextSteps ?? []).map((s, i) =>
      `<div style="margin:4px 0">${i + 1}. ${s}</div>`
    ).join('');

    card.innerHTML = `
      <div style="display:flex; align-items:center; gap:14px; margin-bottom:14px;">
        <div style="font-size:42px; font-weight:700; color:${color}; line-height:1">${report.grade}</div>
        <div>
          <div style="font-size:15px; font-weight:600; color:${color}">${report.gradeLabel}</div>
          <div style="font-size:11px; color:#5a8a9a; margin-top:2px">Climate Hazard Readiness Report</div>
        </div>
      </div>
      <div style="margin-bottom:14px; font-size:13px; color:#a8d8f0; line-height:1.55">${report.keyInsight}</div>
      <div style="margin-bottom:14px">${metricsHtml}</div>
      <div style="margin-bottom:14px; color:#d0e8f5">
        <div style="font-size:11px; color:#5a8a9a; margin-bottom:6px; text-transform:uppercase; letter-spacing:.06em">Next Steps</div>
        ${stepsHtml}
      </div>
      <button class="download-report-btn" style="
        padding:9px 18px; border-radius:8px; border:1px solid ${color}60;
        background:${color}18; color:${color}; cursor:pointer; font-size:13px;
      ">📄 Download Report Card</button>
    `;

    card.querySelector('.download-report-btn')?.addEventListener('click', () => {
      EventBus.emit('report:export_requested', { type: 'empowerment_report', report });
    });

    this._messages?.appendChild(card);
    this._messages?.scrollTo({ top: this._messages.scrollHeight, behavior: 'smooth' });
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * @param {'user'|'assistant'|'error'|'system'|'compound'} role
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  _createMessageEl(role, text) {
    const el = document.createElement('div');
    el.className = `chat-message chat-message--${role}`;
    el.style.cssText = `
      padding: 10px 14px;
      border-radius: 16px;
      font-size: 13px;
      line-height: 1.55;
      max-width: 90%;
      white-space: pre-wrap;
      background: ${role === 'user' ? 'rgba(74,168,232,0.15)' : role === 'system' ? 'rgba(255,255,255,0.04)' : 'rgba(8,20,32,0.9)'};
      border: 1px solid ${role === 'user' ? 'rgba(74,168,232,0.3)' : role === 'system' ? 'rgba(255,255,255,0.1)' : 'rgba(80,160,220,0.12)'};
      color: ${role === 'error' ? '#e85a4a' : role === 'system' ? '#5a8a9a' : '#d0e8f5'};
      align-self: ${role === 'user' ? 'flex-end' : 'flex-start'};
      backdrop-filter: blur(8px);
    `;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * Create, append, scroll-into-view, and return a message element.
   * @param {'user'|'assistant'|'error'|'system'} role
   * @param {string} text
   * @returns {HTMLElement}
   */
  _addMessage(role, text) {
    const el = this._createMessageEl(role, text);
    this._messages?.appendChild(el);
    this._messages?.scrollTo({ top: this._messages.scrollHeight, behavior: 'smooth' });
    return el;
  }
}
