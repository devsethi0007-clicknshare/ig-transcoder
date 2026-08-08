'use strict';
const http = require('http');
const { spawn } = require('child_process');

const PORT            = parseInt(process.env.PORT || '5000', 10);
const SECRET          = process.env.IG_SHARED_SECRET || '';
const WIDTH           = parseInt(process.env.VERTICAL_WIDTH  || '1080', 10);
const HEIGHT          = parseInt(process.env.VERTICAL_HEIGHT || '1920', 10);
const BITRATE         = process.env.VERTICAL_BITRATE || '5000k';
const BUFSIZE         = process.env.VERTICAL_BUFSIZE || '10000k';
const FPS             = parseInt(process.env.VERTICAL_FPS || '30', 10);
const PRESET          = process.env.VERTICAL_PRESET || 'veryfast';
const MAX_RESTARTS    = parseInt(process.env.MAX_RESTARTS || '20', 10);
const RESTART_DELAY   = parseInt(process.env.RESTART_DELAY_MS || '3000', 10);

const jobs = new Map();

function buildArgs(ingestUrl, target) {
  const fc =
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=20:1[bgb];` +
    `[fg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg2];` +
    `[bgb][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS}[v]`;
  return [
    '-thread_queue_size', '512', '-rtbufsize', '256M', '-i', ingestUrl,
    '-filter_complex', fc, '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', PRESET, '-b:v', BITRATE, '-maxrate', BITRATE,
    '-bufsize', BUFSIZE, '-g', String(FPS * 2), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100',
    '-max_muxing_queue_size', '1024',
    '-f', 'flv', target,
  ];
}

function spawnFfmpeg(id) {
  const job = jobs.get(id);
  if (!job || job.stopping) return;
  const proc = spawn('ffmpeg', buildArgs(job.ingestUrl, job.target), { stdio: ['ignore', 'ignore', 'pipe'] });
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
  console.log(`[${id}] ffmpeg -> ${job.target}  (${WIDTH}x${HEIGHT} @ ${BITRATE})`);
}

function startJob(id, ingestUrl, target) {
  stopJob(id);
  jobs.set(id, { proc: null, ingestUrl, target, restarts: 0, stopping: false, lastError: null, startedAt: Date.now() });
  spawnFfmpeg(id);
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  job.stopping = true;
  if (job.proc) { try { job.proc.kill('SIGTERM'); } catch (_) {} }
  jobs.delete(id);
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const list = [...jobs.entries()].map(([id, j]) => ({ id, target: j.target, up: !!j.proc, restarts: j.restarts, lastError: j.lastError }));
      return send(200, { ok: true, count: jobs.size, resolution: `${WIDTH}x${HEIGHT}`, jobs: list });
    }
    if (SECRET && req.headers['x-ig-secret'] !== SECRET) return send(401, { ok: false, error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/start') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { id, ingestUrl, target } = body;
      if (!id || !ingestUrl || !target) return send(400, { ok: false, error: 'id, ingestUrl and target are required' });
      startJob(String(id), String(ingestUrl), String(target));
      return send(200, { ok: true, id: String(id) });
    }
    if (req.method === 'POST' && req.url === '/stop') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const { id } = body;
      if (!id) return send(400, { ok: false, error: 'id is required' });
      return send(200, { ok: true, id: String(id), existed: stopJob(String(id)) });
    }
    return send(404, { ok: false, error: 'not found' });
  } catch (e) { return send(500, { ok: false, error: String((e && e.message) || e) }); }
});

function shutdown() { for (const id of [...jobs.keys()]) stopJob(id); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`ig-transcoder listening on :${PORT} (${WIDTH}x${HEIGHT} @ ${BITRATE}, preset ${PRESET})`);
  if (!SECRET) console.warn('WARNING: IG_SHARED_SECRET not set — endpoints UNAUTHENTICATED.');
});
