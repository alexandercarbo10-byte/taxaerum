const encoder = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'permissions-policy': 'camera=(self)'
  }
});
const route = pathname => pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
const text = (value, max = 120) => String(value || '').trim().slice(0, max);
const cents = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value) * 100) : null;
const isValidEan13 = value => {
  const code = String(value || ''); if (!/^\d{13}$/.test(code)) return false;
  const body = code.slice(0, 12);
  return (10 - body.split('').reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 1 : 3), 0) % 10) % 10 === Number(code[12]);
};

function base64url(bytes) { let value = ''; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function bytesFromBase64url(value) { const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4); return Uint8Array.from(atob(padded), char => char.charCodeAt(0)); }
async function signingKey(secret) { return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
function randomSalt() { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return base64url(bytes); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytesFromBase64url(salt), iterations: 150000 }, key, 256);
  return base64url(new Uint8Array(bits));
}
async function passwordRecord(password) { const salt = randomSalt(); return { salt, hash: await passwordHash(password, salt) }; }
const safePassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 200;
async function makeSession(env, claims) {
  const payload = base64url(encoder.encode(JSON.stringify({ ...claims, exp: Date.now() + 1000 * 60 * 60 * 12 })));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env.SESSION_SECRET), encoder.encode(payload))));
  return `${payload}.${signature}`;
}
async function session(request, env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || !env.SESSION_SECRET) return null;
  const [payload, signature] = token.split('.'); if (!payload || !signature) return null;
  const valid = await crypto.subtle.verify('HMAC', await signingKey(env.SESSION_SECRET), bytesFromBase64url(signature), encoder.encode(payload));
  if (!valid) return null;
  try { const claims = JSON.parse(new TextDecoder().decode(bytesFromBase64url(payload))); return claims.exp > Date.now() ? claims : null; } catch { return null; }
}
const denied = () => json({ error: 'Tu sesión venció. Conéctate otra vez.' }, 401);
const adminOnly = actor => actor?.role === 'admin' || actor?.role === 'owner';
const ownerOnly = actor => actor?.role === 'owner';
const actorName = actor => actor.role === 'seller' ? actor.cashier : (actor.cashier || 'Administrador');
async function audit(env, actor, action, entity, id = '', detail = '', deviceId = '') {
  await env.DB.prepare('INSERT INTO audit_log (actor_name,actor_role,action,entity_type,entity_id,device_id,detail) VALUES (?,?,?,?,?,?,?)')
    .bind(actorName(actor), actor.role, action, entity, String(id), text(deviceId), text(detail, 500)).run();
}
async function getProducts(env, publicOnly = false) {
  const where = publicOnly ? 'WHERE p.is_public=1 AND p.is_active=1' : '';
  const result = await env.DB.prepare(`SELECT p.id,p.name,p.description,p.sku,p.section,p.category,p.section_id,p.category_id,p.price,p.price_cents,p.cost_cents,p.barcode,p.min_stock,p.unit,p.is_active,p.is_public,p.updated_at,p.version,i.quantity AS stock FROM products p JOIN inventory i ON i.product_id=p.id ${where} ORDER BY p.name COLLATE NOCASE`).all();
  return result.results;
}
async function dashboard(env, cashier = null) {
  const suffix = cashier ? ' AND cashier_name=?' : '', binds = cashier ? [cashier] : [];
  const summary = await env.DB.prepare(`SELECT COALESCE(SUM(total_cents),0) AS cents,COALESCE(SUM((SELECT SUM(quantity) FROM sale_items WHERE sale_id=s.id)),0) AS units FROM sales s WHERE status='completed' AND date(created_at,'localtime')=date('now','localtime')${suffix}`).bind(...binds).first();
  const recent = await env.DB.prepare(`SELECT s.id,s.payment_method AS payment,s.cashier_name AS cashier,s.total_cents,s.created_at AS date,COALESCE(SUM(si.quantity),0) AS units,COUNT(si.id) AS item_count FROM sales s LEFT JOIN sale_items si ON si.sale_id=s.id WHERE s.status='completed'${suffix} GROUP BY s.id ORDER BY s.id DESC LIMIT 5`).bind(...binds).all();
  const byCashier = await env.DB.prepare(`SELECT COALESCE(NULLIF(cashier_name,''),'Sin asignar') AS cashier,COUNT(*) AS sales,COALESCE(SUM(total_cents),0) AS total_cents FROM sales WHERE status='completed' AND date(created_at,'localtime')=date('now','localtime')${suffix} GROUP BY cashier ORDER BY total_cents DESC`).bind(...binds).all();
  return { todaySales: Number(summary.cents || 0) / 100, todayUnits: Number(summary.units || 0), recentSales: recent.results.map(row => ({ ...row, total: Number(row.total_cents || 0) / 100 })), byCashier: byCashier.results.map(row => ({ ...row, total: Number(row.total_cents || 0) / 100 })) };
}

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: 'Falta enlazar D1 como DB.' }, 503);
  const current = route(new URL(request.url).pathname);
  if (request.method === 'GET' && current === 'status') return json({ cloud: true, apiVersion: 2 });

  if (request.method === 'POST' && current === 'bootstrap-owner') {
    const body = await request.json().catch(() => ({}));
    const username = text(body.username, 60), displayName = text(body.displayName, 80), password = body.password;
    if (!env.ADMIN_PASSWORD || body.legacyPassword !== env.ADMIN_PASSWORD) return json({ error: 'Contraseña de propietario incorrecta.' }, 401);
    if (!/^[a-z0-9._-]{3,60}$/i.test(username) || !displayName || !safePassword(password)) return json({ error: 'Usa un usuario válido y una contraseña de al menos 8 caracteres.' }, 400);
    const existing = await env.DB.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").first();
    if (existing) return json({ error: 'El propietario ya fue configurado.' }, 409);
    const record = await passwordRecord(password);
    const result = await env.DB.prepare("INSERT INTO users(username,display_name,password_hash,password_salt,role) VALUES(?,?,?,?, 'owner')").bind(username, displayName, record.hash, record.salt).run();
    return json({ id: result.meta.last_row_id, ok: true }, 201);
  }
  if (request.method === 'POST' && current === 'account-login') {
    const body = await request.json().catch(() => ({})), username = text(body.username, 60), password = body.password;
    const user = await env.DB.prepare('SELECT * FROM users WHERE username=? AND is_active=1').bind(username).first();
    if (!user || !safePassword(password) || await passwordHash(password, user.password_salt) !== user.password_hash) return json({ error: 'Usuario o contraseña incorrectos.' }, 401);
    await env.DB.prepare('UPDATE users SET last_login_at=CURRENT_TIMESTAMP WHERE id=?').bind(user.id).run();
    return json({ token: await makeSession(env, { role: user.role, cashier: user.display_name, userId: user.id }), role: user.role, cashier: user.display_name });
  }

  if (request.method === 'POST' && current === 'login') {
    const { password } = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({ error: 'Faltan secretos de seguridad.' }, 503);
    if (typeof password !== 'string' || password !== env.ADMIN_PASSWORD) return json({ error: 'Contraseña incorrecta.' }, 401);
    return json({ token: await makeSession(env, { role: 'admin' }), role: 'admin' });
  }
  if (request.method === 'POST' && current === 'seller-login') {
    const { name, pin } = await request.json().catch(() => ({}));
    let sellers = {}; try { sellers = JSON.parse(env.SELLERS_JSON || '{}'); } catch { return json({ error: 'La lista de vendedores no está configurada.' }, 503); }
    const cashier = text(name, 60);
    if (!cashier || typeof sellers[cashier] !== 'string' || sellers[cashier] !== String(pin || '')) return json({ error: 'Nombre o PIN incorrecto.' }, 401);
    return json({ token: await makeSession(env, { role: 'seller', cashier }), role: 'seller', cashier });
  }
  if (request.method === 'GET' && current === 'catalog') return json((await getProducts(env, true)).map(({ id, name, section, category, price, barcode, stock }) => ({ id, name, section, category, price, barcode, availability: stock > 5 ? 'Disponible' : stock > 0 ? 'Pocas unidades' : 'Agotado' })));

  const actor = await session(request, env); if (!actor) return denied();
  if (request.method === 'GET' && current === 'products') {
    const result = await getProducts(env);
    return json(actor.role === 'seller' ? result.map(({ cost_cents, ...product }) => product) : result);
  }
  if (request.method === 'GET' && current === 'dashboard') return json(await dashboard(env, actor.role === 'seller' ? actor.cashier : null));

  if (request.method === 'GET' && current === 'users') {
    if (!adminOnly(actor)) return json({ error: 'No tienes permiso para ver usuarios.' }, 403);
    const result = await env.DB.prepare('SELECT id,username,display_name,role,is_active,created_at,last_login_at FROM users ORDER BY role,display_name').all();
    return json(result.results);
  }
  if (request.method === 'POST' && current === 'users') {
    if (!adminOnly(actor)) return json({ error: 'Solo un administrador puede crear vendedores.' }, 403);
    const body = await request.json().catch(() => ({})), username = text(body.username, 60), displayName = text(body.displayName, 80), password = body.password, role = body.role === 'admin' ? 'admin' : 'seller';
    if (role === 'admin' && !ownerOnly(actor)) return json({ error: 'Solo el propietario puede crear administradores.' }, 403);
    if (!/^[a-z0-9._-]{3,60}$/i.test(username) || !displayName || !safePassword(password)) return json({ error: 'Revisa usuario, nombre y contraseña de al menos 8 caracteres.' }, 400);
    try { const record = await passwordRecord(password), result = await env.DB.prepare('INSERT INTO users(username,display_name,password_hash,password_salt,role) VALUES(?,?,?,?,?)').bind(username, displayName, record.hash, record.salt, role).run(); await audit(env, actor, 'create', 'user', result.meta.last_row_id, `${role}:${username}`, body.deviceId); return json({ id: result.meta.last_row_id }, 201); } catch { return json({ error: 'Ese usuario ya existe.' }, 409); }
  }
  const userMatch = current.match(/^users\/(\d+)$/);
  if (request.method === 'PATCH' && userMatch) {
    if (!adminOnly(actor)) return json({ error: 'Solo un administrador puede editar usuarios.' }, 403);
    const id = Number(userMatch[1]), body = await request.json().catch(() => ({})), target = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
    if (!target) return json({ error: 'Usuario no encontrado.' }, 404);
    if ((target.role === 'owner' || body.role === 'admin') && !ownerOnly(actor)) return json({ error: 'Solo el propietario puede modificar administradores o propietario.' }, 403);
    const displayName = text(body.displayName, 80) || target.display_name, active = body.isActive === undefined ? target.is_active : (body.isActive ? 1 : 0), nextRole = ownerOnly(actor) && ['admin','seller'].includes(body.role) ? body.role : target.role;
    if (target.role === 'owner' && !active) return json({ error: 'No se puede desactivar al propietario.' }, 409);
    let passwordHashValue = target.password_hash, passwordSalt = target.password_salt;
    if (body.password !== undefined) { if (!safePassword(body.password)) return json({ error: 'La contraseña debe tener al menos 8 caracteres.' }, 400); const record = await passwordRecord(body.password); passwordHashValue = record.hash; passwordSalt = record.salt; }
    await env.DB.prepare('UPDATE users SET display_name=?,password_hash=?,password_salt=?,role=?,is_active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').bind(displayName, passwordHashValue, passwordSalt, nextRole, active, id).run();
    await audit(env, actor, 'update', 'user', id, `${nextRole}:${active ? 'active' : 'inactive'}`, body.deviceId); return json({ ok: true });
  }
  const transferMatch = current.match(/^users\/(\d+)\/transfer-ownership$/);
  if (request.method === 'POST' && transferMatch) {
    if (!ownerOnly(actor)) return json({ error: 'Solo el propietario puede transferir el negocio.' }, 403);
    const body = await request.json().catch(() => ({})); if (body.confirmation !== 'TRANSFERIR') return json({ error: 'Confirma la transferencia escribiendo TRANSFERIR.' }, 400);
    const target = await env.DB.prepare("SELECT id,display_name FROM users WHERE id=? AND role='admin' AND is_active=1").bind(Number(transferMatch[1])).first();
    if (!target) return json({ error: 'El nuevo propietario debe ser un administrador activo.' }, 409);
    await env.DB.batch([env.DB.prepare("UPDATE users SET role='admin',updated_at=CURRENT_TIMESTAMP WHERE role='owner'"), env.DB.prepare("UPDATE users SET role='owner',updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(target.id)]);
    await audit(env, actor, 'transfer_ownership', 'user', target.id, target.display_name, body.deviceId); return json({ ok: true });
  }

  if (current === 'sections' && request.method === 'GET') return json((await env.DB.prepare('SELECT * FROM business_sections ORDER BY sort_order,name').all()).results);
  if (current === 'categories' && request.method === 'GET') return json((await env.DB.prepare('SELECT * FROM business_categories ORDER BY sort_order,name').all()).results);
  if (current === 'sections' && request.method === 'POST') {
    if (!adminOnly(actor)) return json({ error: 'Solo el administrador puede configurar secciones.' }, 403);
    const body = await request.json().catch(() => ({})), name = text(body.name);
    if (!name) return json({ error: 'Escribe el nombre de la sección.' }, 400);
    try { const result = await env.DB.prepare('INSERT INTO business_sections(name,sort_order) VALUES (?,?)').bind(name, Number(body.sortOrder) || 0).run(); await audit(env, actor, 'create', 'section', result.meta.last_row_id, name, body.deviceId); return json({ id: result.meta.last_row_id }, 201); } catch { return json({ error: 'La sección ya existe.' }, 409); }
  }
  if (current === 'categories' && request.method === 'POST') {
    if (!adminOnly(actor)) return json({ error: 'Solo el administrador puede configurar categorías.' }, 403);
    const body = await request.json().catch(() => ({})), name = text(body.name), sectionId = body.sectionId === null ? null : Number(body.sectionId);
    if (!name || (sectionId !== null && !Number.isInteger(sectionId))) return json({ error: 'Revisa categoría y sección.' }, 400);
    try { const result = await env.DB.prepare('INSERT INTO business_categories(section_id,name,sort_order) VALUES (?,?,?)').bind(sectionId, name, Number(body.sortOrder) || 0).run(); await audit(env, actor, 'create', 'category', result.meta.last_row_id, name, body.deviceId); return json({ id: result.meta.last_row_id }, 201); } catch { return json({ error: 'La categoría ya existe en esa sección.' }, 409); }
  }

  if (request.method === 'POST' && current === 'products') {
    if (!adminOnly(actor)) return json({ error: 'Solo el administrador puede modificar productos.' }, 403);
    const body = await request.json().catch(() => ({}));
    const name = text(body.name), barcode = text(body.barcode, 40), priceCents = cents(body.price), stock = Number(body.stock);
    if (!name || !isValidEan13(barcode) || priceCents === null || !Number.isInteger(stock) || stock < 0) return json({ error: 'Revisa nombre, precio, stock y un EAN-13 válido.' }, 400);
    try {
      const created = await env.DB.prepare('INSERT INTO products(name,description,sku,section,category,price,price_cents,cost_cents,barcode,min_stock,unit,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)').bind(name, text(body.description, 1000), text(body.sku, 80) || null, text(body.section) || 'General', text(body.category) || 'Sin categoría', priceCents / 100, priceCents, cents(body.cost) || 0, barcode, Number.isInteger(Number(body.minStock)) ? Number(body.minStock) : 3, text(body.unit, 40) || 'unidad').run();
      await env.DB.batch([env.DB.prepare('INSERT INTO inventory(product_id,quantity) VALUES(?,?)').bind(created.meta.last_row_id, stock), env.DB.prepare("INSERT INTO inventory_movements(product_id,movement_type,quantity_before,quantity_change,quantity_after,reason,actor_name,reference_type) VALUES(?,'initial',0,?,?, 'Stock inicial',?,'product')").bind(created.meta.last_row_id, stock, stock, actorName(actor))]);
      await audit(env, actor, 'create', 'product', created.meta.last_row_id, name, body.deviceId); return json({ id: created.meta.last_row_id }, 201);
    } catch { return json({ error: 'Ese código o SKU ya existe.' }, 409); }
  }

  const productMatch = current.match(/^products\/(\d+)$/);
  if (request.method === 'PATCH' && productMatch) {
    if (!adminOnly(actor)) return json({ error: 'Solo el administrador puede editar productos.' }, 403);
    const body = await request.json().catch(() => ({})), id = Number(productMatch[1]);
    const name = text(body.name), priceCents = cents(body.price), stock = Number(body.stock);
    if (!name || priceCents === null || !Number.isInteger(stock) || stock < 0) return json({ error: 'Revisa nombre, precio y stock.' }, 400);
    const before = await env.DB.prepare('SELECT quantity FROM inventory WHERE product_id=?').bind(id).first(); if (!before) return json({ error: 'Producto no encontrado.' }, 404);
    const change = stock - Number(before.quantity);
    await env.DB.batch([
      env.DB.prepare('UPDATE products SET name=?,description=?,sku=?,section=?,category=?,price=?,price_cents=?,cost_cents=?,min_stock=?,unit=?,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=?').bind(name, text(body.description, 1000), text(body.sku, 80) || null, text(body.section) || 'General', text(body.category) || 'Sin categoría', priceCents / 100, priceCents, cents(body.cost) || 0, Number.isInteger(Number(body.minStock)) ? Number(body.minStock) : 3, text(body.unit, 40) || 'unidad', id),
      env.DB.prepare('UPDATE inventory SET quantity=? WHERE product_id=?').bind(stock, id),
      env.DB.prepare("INSERT INTO inventory_movements(product_id,movement_type,quantity_before,quantity_change,quantity_after,reason,actor_name,device_id,reference_type) VALUES(?,'adjustment',?,?,?,?,?,?,'product')").bind(id, before.quantity, change, stock, text(body.reason, 300) || 'Ajuste manual', actorName(actor), text(body.deviceId))
    ]);
    await audit(env, actor, 'update', 'product', id, `Ajuste de stock: ${change}`, body.deviceId); return json({ ok: true });
  }
  if (request.method === 'DELETE' && productMatch) { if (!adminOnly(actor)) return json({ error: 'Solo el administrador puede eliminar productos.' }, 403); return json({ error: 'Por seguridad, desactiva el producto en lugar de eliminarlo.' }, 409); }

  if (request.method === 'POST' && current === 'sales') {
    const body = await request.json().catch(() => ({})), items = Array.isArray(body.items) ? body.items : [];
    const idempotencyKey = text(request.headers.get('idempotency-key') || body.idempotencyKey, 100), deviceId = text(body.deviceId, 120);
    const cashier = actor.role === 'seller' ? actor.cashier : (text(body.cashier, 60) || 'Sin asignar'), payment = text(body.payment, 40) || 'Efectivo';
    if (!/^[a-zA-Z0-9-]{16,100}$/.test(idempotencyKey)) return json({ error: 'Falta una clave válida de idempotencia.' }, 400);
    const previous = await env.DB.prepare('SELECT id,total_cents FROM sales WHERE idempotency_key=?').bind(idempotencyKey).first();
    if (previous) return json({ ok: true, duplicate: true, saleId: previous.id, total: Number(previous.total_cents) / 100 });
    const clean = items.map(item => ({ id: Number(item.id), qty: Number(item.qty) }));
    if (!clean.length || clean.some(item => !Number.isInteger(item.id) || !Number.isInteger(item.qty) || item.qty < 1)) return json({ error: 'La venta no tiene productos válidos.' }, 400);
    const ids = [...new Set(clean.map(item => item.id))]; if (ids.length !== clean.length) return json({ error: 'Producto repetido en la venta.' }, 400);
    const found = await env.DB.prepare(`SELECT p.id,p.name,p.price_cents,i.quantity AS stock FROM products p JOIN inventory i ON i.product_id=p.id WHERE p.is_active=1 AND p.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    if (found.results.length !== clean.length) return json({ error: 'Uno de los productos no está disponible.' }, 409);
    const available = new Map(found.results.map(product => [product.id, product]));
    for (const item of clean) if (Number(available.get(item.id).stock) < item.qty) return json({ error: `No hay suficiente stock de ${available.get(item.id).name}.` }, 409);
    const totalCents = clean.reduce((sum, item) => sum + Number(available.get(item.id).price_cents) * item.qty, 0), statements = [];
    statements.push(env.DB.prepare("INSERT INTO sales(payment_method,cashier_name,total,total_cents,idempotency_key,device_id,note) VALUES(?,?,?,?,?,?,?)").bind(payment, cashier, totalCents / 100, totalCents, idempotencyKey, deviceId || null, text(body.note, 500)));
    for (const item of clean) {
      const product = available.get(item.id), after = Number(product.stock) - item.qty;
      statements.push(env.DB.prepare('INSERT INTO sale_items(sale_id,product_id,quantity,unit_price,unit_price_cents) VALUES((SELECT id FROM sales WHERE idempotency_key=?),?,?,?,?)').bind(idempotencyKey, item.id, item.qty, Number(product.price_cents) / 100, product.price_cents));
      statements.push(env.DB.prepare('UPDATE inventory SET quantity=quantity-? WHERE product_id=?').bind(item.qty, item.id));
      statements.push(env.DB.prepare("INSERT INTO inventory_movements(product_id,movement_type,quantity_before,quantity_change,quantity_after,reason,actor_name,device_id,reference_type,reference_id,idempotency_key) VALUES(?,'sale',?,?,?,'Venta',?,?, 'sale',(SELECT id FROM sales WHERE idempotency_key=?),?)").bind(item.id, product.stock, -item.qty, after, cashier, deviceId || null, idempotencyKey, `${idempotencyKey}-${item.id}`));
    }
    try { await env.DB.batch(statements); } catch {
      const duplicate = await env.DB.prepare('SELECT id,total_cents FROM sales WHERE idempotency_key=?').bind(idempotencyKey).first();
      if (duplicate) return json({ ok: true, duplicate: true, saleId: duplicate.id, total: Number(duplicate.total_cents) / 100 });
      return json({ error: 'No se pudo registrar la venta. Revisa stock y vuelve a sincronizar.' }, 409);
    }
    const sale = await env.DB.prepare('SELECT id FROM sales WHERE idempotency_key=?').bind(idempotencyKey).first();
    await audit(env, actor, 'create', 'sale', sale.id, `Venta ${payment}`, deviceId);
    return json({ ok: true, saleId: sale.id, total: totalCents / 100 });
  }
  return json({ error: 'Ruta no encontrada.' }, 404);
}
