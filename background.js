// O botão da barra abre o menu; o estado de captura continua visível no badge.
function updateAction(enabled) {
  chrome.action.setTitle({ title: enabled ? 'Stream Clipper — ligado' : 'Stream Clipper — desligado' });
  chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#16803c' });
}

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
