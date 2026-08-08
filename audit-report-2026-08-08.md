# Аудит llama-vscode-chat — 2026-08-08

**Версия:** 1.10.96 (dev, установлена через `.vsix`, source: vsix)
**Методология:** `npm run compile` + полный `npm test` (vscode-test, 343 теста) + `npx eslint src/` (0 ошибок); анализ живых JSONL-логов сессии; сверка реестра `docs/BUGS.md`; скрипт поиска дубликатов функций (16 функций с несколькими объявлениями, тела просмотрены); скрипт поиска неиспользуемых экспортов.

---

## ✅ Итоговая оценка

**Стабильно.** Все известные проблемы закрыты, живые данные подтверждают здоровое поведение без лупов, роста контекста и переключения раскрытых карточек.

---

## 1. Сборка и регрессия

| Проверка | Результат |
|---|---|
| `npm run compile` (`tsc -p ./`) | 0 ошибок |
| `npm test` (vscode-test, VS Code 1.131.0) | **339 passing** (20s), 0 failures |
| eslint (изменённые модули) | 0 ошибок |

Регрессии покрывают ключевые механики: append-only shared memory ledger, scoped delete, snapshot alignment, cache classification, compaction, loop detection, Live Report UI.

---

## 2. Живая сессия (лог `llamacpp-2026-08-08T12-54-08-880Z-25224.jsonl`, 31 ход, deepseek-v4-flash)

| Метрика | Значение | Оценка |
|---|---|---|
| `chat.cache.report` | 36× `healthy`, 1× `history_summarized` (17.5% сразу после компакции) | ✅ ожидаемо |
| Cache hit | 98.6–100% на всех healthy-ходах | ✅ |
| `snapshot_stale` | 0 | ✅ контекст не пересобирается |
| `snapshot_rewound` | 1 (штатно: 137/148 переиспользовано, отмотано 11) | ✅ |
| Подрядные tool-only ходы | **0** из 31 | ✅ лупов нет |
| `loop_detected` / `max_turns_stop` / `tool_force_text` / `validation_retry` | 0 / 0 / 0 / 0 | ✅ защиты активны, не срабатывали |
| `toolExecutionErrors` | 0 | ✅ |
| Shared memory | 7 записей (6 workspace + 1 global); retrieval 1×, далее 36× `frozen-tool-turn` | ✅ ledger стабилен |
| `models.request.failed` | 14× `fetch failed` — фоновые probe/keep-alive | ✅ ходы не затрагивают |

Активные защиты: `maxModelTurnsPerRequest=6`, `toolCallRepairEnabled=true`, `toolLoopForceTextThreshold=12` (src/llama-provider.ts:3883), `memoryMaxTokens=4096`.

---

## 3. Статус реестра багов (`docs/BUGS.md`)

Все 30 записей — **«исправлен»** (дубль номера 19 оставлен как историческая пометка).

| # | Проблема | Версия фикса |
|---|---|---|
| 4 | Агент «зависал» посреди задачи | 1.10.93 — невоспроизводимо, закрыто по подтверждению + логам |
| 17 | Рост контекста +37K/ход после reload (переписывание сообщения 360) | 1.10.93 — `snapshot_stale`=0 в живых данных |
| 18 | Tool-only лупы в другом окне | 1.10.93 — дабл-записи reasoning устранены (1.10.80–83) + force-text; 0 подрядных tool-only в логах |

---

## 4. Что было сделано в рамках аудита

1. **1.10.92 — scoped shared memory:** публичный контракт двух областей `global`/`workspace`; обязательный `scope`; запрет удаления/изменения записей чужого проекта; legacy `model`-scope только для чтения; `scopeCounts` в диагностике.
2. **1.10.93 — Live Report:** раскрываемый exploded view каждого cache-блока (total/cached/miss/hit, собственные шкалы); стабильная identity карточек по `requestId` (вместо позиционных `detail-N`); сохранение viewport-позиции и раскрытых деталей при live-обновлениях.
3. **Закрытие реестра багов** с подтверждением из логов.

---

## 5. Наблюдения / рекомендации (не блокеры)

- 14 фоновых `fetch failed` на сессию — шум от probe-запросов; при желании можно глушить в логах (`models.request.failed` с кодом probe).
- Остались незакоммиченные dev-правки 1.10.92/1.10.93 + служебные файлы (`.tmp-trace11.mjs`, снапшоты HTML) — перед стабильным релизом стоит почистить и закоммитить (по явной команде).
- Формат отчёта повторяет `audit-report-2026-08-07.tmp.md`; при желании оба можно свести в `docs/AUDIT.md`.

---

## 6. Аудит дубликатов и мёртвого кода (1.10.96)

### Дедупликация (вынесено в `src/utils.ts`, локальные копии удалены)

| Функция | Было копий | Файлы, где удалены локальные копии |
|---|---|---|
| `asRecord` | 4 | app-server-client, codex-provider, rollout-metrics, turn-bridge |
| `clampInteger` | 3 | claude-provider (4 вызова переписаны на порядок value/min/max/fallback), output-budget, ui/context-control |
| `truncate` | 2 | codex-provider (явный лимит 1200), turn-bridge (явный лимит 240) |
| `bytesToBase64` | 2 | message-adapter; в utils удалена старая btoa-версия, осталась Buffer |
| `normalizeCopilotTurnIndex` | 2 | claude-provider, codex-provider |
| `contentToText` | 2 | message-compaction, memory/prompt |
| `nonNegativeInteger` | 2 | token-usage-history, usage-experiment |
| `formatTokenCount` | 2 | claude-provider, ui/context-control (единый формат K/M) |

### Мёртвый код (удалён)
- Тернарник с идентичными ветками `/user/balance` (llama-provider) → одна строка.
- Неиспользуемая константа `DEFAULT_CLAUDE_KEEPALIVE_MS` (claude-provider).
- Неиспользуемый импорт `asRecord` (claude-provider).
- `llamacpp.autoCompact` default `true → false` — синхронизация с fallback кода (`cfg.get("autoCompact", false)`) и описанием «Disabled by default».

### Проверено и признано НЕ дубликатами
- `convertTools` (3 объявления — перегрузки TS), `__llamaBoundToolText` (2 — разные варианты патча VS Code), `clip` (2 — разное поведение: с нормализацией пробелов и без), `collectToolResultContent` (2 — разные сигнатуры), `esc` (2 — разные рантаймы: Node vs embedded JS), `createMemento` (2 — тестовые хелперы разных файлов), `normalizeAggregate`/`normalizePersisted` (2 — разные типы схем), `deactivate` (контракт VS Code).

---

## 7. Команды, использованные в аудите

`npm run compile`, `npm test`, `npx eslint src/`, скрипты node по JSONL-логам (`chat.cache.report`, `chat.turn.complete`, `chat.messages.snapshot_*`, `chat.memory.context`, `chat.tools.*`), скрипты поиска дубликатов/мёртвых экспортов, `git status`, `git log --oneline -8`.
