// PapaPoint · Revisor de máquinas y ventas
// Cada 5 minutos (de 05:45 a 23:30, hora de Santiago; lo lanza el reloj del cPanel) en GitHub Actions:
//  1) App de mantención de VM Shopping: en línea y alertas de cada máquina.
//  2) App de administración de VM Shopping: en línea y hora de la última conexión.
//  3) PayScan: lista de transacciones de los últimos 15 días (hora de cada venta), por máquina.
//  4) App de mantención: stock de papas de cada máquina (Carriles) y pedidos de hoy con su estado (Pedidos).
//  5) Lo que queda de la corrida (hasta ~3,5 min): mira Pedidos cada 20 s y avisa a pp-envivo.php qué pedido
//     se está pagando, friendo o esperando que lo saquen ("Máquinas en vivo" lo muestra casi en vivo).
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
const EXTRA = 'https://www.papapoint.cl/pp-extra.php';   // stock y pedidos (21-10-2026)
const ENVIVO = 'https://www.papapoint.cl/pp-envivo.php'; // pedidos en curso, casi en vivo (22-10-2026)
const T0 = Date.now();
// (22-10-2026) Después de leer todo, el revisor se queda mirando la pantalla Pedidos cada 20 s hasta este tope
// (contado desde que parte el script) y le avisa a la intranet qué pedido se está pagando, friendo o esperando que lo saquen.
const VIGILAR_HASTA_MS = 3.5 * 60 * 1000;   // así la corrida completa dura < 5 min y no atrasa la siguiente (ventas cada 5 min)
const VIGILAR_CADA_MS = 20 * 1000;
const PEDIDOS_BIN = '.sesion/pedidos.bin';                // pedidos de hoy ya vistos (cifrados, en el cache)
const SESION = '.sesion/state.bin';   // sesiones guardadas (cifradas) para no iniciar sesión en cada corrida
const ESTADO = 'estado.json';         // último estado de conexión y alertas, queda en el repositorio
const VENTAS_ENC = 'ventas.enc';      // ventas por día y máquina, CIFRADAS (el repositorio es público)
const POS_MAQ = { '846000190': 'M001', '846000189': 'M002', '846000188': 'M003' };   // Serial POS en PayScan → máquina
// Llave PÚBLICA: solo sirve para cifrar. La privada (para leer) está solo en la tarea que carga Logística.
const VENTAS_PUB = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjXpzd2JJYpRkwQbdbFoO\njvgWLfpJ1TuoarrsHmYAQo+zuypOLDf15m5ABY1uHazmARYXCdO7ditx/zOhXPUy\nc1pZyNO3h+u7zdsnrN/7u3VHeZi9qFpaeAq6aw1pWUc1sa2f2Lg8lRTFreIUVMDU\nBn5McrMnsXZrrzFl6ysSDg+DtrfVPHYLj8u/Wsc/GEUB78hPZ6G7cdbayFxOtmBS\n2GxThjzRN2nGiliOd9UGHnBXPZGGRNtsunH6D+tKjGszTITfGKk8lyVoJe/IoAlX\n1tGUKFxsUCP0ZtcOZtWGfd9h6aJEFjtv/t6BfWwq65RG6AvUTRIndBIASmUOo0jW\nbwIDAQAB\n-----END PUBLIC KEY-----';
const VM_USER = process.env.VM_USER, VM_PASS = process.env.VM_PASS;
const ADM_USER = process.env.VMADMIN_USER, ADM_PASS = process.env.VMADMIN_PASS;   // la app de administración tiene su propia clave
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

// Cifrado de ventas: AES-256-CBC con llave al azar, y esa llave cifrada con RSA-OAEP (llave pública de arriba).
function cifrarVentas(obj) {
  const kv = crypto.randomBytes(48);   // 32 de llave + 16 de iv
  const c = crypto.createCipheriv('aes-256-cbc', kv.subarray(0, 32), kv.subarray(32));
  const d = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const k = crypto.publicEncrypt({ key: VENTAS_PUB, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, kv);
  return JSON.stringify({ k: k.toString('base64'), d: d.toString('base64') }) + '\n';
}

// La sesión se guarda cifrada con una llave que sale de la clave (secreto), así nadie más la puede usar.
const LLAVE = crypto.createHash('sha256').update('pp-sesion|' + (VM_PASS || '')).digest();
function guardarSesion(obj, archivo = SESION) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', LLAVE, iv);
  const datos = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  fs.mkdirSync('.sesion', { recursive: true });
  fs.writeFileSync(archivo, Buffer.concat([iv, c.getAuthTag(), datos]));
}
function leerSesion(archivo = SESION) {
  try {
    const b = fs.readFileSync(archivo);
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
async function iniciarSesion(page, urlLogin, user, pass, esLogin, marcarRecordar = false) {
  if (!user || !pass) return false;
  await page.goto(urlLogin, { waitUntil: 'networkidle' }).catch(() => {});
  const clave = page.locator('input[type=password]').first();
  await clave.waitFor({ timeout: 30000 });
  // VM Shopping parte en chino: elegir Español si hay selector de idioma
  await page.locator('select').first().selectOption({ label: 'Español' }, { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const usuario = page.locator('input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio])').first();
  // Se escribe tecla por tecla, como una persona (algunas páginas no toman el texto pegado de una)
  await usuario.click(); await usuario.fill(''); await usuario.pressSequentially(user.trim(), { delay: 40 });
  await clave.click(); await clave.fill(''); await clave.pressSequentially(pass.trim(), { delay: 40 });
  if (marcarRecordar) {   // solo en PayScan ("Recuérdame"); en VM Shopping la casilla cambia el tipo de cuenta
    const recordar = page.locator('input[type=checkbox]').first();
    if (await recordar.count()) await recordar.check({ timeout: 2000 }).catch(() => {});
  }
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
    const sn = (bloque.match(/\b([A-Z]{3,}\d{6,})\b/) || [])[1];
    if (sn) SERIAL_MAQ[sn] = id;
  }
  return maq;
}
const SERIAL_MAQ = { BDSTJ2612001: 'M001', BDSTJ2612002: 'M002', BDSTJ2612003: 'M003' };   // se completa con lo que se ve en la app

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

// ---------- 4a) stock de papas (pantalla Carriles de la app de mantención) ----------
// Cada máquina se abre y se lee su carril de papas: "FRIES RAW MATERIALS … Stock: 7550/11000" (gramos)
// La app sale en el idioma guardado en el navegador (el robot la ve en chino): se fija en español y además se entienden los 3 idiomas
async function enEspanol(page) {
  await page.evaluate(() => { try { localStorage.setItem('locale', 'es-ES'); } catch (e) {} }).catch(() => {});
}
const STOCK_RE = /(?:Stock|库存)\s*[:：]\s*(\d+)\s*\/\s*(\d+)/;
async function leerStock(page) {
  await enEspanol(page);
  await page.goto(MANT + '/slots', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /#M\d{3}/.test(document.body.innerText) || /\/login/.test(location.pathname), null, { timeout: 40000 }).catch(() => {});
  if (esLoginMant(page.url())) return null;
  await page.waitForTimeout(1200);
  const stock = {};
  const series = await page.getByText(/^[A-Z]{3,}\d{6,}$/).all();
  for (const el of series) {
    const sn = ((await el.innerText().catch(() => '')) || '').trim();
    if (!sn) continue;
    await el.click({ timeout: 5000 }).catch(() => {});
    await page.waitForFunction(s => {
      const t = document.body.innerText; const i = t.indexOf(s); if (i < 0) return false;
      const resto = t.slice(i + s.length); const j = resto.search(/\n[A-Z]{3,}\d{6,}\n/);
      return /(?:Stock|库存)\s*[:：]\s*\d+\s*\/\s*\d+/.test(j < 0 ? resto : resto.slice(0, j));
    }, sn, { timeout: 8000 }).catch(() => {});
    const t = await page.innerText('body');
    const i = t.indexOf(sn); if (i < 0) continue;
    let bloque = t.slice(i + sn.length); const j = bloque.search(/\n[A-Z]{3,}\d{6,}\n/); if (j >= 0) bloque = bloque.slice(0, j);
    const id = (bloque.match(/#(M\d{3})/) || [])[1] || SERIAL_MAQ[sn];
    // El carril con papas: el primer "Stock" después de FRIES/papas; si no aparece el nombre, el primer Stock
    const papas = bloque.match(/(?:FRIES|PAPA|PATATA)[\s\S]{0,120}?(?:Stock|库存)\s*[:：]\s*(\d+)\s*\/\s*(\d+)/i) || bloque.match(STOCK_RE);
    if (id && papas) stock[id] = { g: +papas[1], max: +papas[2] };
    await el.click({ timeout: 5000 }).catch(() => {});   // cerrarla para que no se mezcle con la siguiente
    await page.waitForTimeout(400);
  }
  return stock;
}

// ---------- 4b) pedidos de hoy (pantalla Pedidos de la app de mantención) ----------
// 20 pedidos por página, del más nuevo al más antiguo. Se leen páginas hasta llegar a ayer (máximo 15),
// pero si ya se tienen los pedidos de hoy de corridas anteriores, basta con las 2 primeras páginas.
const ESTADOS_PED = ['Pendiente de pago', 'Pagando', 'Pago fallido', 'Cancelado', 'Pagado', 'Entregando', 'Entregado',
  'Reembolsado', 'Entrega fallida', 'Completado', 'Recogida fallida', 'Esperando recogida'];
const ESTADOS_EN = ['Pending Payment', 'Paying', 'Payment Failed', 'Cancelled', 'Paid', 'Delivering', 'Delivered',
  'Refunded', 'Delivery Failed', 'Completed', 'Pickup Failed', 'Awaiting Receipt'];
const ESTADOS_ZH = ['等待支付', '支付中', '支付失败', '已取消', '已支付', '出货中', '已出货', '已退款', '出货失败', '已完成', '取货失败', '待收货'];
const ESTADO_ES = {};
ESTADOS_PED.forEach((e, i) => { ESTADO_ES[e] = e; ESTADO_ES[ESTADOS_EN[i]] = e; ESTADO_ES[ESTADOS_ZH[i]] = e; });
const reOrden = () => new RegExp('(?<=^|\\n)(' + Object.keys(ESTADO_ES).sort((a, b) => b.length - a.length).join('|') + ')\\n(\\d{8,})([A-Z]{3,}\\d{6,})\\n(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2})\\nCLP\\$\\s*([\\d.,]+)', 'g');
async function leerPedidos(page, hoy, yaTengo) {
  await enEspanol(page);
  await page.goto(MANT + '/orders', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(document.body.innerText) || /\/login/.test(location.pathname), null, { timeout: 40000 }).catch(() => {});
  if (esLoginMant(page.url())) return null;
  await page.waitForTimeout(800);
  const re = reOrden();
  const out = {}, tope = yaTengo ? 2 : 15;
  for (let pag = 1; pag <= tope; pag++) {
    const t = await page.innerText('body');
    let r, viejo = false, n = 0;
    while ((r = re.exec(t))) {
      n++;
      const f = r[4];
      if (f.slice(0, 10) < hoy) { viejo = true; continue; }
      if (f.slice(0, 10) > hoy) continue;
      out[r[2]] = { m: SERIAL_MAQ[r[3]] || '?', st: ESTADO_ES[r[1]] || r[1], f, clp: num(r[5]) };
    }
    re.lastIndex = 0;
    if (viejo || !n) break;
    const sig = page.locator('button:has-text("Siguiente"), button:has-text("Next"), button:has-text("下一页")').first();
    if (!(await sig.count()) || await sig.isDisabled().catch(() => true)) break;
    const antes = t.slice(0, 2000);
    await sig.click().catch(() => {});
    await page.waitForFunction(a => document.body.innerText.slice(0, 2000) !== a, antes, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  return out;
}

// ---------- 5) pedidos en curso, casi en vivo (22-10-2026) ----------
// Un pedido pasa por: Pendiente de pago → Pagando → Pagado → Entregando (friendo) → Esperando recogida → Completado.
// Se miran solo los pedidos de los últimos 30 minutos que siguen en uno de esos estados.
const EN_CURSO = ['Pendiente de pago', 'Pagando', 'Pagado', 'Entregando', 'Esperando recogida'];
const aMin = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
async function leerPrimeraPagina(page) {   // solo la primera página de Pedidos (los 20 más nuevos)
  await page.goto(MANT + '/orders', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(document.body.innerText) || /\/login/.test(location.pathname), null, { timeout: 20000 }).catch(() => {});
  if (esLoginMant(page.url())) return null;
  await page.waitForTimeout(500);
  const t = await page.innerText('body'), re = reOrden(), out = {};
  let r;
  while ((r = re.exec(t))) out[r[2]] = { m: SERIAL_MAQ[r[3]] || '?', st: ESTADO_ES[r[1]] || r[1], f: r[4] };
  return out;
}
const vivo = { map: {}, ultEnvio: 0, ultFirma: '', lecturas: 0, envios: 0 };
function actualizarVivo(pedidos) {   // pedidos: id → {m, st, f}
  const a = ahoraSantiago(), ahora = aMin(`${a.dia} ${a.hora}`);
  for (const [id, x] of Object.entries(pedidos || {})) {
    const viejo = vivo.map[id];
    if (!viejo || viejo.st !== x.st) vivo.map[id] = { m: x.m, st: x.st, f: x.f, d: Date.now() };   // d = cuándo se vio por primera vez en ese estado
  }
  for (const [id, x] of Object.entries(vivo.map)) if (!EN_CURSO.includes(x.st) || ahora - aMin(x.f) > 30) delete vivo.map[id];
  return Object.entries(vivo.map).map(([id, x]) => ({ id: id.slice(-6), m: x.m, st: x.st, f: x.f.slice(11), d: Math.round(x.d / 1000) }));
}
async function avisarVivo(lista, fin = false) {
  if (!LLAVE_PP) return;
  const firma = JSON.stringify(lista.map(x => [x.id, x.st]));
  // Se manda en cada vuelta (cada 20 s) para que la página muestre "mirado hace X s" real; la firma queda por si se quiere espaciar
  const r = await postear(ENVIVO, { u: Math.round(Date.now() / 1000), cada: VIGILAR_CADA_MS / 1000, fin, ped: lista }, LLAVE_PP).catch(e => ({ status: 0 }));
  if (r.status === 200) { vivo.ultFirma = firma; vivo.ultEnvio = Date.now(); vivo.envios++; }
}
async function vigilarPedidos(page) {
  let errores = 0;
  while (Date.now() - T0 + VIGILAR_CADA_MS < VIGILAR_HASTA_MS) {
    const espera = VIGILAR_CADA_MS - ((Date.now() - T0) % VIGILAR_CADA_MS);
    await page.waitForTimeout(espera);
    try {
      const l = await leerPrimeraPagina(page);
      if (l === null) { console.log('Vigilancia de pedidos: la sesión venció, se corta'); break; }
      vivo.lecturas++;
      await avisarVivo(actualizarVivo(l));
      errores = 0;
    } catch (e) { if (++errores >= 3) { console.log('Vigilancia de pedidos: 3 errores seguidos, se corta'); break; } }
  }
  await avisarVivo(actualizarVivo({}), true).catch(() => {});
  console.log(`Vigilancia de pedidos: ${vivo.lecturas} lecturas, ${vivo.envios} envíos a la intranet`);
}

// ---------- 3) PayScan ----------
const esLoginPs = u => /auth\/login/.test(u);
const num = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;
// Lee la LISTA de transacciones (no el resumen) directo de la API que usa la página de PayScan,
// con el mismo inicio de sesión: así sale la hora de cada venta y el conteo cuadra con PayScan.
// Trae los últimos DIAS_TX días (hora de Santiago) para armar la curva hora a hora y el historial.
const DIAS_TX = 15;
const KIT_MAQ = { '230800': 'M001', '230799': 'M002', '230798': 'M003' };    // Kit Id en PayScan → máquina
const MAQ_POS = Object.fromEntries(Object.entries(POS_MAQ).map(([p, m]) => [m, p]));
function diaMas(dia, n) { const d = new Date(dia + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function desfaseSantiago() {   // horas que Santiago está detrás de UTC (3 en verano, 4 en invierno)
  const p = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((Date.now() - local) / 3600000);
}
async function leerVentas(page, hoy) {
  await page.goto(`${PS}/#/transactions?commerce_id=${PS_COMERCIO}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  if (esLoginPs(page.url())) return null;
  const off = desfaseSantiago(), hh = n => String(n).padStart(2, '0');
  const desde = diaMas(hoy, -(DIAS_TX - 1));
  const q = `date_start=${desde}T${hh(off)}:00:00&date_end=${diaMas(hoy, 1)}T${hh(off - 1)}:59:59&offset=${off}`;
  const r = await page.evaluate(async ({ comercio, q }) => {
    let tk = sessionStorage.getItem('token');
    if (!tk) return { status: 401 };
    try { const j = JSON.parse(tk); if (typeof j === 'string') tk = j; } catch {}
    const res = await fetch(`/api/commerces/${comercio}/transactions?${q}`, { headers: { Authorization: 'Bearer ' + tk } });
    if (!res.ok) return { status: res.status };
    const d = await res.json();
    if (!Array.isArray(d)) return { status: 200, raro: true };
    return { status: 200, tx: d.map(x => [x.date_local, x.kit_id, x.transaction_result, (x.transaction_amount || {}).amount]) };
  }, { comercio: PS_COMERCIO, q });
  if (r.status === 401 || r.status === 403) return null;
  if (r.status !== 200) throw new Error('la lista de transacciones respondió ' + r.status);
  if (r.raro) throw new Error('la lista de transacciones cambió de formato');
  // Solo APROBADAS. tx: día → máquina → [[HH:MM, monto], ...]
  const tx = {}, ventas = {};
  for (const [fecha, kit, res, monto] of r.tx) {
    const m = KIT_MAQ[String(kit)];
    if (!m || res !== 'APPROVED' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(fecha || '')) continue;
    const dia = fecha.slice(0, 10), hm = fecha.slice(11, 16), clp = num(monto);
    if (dia < desde || dia > hoy) continue;
    ((tx[dia] = tx[dia] || {})[m] = tx[dia][m] || []).push([hm, clp]);
    if (dia === hoy) { const v = ventas[MAQ_POS[m]] || (ventas[MAQ_POS[m]] = { n: 0, clp: 0 }); v.n++; v.clp += clp; }
  }
  for (const d of Object.values(tx)) for (const l of Object.values(d)) l.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return { ventas, tx, desde };
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

  // 2) Administración (usuario y clave propios; si no están en GitHub, se salta para no bloquear la cuenta)
  if (ADM_USER && ADM_PASS) try {
    let admin = await leerAdmin(page);
    if (admin === null) {
      console.log('Administración: la sesión venció, iniciando sesión');
      if (await iniciarSesion(page, VM + '/login', ADM_USER, ADM_PASS, esLoginAdmin)) admin = await leerAdmin(page);
      if (admin === null) { informe.adminLogin = true; await debug(page, 'administracion-login'); throw new Error('pidió iniciar sesión y no pude entrar'); }
    }
    if (!Object.keys(admin).length) { await debug(page, 'administracion-sin-maquinas'); throw new Error('no encontré máquinas'); }
    informe.admin = admin;
  } catch (e) { informe.adminError = e.message.slice(0, 100); fallas.push('administración: ' + e.message); }
  else informe.adminError = 'falta guardar su usuario y clave en GitHub';

  // 4) Stock y pedidos de hoy (misma sesión de la app de mantención). Nada de esto se escribe en el registro público.
  const extra = { dia: t.dia };
  if (mant) {
    try { const st = await leerStock(page); if (st && Object.keys(st).length) extra.stock = st; else { fallas.push('stock: no lo encontré'); await debug(page, 'stock'); } }
    catch (e) { fallas.push('stock: ' + e.message); }
    try {
      let previos = leerSesion(PEDIDOS_BIN);
      if (!previos || previos.dia !== t.dia) previos = { dia: t.dia, p: {} };
      const nuevos = await leerPedidos(page, t.dia, Object.keys(previos.p).length > 0);
      if (nuevos) await avisarVivo(actualizarVivo(nuevos)).catch(() => {});   // primera foto de los pedidos en curso
      if (nuevos) {
        Object.assign(previos.p, nuevos);   // el estado más reciente de cada pedido manda
        guardarSesion(previos, PEDIDOS_BIN);
        extra.pedidosDia = t.dia;
        extra.pedidos = Object.entries(previos.p).map(([id, x]) => ({ id, ...x }));
      }
    } catch (e) { fallas.push('pedidos: ' + e.message); }
  }

  // 3) PayScan (sin pantallazos: mostrarían ventas)
  try {
    let lv = await leerVentas(page, t.dia);
    if (lv === null) {
      console.log('PayScan: la sesión venció, iniciando sesión');
      if (await iniciarSesion(page, `${PS}/#/auth/login`, PS_USER, PS_PASS, esLoginPs, true)) lv = await leerVentas(page, t.dia);
      if (lv === null) { informe.ventasLogin = true; await debug(page, 'payscan-login', false); throw new Error('pidió iniciar sesión y no pude entrar'); }
    }
    informe.ventas = lv.ventas; informe.ventasDia = t.dia;
    informe.tx = lv.tx; informe.txDesde = lv.desde;
  } catch (e) { informe.ventasError = e.message.slice(0, 100); fallas.push('PayScan: ' + e.message); }

  guardarSesion(await ctx.storageState());

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
  // Stock y pedidos a la intranet (receptor aparte, con la misma llave)
  if (LLAVE_PP && (extra.stock || extra.pedidos)) {
    const r = await postear(EXTRA, extra, LLAVE_PP).catch(e => ({ status: 0, texto: e.message }));
    console.log(`pp-extra → ${r.status}`);
  }

  // Registro público: solo qué se pudo leer, sin cifras de ventas
  console.log(`${t.dia} ${t.hora} · mantención: ${mant ? JSON.stringify(mant) : 'sin dato'} · administración: ${informe.admin ? Object.keys(informe.admin).length + ' máquinas' : 'sin dato'} · PayScan: ${informe.ventas ? 'leído' : 'sin dato'} · stock: ${extra.stock ? Object.keys(extra.stock).length + ' máquinas' : 'sin dato'} · pedidos: ${extra.pedidos ? 'leídos' : 'sin dato'}`);
  if (fallas.length) console.log('Avisos: ' + fallas.join(' | '));

  // 5) Lo que queda de la corrida: mirar los pedidos cada 20 s (solo si la app de mantención respondió)
  if (mant) { try { await vigilarPedidos(page); } catch (e) { console.log('Vigilancia de pedidos: ' + e.message.slice(0, 80)); } }
  try { guardarSesion(await ctx.storageState()); } catch {}
  await browser.close();

  // Estado en el repositorio (cambia al menos una vez al día, así GitHub no pausa la tarea)
  if (mant) {
    let viejo = null;
    try { viejo = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch {}
    if (!viejo || viejo.dia !== t.dia || JSON.stringify(viejo.maq) !== JSON.stringify(mant)) {
      fs.writeFileSync(ESTADO, JSON.stringify({ dia: t.dia, desde: t.hora, maq: mant }, null, 2) + '\n');
    }
  }
  // Ventas del día en el archivo cifrado (para Logística). El historial se arma con la copia de la corrida
  // anterior, guardada en el cache de Actions cifrada igual que la sesión (.sesion/ventas.bin).
  if (informe.ventas) {
    let h = null;
    h = leerSesion('.sesion/ventas.bin');
    if (!h || typeof h.hist !== 'object') h = { hist: {} };
    // Días completos sacados de la lista de transacciones (corrige también días anteriores)
    let cambio = !fs.existsSync(VENTAS_ENC);
    for (let d = informe.txDesde; d && d <= t.dia; d = diaMas(d, 1)) {
      const dia = {};
      for (const m of Object.values(POS_MAQ)) {
        const l = ((informe.tx || {})[d] || {})[m] || [];
        dia[m] = { n: l.length, clp: l.reduce((s, x) => s + (x[1] | 0), 0) };
      }
      if (JSON.stringify(h.hist[d]) !== JSON.stringify(dia)) { h.hist[d] = dia; cambio = true; }
    }
    if (cambio) {
      const lim = new Date(Date.now() - 62 * 864e5).toISOString().slice(0, 10);
      for (const d of Object.keys(h.hist)) if (d < lim) delete h.hist[d];
      h.u = `${t.dia} ${t.hora}`;
      guardarSesion(h, '.sesion/ventas.bin');
      fs.writeFileSync(VENTAS_ENC, cifrarVentas(h));
    }
  }
  if (fallas.length >= 2 && !mant && !informe.ventas) throw new Error('No pude leer ninguna de las tres fuentes');
})().catch(e => { console.error('ERROR: ' + e.message); process.exit(1); });
