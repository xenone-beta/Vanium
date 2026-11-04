// Popup: объект vex доступен и здесь (storage, tabs, close).
const btn = document.getElementById('toggle');
let enabled = false;

function paint() {
  btn.textContent = enabled ? 'Выключить' : 'Включить';
  btn.classList.toggle('on', enabled);
}

vex.storage.get('enabled').then((d) => {
  enabled = !!d.enabled;
  paint();
});

vex.tabs.getActive().then((tab) => {
  document.getElementById('site').textContent = tab && tab.url ? new URL(tab.url).hostname : '';
});

btn.addEventListener('click', async () => {
  enabled = !enabled;
  await vex.storage.set({ enabled });
  await vex.tabs.sendMessage({ type: 'dark', enabled });
  paint();
});
