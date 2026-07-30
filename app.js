const key = 'taxaerum-local-v1';
let db = JSON.parse(localStorage.getItem(key) || '{"products":[],"sales":[]}');
let cart = [], cloudAvailable = false, cloudMode = false;
let cloudToken = localStorage.getItem('taxaerum-session') || '';
const $ = id => document.getElementById(id);
const money = n => new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD' }).format(n || 0);
const save = () => localStorage.setItem(key, JSON.stringify(db));
const escapeHtml = value => { const node = document.createElement('div'); node.textContent = value; return node.innerHTML; };

let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('installButton').hidden = false; });
$('installButton').onclick = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installButton').hidden = true; };
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js'));

function makeCode() { return `TX-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`; }
function headers() { return cloudToken ? { authorization: `Bearer ${cloudToken}` } : {}; }
async function api(path, options = {}) {
  const response = await fetch(`/api/${path}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { cloudMode = false; cloudToken = ''; localStorage.removeItem('taxaerum-session'); updateCloudButton(); }
  if (!response.ok) throw new Error(data.error || 'No se pudo conectar con la nube.');
  return data;
}
function updateCloudButton() { const b = $('cloudButton'); b.hidden = !cloudAvailable; b.textContent = cloudMode ? 'Nube conectada' : 'Conectar nube'; b.className = cloudMode ? 'primary' : 'secondary'; }
async function loadCloud() {
  const [products, summary] = await Promise.all([api('products'), api('dashboard')]);
  db.products = products.map(p => ({ ...p, code: p.barcode, stock: p.stock }));
  db.sales = summary.recentSales.map(s => ({ ...s, items: Array.from({ length: s.item_count }, () => ({ qty: 1 })) }));
  db.summary = summary; cloudMode = true; save(); updateCloudButton(); render();
}
async function connectCloud() {
  if (cloudMode && confirm('¿Cerrar la conexión de administración en este dispositivo?')) { cloudMode = false; cloudToken = ''; localStorage.removeItem('taxaerum-session'); updateCloudButton(); render(); return; }
  const password = prompt('Escribe la contraseña de administración de Taxaerum:');
  if (!password) return;
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
    cloudToken = data.token; localStorage.setItem('taxaerum-session', cloudToken); await loadCloud();
  } catch (error) { alert(error.message); }
}
$('cloudButton').onclick = connectCloud;

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
  const product = { name: $('name').value.trim(), section: $('section').value, category: $('category').value.trim() || 'Sin categoría', price: Number($('price').value), stock: Number($('stock').value), barcode: makeCode() };
  try {
    if (cloudMode) await api('products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(product) });
    else { db.products.push({ ...product, id: Date.now(), code: product.barcode }); save(); }
    $('labelPreview').innerHTML = `<b>${escapeHtml(product.name)}</b><div class="barcode"></div><span class="code">${product.barcode}</span><br><b>${money(product.price)}</b>`;
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
  const recent = cloudMode ? db.sales : localSales.slice(-5).reverse();
  $('recentSales').innerHTML = recent.length ? recent.map(s => `<div class="cart-item"><span>${s.units ?? s.items.length} producto(s) · ${escapeHtml(s.payment)}</span><b>${money(s.total)}</b></div>`).join('') : 'Aún no hay ventas registradas.';
  renderSaleProducts(); renderCatalog(db.products);
}
function renderCatalog(products) { $('catalogProducts').innerHTML = products.length ? products.map(p => `<article class="product"><span class="badge">${escapeHtml(p.section)}</span><b style="margin-top:8px">${escapeHtml(p.name)}</b><small>${escapeHtml(p.category)}</small><span class="price">${money(p.price)}</span></article>`).join('') : '<p class="empty">El catálogo se llenará al agregar productos.</p>'; }
async function loadPublicCatalog() { if (!cloudAvailable) return; try { const result = await fetch('/api/catalog'); if (result.ok) renderCatalog(await result.json()); } catch {} }
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
  try {
    if (cloudMode) { const result = await api('sales', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payment: $('payment').value, items: cart }) }); cart = []; await loadCloud(); alert(`Venta guardada correctamente. Total: ${money(result.total)}`); }
    else { cart.forEach(i => db.products.find(p => p.id === i.id).stock -= i.qty); db.sales.push({ date: new Date().toISOString(), items: cart, payment: $('payment').value, total }); cart = []; save(); render(); alert(`Venta guardada correctamente. Total: ${money(total)}`); }
  } catch (error) { alert(error.message); }
}
async function bootCloud() { try { const response = await fetch('/api/status'); if (!response.ok) throw Error(); cloudAvailable = (await response.json()).cloud; updateCloudButton(); if (cloudToken) await loadCloud(); } catch { cloudAvailable = false; updateCloudButton(); } render(); }
render(); bootCloud();
