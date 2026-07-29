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
- **VS Code API**: `^1.104.0`
- **TypeScript**: `^5.9.2`
- **Пакетирование**: `@vscode/vsce 3.9.2`
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
| `bash scripts/stable-release.sh 1.9.0` | Тесты → сборка → git-тег → пуш стабильного релиза |

## Правило версионирования

### Dev-патчи (третья цифра): `1.8.5`, `1.8.24`, `1.9.1`, `1.9.18` и т.д.
**Инкрементировать ТОЛЬКО третью цифру (patch).**
Вторую цифру (minor: `1.9.0`) **НЕ поднимать** без явной команды пользователя.
Причина: может пройти много итераций исправлений до стабильного состояния.

Dev-патчи **НЕ тэгаются** в git и **НЕ выпускаются как GitHub Releases**.
Это рабочие версии — только для локальной установки через `code --install-extension`.

### Стабильные релизы (вторая цифра): `1.9.0`, `1.10.0`, `1.11.0`
Когда код достигает стабильного состояния — пользователь даёт явную команду
«выпустить стабильную версию». Тогда:
1. Версия в `package.json` поднимается до следующей minor (например `1.9.0`)
2. Создаётся аннотированный git-тег: `git tag -a v1.9.0 -m "Stable release 1.9.0"`
3. Тег пушится: `git push origin v1.9.0`
4. Собирается `.vsix` и прикрепляется к GitHub Release

Автоматизировано скриптом `scripts/stable-release.sh`.

### Откат к стабильной версии
```bash
git checkout v1.9.0
npm run package
code --install-extension llama-vscode-chat-1.9.0.vsix
```
Это даёт гарантированно работающую версию — даже если dev-патчи что-то сломали.
