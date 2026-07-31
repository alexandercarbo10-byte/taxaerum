/* Persistent offline queue for Taxaerum. No external dependencies. */
(function () {
  const DB_NAME = 'taxaerum-offline-v1';
  const DB_VERSION = 1;
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('operations')) {
        const store = db.createObjectStore('operations', { keyPath: 'id' });
        store.createIndex('by_status', 'status');
        store.createIndex('by_created_at', 'createdAt');
      }
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function withStore(name, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode), store = tx.objectStore(name);
      let value;
      try { value = fn(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }
  const getAll = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readonly'), request = tx.objectStore('operations').getAll();
      request.onsuccess = () => { db.close(); resolve(request.result || []); };
      request.onerror = () => { db.close(); reject(request.error); };
    });
  };
  window.TaxaerumOffline = {
    async put(operation) { await withStore('operations', 'readwrite', store => store.put(operation)); return operation; },
    async remove(id) { await withStore('operations', 'readwrite', store => store.delete(id)); },
    async list() { return (await getAll()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)); },
    async pendingCount() { return (await getAll()).filter(op => op.status !== 'synced').length; },
    async snapshot(key, data) { await withStore('snapshots', 'readwrite', store => store.put({ key, data, savedAt: new Date().toISOString() })); },
    async getSnapshot(key) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('snapshots', 'readonly').objectStore('snapshots').get(key);
        request.onsuccess = () => { db.close(); resolve(request.result?.data || null); };
        request.onerror = () => { db.close(); reject(request.error); };
      });
    }
  };
})();
