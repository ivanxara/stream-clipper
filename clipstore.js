// Armazenamento da extensão (IndexedDB):
//  - clips:     o último clip (fallback de abertura)
//  - recent:    clips de origem recentes, para retomar edições
//  - media:     biblioteca de vídeos/imagens para as composições
//  - templates: composições guardadas
const DB = 'streamclipper', VERSION = 4, STORES = ['clips', 'recent', 'sessions', 'media', 'templates'];

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

// id = o clip de um clique concreto: o editor aberto nesse clique procura-o por aqui se a
// mensagem direta não chegar. Guarda-se também por id, para vários clips seguidos não se pisarem.
export const saveLastClip = async (blob, name, channel, id) => {
  const item = { blob, name, channel, id, at: Date.now() };
  await tx('clips', 'readwrite', (s) => s.put(item, 'last'));
  if (!id) return;
  await tx('clips', 'readwrite', (s) => s.put(item, 'id:' + id));
  // Só os mais recentes (cada clip fica também nos "recentes" do editor).
  const keys = ((await tx('clips', 'readonly', (s) => s.getAllKeys())) || []).filter((k) => String(k).startsWith('id:'));
  if (keys.length <= 6) return;
  const items = await Promise.all(keys.map((k) => tx('clips', 'readonly', (s) => s.get(k)).then((v) => [k, v?.at || 0])));
  items.sort((x, y) => y[1] - x[1]);
  await Promise.all(items.slice(6).map(([k]) => tx('clips', 'readwrite', (s) => s.delete(k))));
};
export const loadClipById = (id) => tx('clips', 'readonly', (s) => s.get('id:' + id));
export const loadLastClip = () => tx('clips', 'readonly', (s) => s.get('last'));

export async function saveRecentClip(blob, name, channel) {
  const key = `${name}|${blob.size}`;
  const existing = (await listRecentClips()).find((item) => item.key === key);
  const item = { id: existing?.id || crypto.randomUUID(), key, blob, name, channel, at: Date.now() };
  await put('recent', item);
  const items = await listRecentClips();
  await Promise.all(items.slice(12).map((old) => del('recent', old.id)));
  return item;
}

export const loadRecentClip = (id) => tx('recent', 'readonly', (s) => s.get(id));
export const touchRecentClip = async (id) => {
  const item = await loadRecentClip(id);
  if (!item) return null;
  const updated = { ...item, at: Date.now() };
  await put('recent', updated);
  return updated;
};

export const loadEditorSession = (key) => tx('sessions', 'readonly', (s) => s.get(key));
export async function saveEditorSession(key, session) {
  await tx('sessions', 'readwrite', (s) => s.put({ ...session, id: key }, key));
  const sessions = await all('sessions');
  await Promise.all(sessions.slice(0, Math.max(0, sessions.length - 24)).map((old) => del('sessions', old.id)));
}

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
export const listRecentClips = () => all('recent').then((items) => items.reverse());

export const countStored = (store) => tx(store, 'readonly', (s) => s.count());
export const clearStored = (stores) => open().then((db) => new Promise((resolve, reject) => {
  const transaction = db.transaction(stores, 'readwrite');
  for (const store of stores) transaction.objectStore(store).clear();
  transaction.oncomplete = () => { db.close(); resolve(); };
  transaction.onerror = () => { db.close(); reject(transaction.error); };
  transaction.onabort = () => { db.close(); reject(transaction.error || new Error('Não foi possível limpar os dados.')); };
}));

