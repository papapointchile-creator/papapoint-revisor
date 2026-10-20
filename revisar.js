// PapaPoint · Revisor de máquinas
// Entra a la app de mantención de VM Shopping, lee si cada máquina está en línea y su alerta,
// y se lo manda a papapoint.cl (pp-alertas.php), que avisa por Telegram solo lo que cambió.
// Corre en GitHub Actions cada 7 minutos, de 05:45 a 23:30 hora de Santiago.

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const BASE = 'https://mall.vm-shopping.com/maintenance';
const AVISOS = 'https://www.papapoint.cl/pp-alertas.php';
const SESION = '.sesion/state.bin';   // sesión guardada (cifrada) para no iniciar sesión en cada corrida
const ESTADO = 'estado.json';         // último estado conocido, queda en el repositorio
const USER = process.env.VM_USER;
const PASS = process.env.VM_PASS;

// ---------- utilidades ----------
function ahoraSantiago() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date()).map(x => [x.type, x.value])
  );
  return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}` };
}

// La sesión se guarda cifrada con una llave que sale de la clave (secreto), así nadie más la puede usar.
const LLAVE = crypto.createHash('sha256').update('pp-sesion|' + (PASS || '')).digest();
function guardarSesion(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', LLAVE, iv);
  const datos = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  fs.mkdirSync('.sesion', { recursive: true });
  fs.writeFileSync(SESION, Buffer.concat([iv, c.getAuthTag(), datos]));
}
function leerSesion() {
  try {
    const b = fs.readFileSync(SESION);
    const d = crypto.createDecipheriv('aes-256-gcm', LLAVE, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  } catch { return undefined; }
}

async function debug(page, nombre) {
  try {
    fs.mkdirSync('debug', { recursive: true });
    await page.screenshot({ path: `debug/${nombre}.png`, fullPage: true });
    const txt = await page.innerText('body').catch(() => '');
    fs.writeFileSync(`debug/${nombre}.txt`, page.url() + '\n\n' + txt);
    // Pistas para el registro (nunca muestra lo escrito en los campos)
    const campos = await page.$$eval('input, button, select', els => els.map(e =>
      `${e.tagName.toLowerCase()} type=${e.type || ''} name=${e.name || ''} placeholder=${e.placeholder || ''} texto=${(e.innerText || '').trim().slice(0, 30)}`
    )).catch(() => []);
    console.log(`[debug ${nombre}] url=${page.url().split('?')[0]}`);
    if (/\/login/.test(page.url())) console.log(`[debug ${nombre}] campos de la pantalla de login:\n  ` + campos.join('\n  '));
  } catch {}
}

async function enLogin(page) {
  return /\/login/.test(page.url()) || (await page.locator('input[type=password]').count()) > 0;
}

// ---------- iniciar sesión ----------
async function iniciarSesion(page) {
  if (!USER || !PASS) throw new Error('Faltan los secretos VM_USER y VM_PASS en GitHub');
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' }).catch(() => {});
  const clave = page.locator('input[type=password]').first();
  await clave.waitFor({ timeout: 30000 });
  await page.waitForTimeout(1000);
  const usuario = page.locator('input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio])').first();
  await usuario.fill(USER.trim());
  await clave.fill(PASS.trim());
  // Solo anota avisos de error de la pantalla de login (cajitas tipo "toast"), nunca datos de la cuenta
  const vistos = new Set();
  const espia = setInterval(async () => {
    if (!/\/login/.test(page.url())) return;
    const avisos = await page.$$eval('[class*="toast"], [class*="error"], [class*="message"], [role="alert"]',
      els => els.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 80)).catch(() => []);
    for (const a of avisos) if (!vistos.has(a)) { vistos.add(a); console.log('[aviso en la pantalla de login] ' + a); }
  }, 300);
  const boton = page.locator([
    'button[type=submit]', 'button:has-text("Iniciar")', 'button:has-text("Ingresar")',
    'button:has-text("Entrar")', 'button:has-text("Login")', 'button:has-text("Log in")', 'button:has-text("Sign in")',
  ].join(', ')).first();
  if (await boton.count()) await boton.click(); else await clave.press('Enter');
  await page.waitForURL(u => !/\/login/.test(u.toString()), { timeout: 20000 }).catch(() => {});
  clearInterval(espia);
  return !(await enLogin(page));
}

// ---------- leer las máquinas ----------
async function leerMaquinas(page) {
  await page.goto(BASE + '/devices', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /#M\d{3}|No hay más|No more/.test(document.body.innerText) || /\/login/.test(location.pathname),
    null, { timeout: 40000 }
  ).catch(() => {});
  if (await enLogin(page)) return null;
  await page.waitForTimeout(1500);
  const txt = await page.innerText('body');
  const maq = {};
  // Cada máquina viene así: "BDSTJ2612001 / En línea / #M001 · Rosario Sur 135 / Alerta 25"
  for (const bloque of txt.split(/(?=\b[A-Z]{3,}\d{6,}\b)/)) {
    const id = (bloque.match(/#(M\d{3})/) || [])[1];
    if (!id) continue;
    const online = /Fuera de l[ií]nea|Offline/i.test(bloque) ? false
      : (/En l[ií]nea|Online/i.test(bloque) ? true : null);
    const al = bloque.match(/(?:Alerta|Alert|Alarm)\s*:?\s*(\d{1,3})\b/i);
    maq[id] = { online, alerta: al ? al[1] : null };
  }
  return maq;
}

// ---------- principal ----------
(async () => {
  const t = ahoraSantiago();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'es-CL', timezoneId: 'America/Santiago',
    viewport: { width: 430, height: 900 }, storageState: leerSesion(),
  });
  const page = await ctx.newPage();

  let maq = await leerMaquinas(page);
  let loginFallo = false;
  if (maq === null) {
    console.log('La sesión venció: iniciando sesión en VM Shopping');
    if (await iniciarSesion(page)) maq = await leerMaquinas(page);
    if (maq === null) { loginFallo = true; await debug(page, 'login'); }
  }
  const hay = maq && Object.keys(maq).length > 0;
  if (maq && !hay) await debug(page, 'sin-maquinas');
  if (hay) guardarSesion(await ctx.storageState());
  await browser.close();

  if (!loginFallo && !hay) throw new Error('No encontré máquinas en la página (mira el archivo debug de esta corrida)');

  // Avisar a papapoint.cl (el servidor compara con la lectura anterior y manda a Telegram solo lo nuevo)
  const cuerpo = loginFallo ? { accion: 'maquinas', maq: {}, login: true } : { accion: 'maquinas', maq, login: false };
  const r = await fetch(AVISOS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'PapaPoint-Revisor/1.0' },
    body: JSON.stringify(cuerpo),
  });
  const resp = await r.text();
  console.log(`${t.dia} ${t.hora} · máquinas: ${JSON.stringify(maq)}`);
  console.log(`papapoint.cl respondió ${r.status}: ${resp.slice(0, 300)}`);

  // Guardar el último estado en el repositorio (cambia al menos una vez al día, así GitHub no pausa la tarea)
  if (hay) {
    let viejo = null;
    try { viejo = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch {}
    if (!viejo || viejo.dia !== t.dia || JSON.stringify(viejo.maq) !== JSON.stringify(maq)) {
      fs.writeFileSync(ESTADO, JSON.stringify({ dia: t.dia, desde: t.hora, maq }, null, 2) + '\n');
    }
  }

  if (loginFallo) throw new Error('No pude iniciar sesión en VM Shopping: revisa VM_USER y VM_PASS (mira el archivo debug de esta corrida)');
  if (!r.ok) throw new Error('papapoint.cl no recibió el aviso (código ' + r.status + ')');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
