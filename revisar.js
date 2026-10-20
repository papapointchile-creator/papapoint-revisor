// PapaPoint · Revisor de máquinas y ventas
// Cada 7 minutos (de 05:45 a 23:30, hora de Santiago) en GitHub Actions:
//  1) App de mantención de VM Shopping: en línea y alertas de cada máquina.
//  2) App de administración de VM Shopping: en línea y hora de la última conexión.
//  3) PayScan: ventas de hoy por máquina (Resumen por dispositivos).
// Le manda todo a papapoint.cl: pp-alertas.php (alertas y conexión por Telegram, como siempre)
// y pp-revisor.php (ventas, 2 horas sin vender y la página "Máquinas en vivo" de la intranet).
// El registro de GitHub es público: aquí nunca se escriben ventas, montos ni datos de las cuentas.

const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const VM = 'https://mall.vm-shopping.com';
const MANT = VM + '/maintenance';
const PS = 'https://admin.payscan.cl';
const PS_COMERCIO = '3194';
const AVISOS = 'https://www.papapoint.cl/pp-alertas.php';
const REVISOR = 'https://www.papapoint.cl/pp-revisor.php';
const SESION = '.sesion/state.bin';   // sesiones guardadas (cifradas) para no iniciar sesión en cada corrida
const ESTADO = 'estado.json';         // último estado de conexión y alertas, queda en el repositorio
const VM_USER = process.env.VM_USER, VM_PASS = process.env.VM_PASS;
const PS_USER = process.env.PAYSCAN_USER, PS_PASS = process.env.PAYSCAN_PASS;
const LLAVE_PP = process.env.PP_LLAVE;

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
const LLAVE = crypto.createHash('sha256').update('pp-sesion|' + (VM_PASS || '')).digest();
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

// Pistas para el registro público: solo la dirección y los campos de las pantallas de login (nunca lo escrito)
async function debug(page, nombre, conPantallazo = true) {
  try {
    console.log(`[debug ${nombre}] url=${page.url().split('?')[0]}`);
    if (/login/.test(page.url())) {
      const campos = await page.$$eval('input, button, select', els => els.map(e =>
        `${e.tagName.toLowerCase()} type=${e.type || ''} placeholder=${e.placeholder || ''} texto=${(e.innerText || '').trim().slice(0, 30)}`
      )).catch(() => []);
      console.log(`[debug ${nombre}] campos de la pantalla de login:\n  ` + campos.join('\n  '));
    }
    if (conPantallazo) {
      fs.mkdirSync('debug', { recursive: true });
      await page.screenshot({ path: `debug/${nombre}.png`, fullPage: true });
    }
  } catch {}
}

// ---------- iniciar sesión (formulario de usuario + clave) ----------
async function iniciarSesion(page, urlLogin, user, pass, esLogin) {
  if (!user || !pass) return false;
  await page.goto(urlLogin, { waitUntil: 'networkidle' }).catch(() => {});
  const clave = page.locator('input[type=password]').first();
  await clave.waitFor({ timeout: 30000 });
  // VM Shopping parte en chino: elegir Español si hay selector de idioma
  await page.locator('select').first().selectOption({ label: 'Español' }, { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const usuario = page.locator('input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio])').first();
  await usuario.fill(user.trim());
  await clave.fill(pass.trim());
  const recordar = page.locator('input[type=checkbox]').first();
  if (await recordar.count()) await recordar.check({ timeout: 2000 }).catch(() => {});
  const boton = page.locator([
    'button[type=submit]', 'button:has-text("Entrar")', 'button:has-text("Iniciar")', 'button:has-text("Ingresar")',
    'button:has-text("Login")', 'button:has-text("Log in")', 'button:has-text("Sign in")', 'button:has-text("登录")',
  ].join(', ')).first();
  // Solo anota avisos cortos de la pantalla de login (por ejemplo "clave incorrecta") y si aparece una verificación
  const vistos = new Set();
  const espia = setInterval(async () => {
    if (!esLogin(page.url())) return;
    const avisos = await page.$$eval('[class*="message"], [class*="toast"], [class*="error"], [class*="notice"], [role="alert"]',
      els => els.map(e => (e.innerText || '').trim()).filter(t => t && t.length < 80)).catch(() => []);
    const verif = await page.locator('[class*="captcha"], [class*="slider"], [class*="verify"], iframe').count().catch(() => 0);
    for (const a of avisos.concat(verif ? ['(hay una verificación en pantalla: ' + verif + ')'] : [])) if (!vistos.has(a)) { vistos.add(a); console.log('[aviso en el login] ' + a); }
  }, 400);
  if (await boton.count()) await boton.click(); else await clave.press('Enter');
  await page.waitForURL(u => !esLogin(u.toString()), { timeout: 20000 }).catch(() => {});
  clearInterval(espia);
  // La página cambia de dirección antes de sacar el formulario: esperar a que desaparezca
  await page.locator('input[type=password]').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return !esLogin(page.url());
}

// ---------- 1) app de mantención ----------
const esLoginMant = u => /\/maintenance\/login/.test(u);
async function leerMant(page) {
  await page.goto(MANT + '/devices', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /#M\d{3}|No hay más|No more|没有更多/.test(document.body.innerText) || /\/login/.test(location.pathname),
    null, { timeout: 40000 }
  ).catch(() => {});
  if (esLoginMant(page.url()) || (await page.locator('input[type=password]').count()) > 0) return null;
  await page.waitForTimeout(1500);
  const txt = await page.innerText('body');
  const maq = {};
  // Cada máquina viene así: "BDSTJ2612001 / En línea / #M001 · Rosario Sur 135 / Alerta 25"
  for (const bloque of txt.split(/(?=\b[A-Z]{3,}\d{6,}\b)/)) {
    const id = (bloque.match(/#(M\d{3})/) || [])[1];
    if (!id) continue;
    const online = /Fuera de l[ií]nea|Offline|离线/i.test(bloque) ? false
      : (/En l[ií]nea|Online|在线/i.test(bloque) ? true : null);
    const al = bloque.match(/(?:Alerta|Alert|Alarm|告警|报警|警报)\s*:?\s*(\d{1,3})\b/i);
    maq[id] = { online, alerta: al ? al[1] : null };
  }
  return maq;
}

// ---------- 2) app de administración ----------
const esLoginAdmin = u => /mall\.vm-shopping\.com\/login/.test(u);
async function leerAdmin(page) {
  await page.goto(VM + '/operation/devices', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => /\bM\d{3}\b[\s\S]*?\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(document.body.innerText) || /^\/login/.test(location.pathname),
    null, { timeout: 40000 }
  ).catch(() => {});
  if (esLoginAdmin(page.url())) return null;
  await page.waitForTimeout(1000);
  const txt = await page.innerText('body');
  const maq = {};
  // Fila de la tabla: "M003  BDSTJ2612003  Papapoint  -  online  2026-10-20 17:09:19  Settings Clone More"
  const re = /\b(M\d{3})\b[^\n]*?\b(online|offline|在线|离线|en l[ií]nea|fuera de l[ií]nea)\b[^\n]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/gi;
  let r;
  while ((r = re.exec(txt))) maq[r[1]] = { online: /^(online|在线|en l)/i.test(r[2]), visto: r[3] };
  return maq;
}

// ---------- 3) PayScan ----------
const esLoginPs = u => /auth\/login/.test(u);
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;
async function leerVentas(page) {
  await page.goto(`${PS}/#/transactions?commerce_id=${PS_COMERCIO}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (esLoginPs(page.url())) return null;
  // Pestaña "Resumen por dispositivos"; el filtro de fecha parte en "Hoy"
  const pestana = page.getByText('Resumen por dispositivos', { exact: false }).first();
  await pestana.click({ timeout: 20000 });
  await page.waitForTimeout(2500);
  const aplicar = page.getByText('Aplicar Filtros', { exact: false }).first();
  if (await aplicar.count()) { await aplicar.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(3500); }
  const tablas = await page.$$eval('table, mat-table, [role=table], [role=grid]', ts => ts.map(t => ({
    h: [...t.querySelectorAll('th, mat-header-cell, [role=columnheader]')].map(x => x.innerText.trim()),
    r: [...t.querySelectorAll('tbody tr, mat-row, [role=row]')]
      .map(tr => [...tr.querySelectorAll('td, mat-cell, [role=cell], [role=gridcell]')].map(td => td.innerText.trim()))
      .filter(c => c.length),
  })));
  const t = tablas.find(x => x.h.some(h => /serial/i.test(h)));
  if (!t) {
    const vacio = /no hay|sin (datos|resultados|registros)|no se encontraron|0 resultados/i.test(await page.innerText('body'));
    if (vacio) return {};
    console.log('[debug payscan] no encontré la tabla; encabezados vistos: ' + JSON.stringify(tablas.map(x => x.h)));
    throw new Error('no encontré la tabla de Resumen por dispositivos');
  }
  const col = re => t.h.findIndex(h => re.test(h));
  const iS = col(/serial/i), iE = col(/estado/i), iN = col(/n[°º.]?\s*(de\s*)?tx|cantidad|transacc/i), iT = col(/venta total|total|monto/i);
  if (iS < 0 || iN < 0 || iT < 0) {
    console.log('[debug payscan] encabezados: ' + JSON.stringify(t.h));
    throw new Error('la tabla de PayScan cambió de columnas');
  }
  const ventas = {};
  for (const c of t.r) {
    const serial = (c[iS] || '').replace(/\D/g, '');
    if (!serial) continue;
    if (iE >= 0 && !/aprob/i.test(c[iE] || '')) continue;   // solo transacciones APROBADAS
    const v = ventas[serial] || (ventas[serial] = { n: 0, clp: 0 });
    v.n += num(c[iN]); v.clp += num(c[iT]);
  }
  return ventas;
}

async function postear(url, cuerpo, llave) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'PapaPoint-Revisor/2.0' };
  if (llave) headers['X-PP-Llave'] = llave;
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(cuerpo) });
  return { status: r.status, texto: (await r.text()).slice(0, 300) };
}

// ---------- principal ----------
(async () => {
  const t = ahoraSantiago();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    locale: 'es-CL', timezoneId: 'America/Santiago',
    viewport: { width: 1280, height: 900 }, storageState: leerSesion(),
  });
  const page = await ctx.newPage();
  const informe = {}, fallas = [];

  // 1) Mantención
  let mant = null, mantLogin = false;
  try {
    mant = await leerMant(page);
    if (mant === null) {
      console.log('Mantención: la sesión venció, iniciando sesión');
      if (await iniciarSesion(page, MANT + '/login', VM_USER, VM_PASS, esLoginMant)) mant = await leerMant(page);
      if (mant === null) { mantLogin = true; await debug(page, 'mantencion-login'); }
    }
    if (mant && !Object.keys(mant).length) { await debug(page, 'mantencion-sin-maquinas'); throw new Error('no encontré máquinas'); }
    if (mant && Object.values(mant).some(m => m.online === null)) { await debug(page, 'mantencion-sin-estado'); throw new Error('no entendí si están en línea'); }
    if (mant) informe.mant = mant; else informe.mantError = 'pidió iniciar sesión y no pude entrar';
  } catch (e) { mant = null; informe.mantError = e.message.slice(0, 100); fallas.push('mantención: ' + e.message); }

  // 2) Administración (mismo usuario y clave que mantención)
  try {
    let admin = await leerAdmin(page);
    if (admin === null) {
      console.log('Administración: la sesión venció, iniciando sesión');
      if (await iniciarSesion(page, VM + '/login', VM_USER, VM_PASS, esLoginAdmin)) admin = await leerAdmin(page);
      if (admin === null) { informe.adminLogin = true; await debug(page, 'administracion-login'); throw new Error('pidió iniciar sesión y no pude entrar'); }
    }
    if (!Object.keys(admin).length) { await debug(page, 'administracion-sin-maquinas'); throw new Error('no encontré máquinas'); }
    informe.admin = admin;
  } catch (e) { informe.adminError = e.message.slice(0, 100); fallas.push('administración: ' + e.message); }

  // 3) PayScan (sin pantallazos: mostrarían ventas)
  try {
    let ventas = await leerVentas(page);
    if (ventas === null) {
      console.log('PayScan: la sesión venció, iniciando sesión');
      if (await iniciarSesion(page, `${PS}/#/auth/login`, PS_USER, PS_PASS, esLoginPs)) ventas = await leerVentas(page);
      if (ventas === null) { informe.ventasLogin = true; await debug(page, 'payscan-login', false); throw new Error('pidió iniciar sesión y no pude entrar'); }
    }
    informe.ventas = ventas; informe.ventasDia = t.dia;
  } catch (e) { informe.ventasError = e.message.slice(0, 100); fallas.push('PayScan: ' + e.message); }

  guardarSesion(await ctx.storageState());
  await browser.close();

  // Alertas y conexión por Telegram (como siempre)
  if (mant || mantLogin) {
    const r = await postear(AVISOS, mant ? { accion: 'maquinas', maq: mant, login: false } : { accion: 'maquinas', maq: {}, login: true });
    console.log(`pp-alertas → ${r.status}: ${r.texto}`);
  }
  // Ventas, 2 horas sin vender y página de la intranet
  if (LLAVE_PP) {
    const r = await postear(REVISOR, informe, LLAVE_PP);
    console.log(`pp-revisor → ${r.status}: ${r.texto}`);
  } else console.log('Falta el secreto PP_LLAVE: no se mandaron ventas ni estado a la intranet');

  // Registro público: solo qué se pudo leer, sin cifras de ventas
  console.log(`${t.dia} ${t.hora} · mantención: ${mant ? JSON.stringify(mant) : 'sin dato'} · administración: ${informe.admin ? Object.keys(informe.admin).length + ' máquinas' : 'sin dato'} · PayScan: ${informe.ventas ? 'leído' : 'sin dato'}`);
  if (fallas.length) console.log('Avisos: ' + fallas.join(' | '));

  // Estado en el repositorio (cambia al menos una vez al día, así GitHub no pausa la tarea)
  if (mant) {
    let viejo = null;
    try { viejo = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch {}
    if (!viejo || viejo.dia !== t.dia || JSON.stringify(viejo.maq) !== JSON.stringify(mant)) {
      fs.writeFileSync(ESTADO, JSON.stringify({ dia: t.dia, desde: t.hora, maq: mant }, null, 2) + '\n');
    }
  }
  if (fallas.length === 3) throw new Error('No pude leer ninguna de las tres fuentes');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
