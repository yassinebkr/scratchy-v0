const crypto = require('crypto');

class RunTracker {
  constructor() {
    this._runs = new Map();
    this._activeRun = null;
    this._activeStep = null;
    this._listeners = [];
    this._textActive = false;
  }

  startRun(threadId) {
    const runId = crypto.randomUUID();
    const run = { runId, threadId, status: 'running', steps: [], startedAt: Date.now(), finishedAt: null, error: null };
    this._runs.set(runId, run);
    this._activeRun = runId;
    this._emit('RUN_STARTED', { type: 'RUN_STARTED', threadId, runId, timestamp: Date.now() });
    return { runId, threadId };
  }

  finishRun(runId) {
    const run = this._runs.get(runId);
    if (!run) return;
    run.status = 'finished';
    run.finishedAt = Date.now();
    if (this._activeRun === runId) this._activeRun = null;
    this._activeStep = null;
    this._textActive = false;
    this._emit('RUN_FINISHED', { type: 'RUN_FINISHED', runId, threadId: run.threadId, durationMs: run.finishedAt - run.startedAt, steps: run.steps.length, timestamp: Date.now() });
  }

  errorRun(runId, error) {
    const run = this._runs.get(runId);
    if (!run) return;
    run.status = 'error';
    run.error = error;
    run.finishedAt = Date.now();
    if (this._activeRun === runId) this._activeRun = null;
    this._activeStep = null;
    this._textActive = false;
    this._emit('RUN_ERROR', { type: 'RUN_ERROR', runId, threadId: run.threadId, error, timestamp: Date.now() });
  }

  startStep(runId, stepName, metadata) {
    const run = this._runs.get(runId);
    if (!run) return null;
    const stepId = crypto.randomUUID();
    const step = { stepId, stepName, metadata, startedAt: Date.now(), finishedAt: null };
    run.steps.push(step);
    this._activeStep = stepId;
    this._emit('STEP_STARTED', { type: 'STEP_STARTED', runId, stepId, stepName, metadata, timestamp: Date.now() });
    return stepId;
  }

  finishStep(stepId) {
    for (const run of this._runs.values()) {
      const step = run.steps.find(s => s.stepId === stepId);
      if (step) {
        step.finishedAt = Date.now();
        if (this._activeStep === stepId) this._activeStep = null;
        this._emit('STEP_FINISHED', { type: 'STEP_FINISHED', runId: run.runId, stepId, stepName: step.stepName, durationMs: step.finishedAt - step.startedAt, timestamp: Date.now() });
        return;
      }
    }
  }

  textStart(runId) {
    this._textActive = true;
    this._emit('TEXT_MESSAGE_START', { type: 'TEXT_MESSAGE_START', runId, timestamp: Date.now() });
  }

  textContent(runId, delta) {
    this._emit('TEXT_MESSAGE_CONTENT', { type: 'TEXT_MESSAGE_CONTENT', runId, delta, timestamp: Date.now() });
  }

  textEnd(runId) {
    this._textActive = false;
    this._emit('TEXT_MESSAGE_END', { type: 'TEXT_MESSAGE_END', runId, timestamp: Date.now() });
  }

  on(event, callback) {
    this._listeners.push({ event, callback });
  }

  _emit(event, data) {
    for (const l of this._listeners) {
      if (l.event === event || l.event === '*') {
        try { l.callback(data); } catch (_) {}
      }
    }
  }

  getActiveRun() {
    return this._activeRun ? this._runs.get(this._activeRun) : null;
  }

  getRun(runId) {
    return this._runs.get(runId) || null;
  }

  processGatewayActivity(activity, threadId) {
    const type = activity && activity.type;

    if (type === 'thinking') {
      if (!this._activeRun) {
        this.startRun(threadId);
        this.textStart(this._activeRun);
      }
    } else if (type === 'tool') {
      if (!this._activeRun) this.startRun(threadId);
      if (this._textActive) this.textEnd(this._activeRun);
      if (this._activeStep) this.finishStep(this._activeStep);
      this.startStep(this._activeRun, activity.name || 'tool', activity);
    } else if (type === 'done') {
      if (this._activeStep) this.finishStep(this._activeStep);
      if (this._activeRun) {
        if (this._textActive) this.textEnd(this._activeRun);
        this.finishRun(this._activeRun);
      }
    }
  }

  processGatewayChatEvent(chatEvent, threadId) {
    const state = chatEvent && chatEvent.state;
    const text = chatEvent.message && chatEvent.message.content && chatEvent.message.content[0] && chatEvent.message.content[0].text;

    if (state === 'delta') {
      if (!this._activeRun) {
        this.startRun(threadId);
        this.textStart(this._activeRun);
      }
      if (!this._textActive) this.textStart(this._activeRun);
      if (this._activeStep) this.finishStep(this._activeStep);
      this.textContent(this._activeRun, text || '');
    } else if (state === 'final') {
      if (this._activeRun) {
        if (this._textActive) this.textEnd(this._activeRun);
        this.finishRun(this._activeRun);
      }
    }
  }

  emitStateSnapshot(state) {
    this._emit('STATE_SNAPSHOT', { type: 'STATE_SNAPSHOT', state, timestamp: Date.now() });
  }

  emitStateDelta(patches) {
    this._emit('STATE_DELTA', { type: 'STATE_DELTA', patches, timestamp: Date.now() });
  }
}

module.exports = { RunTracker };
