const encoder = new TextEncoder();

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

function route(pathname) {
  return pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
}

function base64url(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesFromBase64url(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function signingKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function makeSession(env) {
  const payload = base64url(encoder.encode(JSON.stringify({ exp: Date.now() + 1000 * 60 * 60 * 12 })));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), encoder.encode(payload))));
  return `${payload}.${signature}`;
}

async function authorized(request, env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !env.SESSION_SECRET) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const valid = await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), bytesFromBase64url(signature), encoder.encode(payload));
  if (!valid) return false;
  try { return JSON.parse(new TextDecoder().decode(bytesFromBase64url(payload))).exp > Date.now(); } catch { return false; }
}

async function requireAdmin(request, env) {
  return (await authorized(request, env)) ? null : json({ error: 'Tu sesión venció. Conéctate otra vez.' }, 401);
}

async function products(env, publicOnly = false) {
  const where = publicOnly ? 'WHERE p.is_public = 1' : '';
  const result = await env.DB.prepare(`SELECT p.id, p.name, p.section, p.category, p.price, p.barcode, p.is_public, i.quantity AS stock FROM products p JOIN inventory i ON i.product_id = p.id ${where} ORDER BY p.name COLLATE NOCASE`).all();
  return result.results;
}

async function dashboard(env) {
  const summary = await env.DB.prepare(`SELECT COALESCE(SUM(s.total),0) AS sales, COALESCE(SUM((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id = s.id)),0) AS units FROM sales s WHERE date(s.created_at, 'localtime') = date('now', 'localtime')`).first();
  const recent = await env.DB.prepare(`SELECT s.id, s.payment_method AS payment, s.total, s.created_at AS date, COALESCE(SUM(si.quantity),0) AS units, COUNT(si.id) AS item_count FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id GROUP BY s.id ORDER BY s.id DESC LIMIT 5`).all();
  return { todaySales: Number(summary.sales || 0), todayUnits: Number(summary.units || 0), recentSales: recent.results };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'Falta conectar la base de datos D1 con el nombre DB.' }, 503);
  const current = route(new URL(request.url).pathname);

  if (request.method === 'GET' && current === 'status') return json({ cloud: true });

  if (request.method === 'POST' && current === 'login') {
    const { password } = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Faltan los secretos de seguridad en Cloudflare.' }, 503);
    if (typeof password !== 'string' || password !== env.ADMIN_PASSWORD) return json({ error: 'Contraseña incorrecta.' }, 401);
    return json({ token: await makeSession(env) });
  }

  if (request.method === 'GET' && current === 'catalog') {
    const list = await products(env, true);
    return json(list.map(({ id, name, section, category, price }) => ({ id, name, section, category, price })));
  }

  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (request.method === 'GET' && current === 'products') return json(await products(env));
  if (request.method === 'GET' && current === 'dashboard') return json(await dashboard(env));

  if (request.method === 'POST' && current === 'products') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const section = String(body.section || 'General').trim();
    const category = String(body.category || 'Sin categoría').trim();
    const price = Number(body.price);
    const stock = Number(body.stock);
    const barcode = String(body.barcode || '').trim();
    if (!name || !barcode || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) return json({ error: 'Revisa nombre, precio, stock y código.' }, 400);
    try {
      const created = await env.DB.prepare('INSERT INTO products (name, section, category, price, barcode) VALUES (?, ?, ?, ?, ?)').bind(name, section, category, price, barcode).run();
      await env.DB.prepare('INSERT INTO inventory (product_id, quantity) VALUES (?, ?)').bind(created.meta.last_row_id, stock).run();
      return json({ id: created.meta.last_row_id }, 201);
    } catch (error) { return json({ error: 'Ese código ya existe o no se pudo guardar.' }, 409); }
  }

  const productMatch = current.match(/^products\/(\d+)$/);
  if (request.method === 'DELETE' && productMatch) {
    const id = Number(productMatch[1]);
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  if (request.method === 'POST' && current === 'sales') {
    const body = await request.json().catch(() => ({}));
    const items = Array.isArray(body.items) ? body.items : [];
    const payment = String(body.payment || 'Efectivo').slice(0, 40);
    if (!items.length) return json({ error: 'La venta no tiene productos.' }, 400);
    const clean = items.map(item => ({ id: Number(item.id), qty: Number(item.qty) }));
    if (clean.some(item => !Number.isInteger(item.id) || !Number.isInteger(item.qty) || item.qty < 1)) return json({ error: 'Productos de venta inválidos.' }, 400);
    const ids = [...new Set(clean.map(item => item.id))];
    if (ids.length !== clean.length) return json({ error: 'Producto repetido en la venta.' }, 400);
    const values = await env.DB.prepare(`SELECT p.id, p.name, p.price, i.quantity AS stock FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    if (values.results.length !== clean.length) return json({ error: 'Uno de los productos ya no existe.' }, 400);
    const available = new Map(values.results.map(product => [product.id, product]));
    for (const item of clean) if (available.get(item.id).stock < item.qty) return json({ error: `No hay suficiente stock de ${available.get(item.id).name}.` }, 400);
    const total = clean.reduce((sum, item) => sum + available.get(item.id).price * item.qty, 0);
    const sale = await env.DB.prepare('INSERT INTO sales (payment_method, total) VALUES (?, ?)').bind(payment, total).run();
    const statements = [];
    for (const item of clean) {
      const product = available.get(item.id);
      statements.push(env.DB.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)').bind(sale.meta.last_row_id, item.id, item.qty, product.price));
      statements.push(env.DB.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id = ?').bind(item.qty, item.id));
    }
    await env.DB.batch(statements);
    return json({ ok: true, total });
  }

  return json({ error: 'Ruta no encontrada.' }, 404);
}
