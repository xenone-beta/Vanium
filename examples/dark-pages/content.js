// Content script: выполняется на страницах в изолированном мире. Доступен объект vex.
(function () {
  const root = document.documentElement;
  const apply = (on) => root.classList.toggle('vex-dark-pages', !!on);

  // Сохранённое состояние
  vex.storage.get('enabled').then((data) => apply(data.enabled));

  // Сообщения от popup
  vex.onMessage((msg) => {
    if (msg && msg.type === 'dark') apply(msg.enabled);
  });
})();
