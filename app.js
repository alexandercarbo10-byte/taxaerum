const key = 'taxaerum-local-v1';
let db = JSON.parse(localStorage.getItem(key) || '{"products":[],"sales":[]}');
let cart = [], cloudAvailable = false, cloudMode = false, syncing = false;
let cloudToken = localStorage.getItem('taxaerum-session') || '';
let cloudRole = localStorage.getItem('taxaerum-role') || 'admin';
let cloudCashier = localStorage.getItem('taxaerum-session-cashier') || '';
let cloudBusiness = JSON.parse(localStorage.getItem('taxaerum-business') || 'null');
let cloudBusinesses = JSON.parse(localStorage.getItem('taxaerum-businesses') || '[]');
let businessSections = [], businessCategories = [], businessUsers = [];
const isManager = () => cloudRole === 'owner' || cloudRole === 'admin';
const deviceId = localStorage.getItem('taxaerum-device-id') || (() => { const id = crypto.randomUUID ? crypto.randomUUID() : `device-${Date.now()}-${Math.random().toString(16).slice(2)}`; localStorage.setItem('taxaerum-device-id', id); return id; })();
const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(n || 0);
const save = () => localStorage.setItem(key, JSON.stringify(db));
const escapeHtml = value => { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; };

let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('installButton').hidden = false; });
$('installButton').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installButton').hidden = true; };
if ('serviceWorker' in navigator) window.addEventListener('load', async () => {
  const registration = await navigator.serviceWorker.register('service-worker.js');
  registration.update();
  let refreshed = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!refreshed) { refreshed = true; window.location.reload(); }
  });
});

function eanCheck(body) { return (10 - body.split('').reverse().reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 1 : 3), 0) % 10) % 10; }
function validEan13(code) { return /^\d{13}$/.test(String(code)) && eanCheck(String(code).slice(0, 12)) === Number(String(code)[12]); }
function makeCode() { const body = `200${Date.now().toString().slice(-7)}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`; return `${body}${eanCheck(body)}`; }
const eanL = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const eanG = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const eanR = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
const eanParity = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
function barcodeHtml(code) {
  if (!/^\d{13}$/.test(code)) return `<span class="code">${escapeHtml(code)}</span>`;
  let bars = '101', parity = eanParity[Number(code[0])];
  for (let i = 1; i <= 6; i++) bars += (parity[i - 1] === 'L' ? eanL : eanG)[Number(code[i])];
  bars += '01010'; for (let i = 7; i <= 12; i++) bars += eanR[Number(code[i])]; bars += '101';
  const rects = [...bars].map((bar, index) => bar === '1' ? `<rect x="${index + 9}" y="${index < 3 || (index >= 45 && index < 50) || index >= 92 ? 4 : 10}" width="1" height="${index < 3 || (index >= 45 && index < 50) || index >= 92 ? 50 : 42}"/>` : '').join('');
  return `<div class="barcode"><svg viewBox="0 0 113 64" role="img" aria-label="Código de barras ${code}"><rect width="113" height="64" fill="white"/>${rects}<text x="56.5" y="61" text-anchor="middle" font-family="monospace" font-size="8">${code}</text></svg></div>`;
}
function mountScanner() {
  const input = $('search');
  input.insertAdjacentHTML('afterend', '<div class="actions"><button class="secondary" type="button" onclick="startScanner()">Escanear con cámara</button></div><div id="scannerPanel" hidden><video id="scannerVideo" autoplay muted playsinline></video><div class="actions"><span class="label">Apunta la cámara al código de barras.</span><button class="danger" type="button" onclick="stopScanner()">Cerrar cámara</button></div></div>');
}
function mountCashier() {
  $('payment').insertAdjacentHTML('afterend', '<label style="margin-top:12px">Vendedor/a</label><input id="cashier" maxlength="60" placeholder="Ej. Andrea" />');
  const input = $('cashier'); input.value = localStorage.getItem('taxaerum-cashier') || '';
  input.onchange = () => localStorage.setItem('taxaerum-cashier', input.value.trim());
  $('recentSales').closest('.card').insertAdjacentHTML('beforeend', '<h2 class="title" style="margin-top:22px">Ventas por persona (hoy)</h2><div id="cashierSummary" class="empty">Aún no hay ventas registradas.</div>');
}
function mountProductDetails() {
  const grid = $('productForm').querySelector('.form-grid');
  grid.insertAdjacentHTML('beforeend', '<div class="wide"><label>Descripción</label><input id="description" maxlength="1000" placeholder="Opcional" /></div><div><label>SKU interno</label><input id="sku" maxlength="80" placeholder="Opcional" /></div><div><label>Código EAN-13</label><input id="barcode" inputmode="numeric" maxlength="13" placeholder="Automático si se deja vacío" /></div><div><label>Costo unitario (USD)</label><input id="cost" min="0" step="0.01" type="number" value="0" /></div><div><label>Stock mínimo</label><input id="minStock" min="0" step="1" type="number" value="3" /></div><div><label>Unidad de medida</label><input id="unit" maxlength="40" value="unidad" /></div>');
}
function mountRoleAccess() {
  $('cloudButton').insertAdjacentHTML('afterend', '<button id="sellerButton" class="secondary" hidden>Entrar como vendedor</button>');
  $('sellerButton').insertAdjacentHTML('afterend', '<button id="accountButton" class="secondary" hidden>Entrar con usuario</button>');
  $('accountButton').insertAdjacentHTML('afterend', '<button id="createBusinessButton" class="secondary" hidden>Crear mi negocio</button>');
  $('createBusinessButton').insertAdjacentHTML('afterend', '<button id="switchBusinessButton" class="secondary" hidden>Cambiar negocio</button>');
  $('sellerButton').onclick = connectSeller;
  $('accountButton').onclick = connectAccount;
  $('createBusinessButton').onclick = registerBusiness;
  $('switchBusinessButton').onclick = switchBusiness;
}
function mountSyncStatus() {
  document.querySelector('main.wrap').insertAdjacentHTML('afterbegin', '<div id="syncStatus" class="notice" role="status" aria-live="polite" style="display:none"></div>');
}
function mountConfiguration() {
  if (!$('categoryOptions')) { $('category').setAttribute('list', 'categoryOptions'); $('category').insertAdjacentHTML('afterend', '<datalist id="categoryOptions"></datalist>'); }
  if ([...$('section').options].some(option => option.textContent !== 'General')) $('section').innerHTML = '<option>General</option>';
  document.querySelector('nav').insertAdjacentHTML('beforeend', '<button class="tab" data-view="configuracion">Configuración</button>');
  document.querySelector('main.wrap').insertAdjacentHTML('beforeend', '<section class="view" id="configuracion"><div class="hero"><div><h1>Configuración</h1><p>Administra las secciones, categorías y accesos de tu negocio.</p></div></div><div class="split"><article class="card"><h2 class="title">Secciones</h2><form id="sectionForm"><label for="sectionName">Nueva sección</label><input id="sectionName" required maxlength="80" placeholder="Ej. Abarrotes" /><div class="actions"><button class="primary">Crear sección</button></div></form><div id="sectionRows" class="empty"></div></article><article class="card"><h2 class="title">Categorías</h2><form id="categoryForm"><label for="categorySection">Sección</label><select id="categorySection"><option value="">Sin sección</option></select><label for="categoryName" style="margin-top:12px">Nueva categoría</label><input id="categoryName" required maxlength="80" placeholder="Ej. Bebidas" /><div class="actions"><button class="primary">Crear categoría</button></div></form><div id="categoryRows" class="empty"></div></article></div><article class="card" id="usersCard" style="margin-top:18px"><h2 class="title">Usuarios del negocio</h2><div class="actions"><button class="secondary" type="button" onclick="bootstrapOwner()">Configurar propietario inicial</button></div><form id="userForm" style="margin-top:16px"><div class="form-grid"><div><label>Usuario</label><input id="userUsername" required pattern="[A-Za-z0-9._-]{3,60}" placeholder="Ej. andrea" /></div><div><label>Nombre visible</label><input id="userDisplayName" required maxlength="80" placeholder="Ej. Andrea" /></div><div><label>Contraseña o PIN</label><input id="userPassword" required minlength="8" type="password" /></div><div><label>Rol</label><select id="userRole"><option value="seller">Vendedor</option><option value="admin">Administrador</option></select></div></div><div class="actions"><button class="primary">Crear usuario</button></div></form><div id="userRows" class="empty"></div></article></section>');
  document.querySelector('[data-view="configuracion"]').onclick = () => show('configuracion');
  $('sectionForm').onsubmit = async event => { event.preventDefault(); try { await api('sections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('sectionName').value, deviceId }) }); event.target.reset(); await loadConfiguration(); } catch (error) { alert(error.message); } };
  $('categoryForm').onsubmit = async event => { event.preventDefault(); try { await api('categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: $('categoryName').value, sectionId: $('categorySection').value || null, deviceId }) }); event.target.reset(); await loadConfiguration(); } catch (error) { alert(error.message); } };
  $('userForm').onsubmit = async event => { event.preventDefault(); try { await api('users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('userUsername').value.trim(), displayName: $('userDisplayName').value.trim(), password: $('userPassword').value, role: $('userRole').value, deviceId }) }); event.target.reset(); await loadConfiguration(); } catch (error) { alert(error.message); } };
}
function renderConfiguration() {
  const sectionOptions = businessSections.filter(item => item.is_active).map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('');
  $('section').innerHTML = sectionOptions || '<option>General</option>';
  $('categoryOptions').innerHTML = businessCategories.filter(item => item.is_active).map(item => `<option value="${escapeHtml(item.name)}"></option>`).join('');
  $('categorySection').innerHTML = '<option value="">Sin sección</option>' + businessSections.filter(item => item.is_active).map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  $('sectionRows').innerHTML = businessSections.length ? businessSections.map(item => `<div class="cart-item"><span><b>${escapeHtml(item.name)}</b><br><small>${item.is_active ? 'Activa' : 'Inactiva'}</small></span></div>`).join('') : 'Aún no hay secciones.';
  $('categoryRows').innerHTML = businessCategories.length ? businessCategories.map(item => `<div class="cart-item"><span><b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(businessSections.find(section => section.id === item.section_id)?.name || 'Sin sección')}</small></span></div>`).join('') : 'Aún no hay categorías.';
  $('usersCard').hidden = !isManager();
  $('userRole').innerHTML = cloudRole === 'owner' ? '<option value="seller">Vendedor</option><option value="admin">Administrador</option>' : '<option value="seller">Vendedor</option>';
  $('userRows').innerHTML = businessUsers.length ? businessUsers.map(user => `<div class="cart-item"><span><b>${escapeHtml(user.display_name)}</b><br><small>${escapeHtml(user.username)} · ${user.role === 'owner' ? 'Propietario' : user.role === 'admin' ? 'Administrador' : 'Vendedor'} · ${user.is_active ? 'Activo' : 'Inactivo'}</small></span>${cloudRole === 'owner' && user.role === 'admin' && user.is_active ? `<button class="secondary" onclick="transferOwnership(${user.id}, '${escapeHtml(user.display_name).replace(/'/g, '&#39;')}')">Hacer propietario</button>` : ''}</div>`).join('') : 'Aún no hay cuentas creadas.';
}
async function loadConfiguration() {
  if (!cloudMode || !isManager()) return;
  [businessSections, businessCategories, businessUsers] = await Promise.all([api('sections'), api('categories'), api('users')]); renderConfiguration();
}
async function bootstrapOwner() {
  const username = prompt('Usuario del propietario (ej. dueno):'); if (!username) return;
  const displayName = prompt('Nombre visible del propietario:'); if (!displayName) return;
  const password = prompt('Nueva contraseña del propietario (mínimo 8 caracteres):'); if (!password) return;
  const legacyPassword = prompt('Contraseña administrativa actual, solo para confirmar esta configuración:'); if (!legacyPassword) return;
  try { const response = await fetch('/api/bootstrap-owner', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName, password, legacyPassword }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo configurar el propietario.'); alert('Propietario configurado. Cierra sesión y entra de nuevo usando tu usuario y nueva contraseña.'); } catch (error) { alert(error.message); }
}
async function transferOwnership(id, name) {
  if (!confirm(`¿Transferir el control total del negocio a ${name}? Tú pasarás a ser administrador.`)) return;
  const confirmation = prompt('Escribe TRANSFERIR para confirmar:'); if (confirmation !== 'TRANSFERIR') return;
  try { await api(`users/${id}/transfer-ownership`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation, deviceId }) }); alert('Propiedad transferida correctamente.'); await loadConfiguration(); } catch (error) { alert(error.message); }
}
async function updateSyncStatus(message = '') {
  const box = $('syncStatus'); if (!box) return;
  const pending = await TaxaerumOffline.pendingCount().catch(() => 0);
  const online = navigator.onLine;
  box.style.display = (!online || pending || message) ? 'block' : 'none';
  if (!box.style.display || box.style.display === 'none') return;
  if (message) box.textContent = message;
  else if (!online) box.textContent = pending ? `Sin conexión. ${pending} venta(s) pendiente(s) de sincronizar.` : 'Sin conexión. Puedes preparar ventas; se guardarán en este dispositivo.';
  else box.textContent = pending ? `${pending} venta(s) pendiente(s). Se sincronizarán automáticamente.` : 'Conectado y sincronizado.';
}
function saleOperation(items, payment, cashier) {
  const id = crypto.randomUUID ? crypto.randomUUID() : `sale-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, type: 'sale', status: 'pending', createdAt: new Date().toISOString(), attempts: 0, deviceId, payload: { items: items.map(item => ({ id: item.id, qty: item.qty })), payment, cashier, idempotencyKey: id, deviceId } };
}
async function queueOfflineSale(operation, reason = '') {
  operation.status = reason ? 'conflict' : 'pending'; operation.lastError = reason;
  await TaxaerumOffline.put(operation); await updateSyncStatus();
}
async function withSyncLock(callback) {
  if (navigator.locks?.request) return navigator.locks.request('taxaerum-sales-sync', { ifAvailable: true }, lock => lock ? callback() : undefined);
  if (syncing) return; syncing = true; try { return await callback(); } finally { syncing = false; }
}
async function syncPending() {
  if (!navigator.onLine || !cloudToken || syncing) return updateSyncStatus();
  return withSyncLock(async () => {
    const operations = await TaxaerumOffline.list();
    for (const operation of operations.filter(item => item.type === 'sale' && item.status === 'pending')) {
      if (operation.nextAttemptAt && Date.parse(operation.nextAttemptAt) > Date.now()) continue;
    try {
        const result = await api('sales', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': operation.id }, body: JSON.stringify(operation.payload) });
        if (result.ok) await TaxaerumOffline.remove(operation.id);
      } catch (error) {
        operation.attempts = Number(operation.attempts || 0) + 1;
        operation.lastError = error.message;
        if (/stock|no existe|inval/i.test(error.message)) operation.status = 'conflict';
        else operation.nextAttemptAt = new Date(Date.now() + Math.min(300000, 1000 * 2 ** operation.attempts)).toISOString();
        await TaxaerumOffline.put(operation);
      }
    }
    await updateSyncStatus();
    if (cloudMode) await loadCloud().catch(() => {});
  });
}
let scanStream, scanning = false;
async function startScanner() {
  if (!('BarcodeDetector' in window)) return alert('Este navegador no permite escanear con cámara. Puedes usar la cámara normal del iPhone para leer el código o escribirlo en el buscador.');
  try {
    const video = $('scannerVideo'); scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = scanStream; $('scannerPanel').hidden = false; scanning = true;
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a'] });
    const scan = async () => {
      if (!scanning) return;
      const found = await detector.detect(video);
      if (found[0]?.rawValue) {
        const code = found[0].rawValue;
        const product = db.products.find(item => String(item.code || item.barcode) === code);
        stopScanner();
        if (!product) { $('search').value = code; renderSaleProducts(); return alert('No encontré ese código. Puedes revisar el producto en el buscador.'); }
        if (confirm(`¿Confirmar venta de ${product.name} por ${money(product.price)}?`)) { cart = [{ id: product.id, qty: 1 }]; await completeSale(); }
        return;
      }
      requestAnimationFrame(scan);
    };
    video.onloadeddata = scan;
  } catch (error) { stopScanner(); alert('No se pudo abrir la cámara. Revisa que Safari tenga permiso para usarla.'); }
}
function stopScanner() { scanning = false; if (scanStream) scanStream.getTracks().forEach(track => track.stop()); scanStream = null; const panel = $('scannerPanel'); if (panel) panel.hidden = true; }
function headers() { return cloudToken ? { authorization: `Bearer ${cloudToken}` } : {}; }
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { cloudMode = false; cloudToken = ''; localStorage.removeItem('taxaerum-session'); updateCloudButton(); }
  if (!response.ok) { const error = new Error(data.error || 'No se pudo conectar con la nube.'); error.status = response.status; throw error; }
  return data;
}
function applyAccess() {
  const seller = cloudMode && cloudRole === 'seller';
  document.querySelector('[data-view="productos"]').hidden = seller;
  document.querySelector('[data-view="configuracion"]').hidden = seller;
  if (seller) { $('cashier').value = cloudCashier; $('cashier').disabled = true; } else $('cashier').disabled = false;
}
function saveSession(data) {
  cloudToken = data.token; cloudRole = data.role; cloudCashier = data.cashier || ''; cloudBusiness = data.business || null; cloudBusinesses = data.businesses || [];
  localStorage.setItem('taxaerum-session', cloudToken); localStorage.setItem('taxaerum-role', cloudRole);
  if (cloudCashier) localStorage.setItem('taxaerum-session-cashier', cloudCashier); else localStorage.removeItem('taxaerum-session-cashier');
  if (cloudBusiness) localStorage.setItem('taxaerum-business', JSON.stringify(cloudBusiness)); else localStorage.removeItem('taxaerum-business');
  localStorage.setItem('taxaerum-businesses', JSON.stringify(cloudBusinesses));
}
function clearSession() { cloudMode = false; cloudToken = ''; cloudCashier = ''; cloudBusiness = null; cloudBusinesses = []; localStorage.removeItem('taxaerum-session'); localStorage.removeItem('taxaerum-role'); localStorage.removeItem('taxaerum-session-cashier'); localStorage.removeItem('taxaerum-business'); localStorage.removeItem('taxaerum-businesses'); }
function updateCloudButton() {
  const admin = $('cloudButton'), seller = $('sellerButton'), account = $('accountButton'), createBusiness = $('createBusinessButton'), switcher = $('switchBusinessButton');
  admin.hidden = !cloudAvailable || (cloudMode && cloudRole === 'seller'); seller.hidden = !cloudAvailable || (cloudMode && isManager());
  account.hidden = !cloudAvailable || cloudMode;
  createBusiness.hidden = !cloudAvailable || cloudMode;
  switcher.hidden = !cloudAvailable || !cloudMode || cloudBusinesses.length < 2;
  admin.textContent = cloudMode ? `${cloudBusiness?.name || 'Negocio'} conectado` : 'Entrar como administrador'; admin.className = cloudMode ? 'primary' : 'secondary';
  seller.textContent = cloudMode ? `Vendedor: ${cloudCashier}` : 'Entrar como vendedor'; seller.className = cloudMode ? 'primary' : 'secondary'; applyAccess();
}
async function loadCloud() {
  const [products, summary] = await Promise.all([api('products'), api('dashboard')]);
  db.products = products.map(p => ({ ...p, code: p.barcode, stock: p.stock }));
  db.sales = summary.recentSales.map(s => ({ ...s, items: Array.from({ length: s.item_count }, () => ({ qty: 1 })) }));
  db.summary = summary; cloudMode = true; save(); await TaxaerumOffline.snapshot('cloud-data', { products: db.products, sales: db.sales, summary: db.summary }); updateCloudButton(); render(); await loadConfiguration().catch(() => {});
}
async function connectCloud() {
  if (cloudMode && confirm('¿Cerrar la conexión de administración en este dispositivo?')) { clearSession(); updateCloudButton(); render(); return; }
  const password = prompt('Escribe la contraseña de administración de Taxaerum:');
  if (!password) return;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    saveSession({ ...data, role: 'admin', cashier: '', business: { id: 1, name: 'Mi negocio', slug: 'mi-negocio', role: 'admin' }, businesses: [{ id: 1, name: 'Mi negocio', slug: 'mi-negocio', role: 'admin' }] }); await loadCloud();
  } catch (error) { alert(error.message); }
}
$('cloudButton').onclick = connectCloud;
async function connectSeller() {
  if (cloudMode && confirm('¿Cerrar la sesión de vendedor en este dispositivo?')) { clearSession(); updateCloudButton(); render(); return; }
  const name = prompt('Nombre del vendedor:'); if (!name) return;
  const pin = prompt('PIN de vendedor:'); if (!pin) return;
  try {
    const response = await fetch('/api/seller-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), pin }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    saveSession({ ...data, role: 'seller', business: { id: 1, name: 'Mi negocio', slug: 'mi-negocio', role: 'seller' }, businesses: [{ id: 1, name: 'Mi negocio', slug: 'mi-negocio', role: 'seller' }] }); await loadCloud();
  } catch (error) { alert(error.message); }
}
async function connectAccount() {
  const username = prompt('Usuario:'); if (!username) return;
  const password = prompt('Contraseña o PIN:'); if (!password) return;
  try {
    const response = await fetch('/api/account-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    saveSession(data); await loadCloud();
  } catch (error) { alert(error.message); }
}
async function registerBusiness() {
  const businessName = prompt('Nombre de tu negocio:'); if (!businessName) return;
  const businessSlug = prompt('Nombre corto para tu enlace (solo letras, números y guiones):', businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')); if (!businessSlug) return;
  const username = prompt('Usuario del propietario:'); if (!username) return;
  const displayName = prompt('Tu nombre visible:'); if (!displayName) return;
  const password = prompt('Crea una contraseña de al menos 8 caracteres:'); if (!password) return;
  try {
    const response = await fetch('/api/register-business', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ businessName, businessSlug, username, displayName, password }) });
    const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'No se pudo crear el negocio.');
    saveSession(data); alert(`Negocio creado. Tu catálogo público será: taxaerum.pages.dev/?negocio=${data.business.slug}#catalogo`); await loadCloud();
  } catch (error) { alert(error.message); }
}
async function switchBusiness() {
  const choices = cloudBusinesses.map(item => `${item.slug} — ${item.name}`).join('\n');
  const businessSlug = prompt(`Escribe el nombre corto del negocio al que deseas entrar:\n${choices}`, cloudBusiness?.slug || ''); if (!businessSlug) return;
  try {
    const data = await api('select-business', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ businessSlug }) });
    saveSession(data); await loadCloud();
  } catch (error) { alert(error.message); }
}

function show(id) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === id));
  document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === id));
  if (id === 'ventas') setTimeout(() => $('search').focus(), 100);
  if (id === 'catalogo') loadPublicCatalog();
  render();
}
document.querySelectorAll('.tab').forEach(button => button.onclick = () => show(button.dataset.view));

$('productForm').onsubmit = async event => {
  event.preventDefault();
  const details = { description: $('description').value.trim(), sku: $('sku').value.trim(), cost: Number($('cost').value), minStock: Number($('minStock').value), unit: $('unit').value.trim() || 'unidad', suppliedBarcode: $('barcode').value.trim() };
  const product = { name: $('name').value.trim(), section: $('section').value, category: $('category').value.trim() || 'Sin categoría', price: Number($('price').value), stock: Number($('stock').value), barcode: makeCode() };
  try {
      if (details.suppliedBarcode) product.barcode = details.suppliedBarcode;
      if (!validEan13(product.barcode)) return alert('El código debe ser un EAN-13 válido de 13 dígitos.');
      Object.assign(product, details);
      if (cloudMode) await api('products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(product) });
    else { db.products.push({ ...product, id: Date.now(), code: product.barcode }); save(); }
    $('labelPreview').innerHTML = `<b>${escapeHtml(product.name)}</b>${barcodeHtml(product.barcode)}<b>${money(product.price)}</b>`;
    event.target.reset(); if (cloudMode) await loadCloud(); else render();
  } catch (error) { alert(error.message); }
};

function render() {
  const summary = db.summary || {}, today = new Date().toDateString();
  const localSales = db.sales.filter(s => new Date(s.date).toDateString() === today);
  $('productsCount').textContent = db.products.length;
  $('lowStock').textContent = db.products.filter(p => Number(p.stock) <= 3).length;
  $('todaySales').textContent = money(cloudMode ? summary.todaySales : localSales.reduce((sum, sale) => sum + sale.total, 0));
  $('todayUnits').textContent = cloudMode ? (summary.todayUnits || 0) : localSales.reduce((sum, sale) => sum + sale.items.reduce((total, item) => total + item.qty, 0), 0);
  $('productRows').innerHTML = db.products.length ? db.products.map(p => `<tr><td><b>${escapeHtml(p.name)}</b><br><small>${escapeHtml(p.category)}</small></td><td>${escapeHtml(p.section)}</td><td class="code">${escapeHtml(p.code || p.barcode)}</td><td>${money(p.price)}</td><td>${Number(p.stock) <= 3 ? `<b style="color:#b64646">${p.stock}</b>` : p.stock}</td><td><button class="danger" onclick="removeProduct(${p.id})">Eliminar</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">Todavía no has agregado productos.</td></tr>';
  if (cloudMode && isManager()) document.querySelectorAll('#productRows tr').forEach((row, index) => { if (db.products[index] && row.lastElementChild) row.lastElementChild.insertAdjacentHTML('afterbegin', `<button class="secondary" onclick="editProduct(${db.products[index].id})">Editar</button> `); });
  const recent = cloudMode ? db.sales : localSales.slice(-5).reverse();
  $('recentSales').innerHTML = recent.length ? recent.map(s => `<div class="cart-item"><span>${s.units ?? s.items.length} producto(s) · ${escapeHtml(s.payment)}<br><small>Vendedor: ${escapeHtml(s.cashier || 'Sin asignar')}</small></span><b>${money(s.total)}</b></div>`).join('') : 'Aún no hay ventas registradas.';
  const cashierRows = cloudMode ? (summary.byCashier || []) : Object.values(localSales.reduce((all, sale) => { const cashier = sale.cashier || 'Sin asignar'; all[cashier] = all[cashier] || { cashier, sales: 0, total: 0 }; all[cashier].sales++; all[cashier].total += sale.total; return all; }, {}));
  $('cashierSummary').innerHTML = cashierRows.length ? cashierRows.map(row => `<div class="cart-item"><span><b>${escapeHtml(row.cashier)}</b><br><small>${row.sales} venta(s)</small></span><b>${money(row.total)}</b></div>`).join('') : 'Aún no hay ventas registradas.';
  renderSaleProducts(); renderCatalog(db.products);
}
function renderCatalog(products) { $('catalogProducts').innerHTML = products.length ? products.map(p => `<article class="product"><span class="badge">${escapeHtml(p.section)}</span><b style="margin-top:8px">${escapeHtml(p.name)}</b><small>${escapeHtml(p.category)}</small><span class="price">${money(p.price)}</span></article>`).join('') : '<p class="empty">El catálogo se llenará al agregar productos.</p>'; }
async function loadPublicCatalog() { if (!cloudAvailable) return; try { const slug = new URLSearchParams(location.search).get('negocio') || cloudBusiness?.slug; const result = await fetch(`/api/catalog${slug ? `/${encodeURIComponent(slug)}` : ''}`); if (result.ok) renderCatalog(await result.json()); } catch {} }
async function editProduct(id) {
  if (!cloudMode || !isManager()) return alert('Solo el administrador puede editar productos.');
  const product = db.products.find(item => item.id === Number(id)); if (!product) return;
  const name = prompt('Nombre del producto:', product.name); if (name === null) return;
  const section = prompt('Sección:', product.section); if (section === null) return;
  const category = prompt('Categoría (puedes escribir una nueva):', product.category); if (category === null) return;
  const price = prompt('Precio de venta (USD):', product.price); if (price === null) return;
  const stock = prompt('Stock actual:', product.stock); if (stock === null) return;
  try {
    await api(`products/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim(), section: section.trim(), category: category.trim() || 'Sin categoría', price: Number(price), stock: Number(stock) }) });
    await loadCloud();
  } catch (error) { alert(error.message); }
}
async function removeProduct(id) { if (!confirm('¿Eliminar este producto?')) return; try { if (cloudMode) { await api(`products/${id}`, { method: 'DELETE' }); await loadCloud(); } else { db.products = db.products.filter(p => p.id !== Number(id)); save(); render(); } } catch (error) { alert(error.message); } }
function renderSaleProducts() {
  const query = $('search').value.toLowerCase();
  const items = db.products.filter(p => Number(p.stock) > 0 && (p.name.toLowerCase().includes(query) || String(p.code || p.barcode).toLowerCase().includes(query)));
  $('saleProducts').innerHTML = items.length ? items.map(p => `<button class="product" onclick="add(${p.id})"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.code || p.barcode)} · Stock: ${p.stock}</small><span class="price">${money(p.price)}</span></button>`).join('') : '<p class="empty">No hay productos disponibles.</p>'; renderCart();
}
function add(id) { id = Number(id); const product = db.products.find(p => p.id === id), item = cart.find(i => i.id === id); if (item) { if (item.qty < product.stock) item.qty++; } else cart.push({ id, qty: 1 }); $('search').value = ''; renderSaleProducts(); }
function renderCart() { const rows = cart.map(i => ({ ...i, p: db.products.find(p => p.id === i.id) })).filter(i => i.p); $('cartCount').textContent = cart.reduce((sum, i) => sum + i.qty, 0); $('cart').innerHTML = rows.length ? rows.map(i => `<div class="cart-item"><span><b>${escapeHtml(i.p.name)}</b><br><small>${i.qty} × ${money(i.p.price)}</small></span><span><b>${money(i.qty * i.p.price)}</b><br><button onclick="minus(${i.id})">−</button></span></div>`).join('') : '<p class="empty">Agrega productos a la venta.</p>'; $('cartTotal').textContent = money(rows.reduce((sum, i) => sum + i.qty * i.p.price, 0)); }
function minus(id) { const item = cart.find(i => i.id === Number(id)); if (item && --item.qty === 0) cart = cart.filter(i => i.id !== Number(id)); renderSaleProducts(); }
function clearCart() { cart = []; renderSaleProducts(); }
async function completeSale() {
  if (!cart.length) return alert('Agrega al menos un producto.');
  const total = cart.reduce((sum, i) => sum + i.qty * db.products.find(p => p.id === i.id).price, 0);
  let pendingOperation;
  try {
    const cashier = cloudRole === 'seller' ? cloudCashier : $('cashier').value.trim();
    if (!cashier) return alert('Escribe el nombre del vendedor antes de cobrar.');
    localStorage.setItem('taxaerum-cashier', cashier);
    if (cloudMode || cloudToken) {
      const operation = pendingOperation = saleOperation(cart, $('payment').value, cashier);
      if (!navigator.onLine) {
        cart.forEach(i => { const product = db.products.find(p => p.id === i.id); if (product) product.stock -= i.qty; });
        db.sales.unshift({ date: operation.createdAt, items: cart, payment: $('payment').value, cashier, total, pending: true }); cart = []; save(); await queueOfflineSale(operation); render(); return alert(`Venta guardada sin conexión. Total: ${money(total)}. Se sincronizará al volver Internet.`);
      }
      const result = await api('sales', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': operation.id }, body: JSON.stringify(operation.payload) }); cart = []; await loadCloud(); alert(`Venta guardada correctamente. Total: ${money(result.total)}`);
    } else { cart.forEach(i => db.products.find(p => p.id === i.id).stock -= i.qty); db.sales.push({ date: new Date().toISOString(), items: cart, payment: $('payment').value, cashier, total }); cart = []; save(); render(); alert(`Venta guardada correctamente. Total: ${money(total)}`); }
  } catch (error) {
    if (pendingOperation && !error.status) {
      cart.forEach(i => { const product = db.products.find(p => p.id === i.id); if (product) product.stock -= i.qty; });
      db.sales.unshift({ date: pendingOperation.createdAt, items: cart, payment: pendingOperation.payload.payment, cashier: pendingOperation.payload.cashier, total, pending: true }); cart = []; save(); await queueOfflineSale(pendingOperation); render(); return alert(`No se pudo contactar al servidor. La venta quedó pendiente y se sincronizará automáticamente.`);
    }
    alert(error.message);
  }
}
async function bootCloud() { try { const response = await fetch('/api/status'); if (!response.ok) throw Error(); cloudAvailable = (await response.json()).cloud; updateCloudButton(); if (cloudToken) await loadCloud(); } catch { cloudAvailable = false; if (cloudToken) { const snapshot = await TaxaerumOffline.getSnapshot('cloud-data').catch(() => null); if (snapshot) Object.assign(db, snapshot); cloudMode = true; } updateCloudButton(); } render(); updateSyncStatus(); syncPending(); }
window.addEventListener('online', () => { updateSyncStatus('Conexión recuperada. Sincronizando ventas pendientes…'); syncPending(); });
window.addEventListener('offline', () => updateSyncStatus());
setInterval(syncPending, 30000);
mountScanner(); mountCashier(); mountRoleAccess(); mountProductDetails(); mountSyncStatus(); mountConfiguration(); render(); bootCloud();
