import { parseInfo } from './analysis-model.js';

export function createAnalysisEngine(workerUrl) {
  const listeners = new Set();
  let worker = null;
  let ready = false;
  let failed = false;
  let token = 0;
  let state = 'idle';
  let current = null;
  let queued = null;
  let lines = new Map();

  function emit(type, detail) {
    listeners.forEach((fn) => fn(type, detail));
  }

  function fail(message) {
    if (failed) return;
    failed = true;
    ready = false;
    state = 'idle';
    emit('error', { message });
  }

  function startJob(job) {
    if (!worker || failed || job.token !== token) return;
    current = job;
    queued = null;
    lines = new Map();
    state = 'thinking';
    worker.postMessage('setoption name UCI_LimitStrength value false');
    worker.postMessage('setoption name MultiPV value ' + job.multipv);
    worker.postMessage('position fen ' + job.fen);
    worker.postMessage(job.depth ? 'go depth ' + job.depth : 'go movetime ' + job.ms);
    emit('thinking', { token: job.token });
  }

  function onLine(line) {
    if (line === 'uciok') {
      worker.postMessage('isready');
      return;
    }
    if (line === 'readyok' && !ready && !failed) {
      ready = true;
      emit('ready', {});
      return;
    }
    const info = parseInfo(line);
    if (info && current && current.token === token) {
      lines.set(info.multipv, info);
      emit('info', { token: current.token, fen: current.fen, lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv) });
    }
    if (!line.startsWith('bestmove')) return;
    const uci = line.split(/\s+/)[1] || '(none)';
    if (state === 'stopping') {
      state = 'idle';
      const job = queued;
      current = null;
      queued = null;
      if (job && job.token === token) startJob(job);
      return;
    }
    const job = current;
    const found = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
    current = null;
    state = 'idle';
    if (!job || job.token !== token) return;
    emit('done', { token: job.token, fen: job.fen, uci, lines: found });
  }

  return {
    get ready() { return ready && !failed; },
    on(fn) { listeners.add(fn); },
    start() {
      worker = new Worker(workerUrl);
      worker.onmessage = (event) => {
        const data = event.data;
        if (typeof data === 'string') onLine(data.trim());
      };
      worker.onerror = () => fail('The engine failed to load.');
      worker.postMessage('uci');
    },
    search(fen, options) {
      if (failed || !ready) return false;
      const job = {
        fen,
        token,
        multipv: Math.min(3, Math.max(1, Number(options && options.multipv) || 1)),
        depth: options && options.depth ? Number(options.depth) : 0,
        ms: options && options.ms ? Number(options.ms) : 400
      };
      if (state === 'thinking' || state === 'stopping') {
        queued = job;
        if (state === 'thinking') {
          state = 'stopping';
          worker.postMessage('stop');
        }
        return true;
      }
      startJob(job);
      return true;
    },
    cancel() {
      token += 1;
      queued = null;
      if (state === 'thinking' && worker) {
        state = 'stopping';
        current = null;
        worker.postMessage('stop');
      } else if (state !== 'stopping') {
        state = 'idle';
        current = null;
      }
    }
  };
}
