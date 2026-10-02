import { countStored, clearStored } from './clipstore.js';

const $ = (selector) => document.querySelector(selector);
let enabled = false;
let pendingClear = '';

function renderPower() {
  $('#powerText').textContent = enabled ? 'Ligado' : 'Desligado';
  $('#powerSwitch').setAttribute('aria-checked', String(enabled));
  $('#powerSwitch').setAttribute('aria-label', enabled ? 'Desligar Stream Clipper' : 'Ligar Stream Clipper');
}

async function refreshCounts() {
  const [templates, recent, sessions, clips, media] = await Promise.all([
    countStored('templates'), countStored('recent'), countStored('sessions'), countStored('clips'), countStored('media'),
  ]);
  $('#templateCount').textContent = templates === 1 ? '1 template' : `${templates} templates`;
  $('#savedCount').textContent = `${recent} clip${recent === 1 ? '' : 's'} · ${sessions} sess${sessions === 1 ? 'ão' : 'ões'}`;
  $('#libraryCount').textContent = `${media} ficheiro${media === 1 ? '' : 's'}`;
  $('#clearTemplates').disabled = templates === 0;
  // Cópias temporárias também podem existir sem clips recentes.
  $('#clearSaved').disabled = recent + sessions + clips === 0;
  $('#clearLibrary').disabled = media === 0;
}

async function init() {
  try {
    enabled = (await chrome.storage.local.get('enabled')).enabled === true;
    renderPower();
    $('#powerSwitch').disabled = false;
    await refreshCounts();
  } catch (error) { $('#message').textContent = 'Não foi possível ler os dados: ' + error.message; }
}

$('#powerSwitch').addEventListener('click', async () => {
  const button = $('#powerSwitch');
  button.disabled = true;
  try {
    const nextEnabled = !enabled;
    await chrome.storage.local.set({ enabled: nextEnabled });
    enabled = nextEnabled;
    renderPower();
    $('#message').textContent = '';
  } catch (error) { $('#message').textContent = 'Não foi possível alterar a captura: ' + error.message; }
  finally { button.disabled = false; }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) {
    enabled = changes.enabled.newValue === true;
    renderPower();
  }
});

$('#openEditor').addEventListener('click', async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html?blank=1') });
    window.close();
  } catch (error) { $('#message').textContent = 'Não foi possível abrir o editor: ' + error.message; }
});

function askClear(kind) {
  pendingClear = kind;
  $('#confirmTitle').textContent = {
    templates: 'Limpar templates?', saved: 'Limpar guardados?', library: 'Limpar biblioteca?',
  }[kind];
  $('#confirmText').textContent = {
    templates: 'Apaga todos os templates guardados.',
    saved: 'Apaga clips recentes, cópias temporárias e sessões de edição. A biblioteca e os templates ficam guardados.',
    library: 'Apaga imagens, vídeos e áudios da biblioteca. Os templates que os usam deixarão de mostrar esses ficheiros.',
  }[kind];
  $('#confirmBox').hidden = false;
  $('#message').textContent = '';
}

$('#clearTemplates').addEventListener('click', () => askClear('templates'));
$('#clearSaved').addEventListener('click', () => askClear('saved'));
$('#clearLibrary').addEventListener('click', () => askClear('library'));
$('#cancelClear').addEventListener('click', () => { pendingClear = ''; $('#confirmBox').hidden = true; });
$('#confirmClear').addEventListener('click', async () => {
  if (!pendingClear) return;
  const kind = pendingClear, button = $('#confirmClear');
  button.disabled = true;
  try {
    if (kind === 'templates') {
      await clearStored(['templates']);
      localStorage.removeItem('sc.template');
      await chrome.storage.local.set({ templatesChangedAt: Date.now() });
      $('#message').textContent = 'Templates limpos.';
    } else if (kind === 'saved') {
      localStorage.removeItem('sc.session');
      await clearStored(['clips', 'recent', 'sessions']);
      await chrome.storage.local.set({ savedChangedAt: Date.now() });
      $('#message').textContent = 'Guardados limpos.';
    } else {
      await clearStored(['media']);
      await chrome.storage.local.set({ libraryChangedAt: Date.now() });
      $('#message').textContent = 'Biblioteca limpa.';
    }
    pendingClear = '';
    $('#confirmBox').hidden = true;
    await refreshCounts();
  } catch (error) { $('#message').textContent = 'Não foi possível limpar: ' + error.message; }
  finally { button.disabled = false; }
});

init();
