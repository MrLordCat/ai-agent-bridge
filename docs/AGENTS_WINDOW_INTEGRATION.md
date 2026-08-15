# Интеграция в Agents Window VS Code — ресёрч (2026-08-05)

**ОБНОВЛЕНИЕ (2026-08-15): финальная архитектура — см. раздел 0 ниже.**
Путь найден и проверен пользователем: модели напрямую регистрируются в Agents
через встроенный language-model провайдер расширения (флаг
`chat.agentHost.byokModels.enabled` + рестарт агент-хоста). Локальный HTTP-мост
(«Agents Bridge», 1.14.4–1.14.10) оказался ненужным и удалён в 1.14.13 вместе с
командами, настройками и watcher'ом. Для переключателя мышления в модель-пикере
Agents и для non-streaming запросов SDK применяется патч бандла агент-хоста
(`src/byok/agent-host-thinking-patch.ts`).


---

## 0. Итог (2026-08-15): llamacpp-провайдер + патч агент-хоста — рабочий путь

**Финальная архитектура (проверено пользователем 2026-08-15):**

- Модели расширения регистрируются как встроенный language-model провайдер
  (`llamacpp` vendor, `isBYOK: true`) и попадают в модель-пикер Agents
  напрямую — без HTTP-моста и API-ключа. Нужно только, чтобы флаг
  `chat.agentHost.byokModels.enabled` был true ДО спавна агент-хоста
  (расширение включает его само; reload окна агент-хост НЕ переспавнивает).
- Переключатель уровня мышления в модель-пикере Agents: патч бандла
  `agentHostMain.js` (`src/byok/agent-host-thinking-patch.ts`, маркеры
  `agent-host-thinking-levels:v1` / `agent-host-non-streaming:v1` /
  `agent-host-reasoning-effort:v1`):
  1) `configSchema.thinkingLevel` в снапшоте BYOK-моделей — без него UI не
     показывает опцию мышления;
  2) non-streaming JSON-ответ в `ByokLmProxyService._handleChatCompletions` —
     иначе нативный SDK падает с «non-streaming response body was not valid
     JSON» после включения мышления (прокси всегда отвечал SSE);
  3) проброс `reasoning_effort` из тела SDK-запроса в `modelOptions`
     провайдера — без него уровень мышления не доходил до модели.
- Бывший HTTP-мост «Agents Bridge» (сервер 127.0.0.1:17811, key в
  SecretStorage, watcher `chatLanguageModels.json`, команды
  `llamacpp.toggleAgentsBridge`/`copyAgentsBridgeKey`/
  `regenerateAgentsBridgeKey`/`checkAgentsPicker`) удалён в 1.14.13 —
  поток customendpoint не нужен.

**Исторический ресёрч ниже (CustomEndpoint-путь, 2026-08-14):**


Пользователь обнаружил в Agents Window UI добавление кастомного
эндпоинта + API-ключа — это и есть BYOK-механизм, который в ресёрче был
открытым вопросом №3. Разобрано по бандлам установленного VS Code 1.131:

- В `extensions/copilot/dist/extension.js` есть 9 BYOK-провайдеров
  (Anthropic, Gemini, xAI, OpenAI/OpenRouter, Azure, **CustomOAI**,
  **CustomEndpoint**), регистрируются через
  `registerLanguageModelChatProvider` (сервис `byok-contribution`,
  метод `_buildProviders`).
- `CustomEndpoint`/`CustomOAI` (классы `aP`/`GI`) ходят в наш URL так:
  - `GET {base}/models` с `Authorization: Bearer <key>` — ждёт
    `{data:[{id,...}]}` или `{models:[...]}` (`getModelsDiscoveryUrl` =
    `{url}/models`, `callSite: byok-models-discovery`);
  - `POST {base}/chat/completions` (или `/responses` при
    `apiType=responses`) — OpenAI-совместимый, SSE-стриминг, tools,
    thinking (`h3i`/`b3i` добавляют `/v1/chat/completions` к base URL);
  - ключ хранится у Copilot в SecretStorage (`copilot-byok-...-api-key`),
    модели — в globalState (`copilot-byok-...-models-config`).
- Агент-хост достаёт BYOK-модели через мост `agentHostByokLmHandler`
  (канал renderer→agent-host `agentHostClientByokLm`: `models` →
  `listModels`, `chat` → `chat`).

**Решение, реализованное в расширении (1.14.4):**
- `src/byok/agents-bridge-server.ts` — node:http сервер на 127.0.0.1
  (порт по умолчанию 17811, fallback +20 при занятости), локальный
  API-ключ (64 hex, SecretStorage `llamacpp.agentsBridgeApiKey`),
  timing-safe проверка Bearer.
- `src/byok/openai-message-converter.ts` — конвертеры OpenAI ↔
  vscode.LanguageModelChat (сообщения, tools, SSE-дельта, non-stream
  ответ). Requests идут через `vscode.lm` в наш composite provider,
  поэтому Local/DeepSeek/Codex/Claude/custom API работают с той же
  механикой (подписки, лимиты, tool calling, reasoning, компакция).
- Команды: `llamacpp.toggleAgentsBridge`, `llamacpp.copyAgentsBridgeKey`,
  `llamacpp.regenerateAgentsBridgeKey`; группа «Agents Bridge» в Quick
  Access показывает URL и ключ при включении; карточка в Providers
  Manager; авто-восстановление после перезагрузки окна; настройки
  `llamacpp.agentsBridgeEnabled` / `llamacpp.agentsBridgePort`.
- Тесты: `src/test/agents-bridge.test.ts` (414 passing всего).

Проверка вручную: включить мост → в Agents Window добавить custom
endpoint: URL `http://127.0.0.1:<port>/v1`, ключ из Quick Access →
выбрать модель (id вида `deepseek::deepseek-chat`, `codex::...`,
`claude::...`, `local::...`, `api-<id>::...`).

---


Источники: установленный VS Code **1.131** (`e4c7e7b1d6/resources/app`),
расширение **OpenAI ChatGPT 26.707.91948** (`~/.vscode/extensions`),
proposed API `chatSessionsProvider.d.ts` (microsoft/vscode@main),
официальная документация (agents-window, agent-host).

---

## 1. Что такое Agents Window

- Отдельное окно VS Code: кнопка **«Open in Agents»** в title bar,
  команда **`Chat: Open Agents Window`**, `code --agents`, браузер
  `insiders.vscode.dev/agents`.
- Интерфейс: sessions list (группировка по воркспейсам), customizations
  panel, chat-зона (несколько сессий side-by-side), панель **Changes**
  (диффы файлов, file explorer), встроенный Markdown-редактор с
  комментариями для агента, Git worktree isolation (New Worktree).
- По докам поддерживаются только **Copilot CLI, Copilot Cloud, Claude**;
  локальные/третьи агенты — «manage from the main VS Code window».
- Расширения активируются в Agents Window: статические — автоматически,
  остальные — opt-in через `extensions.supportAgentsWindow` (по ID,
  только в default profile). Но `vscode.lm`-провайдеры НЕ подключаются
  к agent-host сессиям — чат там через AHP.

## 2. Архитектура Agent Host / AHP

- **Agent Host** — отдельный процесс VS Code, владеющий сессиями;
  клиенты (любые окна, браузер, удалённо) говорят с ним по
  **Agent Host Protocol (AHP)** — JSON-RPC-подобный протокол в стиле
  LSP/DAP: immutable state, pure reducers, write-ahead reconciliation,
  монотонные sequence-номера, broadcast каждому клиенту.
- Спека: https://microsoft.github.io/agent-host-protocol/ ,
  репо: microsoft/agent-host-protocol (MIT).
- Сессии живут в отдельном процессе: переживают закрытие окон, доступны
  из нескольких окон/устройств одновременно, поддерживают удалённое
  исполнение (SSH, dev tunnel).
- Copilot-агент в Agent Host построен на `@github/copilot-sdk` — поведение
  совпадает с Copilot CLI/приложением.

### 2.1 Что такое AHP-сервер (детали)

**AHP-сервер = reference-реализация серверной части протокола.**
По README репозитория agent-host-protocol, официальный (и пока
единственный) AHP-сервер — **это сам VS Code**: `src/vs/platform/agentHost/node/`
(microsoft/vscode@main). «Standalone sessions server», которому клиенты
подключаются и видят синхронизированное состояние сессий.

**Транспорт**: AHP — это JSON-RPC 2.0 поверх любого надёжного
двунаправленного потока (WebSocket — в `ahp-ws` крейте Rust; в VS Code —
внутренний IPC). Спека — DRAFT, breaking changes ожидаются.

**Ключевая идея — каналы (channels)**: каждое сообщение несёт
`params.channel: URI`, по которому маршрутизируется:

| Канал | Что содержит |
|---|---|
| `ahp-root://` | каталог агентов, конфиг хоста, события сессий |
| `ahp-session:/<uuid>` | состояние сессии: chats, дефолтный чат, клиенты, кастомизации, changesets |
| `ahp-chat:/<cid>` | состояние чата: ходы, стриминг, tool calls, ввод |
| `ahp-terminal:` | pty-терминалы |
| `ahp-otlp:` | телеметрия (OpenTelemetry) |

**Методы клиент→сервер**: `initialize`, `reconnect`, `subscribe`,
`createSession`, `disposeSession`, `listSessions`, `fetchTurns`,
`resourceRead/Write/List/Copy/Delete/Move/Resolve/Mkdir`,
`createResourceWatch`, `dispatchAction` (нотификация), `unsubscribe`.
**Сервер→клиент**: `action` (нотификация), `resource*` (запросы,
обратное направление), `root/sessionAdded|Removed|SummaryChanged`,
`auth/required`.

**Клиентские SDK** (подключаться К СЕРВЕРУ, не сервер!):
- TypeScript: `@microsoft/agent-host-protocol` (npm)
- Rust: `ahp`, `ahp-types`, `ahp-ws` (WebSocket транспорт)
- Kotlin (Maven), Go (pkg.go.dev), Swift (SPM)
- AHPX (CLI + Node.js клиент, TylerLeonhardt)

**Значение для нашей интеграции**: «сделать свой AHP-сервер» = реализовать
этот JSON-RPC-протокол (каналы, состояния, редьюсеры, sequence) как
самостоятельный процесс. VS Code-клиент (окна) подключится к нему, если
провайдер зарегистрирован с `agentHostProviderId` (это поле есть только во
внутреннем контракте `registerChatSessionContribution` в workbench —
сторонним расширениям через `contributes.chatSessions` оно НЕ доступно).
Альтернатива: использовать готовый клиентский SDK (`@microsoft/
agent-host-protocol`) НЕ для этого — он клиентский. Серверная часть
существует только в VS Code; для своего хоста её пришлось бы писать
самостоятельно по спеке (большой объём).


## 3. Все настройки Agent Host (из workbench bundle 1.131)

Найдены точные имена конфигов:

```
chat.agentHost.enabled                       # включить agent host (opt-in)
chat.agentHost.ahpJsonlLoggingEnabled        # лог AHP-протокола в JSONL (для отладки!)
chat.agentHost.systemProxy.enabled
chat.agentHost.claudeAgent.enabled           # Claude-агент через Agent Host
chat.agentHost.codexAgent.enabled            # Codex-агент через Agent Host
chat.agentHost.byokModels.enabled            # BYOK (bring-your-own-key) модели!
chat.agentHost.sdkSandbox.enabled            # sandbox для SDK
chat.agentHost.codexAgent.sdkRoot            # путь к SDK Codex
chat.agentHost.codexAgent.codexHome          # CODEX_HOME
chat.agentHost.codexAgent.binaryArgs         # доп. аргументы бинарника Codex
chat.agents.claude.preferAgentHost
chat.editor.claude.preferAgentHost
chat.editor.codex.preferAgentHost
chat.agentHost.otel.*                        # OpenTelemetry: enabled,
                                             #   exporterType, otlpProtocol, otlpEndpoint,
                                             #   captureContent, outfile, serviceName,
                                             #   resourceAttributes
```

Прямая цитата из бандла:

```js
var N_="chat.agentHost.ahpJsonlLoggingEnabled",
    Nat="chat.agentHost.systemProxy.enabled",
    VMo="chat.agentHost.claudeAgent.enabled",
    S9="chat.agentHost.codexAgent.enabled",
    UGt="chat.agentHost.byokModels.enabled",
    Oat="chat.agentHost.sdkSandbox.enabled",
    UMo="chat.agentHost.codexAgent.sdkRoot",
    zMo="chat.agentHost.codexAgent.codexHome",
    KMo="chat.agentHost.codexAgent.binaryArgs";
```

## 4. Extension point `contributes.chatSessions` (официальный!)

Полная JSON-схема из workbench bundle:

```json
"chatSessions": {
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["type", "name", "displayName", "description"],
    "properties": {
      "type":        { "type": "string" },
      "name":        { "type": "string", "pattern": "^[\\w-]+$" },
      "displayName": { "type": "string" },
      "description": { "type": "string" },
      "when":        { "type": "string" },
      "icon":        { "anyOf": [ { "type": "string" },
                                   { "type": "object", "properties": {
                                       "light": { "type": "string" },
                                       "dark":  { "type": "string" } } } ] },
      "order":         { "type": "integer" },
      "alternativeIds": { "type": "array", "items": { "type": "string" } },
      "welcomeTitle":   { "type": "string" },
      "welcomeMessage": { "type": "string" },
      "welcomeTips":    { "type": "string" },
      "inputPlaceholder": { "type": "string" },
      "capabilities": {
        "type": "object",
        "properties": {
          "supportsFileAttachments":        { "type": "boolean" },
          "supportsToolAttachments":        { "type": "boolean" },
          "supportsMCPAttachments":         { "type": "boolean" },
          "supportsImageAttachments":       { "type": "boolean" },
          "supportsSearchResultAttachments": { "type": "boolean" },
          "supportsInstructionAttachments": { "type": "boolean" },
          "supportsSourceControlAttachments": { "type": "boolean" },
          "supportsProblemAttachments":     { "type": "boolean" },
          "supportsSymbolAttachments":      { "type": "boolean" },
          "supportsPromptAttachments":      { "type": "boolean" },
          "supportsHandOffs":               { "type": "boolean" }
        }
      },
      "commands": [ { "name": "", "description": "", "when": "" } ],
      "canDelegate":                       { "type": "boolean", "default": false },
      "customAgentTarget":                 { "type": "string" },
      "requiresCustomModels":              { "type": "boolean", "default": false },
      "supportsAutoModel":                 { "type": "boolean", "default": false },
      "requiresCopilotSignIn":             { "type": "boolean", "default": false },
      "autoAttachReferences":              { "type": "boolean", "default": false },
      "useRequestToPopulateBuiltInPickers":{ "type": "boolean", "default": false }
    }
  }
}
```

**Автогенерация activation event** (из бандла):

```js
activationEventsGenerator: function* (s) {
  for (let i of s) yield `onChatSession:${i.type}`
}
```

→ Объявив `chatSessions`, расширение автоматически активируется по
событию `onChatSession:<type>`.

## 5. Proposed API `vscode.proposed.chatSessionsProvider`

Файл: `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts`
(microsoft/vscode@main, 849 строк). Включение: `"enabledApiProposals":
["chatSessionsProvider"]` в package.json. Требуется **Insiders** или
`--enable-proposed-api` (в Stable предложки отключены — отсюда и тема
«только через патчи»).

Ключевые члены namespace `vscode.chat`:

| Член | Назначение |
|---|---|
| `registerChatSessionItemProvider(chatSessionType, provider)` | **deprecated** — регистрация провайдера для списка сессий |
| `createChatSessionItemController(chatSessionType, refreshHandler)` | **актуальный** способ управления элементами сессии |
| `registerChatSessionContentProvider(scheme, provider, defaultChatParticipant, capabilities?)` | рендер истории сессии в нативном чат-UI |

Интерфейсы:

- `ChatSessionItemProvider` — провайдер элементов сессий (uri ↔ item).
- `ChatSessionItemController` — создание/перечисление/форк сессий.
- `ChatSessionContentProvider`:
  - `provideChatSessionContent(resource, token, {inputState})` → `ChatSession`;
  - `onDidChangeChatSessionOptions?`, `provideChatSessionProviderOptions?`,
    `provideHandleOptionsChange?` — deprecated-эвенты опций.
- `ChatSession`:
  - `title?`, `history: ChatRequestTurn[] | ChatResponseTurn2[]`,
  - `options?`, `activeResponseCallback?` (стриминг текущего ответа),
  - **`requestHandler: ChatRequestHandler | undefined`** — обработка новых
    запросов (если `undefined` — сессия read-only!),
  - `forkHandler?` (deprecated).
- `ChatSessionCapabilities`: `supportsInterruptions?` — прерываемость без
  побочных эффектов.
- `ChatSessionProviderOptions`: `optionGroups` (**0-2 группы**: пикеры
  моделей, сабагентов), `newSessionOptions` (дефолты).
- `ChatSessionInputState`: `groups` (группы опций ввода, заменяются
  целиком), `sessionResource`, `onDidChange`, `onDidDispose`.
- `ChatSessionStatus`: Failed / Completed / InProgress / NeedsInput.

## 6. Эталон — расширение OpenAI ChatGPT (openai.chatgpt 26.707.91948)

Его Codex-агент реально попадает в Agents Window. package.json:

```json
"enabledApiProposals": ["chatSessionsProvider", "languageModelProxy"],
"contributes": {
  "chatSessions": [{
    "type": "openai-codex",
    "name": "Codex",
    "displayName": "OpenAI Codex",
    "description": "OpenAI Codex integration for VS Code"
  }]
}
```

Код: `registerChatSessionItemProvider(type, provider)` (единственный вызов
этого API в бандле) + `languageModelProxy` (второй proposed API — видимо,
прокси LM-запросов, вероятно релевантен для BYOK-моделей).

## 7. Как Copilot Chat (встроенный) регистрирует агентов

Из workbench bundle (внутренний сервис `chatSessionsService`):

```js
registerChatSessionContribution({type, name, displayName, description,
  customAgentTarget: isSessionsWindow ? undefined : "github-copilot",
  canDelegate: true, requiresCustomModels: true,
  supportsAutoModel: autoModelFor(provider),
  requiresCopilotSignIn: true,
  agentHostProviderId: provider,          // ← связь с Agent Host
  supportsDelegation: true, ...})
```

- `chatSessionsService.getChatSessionContribution(type)`,
  `getAllChatSessionContributions()`, `requiresCustomModelsForSessionType()`,
  `supportsDelegationForSessionType()`, `getOptionGroupsForSessionType()`,
  `onDidChangeAvailability` — сервис workbench, общий для всех окон.
- **Условие видимости Codex-типа** в обычном (не sessions) окне:

```js
gTn = and(negate(Ho /* isSessionsWindow */),
          or(negate(dA),
             not(config.chat.agentHost.claudeAgent.enabled),
             not(config.chat.agentHost.codexAgent.enabled)));
fTn = (s) => s.type === Codex ? {...s, when: and(s.when, gTn)} : s;
```

То есть в обычном окне Codex-сессия скрывается, как только включён
`chat.agentHost.claudeAgent.enabled` или `chat.agentHost.codexAgent.enabled`
(агенты переезжают в Agent Host). В Agents Window (isSessionsWindow=true)
этот гейт не применяется. `dA` — контекст-условие (уточнить).

## 8. Выводы и гипотезы для нашей интеграции

### Путь A — официальный (без патча, только Insiders)
1. `contributes.chatSessions`: `{type: "llamacpp", name, displayName,
   description}` → активация `onChatSession:llamacpp` автоматически.
2. `enabledApiProposals: ["chatSessionsProvider"]` (нужен Insiders /
   `--enable-proposed-api`).
3. `vscode.chat.registerChatSessionItemProvider("llamacpp", provider)` +
   `vscode.chat.registerChatSessionContentProvider("llamacpp",
   contentProvider, defaultParticipant)`.
4. `ChatSession.requestHandler` → **наши** провайдеры (DeepSeek / Codex /
   Claude / llama.cpp) — история рендерится нативно, запросы идут через
   нас; `optionGroups` — пикеры моделей.
5. НО: это обычные chat-сессии (без `agentHostProviderId` — поля нет в
   схеме contribution). Полноценный agent-host статус (фоновые сессии,
   продолжение при закрытых окнах, remote) недоступен сторонним
   расширениям — только через AHP-харнесс.

### Путь B — патч (текущий подход расширения)
Как мы уже патим Copilot Chat (native model controls и т.д.), можно:
- вставить нашу регистрацию `registerChatSessionContribution` в
  copilot-бандл или workbench (поля `agentHostProviderId` и
  `supportsDelegation` доступны только в этом внутреннем контракте);
- подменить/добавить тип сессии с `agentHostProviderId` на наш
  AHP-совместимый провайдер — требует реализации AHP-сервера;
- либо «прокинуть» наш `requestHandler` в существующую сессию.

### Путь C — BYOK
Настройка `chat.agentHost.byokModels.enabled` существует. Механизм пока не
изучен (в copilot-бандле `byokModels` не найден — 0 совпадений; вероятно,
логика в agent-host бинарнике/расширении OpenAI через `languageModelProxy`).
**Открытый вопрос**: можно ли через BYOK подставить наши модели в Agent
Host без патчей (модель = `vscode.lm`-провайдер или OpenAI-совместимый
endpoint DeepSeek/llama.cpp).

## 9. Открытые вопросы для дальнейшего ресёрча

1. Формируется ли список агентов в Agents Window (New Session → агент)
   из `getAllChatSessionContributions()`? Если да — наши сессии появятся
   там сразу после contribution (путь A). Проверить в коде sessions
   window picker.
2. Что такое контекст `dA` в гейте видимости Codex (путь B, уточнить).
3. Как работает `chat.agentHost.byokModels.enabled` + `languageModelProxy`
   (расширение OpenAI) — можно ли подключить DeepSeek/llama.cpp как
   BYOK-модель в Agent Host.
4. `chat.agentHost.ahpJsonlLoggingEnabled` — включить и посмотреть реальный
   трафик AHP (какие методы харнессы вызывают).
5. Нужен ли `extensions.supportAgentsWindow` для нашего расширения, чтобы
   оно активировалось в Agents Window (в т.ч. для отображения сессий).
6. `chatSessions` + `onChatSession:<type>` — проверить, что наш тип
   реально появляется в sessions window (есть ли там вообще сторонние
   типы — по докам «Folder: Copilot CLI or Claude agent»).
7. Как сессии агентов хранятся/переносятся между окнами
   (workspaceStorage/chatSessions, emptyWindowChatSessions) — можно ли
   «навесить» наши сессии на тот же сторадж.

## 10. Полезные команды для экспериментов (без кода)

```bash
# Лог AHP-трафика agent host
"chat.agentHost.ahpJsonlLoggingEnabled": true   # затем смотреть output/файл

# Включить agent host (opt-in)
"chat.agentHost.enabled": true

# BYOK-модели
"chat.agentHost.byokModels.enabled": true

# Настройки бинарника Codex (для экспериментов с харнессом)
"chat.agentHost.codexAgent.sdkRoot"
"chat.agentHost.codexAgent.codexHome"
"chat.agentHost.codexAgent.binaryArgs"
```

## Файлы/артефакты, использованные в ресёрче

- `.../resources/app/out/vs/workbench/workbench.desktop.main.js` (1.131)
- `.../resources/app/extensions/copilot/dist/extension.js` (1.131)
- `~/.vscode/extensions/openai.chatgpt-26.707.91948-win32-x64/`
  (package.json + out/extension.js)
- `/tmp/chatSessionsProvider.d.ts` — proposed API (microsoft/vscode@main)
- https://code.visualstudio.com/docs/agents/agents-window
- https://code.visualstudio.com/docs/agents/concepts/agent-host
- https://microsoft.github.io/agent-host-protocol/
- https://code.visualstudio.com/updates/v1_131
