# Расширения Vanium (.vex)

`.vex` — обычный ZIP-архив с файлом `manifest.json` в корне. Расширение может:

- вставлять **JavaScript и CSS** на сайты по маске адреса (как userscript / content script);
- добавить **кнопку в панель инструментов** с popup-окном;
- хранить свои данные через **`vex.storage`**;
- (с разрешением `tabs`) читать адрес активной вкладки, открывать ссылки и слать сообщения скриптам на странице.

Расширения не работают в приватных окнах.

## Быстрый старт

```bash
node scripts/pack-vex.js examples/dark-pages        # соберёт examples/dark-pages.vex
```

Установка: перетащите `.vex` в окно Vanium, дважды щёлкните по файлу или откройте `vanium://extensions` → «Установить из файла». Перед установкой Vanium покажет, к чему получит доступ расширение.

Готовый пример с popup, хранилищем и сообщениями: [`examples/dark-pages`](../examples/dark-pages).

## manifest.json

```json
{
  "id": "my-extension",
  "name": "Моё расширение",
  "version": "1.0.0",
  "description": "Что делает расширение",
  "icon": "icon.png",
  "permissions": ["storage", "tabs"],
  "content_scripts": [
    {
      "matches": ["https://*.example.com/*"],
      "exclude_matches": ["https://example.com/private/*"],
      "js": ["content.js"],
      "css": ["style.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "title": "Подсказка кнопки",
    "popup": "popup.html",
    "popup_width": 360,
    "popup_height": 480
  }
}
```

| Поле | Описание |
|---|---|
| `id` | обязательно; строчные латинские буквы, цифры, дефис; 2–48 символов. По нему определяется обновление |
| `name`, `version` | обязательно; версия вида `1.2.3` |
| `description`, `icon` | необязательно; иконка png/jpg/webp/svg до 256 КБ |
| `permissions` | `storage`, `tabs` |
| `content_scripts` | до 10 правил; нужен хотя бы один `js` или `css` |
| `matches` | шаблоны адресов: `<all_urls>` или `схема://хост/путь`, схема `*`, `http` или `https`, хост `*`, `*.example.com` или `example.com`, в пути можно `*` |
| `run_at` | `document_start`, `document_end` или `document_idle` (по умолчанию) |
| `action.popup` | HTML-страница popup; размер 200–700 px |

Расширение должно содержать `content_scripts` или `action.popup` (или оба).

## Content scripts

Скрипты выполняются на сайтах `http(s)` в **изолированном мире**: у них есть DOM страницы, но нет её JS-переменных, нет Node.js и нет прямого доступа к сети браузера. Все скрипты одного расширения делят общую область видимости. Работают только в основном кадре страницы (не во вложенных iframe).

Доступен глобальный объект `vex`:

```js
vex.id; vex.version;

// только с разрешением "storage"
await vex.storage.get('key');          // -> { key: значение }
await vex.storage.get(['a', 'b']);     // несколько ключей
await vex.storage.get(null);           // всё
await vex.storage.set({ key: 123 });   // значения должны быть JSON-совместимы
await vex.storage.remove('key');
await vex.storage.clear();

// сообщения от popup (popup отправляет через vex.tabs.sendMessage)
vex.onMessage((message) => { /* ... */ });
```

## Popup

Страница popup открывается по клику на кнопку и закрывается при потере фокуса или по Esc. Файлы popup (HTML, JS, CSS, картинки, шрифты) берутся из архива. Ограничения безопасности (CSP): только собственные скрипты (`script-src 'self'`, без inline-скриптов), сеть только по `https`.

```js
vex.id;
await vex.storage.get(...) / set / remove / clear      // разрешение "storage"

await vex.tabs.getActive();            // { url, title }       // разрешение "tabs"
await vex.tabs.open('https://…');      // открыть ссылку в новой вкладке (только http/https)
await vex.tabs.sendMessage({ a: 1 }); // сообщение скриптам активной вкладки (до 64 КБ)

vex.close();                           // закрыть popup
```

## Безопасность

- Расширение получает доступ только к тем сайтам, что указаны в `matches`, и только к заявленным разрешениям.
- Хранилище ограничено 1 МБ на расширение.
- Архив проверяется при установке: путь `..`, абсолютные пути, символические ссылки, ZIP-бомбы и файлы вне манифеста отклоняются.
- Устанавливайте расширения только из источников, которым доверяете: скрипт с `<all_urls>` видит содержимое всех страниц.

## Обновление и удаление

Установите `.vex` с тем же `id` — Vanium предложит обновить расширение (данные в хранилище сохраняются). Удаление на странице `vanium://extensions` стирает и файлы, и данные расширения.
