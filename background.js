// Alterna a captura a partir do ícone da extensão.
function updateAction(enabled) {
  chrome.action.setTitle({ title: enabled ? 'Desativar Stream Clipper' : 'Ativar Stream Clipper' });
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#16803c' });
}

chrome.action.onClicked.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  await chrome.storage.local.set({ enabled: enabled !== true });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateAction(changes.enabled.newValue === true);
});

chrome.runtime.onInstalled.addListener(async () => {
  const { activationDefaultMigrated } = await chrome.storage.local.get('activationDefaultMigrated');
  if (!activationDefaultMigrated) {
    await chrome.storage.local.set({ enabled: false, activationDefaultMigrated: true });
  }
  const { enabled } = await chrome.storage.local.get('enabled');
  updateAction(enabled === true);
});

chrome.runtime.onStartup.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  updateAction(enabled === true);
});