// CORREXO — servidor Express para Railway.
// Sirve el frontend estático + endpoints de Stripe + backend del piloto
// (persistencia de análisis en Postgres y videos en el volumen).
const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '2mb' }));

/* ---------- almacenamiento de videos (volumen /data) ---------- */
const VIDEO_DIR = process.env.VIDEO_DIR || path.join(__dirname, 'data', 'videos');
try { fs.mkdirSync(VIDEO_DIR, { recursive: true }); } catch (e) { console.error('mkdir VIDEO_DIR:', e.message); }

/* ---------- base de datos ---------- */
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false
  });
  pool.on('error', (err) => console.error('pg pool error:', err.message));
}
async function initDb() {
  if (!pool) { console.warn('Sin DATABASE_URL: el backend de piloto queda deshabilitado.'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS analyses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at timestamptz NOT NULL DEFAULT now(),
        camp text,
        runner_name text,
        runner_height int,
        runner_age int,
        index_score int,
        metrics jsonb,
        doctor_name text,
        doctor_reg text,
        doctor_notes text,
        concordance text,
        doctor_adjust text,
        video_perfil text,
        video_trasera text,
        consent boolean DEFAULT false
      );
    `);
    console.log('DB lista (tabla analyses).');
  } catch (err) {
    console.error('initDb error:', err.message);
  }
}

/* ---------- PIN de operador ---------- */
function pinOk(req) {
  const expected = process.env.OPERATOR_PIN;
  if (!expected) return false;
  const got = req.headers['x-operator-pin'] || (req.query && req.query.pin);
  return got && String(got) === String(expected);
}
function requirePin(req, res, next) {
  if (!process.env.OPERATOR_PIN) return res.status(500).json({ error: 'OPERATOR_PIN no configurado' });
  if (!pinOk(req)) return res.status(401).json({ error: 'PIN inválido' });
  next();
}
function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'Base de datos no disponible' });
  next();
}

/* ---------- subida de videos ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_DIR),
  filename: (req, file, cb) => {
    const view = (req.query.view === 'trasera') ? 'trasera' : 'perfil';
    const ext = file.mimetype && file.mimetype.includes('webm') ? 'webm'
      : file.mimetype && file.mimetype.includes('quicktime') ? 'mov' : 'mp4';
    cb(null, `${req.params.id}-${view}-${Date.now()}.${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 90 * 1024 * 1024 } });

/* ============================================================
   STRIPE
   ============================================================ */
function getStripe(res) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) { res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY en las variables de entorno' }); return null; }
  return Stripe(secret);
}
function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return proto + '://' + req.headers.host;
}
app.post('/api/create-checkout-session', async (req, res) => {
  const stripe = getStripe(res); if (!stripe) return;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return res.status(500).json({ error: 'Falta STRIPE_PRICE_ID en las variables de entorno' });
  try {
    const origin = originOf(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: origin + '/?paid=1&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/?canceled=1'
    });
    res.json({ url: session.url });
  } catch (err) { console.error('checkout:', err); res.status(500).json({ error: err.message }); }
});
app.get('/api/verify-session', async (req, res) => {
  const stripe = getStripe(res); if (!stripe) return;
  const id = req.query.session_id;
  if (!id) return res.status(400).json({ paid: false, error: 'Falta session_id' });
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    res.json({ paid: s.payment_status === 'paid' });
  } catch (err) { console.error('verify:', err); res.status(500).json({ paid: false, error: err.message }); }
});

/* ============================================================
   BACKEND DEL PILOTO
   ============================================================ */
// validar PIN (para habilitar el modo operador en la UI)
app.post('/api/operator/login', (req, res) => {
  if (!process.env.OPERATOR_PIN) return res.status(500).json({ ok: false, error: 'OPERATOR_PIN no configurado' });
  const pin = req.body && req.body.pin;
  res.json({ ok: !!pin && String(pin) === String(process.env.OPERATOR_PIN) });
});

// gate de acceso al ANÁLISIS (previo a la etapa de pago): solo usuarios habilitados.
// Códigos válidos = ACCESS_CODES (separados por coma) con fallback a OPERATOR_PIN.
app.post('/api/access/login', (req, res) => {
  const code = req.body && req.body.code;
  const raw = process.env.ACCESS_CODES || process.env.OPERATOR_PIN || '';
  const codes = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  const ok = !!code && codes.includes(String(code).trim());
  if (!ok) return res.status(401).json({ ok: false });
  res.json({ ok: true, token: Buffer.from('cx:' + Date.now()).toString('base64') });
});

// crear un análisis (datos del corredor + métricas + revisión médica)
app.post('/api/analyses', requirePin, requireDb, async (req, res) => {
  const b = req.body || {};
  try {
    const q = await pool.query(
      `INSERT INTO analyses
        (camp, runner_name, runner_height, runner_age, index_score, metrics,
         doctor_name, doctor_reg, doctor_notes, concordance, doctor_adjust, consent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, created_at`,
      [b.camp || null, b.runner_name || null, b.runner_height || null, b.runner_age || null,
       b.index_score || null, b.metrics ? JSON.stringify(b.metrics) : null,
       b.doctor_name || null, b.doctor_reg || null, b.doctor_notes || null,
       b.concordance || null, b.doctor_adjust || null, b.consent === true]
    );
    res.json({ id: q.rows[0].id, created_at: q.rows[0].created_at });
  } catch (err) { console.error('POST analyses:', err); res.status(500).json({ error: err.message }); }
});

// subir un video (perfil o trasera) para un análisis
app.post('/api/analyses/:id/video', requirePin, requireDb, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Falta el archivo de video' });
  const view = (req.query.view === 'trasera') ? 'trasera' : 'perfil';
  const col = view === 'trasera' ? 'video_trasera' : 'video_perfil';
  try {
    await pool.query(`UPDATE analyses SET ${col}=$1 WHERE id=$2`, [req.file.filename, req.params.id]);
    res.json({ ok: true, view, file: req.file.filename, bytes: req.file.size });
  } catch (err) { console.error('POST video:', err); res.status(500).json({ error: err.message }); }
});

// listar análisis (panel del operador)
app.get('/api/analyses', requirePin, requireDb, async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT id, created_at, runner_name, runner_age, index_score, concordance, camp,
              (video_perfil IS NOT NULL) AS has_perfil, (video_trasera IS NOT NULL) AS has_trasera
       FROM analyses ORDER BY created_at DESC LIMIT 500`
    );
    res.json(q.rows);
  } catch (err) { console.error('GET analyses:', err); res.status(500).json({ error: err.message }); }
});

// detalle de un análisis
app.get('/api/analyses/:id', requirePin, requireDb, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM analyses WHERE id=$1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ error: 'No encontrado' });
    res.json(q.rows[0]);
  } catch (err) { console.error('GET analysis:', err); res.status(500).json({ error: err.message }); }
});

// descargar un video guardado
app.get('/api/analyses/:id/video/:view', requirePin, requireDb, async (req, res) => {
  const col = req.params.view === 'trasera' ? 'video_trasera' : 'video_perfil';
  try {
    const q = await pool.query(`SELECT ${col} AS f FROM analyses WHERE id=$1`, [req.params.id]);
    const f = q.rows[0] && q.rows[0].f;
    if (!f) return res.status(404).json({ error: 'Sin video' });
    const full = path.join(VIDEO_DIR, f);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.sendFile(full);
  } catch (err) { console.error('GET video:', err); res.status(500).json({ error: err.message }); }
});

// borrar un análisis (y sus videos)
app.delete('/api/analyses/:id', requirePin, requireDb, async (req, res) => {
  try {
    const q = await pool.query('SELECT video_perfil, video_trasera FROM analyses WHERE id=$1', [req.params.id]);
    if (q.rows[0]) {
      ['video_perfil', 'video_trasera'].forEach(c => {
        const f = q.rows[0][c];
        if (f) { try { fs.unlinkSync(path.join(VIDEO_DIR, f)); } catch (e) {} }
      });
    }
    await pool.query('DELETE FROM analyses WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { console.error('DELETE analysis:', err); res.status(500).json({ error: err.message }); }
});

// export CSV (mini-estudio de validación: métricas + concordancia del médico)
app.get('/api/export.csv', requirePin, requireDb, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM analyses ORDER BY created_at DESC`);
    const cols = ['created_at', 'camp', 'runner_name', 'runner_age', 'runner_height', 'index_score',
      'cadencia', 'oscilacion_cm', 'overstride', 'caida_pelvica', 'valgo',
      'concordance', 'doctor_name', 'doctor_reg', 'doctor_notes', 'doctor_adjust',
      'video_perfil', 'video_trasera'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const lines = [cols.join(',')];
    for (const r of q.rows) {
      const m = r.metrics || {};
      const lat = m.lat || {}, rear = m.rear || {};
      lines.push([
        r.created_at ? new Date(r.created_at).toISOString() : '', r.camp, r.runner_name, r.runner_age, r.runner_height, r.index_score,
        lat.cadence != null ? Math.round(lat.cadence) : '',
        lat.voCm != null ? lat.voCm.toFixed(1) : (lat.voPct != null ? lat.voPct.toFixed(1) + '%' : ''),
        lat.overOffset != null ? (lat.overOffset * 100).toFixed(0) : '',
        rear.cpd != null ? rear.cpd.toFixed(0) : '',
        rear.valgus != null ? (rear.valgus * 100).toFixed(0) : '',
        r.concordance, r.doctor_name, r.doctor_reg, r.doctor_notes, r.doctor_adjust,
        r.video_perfil, r.video_trasera
      ].map(esc).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="correxo-piloto.csv"');
    res.send(lines.join('\n'));
  } catch (err) { console.error('export:', err); res.status(500).json({ error: err.message }); }
});

// salud del backend (para debug)
app.get('/api/health', async (req, res) => {
  let db = 'off';
  if (pool) { try { await pool.query('SELECT 1'); db = 'ok'; } catch (e) { db = 'error: ' + e.message; } }
  res.json({ ok: true, version: require('./package.json').version, db, videoDir: VIDEO_DIR, videoDirWritable: fs.existsSync(VIDEO_DIR), pinConfigured: !!process.env.OPERATOR_PIN });
});

/* ---------- frontend estático (HTML sin caché → siempre la última versión) ---------- */
app.use(express.static(path.join(__dirname), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); }
}));

const PORT = process.env.PORT || 3000;
initDb().finally(() => {
  app.listen(PORT, () => console.log('CORREXO escuchando en el puerto ' + PORT));
});
