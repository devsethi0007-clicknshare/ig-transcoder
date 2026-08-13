'use strict';
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const PORT            = parseInt(process.env.PORT || '5000', 10);
const SECRET          = process.env.IG_SHARED_SECRET || '';
const MONITOR_PORT    = parseInt(process.env.MONITOR_PORT || '8080', 10);
const MONITOR_KEY     = process.env.MONITOR_KEY || '';
const WIDTH           = parseInt(process.env.VERTICAL_WIDTH  || '1080', 10);
const HEIGHT          = parseInt(process.env.VERTICAL_HEIGHT || '1920', 10);
const BITRATE         = process.env.VERTICAL_BITRATE || '5000k';
const BUFSIZE         = process.env.VERTICAL_BUFSIZE || '10000k';
const FPS             = parseInt(process.env.VERTICAL_FPS || '30', 10);
const PRESET          = process.env.VERTICAL_PRESET || 'veryfast';
const MAX_RESTARTS    = parseInt(process.env.MAX_RESTARTS || '20', 10);
const RESTART_DELAY   = parseInt(process.env.RESTART_DELAY_MS || '3000', 10);

// id -> { proc, ingestUrl, target, restarts, stopping, lastError, startedAt }
const jobs = new Map();

function buildArgs(ingestUrl, target) {
  const fc =
    `[0:v]split=2[bg][fg];` +
    `[bg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=20:1[bgb];` +
    `[fg]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease[fg2];` +
    `[bgb][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=${FPS}[v]`;
  // input analysis: give ffmpeg enough time/data to positively detect the VIDEO track on a
  // live stream (audio packets often arrive first). Without this the [0:v] filter input can
  // resolve to "no streams" and the whole filtergraph fails to initialise (exit 234).
  const input = ['-hide_banner', '-fflags', '+genpts', '-analyzeduration', '10000000', '-probesize', '50000000'];
  if (/^rtsp:/i.test(ingestUrl)) input.push('-rtsp_transport', 'tcp');
  return [
    ...input,
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

// ---- live CPU % sampler (updated every 2s) -----------------------------
let lastCpu = os.cpus();
let cpuPercent = 0;
function sampleCpu() {
  const now = os.cpus();
  let idleD = 0, totalD = 0;
  for (let i = 0; i < now.length && i < lastCpu.length; i++) {
    const a = lastCpu[i].times, b = now[i].times;
    const idle = b.idle - a.idle;
    const total = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    idleD += idle; totalD += total;
  }
  cpuPercent = totalD > 0 ? Math.round(100 * (1 - idleD / totalD)) : 0;
  lastCpu = now;
}
setInterval(sampleCpu, 2000);

// Show the endpoint host + /rtmp/ but hide the actual stream key.
function redactTarget(t) {
  if (!t) return '';
  const i = t.indexOf('/rtmp/');
  if (i >= 0) return t.slice(0, i + 6) + '••••••••(key hidden)';
  return t.slice(0, 24) + '…';
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
}

// ---- control server (port 5000, locked to the main box by firewall) ----
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

// ---- monitor server (port 8080, public but password-gated + redacted) --
function renderStatusPage() {
  const totalMem = os.totalmem(), freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPct = Math.round(100 * usedMem / totalMem);
  const cores = os.cpus().length;
  const load = os.loadavg().map((n) => n.toFixed(2)).join('  ');
  const upSecs = Math.floor(os.uptime());
  const now = Date.now();
  const rows = [...jobs.values()].map((j) => {
    const up = !!j.proc;
    const state = up ? '<span class="ok">● LIVE</span>' : '<span class="bad">● down</span>';
    const dur = up && j.startedAt ? fmtDur(now - j.startedAt) : '—';
    return `<tr><td>${j && j.target ? redactTarget(j.target) : ''}</td><td>${state}</td><td>${j.restarts}</td><td>${dur}</td></tr>`;
  }).join('');
  const jobsTable = jobs.size
    ? `<table><thead><tr><th>Destination</th><th>State</th><th>Restarts</th><th>Uptime</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="muted">No Instagram streams running right now.</p>`;
  const cpuClass = cpuPercent >= 85 ? 'bad' : cpuPercent >= 60 ? 'warn' : 'ok';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>clicknlive · Instagram transcoder</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0f14;color:#e7edf3;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;padding:22px}
  h1{font-size:17px;margin:0 0 2px;font-weight:600}
  .sub{color:#7d8ba0;font-size:12px;margin-bottom:20px}
  .tiles{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:22px}
  .tile{background:#131a23;border:1px solid #1e2833;border-radius:12px;padding:14px 16px;min-width:120px;flex:1}
  .tile .k{color:#7d8ba0;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .tile .v{font-size:26px;font-weight:650;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#131a23;border:1px solid #1e2833;border-radius:12px;overflow:hidden}
  th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #1e2833;font-size:13px}
  th{color:#7d8ba0;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.04em}
  tr:last-child td{border-bottom:none}
  td:first-child{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#aeb9c7}
  .ok{color:#3ddc84}.warn{color:#f6c343}.bad{color:#ff6b6b}
  .muted{color:#7d8ba0}
  .foot{color:#55606f;font-size:11px;margin-top:18px}
</style></head><body>
<h1>Instagram Transcoder</h1>
<div class="sub">${WIDTH}×${HEIGHT} · auto-refreshes every 5s</div>
<div class="tiles">
  <div class="tile"><div class="k">CPU</div><div class="v ${cpuClass}">${cpuPercent}%</div></div>
  <div class="tile"><div class="k">Memory</div><div class="v">${memPct}%</div></div>
  <div class="tile"><div class="k">Streams live</div><div class="v">${[...jobs.values()].filter((j)=>!!j.proc).length} / ${jobs.size}</div></div>
  <div class="tile"><div class="k">Cores</div><div class="v">${cores}</div></div>
  <div class="tile"><div class="k">Box uptime</div><div class="v" style="font-size:18px">${fmtDur(upSecs*1000)}</div></div>
</div>
${jobsTable}
<div class="foot">load avg (1/5/15m): ${load} &nbsp;·&nbsp; server time ${new Date().toISOString()}</div>
</body></html>`;
}

const monitor = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/status' && url.pathname !== '/') {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return;
  }
  if (MONITOR_KEY && url.searchParams.get('key') !== MONITOR_KEY) {
    res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized — add ?key=YOUR_KEY'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderStatusPage());
});

function shutdown() { for (const id of [...jobs.keys()]) stopJob(id); server.close(); monitor.close(); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`ig-transcoder control on :${PORT} (${WIDTH}x${HEIGHT} @ ${BITRATE}, preset ${PRESET})`);
  if (!SECRET) console.warn('WARNING: IG_SHARED_SECRET not set — control endpoints UNAUTHENTICATED.');
});
monitor.listen(MONITOR_PORT, () => {
  console.log(`ig-transcoder monitor on :${MONITOR_PORT}${MONITOR_KEY ? '' : '  (WARNING: MONITOR_KEY not set — page is open)'}`);
});
