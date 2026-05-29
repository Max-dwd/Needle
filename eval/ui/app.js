const state = {
  data: null,
  selectedRunId: null,
};

const els = {
  refresh: document.querySelector('#refresh'),
  error: document.querySelector('#error'),
  runs: document.querySelector('#runs'),
  cases: document.querySelector('#cases'),
  pipelines: document.querySelector('#pipelines'),
  runHead: document.querySelector('#run-head'),
  metrics: document.querySelector('#metrics'),
  timing: document.querySelector('#timing'),
  alignmentSummary: document.querySelector('#alignment-summary'),
  pairs: document.querySelector('#pairs'),
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
  if (!peer || value === peer) return escapeHtml(value);
  const chars = Array.from(String(value || ''));
  const { aKeep, bKeep } =
    side === 'golden' ? lcsMask(value, peer) : lcsMask(peer, value);
  const keepMask = side === 'golden' ? aKeep : bKeep;
  return chars
    .map((char, index) =>
      keepMask[index]
        ? escapeHtml(char)
        : `<span class="diff">${escapeHtml(char)}</span>`,
    )
    .join('');
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

function metricCard(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function timingCard(label, value) {
  return `<div class="timing-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function statusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
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

async function loadArtifacts(runId = state.selectedRunId) {
  setError(null);
  const query = runId ? `?run=${encodeURIComponent(runId)}` : '';
  const response = await fetch(`/api/artifacts${query}`, { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || 'Failed to read eval artifacts');
  }
  state.data = payload;
  state.selectedRunId =
    payload.selected?.run?.runId || payload.runs?.[0]?.runId || null;
  render();
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
          <strong>${escapeHtml(run.id)}</strong>
          <span>${escapeHtml(run.pipeline)}${run.caseId ? ` · ${escapeHtml(run.caseId)}` : ''}</span>
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

function renderCases(selectedRun) {
  const cases = state.data?.dataset?.cases || [];
  els.cases.innerHTML = cases
    .map(
      (entry) => `
        <div class="case-item ${entry.id === selectedRun?.caseId ? 'active' : ''}">
          <strong>${escapeHtml(entry.id)}</strong>
          <span>${escapeHtml(entry.platform || 'case')} · ${escapeHtml(formatMetric(entry.segmentCount))}</span>
        </div>
      `,
    )
    .join('');
}

function renderPipelines() {
  const pipelines = Array.from(
    new Set((state.data?.runs || []).map((run) => run.pipeline)),
  );
  els.pipelines.innerHTML = pipelines.length
    ? pipelines
        .map((pipeline) => `<span>${escapeHtml(pipeline)}</span>`)
        .join('')
    : '<span>none</span>';
}

function renderRunHead(selectedRun, selectedCase) {
  if (!selectedRun) {
    els.runHead.className = 'run-head empty';
    els.runHead.innerHTML = `
      <div>
        <div class="meta">No run selected</div>
        <h2>Run artifacts will appear here</h2>
        <p>Run the CLI harness, then refresh this viewer.</p>
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
    ),
    metricCard('NCER', formatMetric(quality.text?.normalizedCharErrorRate)),
    metricCard('Coverage', formatPercent(quality.text?.coverage)),
    metricCard('Start MAE', formatMetric(quality.timing?.startMaeSeconds, 's')),
    metricCard('Start P95', formatMetric(quality.timing?.startP95Seconds, 's')),
    metricCard('Generated', formatMetric(summary.segmentCount)),
    metricCard('Reference', formatMetric(quality.segments?.referenceCount)),
    metricCard('Chunks', formatMetric(summary.chunkCount)),
    metricCard('Fallback', formatPercent(summary.fallbackRatio)),
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

function renderAlignmentSummary(alignment) {
  if (!alignment) {
    els.alignmentSummary.innerHTML = '';
    return;
  }
  const summary = alignment.summary || {};
  els.alignmentSummary.innerHTML = [
    `pairs ${summary.pairCount ?? 0}`,
    `text ${summary.textMismatchCount ?? 0}`,
    `missing ${summary.missingGeneratedCount ?? 0}`,
    `extra ${summary.extraGeneratedCount ?? 0}`,
    `drift ${summary.timestampDriftCount ?? 0}`,
  ]
    .map((entry) => `<span>${escapeHtml(entry)}</span>`)
    .join('');
}

function renderPairs(alignment) {
  const pairs = alignment?.pairs || [];
  if (pairs.length === 0) {
    els.pairs.innerHTML =
      '<div class="empty-state">No alignment artifact for this run.</div>';
    return;
  }

  els.pairs.innerHTML = pairs
    .map((pair) => {
      const golden = pair.golden;
      const generated = pair.generated;
      const drift =
        pair.startDriftSeconds === null || pair.startDriftSeconds === undefined
          ? ''
          : `${pair.startDriftSeconds >= 0 ? '+' : ''}${pair.startDriftSeconds.toFixed(2)}s`;
      return `
        <article class="pair ${escapeHtml(pair.status)}">
          <div class="time">
            <strong>${escapeHtml(formatTime(golden?.start ?? generated?.start))}</strong>
            <span>${escapeHtml(drift)}</span>
          </div>
          <div class="subtitle">
            ${
              golden
                ? `<span class="range">${escapeHtml(formatTime(golden.start))} - ${escapeHtml(formatTime(golden.end))}</span><p>${diffText(golden.text, generated?.text || null, 'golden')}</p>`
                : '<p class="missing-text">--</p>'
            }
          </div>
          <div class="subtitle">
            ${
              generated
                ? `<span class="range">${escapeHtml(formatTime(generated.start))} - ${escapeHtml(formatTime(generated.end))}</span><p>${diffText(generated.text, golden?.text || null, 'generated')}</p>`
                : '<p class="missing-text">--</p>'
            }
          </div>
          <div class="status">
            <span>${escapeHtml(statusLabel(pair.status))}</span>
            ${
              pair.textSimilarity === null || pair.textSimilarity === undefined
                ? ''
                : `<small>${escapeHtml(formatPercent(pair.textSimilarity))}</small>`
            }
          </div>
        </article>
      `;
    })
    .join('');
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
  renderCases(selectedRun);
  renderPipelines();
  renderRunHead(selectedRun, selectedCase);
  renderMetrics(selectedRun);
  renderAlignmentSummary(alignment);
  renderPairs(alignment);

  if (selectedRun?.error) {
    setError(selectedRun.error);
  }
}

els.refresh.addEventListener('click', () => {
  loadArtifacts().catch((error) => setError(error.message));
});

loadArtifacts().catch((error) => setError(error.message));
