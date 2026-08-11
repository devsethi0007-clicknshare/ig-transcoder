'use strict';
const http = require('http');
const { spawn } = require('child_process');

const PORT          = parseInt(process.env.PORT || '6000', 10);
const SECRET        = process.env.FANOUT_SECRET || '';
const MTX_RTSP      = process.env.MTX_RTSP || 'rtsp://127.0.0.1:8554';
const MAX_RESTARTS  = parseInt(process.env.MAX_RESTARTS || '20', 10);
const RESTART_DELAY = parseInt(process.env.RESTART_DELAY_MS || '3000', 10);

const jobs = new Map();

function buildArgs(job) {
  const src = `${MTX_RTSP}/${job.path}`;
  const input = ['-rtsp_transport', 'tcp', '-fflags', '+genpts', '-i', src];
  if (job.transcode) {
    const br = job.bitrate || '6000k';
    const buf = (parseInt(br, 10) * 2) + 'k';
    return [...input,
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', br, '-maxrate', br, '-bufsize', buf,
      '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
      '-max_muxing_queue_size', '1024',
      '-f', 'flv', job.target];
  }
  return [...input, '-c', 'copy', '-f', 'flv', job.target];
}

function spawnFfmpeg(id) {
  const job = jobs.get(id);
  if (!job || job.stopping) return;
  const proc = spawn('ffmpeg', buildArgs(job), { stdio: ['ignore', 'ignore', 'pipe'] });
  job.proc = proc;
  let errTail = '';
  proc.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  proc.on('exit', (code, signal) => {
    job.proc = null;
    job.lastError = `exit code=${code} signal=${signal} :: ${errTail.slice(-400)}`;
    if (job.stopping) { jobs.delete(id); return; }
    if (job.restarts >= MAX_RESTARTS) { console.error(`[${id}] gave up`); jobs.delete(id); return; }
    job.restarts += 1;
    console.error(`[${id}] ffmpeg died (code=${code}); restart ${job.restarts}/${MAX_RESTARTS}`);
    setTimeout(() => spawnFfmpeg(id), RESTART_DELAY);
  });
  console.log(`[${id}] ${job.transcode ? 'TRANSCODE' : 'PASSTHROUGH'} ${job.path} -> ${job.target}`);
}

function startJob(o) {
  stopJob(o.id);
  jobs.set(o.id, { proc: null, path: o.path, target: o.target, transcode: !!o.transcode, bitrate: o.bitrate || null, restarts: 0, stopping: false, lastError: null, startedAt: Date.now() });
  spawnFfmpeg(o.id);
}
function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopping = true;
  if (job.proc) { try { job.proc.kill('SIGTERM'); } catch (_) {} }
  jobs.delete(id);
  return true;
}
function readBody(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => res(b)); }); }

const server = http.createServer(async (req, res) => {
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const list = [...jobs.entries()].map(([id, j]) => ({ id, mode: j.transcode ? 'transcode' : 'passthrough', target: j.target, up: !!j.proc, restarts: j.restarts, lastError: j.lastError }));
      return send(200, { ok: true, count: jobs.size, jobs: list });
    }
    if (SECRET && req.headers['x-fanout-secret'] !== SECRET) return send(401, { ok: false, error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/start') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.id || !b.path || !b.target) return send(400, { ok: false, error: 'id, path and target are required' });
      startJob(b);
      return send(200, { ok: true, id: String(b.id), mode: b.transcode ? 'transcode' : 'passthrough' });
    }
    if (req.method === 'POST' && req.url === '/stop') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.id) return send(400, { ok: false, error: 'id is required' });
      return send(200, { ok: true, id: String(b.id), existed: stopJob(String(b.id)) });
    }
    return send(404, { ok: false, error: 'not found' });
  } catch (e) { return send(500, { ok: false, error: String((e && e.message) || e) }); }
});

function shutdown() { for (const id of [...jobs.keys()]) stopJob(id); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
server.listen(PORT, () => { console.log(`clicknlive-fanout on :${PORT} (source ${MTX_RTSP})`); if (!SECRET) console.warn('WARNING: FANOUT_SECRET not set.'); });
