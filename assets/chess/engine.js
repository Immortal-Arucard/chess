import { strengthCommands } from './bot-prefs.js';

export function createEngine(workerUrl) {
  const listeners = new Set();
  let worker = null;
  let ready = false;
  let failed = false;
  let token = 0;
  let state = 'idle';
  let current = null;
  let queued = null;
  let bootTimer = 0;
  let elo = 1600;

  function emit(type, detail) {
    listeners.forEach((fn) => fn(type, detail));
  }

  function fail(message) {
    if (failed) return;
    failed = true;
    ready = false;
    state = 'idle';
    current = null;
    queued = null;
    window.clearTimeout(bootTimer);
    emit('error', { message });
  }

  function startJob(job) {
    if (!worker || failed || job.token !== token) return;
    current = job;
    queued = null;
    state = 'thinking';
    strengthCommands(job.elo == null ? elo : job.elo).forEach((command) => worker.postMessage(command));
    worker.postMessage('position fen ' + job.fen);
    worker.postMessage('go movetime ' + job.ms);
    emit('thinking', { token: job.token });
  }

  function onLine(line) {
    if (line === 'uciok') {
      worker.postMessage('isready');
      return;
    }
    if (line === 'readyok' && !ready && !failed) {
      ready = true;
      window.clearTimeout(bootTimer);
      worker.postMessage('ucinewgame');
      emit('ready', {});
      return;
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
    current = null;
    state = 'idle';
    if (!job || job.token !== token) return;
    emit('move', { uci, token: job.token, fen: job.fen });
  }

  return {
    get ready() { return ready && !failed; },
    get token() { return token; },
    on(fn) { listeners.add(fn); },
    start() {
      worker = new Worker(workerUrl);
      bootTimer = window.setTimeout(() => {
        fail('The engine did not become ready. No bot move was played.');
      }, 20000);
      worker.onmessage = (event) => {
        const data = event.data;
        if (typeof data === 'string') onLine(data.trim());
        else if (data && typeof data.percent === 'number' && !ready) {
          emit('progress', { percent: data.percent });
        }
      };
      worker.onerror = () => {
        fail('The engine failed to load. No bot move was played.');
      };
      worker.postMessage('uci');
    },
    setElo(value) {
      elo = value;
      if (worker && ready && state === 'idle') {
        strengthCommands(elo).forEach((command) => worker.postMessage(command));
      }
    },
    search(fen, ms, searchElo) {
      if (failed || !ready) {
        emit('error', { message: 'The engine is not ready. No bot move was played.' });
        return false;
      }
      const job = { fen, ms, token, elo: searchElo == null ? elo : searchElo };
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
      return token;
    }
  };
}
