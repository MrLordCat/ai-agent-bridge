# llama-vscode-chat — агентные инструкции

## Сборка и установка расширения (обязательный порядок)

Никогда не копируй папки вручную в `~/.vscode/extensions/` и не правь `extensions.json` руками.
Расширение устанавливается из `.vsix` (source: vsix), VS Code сам обновляет `extensions.json` и чистит `.obsolete`.

```bash
# 1. Компиляция TypeScript
npm run compile

# 2. Сборка .vsix пакета (включает prepublish: clean + compile)
npm run package
# → llama-vscode-chat-{version}.vsix

# 3. Установка через code CLI
code --install-extension llama-vscode-chat-{version}.vsix

# 4. Перезагрузка окна
# Ctrl+Shift+P → Developer: Reload Window
```

### Что делает `npm run package`
- `vsce package` — собирает расширение в `.vsix`
- Автоматически выполняет `npm run vscode:prepublish` (clean + compile)
- Упаковывает только файлы, перечисленные в `.vscodeignore`

### Проверка после установки
```bash
node -e "
const fs = require('fs');
const dir = process.env.USERPROFILE + '/.vscode/extensions';
const json = JSON.parse(fs.readFileSync(dir + '/extensions.json', 'utf8'));
const ext = json.find(e => e.identifier?.id === 'mrlordcat.llama-vscode-chat');
console.log('version:', ext?.version, 'source:', ext?.metadata?.source);
"
```
Ожидаемый результат: `version: {текущая} source: vsix`

## Контекст проекта

- **Publisher**: `mrlordcat`
- **Extension ID**: `mrlordcat.llama-vscode-chat`
- **VS Code API**: `^1.131.0`
- **TypeScript**: `^5.9.3`
- **Пакетирование**: `@vscode/vsce 4.0.0`
- **Python venv**: `.venv/` (активировать: `source .venv/Scripts/activate` на Windows bash)

## Скрипты npm
| Команда | Действие |
|---|---|
| `npm run compile` | `tsc -p ./` |
| `npm run watch` | `tsc -watch -p ./` |
| `npm run package` | `vsce package` |
| `npm run clean` | удалить `out/` |
| `npm run lint` | eslint |
| `npm test` | compile + vscode-test |
| `npm run format` | prettier --write . |

## Вспомогательные скрипты
| Скрипт | Назначение |
|---|---|
| `bash scripts/stable-release.sh 1.20.2` | Метаданные и RELEASE_NOTES → тесты → сборка → git-тег → пуш → чистка локальных VSIX и тегов |
| `npm run prune:local [-- --dry-run]` | Удалить старые локальные VSIX и теги по правилу хранения |

## Правило версионирования

### Dev-патчи (третья цифра): `1.8.5`, `1.8.24`, `1.9.1`, `1.9.18` и т.д.
**Инкрементировать ТОЛЬКО третью цифру (patch).**
Вторую цифру (minor: `1.9.0`) **НЕ поднимать** без явной команды пользователя.
Причина: может пройти много итераций исправлений до стабильного состояния.

Dev-патчи **не тэгаются** и не публикуются без явной команды пользователя.
По команде «выпустить промежуточный релиз» патч выпускается так же, как
стабильный (см. «Релиз патча»), и updater предлагает его пользователям.

### Стабильные релизы (вторая цифра): `1.9.0`, `1.10.0`, `1.11.0`
Когда код достигает стабильного состояния — пользователь даёт явную команду
«выпустить стабильную версию». Тогда:
1. Версия в `package.json` поднимается до следующей minor (например `1.9.0`)
2. Создаётся аннотированный git-тег: `git tag -a v1.9.0 -m "Stable release 1.9.0"`
3. Тег пушится: `git push origin v1.9.0`
4. Собирается `.vsix` и прикрепляется к GitHub Release

Автоматизировано скриптом `scripts/stable-release.sh`.

### Релиз патча (по явной команде)
```bash
bash scripts/stable-release.sh 1.20.2
```
Тег `v*` запускает workflow Release: lint + тесты + `npm run package`,
затем GitHub Release с платформенными VSIX для Windows и Linux. Описание релиза
берётся из `docs/RELEASE_NOTES.md` (первая строка `# AI Agent Bridge 1.20.2`),
поэтому его и `CHANGELOG.md` обновляют ДО тега. Патчи тэгуются только по явной
команде пользователя.

### Хранение релизов
После публикации workflow запускает `scripts/prune-releases.mjs --github` и
удаляет старые GitHub Releases вместе с тегами. Остаются:
- `x.y.0` трёх последних линий (например `1.20.0`, `1.19.0`, `1.18.0`);
- два последних патча только последней линии (`1.20.2`, `1.20.5`; после
  `1.20.6` удаляется `1.20.2`, после `1.21.0` — все патчи `1.20.x`).

Теги не вида `vX.Y.Z` не трогаются. Чистка запускается только после успешной
публикации текущего релиза. То же правило для локальных VSIX и тегов —
`npm run prune:local`; установленные расширения в `~/.vscode/extensions`
чистит сам VS Code.

### Откат к стабильной версии
```bash
git checkout v1.9.0
npm run package
code --install-extension llama-vscode-chat-1.9.0.vsix
```
Это даёт гарантированно работающую версию — даже если dev-патчи что-то сломали.
