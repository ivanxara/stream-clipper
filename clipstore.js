// Armazenamento da extensão (IndexedDB):
//  - clips:     o último clip (para o editor o poder abrir mesmo que a passagem entre abas falhe)
//  - media:     biblioteca de vídeos/imagens para as composições
//  - templates: composições guardadas
const DB = 'streamclipper', VERSION = 2, STORES = ['clips', 'media', 'templates'];

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('Sem espaço para guardar.')); };
  }));
}

export const saveLastClip = (blob, name, channel) => tx('clips', 'readwrite', (s) => s.put({ blob, name, channel, at: Date.now() }, 'last'));
export const loadLastClip = () => tx('clips', 'readonly', (s) => s.get('last'));

// Cada item tem um campo id, que é também a chave.
const all = (store) => tx(store, 'readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => a.at - b.at));
const put = (store, item) => tx(store, 'readwrite', (s) => s.put(item, item.id));
const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

export const listMedia = () => all('media');
export const putMedia = (m) => put('media', m);
export const deleteMedia = (id) => del('media', id);
export const listTemplates = () => all('templates');
export const putTemplate = (t) => put('templates', t);
export const deleteTemplate = (id) => del('templates', id);

