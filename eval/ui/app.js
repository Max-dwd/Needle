const state = {
  data: null,
  selectedRunId: null,
  jobTimer: null,
  activeJobId: null,
  jobSince: 0,
  jobLog: [],
  jobSummary: null,
  pairFilter: 'all',
};

const els = {
  refresh: document.querySelector('#refresh'),
  runAll: document.querySelector('#run-all'),
  pipelineSelect: document.querySelector('#pipeline-select'),
  error: document.querySelector('#error'),
  runs: document.querySelector('#runs'),
  runHead: document.querySelector('#run-head'),
  metrics: document.querySelector('#metrics'),
  timing: document.querySelector('#timing'),
  alignmentSummary: document.querySelector('#alignment-summary'),
  pairs: document.querySelector('#pairs'),
  jobs: document.querySelector('#jobs'),
  overviewBody: document.querySelector('#overview-body'),
  overviewMeta: document.querySelector('#overview-meta'),
  addVideoForm: document.querySelector('#add-video-form'),
  videoUrl: document.querySelector('#video-url'),
  videoTier: document.querySelector('#video-tier'),
  videoDifficulty: document.querySelector('#video-difficulty'),
  videoLanguage: document.querySelector('#video-language'),
  videoNote: document.querySelector('#video-note'),
  submitUrl: document.querySelector('#submit-url'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeText(value) {
  return Array.from(
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ''),
  );
}

function lcsMask(reference, hypothesis) {
  const a = Array.from(reference || '');
  const b = Array.from(hypothesis || '');
  const dp = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const aKeep = new Array(a.length).fill(false);
  const bKeep = new Array(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      aKeep[i] = true;
      bKeep[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return { aKeep, bKeep };
}

function diffText(value, peer, side) {
  const text = String(value || '');
  if (!peer || value === peer) return escapeHtml(text);
  const chars = Array.from(text);
  const { aKeep, bKeep } =
    side === 'golden' ? lcsMask(value, peer) : lcsMask(peer, value);
  const keepMask = side === 'golden' ? aKeep : bKeep;
  const cls = side === 'golden' ? 'diff-del' : 'diff-add';

  // Group consecutive changed chars into single spans for cleaner markup.
  let html = '';
  let buffer = '';
  let inDiff = false;
  const flush = () => {
    if (!buffer) return;
    html += inDiff
      ? `<span class="${cls}">${escapeHtml(buffer)}</span>`
      : escapeHtml(buffer);
    buffer = '';
  };
  chars.forEach((char, index) => {
    const changed = !keepMask[index];
    if (changed !== inDiff) {
      flush();
      inDiff = changed;
    }
    buffer += char;
  });
  flush();
  return html;
}

function formatTime(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return '--:--';
  }
  const safe = Math.max(0, seconds);
  const total = Math.floor(safe);
  const ms = Math.round((safe - total) * 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const prefix = h > 0 ? `${String(h).padStart(2, '0')}:` : '';
  return `${prefix}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return `${Math.round(value * 1000) / 10}%`;
}

function formatMetric(value, suffix = '') {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '--';
  }
  return `${value}${suffix}`;
}

function metricCard(label, value, tone = '') {
  const cls = tone ? ` metric-${tone}` : '';
  return `<div class="metric${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function timingCard(label, value) {
  return `<div class="timing-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function statusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

const STATUS_TONE = {
  match: 'green',
  text_mismatch: 'amber',
  timestamp_drift: 'blue',
  missing_generated: 'red',
  extra_generated: 'red',
};

function statusTone(status) {
  return STATUS_TONE[status] || 'gray';
}

function gateBadge(run) {
  if (!run) return '<span class="badge badge-none">no run</span>';
  const gate = run.qualityGateResult;
  if (gate && typeof gate.passed === 'boolean') {
    return gate.passed
      ? '<span class="badge badge-pass">pass</span>'
      : '<span class="badge badge-fail">fail</span>';
  }
  if (run.status === 'failed') {
    return '<span class="badge badge-fail">error</span>';
  }
  return '<span class="badge badge-none">n/a</span>';
}

function setError(error) {
  if (!error) {
    els.error.hidden = true;
    els.error.textContent = '';
    return;
  }
  els.error.hidden = false;
  els.error.textContent = error;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `request failed: ${response.status}`);
  }
  return payload;
}

async function loadArtifacts(runId = state.selectedRunId) {
  setError(null);
  const query = runId ? `?run=${encodeURIComponent(runId)}` : '';
  const response = await fetch(`/api/artifacts${query}`, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to read eval artifacts');
  }
  const previousRunId = state.selectedRunId;
  state.data = payload;
  state.selectedRunId =
    payload.selected?.run?.runId || payload.runs?.[0]?.runId || null;
  if (state.selectedRunId !== previousRunId) {
    state.pairFilter = 'all';
  }
  render();
  maybeResumeJob();
}

function maybeResumeJob() {
  if (state.jobTimer) return;
  const running = (state.data?.jobs || []).find(
    (job) => job.status === 'running',
  );
  if (running) {
    pollJob(running.id);
  }
}

function formatRunTime(value) {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderRuns() {
  const runs = state.data?.runs || [];
  if (runs.length === 0) {
    els.runs.innerHTML = '<div class="empty-state">No eval runs found.</div>';
    return;
  }
  els.runs.innerHTML = runs
    .map(
      (run) => `
        <button class="run-button ${run.runId === state.selectedRunId ? 'active' : ''}" data-run="${escapeHtml(run.runId)}" type="button">
          <strong>${escapeHtml(run.caseId || run.id)}</strong>
          <span class="run-sub">${escapeHtml(formatRunTime(run.completedAt || run.startedAt))}${gateBadge(run)}</span>
        </button>
      `,
    )
    .join('');
  els.runs.querySelectorAll('[data-run]').forEach((button) => {
    button.addEventListener('click', () => {
      loadArtifacts(button.getAttribute('data-run')).catch((error) =>
        setError(error.message),
      );
    });
  });
}

function latestRunForCase(caseId, pipeline) {
  const runs = state.data?.runs || [];
  // runs are newest-first; take the first matching the case + selected pipeline.
  return (
    runs.find((run) => run.caseId === caseId && run.pipeline === pipeline) ||
    null
  );
}

function renderOverview(selectedRun) {
  const cases = state.data?.dataset?.cases || [];
  const pipeline = selectedPipeline();
  const latest = {};
  for (const entry of cases) {
    latest[entry.id] = latestRunForCase(entry.id, pipeline);
  }
  const passed = cases.filter(
    (entry) => latest[entry.id]?.qualityGateResult?.passed,
  ).length;
  const withRuns = cases.filter((entry) => latest[entry.id]).length;
  els.overviewMeta.textContent = cases.length
    ? `${pipeline} · ${passed}/${withRuns} gates passing · ${cases.length} cases`
    : '';

  if (cases.length === 0) {
    els.overviewBody.innerHTML =
      '<div class="empty-state">No cases yet. Submit a URL or build the golden set.</div>';
    return;
  }

  els.overviewBody.innerHTML = cases
    .map((entry) => {
      const run = latest[entry.id];
      const quality = run?.quality || {};
      const summary = run?.summary || {};
      const active = entry.id === selectedRun?.caseId ? 'active' : '';
      const clickable = run
        ? `data-overview-run="${escapeHtml(run.runId)}"`
        : '';
      return `
        <div class="overview-row ${active}" ${clickable}>
          <span class="cell-id" title="${escapeHtml(entry.id)}">
            <span class="id-text">${escapeHtml(entry.id)}</span>${entry.adhoc ? '<span class="tag">ad-hoc</span>' : ''}
          </span>
          <span class="cell-platform">${escapeHtml(entry.platform || '--')}</span>
          <span class="cell-gate">${gateBadge(run)}</span>
          <span class="num">${escapeHtml(formatPercent(quality.text?.coverage))}</span>
          <span class="num">${escapeHtml(formatMetric(quality.text?.normalizedCharErrorRate))}</span>
          <span class="num">${escapeHtml(formatMetric(quality.timing?.startMaeSeconds, 's'))}</span>
          <span class="num">${escapeHtml(formatMetric(summary.segmentCount))}</span>
          <span class="cell-run">
            <button class="run-mini" data-run-case="${escapeHtml(entry.id)}" type="button">Run</button>
            <button class="run-mini delete-mini" data-delete-case="${escapeHtml(entry.id)}" type="button" title="Delete this case (golden data, config target, runs)">Delete</button>
          </span>
        </div>
      `;
    })
    .join('');

  els.overviewBody.querySelectorAll('[data-overview-run]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-run-case]')) return;
      loadArtifacts(row.getAttribute('data-overview-run')).catch((error) =>
        setError(error.message),
      );
    });
  });
  els.overviewBody.querySelectorAll('[data-run-case]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      runCase(button.getAttribute('data-run-case'));
    });
  });
  els.overviewBody.querySelectorAll('[data-delete-case]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteCase(button.getAttribute('data-delete-case'));
    });
  });
}

function renderRunHead(selectedRun, selectedCase) {
  if (!selectedRun) {
    els.runHead.className = 'run-head empty';
    els.runHead.innerHTML = `
      <div>
        <div class="meta">No run selected</div>
        <h2>Run artifacts will appear here</h2>
        <p>Run a case from the overview, or pick an existing run.</p>
      </div>
    `;
    return;
  }

  els.runHead.className = 'run-head';
  els.runHead.innerHTML = `
    <div>
      <div class="meta">${escapeHtml(selectedRun.pipeline)} · ${escapeHtml(selectedRun.status)}</div>
      <h2>${escapeHtml(selectedCase?.title || selectedRun.id)}</h2>
      <p>
        ${escapeHtml(selectedRun.caseId || 'ad hoc eval')}
        ${selectedCase?.duration ? ` · ${escapeHtml(selectedCase.duration)}` : ''}
        ${selectedRun.completedAt ? ` · ${escapeHtml(new Date(selectedRun.completedAt).toLocaleString())}` : ''}
      </p>
    </div>
    <div class="path-pill" title="${escapeHtml(selectedRun.path)}">${escapeHtml(selectedRun.path)}</div>
  `;
}

function renderMetrics(selectedRun) {
  if (!selectedRun) {
    els.metrics.innerHTML = '';
    els.timing.innerHTML = '';
    return;
  }

  const quality = selectedRun.quality || {};
  const qualityGate = selectedRun.qualityGateResult || null;
  const summary = selectedRun.summary || {};
  const phaseTiming = selectedRun.phaseTiming || {};
  els.metrics.innerHTML = [
    metricCard(
      'Gate',
      qualityGate ? (qualityGate.passed ? 'pass' : 'fail') : 'n/a',
      qualityGate ? (qualityGate.passed ? 'pass' : 'fail') : '',
    ),
    metricCard('NCER', formatMetric(quality.text?.normalizedCharErrorRate)),
    metricCard('Coverage', formatPercent(quality.text?.coverage)),
    metricCard('Start MAE', formatMetric(quality.timing?.startMaeSeconds, 's')),
    metricCard('Start P95', formatMetric(quality.timing?.startP95Seconds, 's')),
    metricCard('Generated', formatMetric(summary.segmentCount)),
    metricCard('Reference', formatMetric(quality.segments?.referenceCount)),
    metricCard('Chunks', formatMetric(summary.chunkCount)),
  ].join('');

  els.timing.innerHTML = [
    timingCard('Total', formatDuration(phaseTiming.totalDurationMs)),
    timingCard(
      'Audio Prep',
      formatDuration(phaseTiming.audioPrepareDurationMs),
    ),
    timingCard('Transcribe', formatDuration(phaseTiming.transcribeDurationMs)),
    timingCard('Aligner', formatDuration(phaseTiming.alignerDurationMs)),
  ].join('');
}

function renderDiffToolbar(alignment) {
  const pairs = alignment?.pairs || [];
  if (pairs.length === 0) {
    els.alignmentSummary.innerHTML = '';
    els.alignmentSummary.hidden = true;
    return;
  }
  els.alignmentSummary.hidden = false;

  const counts = pairs.reduce((acc, pair) => {
    acc[pair.status] = (acc[pair.status] || 0) + 1;
    return acc;
  }, {});

  const filters = [
    { key: 'all', label: 'All', tone: '', value: pairs.length },
    { key: 'match', label: 'Match', tone: 'green', value: counts.match || 0 },
    {
      key: 'text_mismatch',
      label: 'Text',
      tone: 'amber',
      value: counts.text_mismatch || 0,
    },
    {
      key: 'timestamp_drift',
      label: 'Drift',
      tone: 'blue',
      value: counts.timestamp_drift || 0,
    },
    {
      key: 'missing_generated',
      label: 'Missing',
      tone: 'red',
      value: counts.missing_generated || 0,
    },
    {
      key: 'extra_generated',
      label: 'Extra',
      tone: 'red',
      value: counts.extra_generated || 0,
    },
  ];

  els.alignmentSummary.innerHTML = filters
    .map((filter) => {
      const active = state.pairFilter === filter.key ? ' active' : '';
      const toneCls = filter.tone ? ` tone-${filter.tone}` : '';
      const disabled =
        filter.key !== 'all' && filter.value === 0 ? ' disabled' : '';
      return `<button type="button" class="diff-filter${toneCls}${active}${disabled}" data-filter="${filter.key}"${disabled ? ' disabled' : ''}>
        <span class="dot"></span>${escapeHtml(filter.label)}<b>${filter.value}</b>
      </button>`;
    })
    .join('');

  els.alignmentSummary.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.pairFilter = button.getAttribute('data-filter');
      renderDiffToolbar(alignment);
      renderPairs(alignment);
    });
  });
}

function driftBadge(pair) {
  const drift = pair.startDriftSeconds;
  if (drift === null || drift === undefined || !Number.isFinite(drift)) {
    return '';
  }
  const text = `${drift >= 0 ? '+' : ''}${drift.toFixed(2)}s`;
  const heavy = Math.abs(drift) >= 1 ? ' drift-heavy' : '';
  return `<span class="drift${heavy}">${escapeHtml(text)}</span>`;
}

function subtitleCell(segment, peerText, side) {
  if (!segment) {
    const label =
      side === 'golden' ? 'no golden segment' : 'no generated segment';
    return `<div class="subtitle ${side}"><p class="missing-text">— ${label} —</p></div>`;
  }
  const range = `${formatTime(segment.start)} – ${formatTime(segment.end)}`;
  return `<div class="subtitle ${side}">
    <span class="range">${escapeHtml(range)}</span>
    <p>${diffText(segment.text, peerText || null, side)}</p>
  </div>`;
}

function similarityMeter(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '';
  }
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  const tone = pct >= 85 ? 'green' : pct >= 60 ? 'amber' : 'red';
  return `<div class="sim tone-${tone}">
    <div class="sim-track"><span style="width:${pct}%"></span></div>
    <small>${escapeHtml(formatPercent(value))}</small>
  </div>`;
}

function renderPairs(alignment) {
  const all = alignment?.pairs || [];
  if (all.length === 0) {
    els.pairs.innerHTML =
      '<div class="empty-state">No alignment artifact for this run.</div>';
    return;
  }

  const pairs =
    state.pairFilter === 'all'
      ? all
      : all.filter((pair) => pair.status === state.pairFilter);

  if (pairs.length === 0) {
    els.pairs.innerHTML =
      '<div class="empty-state">No segments match this filter.</div>';
    return;
  }

  els.pairs.innerHTML = pairs
    .map((pair) => {
      const golden = pair.golden;
      const generated = pair.generated;
      const anchor = golden?.start ?? generated?.start;
      return `
        <article class="pair tone-${statusTone(pair.status)}">
          <div class="time">
            <strong>${escapeHtml(formatTime(anchor))}</strong>
            ${driftBadge(pair)}
          </div>
          ${subtitleCell(golden, generated?.text, 'golden')}
          ${subtitleCell(generated, golden?.text, 'generated')}
          <div class="status">
            <span class="status-pill tone-${statusTone(pair.status)}">${escapeHtml(statusLabel(pair.status))}</span>
            ${pair.merged ? '<span class="merged-tag" title="Generated segment also covers other golden segments">merged</span>' : ''}
            ${similarityMeter(pair.textSimilarity)}
          </div>
        </article>
      `;
    })
    .join('');
}

function renderJob() {
  const summary = state.jobSummary;
  if (!summary) {
    els.jobs.hidden = true;
    return;
  }
  els.jobs.hidden = false;
  const stepInfo =
    summary.stepCount > 0
      ? `step ${Math.min(summary.stepIndex + 1, summary.stepCount)}/${summary.stepCount}`
      : '';
  const label = summary.stepLabel ? ` · ${summary.stepLabel}` : '';
  els.jobs.innerHTML = `
    <div class="jobs-head">
      <div>
        <span class="job-status job-${escapeHtml(summary.status)}">${escapeHtml(summary.status)}</span>
        <strong>${escapeHtml(summary.kind)}${summary.caseId ? ` · ${escapeHtml(summary.caseId)}` : ''}</strong>
        <span class="job-step">${escapeHtml(stepInfo)}${escapeHtml(label)}</span>
      </div>
      <button id="job-close" type="button" title="Hide console">Hide</button>
    </div>
    <pre class="jobs-log">${escapeHtml(state.jobLog.join('\n'))}</pre>
  `;
  const log = els.jobs.querySelector('.jobs-log');
  if (log) log.scrollTop = log.scrollHeight;
  const close = els.jobs.querySelector('#job-close');
  if (close) {
    close.addEventListener('click', () => {
      els.jobs.hidden = true;
    });
  }
}

async function pollJob(jobId) {
  if (state.jobTimer) {
    clearInterval(state.jobTimer);
    state.jobTimer = null;
  }
  state.activeJobId = jobId;
  state.jobSince = 0;
  state.jobLog = [];
  state.jobSummary = null;

  const tick = async () => {
    try {
      const response = await fetch(
        `/api/jobs?id=${encodeURIComponent(jobId)}&since=${state.jobSince}`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        if (state.jobTimer) clearInterval(state.jobTimer);
        state.jobTimer = null;
        return;
      }
      const data = await response.json();
      if (Array.isArray(data.log) && data.log.length) {
        state.jobLog.push(...data.log);
        state.jobSince = data.nextSince ?? state.jobSince;
      }
      state.jobSummary = data;
      renderJob();
      if (data.status !== 'running') {
        if (state.jobTimer) clearInterval(state.jobTimer);
        state.jobTimer = null;
        state.activeJobId = null;
        await loadArtifacts();
      }
    } catch {
      // transient; keep polling
    }
  };

  await tick();
  if (state.activeJobId === jobId) {
    state.jobTimer = setInterval(tick, 2000);
  }
}

function selectedPipeline() {
  return els.pipelineSelect?.value || 'llm-aligner';
}

async function runCase(caseId) {
  if (!caseId) return;
  setError(null);
  try {
    const job = await postJson('/api/run', {
      caseId,
      pipeline: selectedPipeline(),
    });
    await pollJob(job.jobId);
  } catch (error) {
    setError(error.message);
  }
}

async function deleteCase(caseId) {
  if (!caseId) return;
  if (
    !window.confirm(
      `Delete case "${caseId}"?\n\nThis removes its golden data, config target, and saved runs. This cannot be undone.`,
    )
  ) {
    return;
  }
  setError(null);
  try {
    await postJson('/api/delete-case', { caseId });
    if (state.selectedRunId && state.data?.selected?.run?.caseId === caseId) {
      state.selectedRunId = null;
    }
    await loadArtifacts();
  } catch (error) {
    setError(error.message);
  }
}

async function runAll() {
  setError(null);
  try {
    const job = await postJson('/api/run-all', {
      pipeline: selectedPipeline(),
    });
    await pollJob(job.jobId);
  } catch (error) {
    setError(error.message);
  }
}

async function submitUrl(event) {
  event.preventDefault();
  setError(null);
  const url = els.videoUrl.value.trim();
  if (!url) return;
  els.submitUrl.disabled = true;
  els.submitUrl.textContent = 'Submitting…';
  try {
    const job = await postJson('/api/submit-url', {
      url,
      tier: els.videoTier.value,
      difficulty: els.videoDifficulty.value,
      expectedLanguage: els.videoLanguage.value.trim(),
      note: els.videoNote.value.trim(),
      pipeline: selectedPipeline(),
    });
    els.videoUrl.value = '';
    els.videoNote.value = '';
    await pollJob(job.jobId);
  } catch (error) {
    setError(error.message);
  } finally {
    els.submitUrl.disabled = false;
    els.submitUrl.textContent = 'Build & run';
  }
}

function render() {
  const selectedRun = state.data?.selected?.run || null;
  const selectedCase = selectedRun?.caseId
    ? (state.data?.dataset?.cases || []).find(
        (entry) => entry.id === selectedRun.caseId,
      )
    : null;
  const alignment = state.data?.selected?.alignment || null;

  renderRuns();
  renderOverview(selectedRun);
  renderRunHead(selectedRun, selectedCase);
  renderMetrics(selectedRun);
  renderDiffToolbar(alignment);
  renderPairs(alignment);

  if (selectedRun?.error) {
    setError(selectedRun.error);
  }
}

els.refresh.addEventListener('click', () => {
  loadArtifacts().catch((error) => setError(error.message));
});
els.runAll.addEventListener('click', () => {
  runAll();
});
els.pipelineSelect?.addEventListener('change', () => {
  if (state.data) render();
});
els.addVideoForm.addEventListener('submit', submitUrl);

loadArtifacts().catch((error) => setError(error.message));
