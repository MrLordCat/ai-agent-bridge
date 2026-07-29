#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# stable-release.sh — выпуск стабильной версии llama-vscode-chat
#
# Использование:
#   bash scripts/stable-release.sh 1.9.0
#
# Что делает:
#   1. Проверяет, что версия в package.json совпадает с переданной
#   2. Прогоняет тесты (npm test)
#   3. Собирает .vsix
#   4. Создаёт аннотированный git-тег v1.9.0
#   5. Атомарно пушит текущую ветку и тег в origin
#   6. GitHub Actions собирает VSIX и публикует GitHub Release
#
# Dev-патчи (1.8.x) НЕ тэгаются — только minor/major версии.
# ---------------------------------------------------------------------------
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ $# -ne 1 ]; then
  echo -e "${RED}Использование: bash scripts/stable-release.sh <version>${NC}"
  echo "Пример: bash scripts/stable-release.sh 1.9.0"
  exit 1
fi

VERSION="$1"

# Убираем ведущую 'v' если передали
VERSION="${VERSION#v}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# --- Проверка версии в package.json ---
PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
if [ "$PKG_VERSION" != "$VERSION" ]; then
  echo -e "${RED}ОШИБКА: версия в package.json ($PKG_VERSION) не совпадает с $VERSION${NC}"
  echo "Обнови package.json → npm run package → затем запусти этот скрипт снова."
  exit 1
fi

# --- Проверка что это minor/major версия (не patch) ---
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
PATCH=$(echo "$VERSION" | cut -d. -f3)

if [ "$PATCH" != "0" ]; then
  echo -e "${YELLOW}ПРЕДУПРЕЖДЕНИЕ: версия $VERSION — это patch (третья цифра не 0).${NC}"
  echo "Стабильные релизы обычно имеют патч = 0 (например 1.9.0, 1.10.0)."
  read -r -p "Продолжить? (y/N) " confirm
  if [ "${confirm,,}" != "y" ]; then
    echo "Отменено."
    exit 0
  fi
fi

# --- Проверка незакоммиченных изменений ---
if ! git diff-index --quiet HEAD --; then
  echo -e "${RED}ОШИБКА: есть незакоммиченные изменения. Закоммить сначала.${NC}"
  git status --short
  exit 1
fi

# --- Проверка что мы на main ---
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  echo -e "${YELLOW}ПРЕДУПРЕЖДЕНИЕ: текущая ветка '$BRANCH', не 'main'.${NC}"
  read -r -p "Продолжить? (y/N) " confirm
  if [ "${confirm,,}" != "y" ]; then
    echo "Отменено."
    exit 0
  fi
fi

# --- Прогон тестов ---
echo -e "${GREEN}[1/4] Прогон тестов...${NC}"
npm test

# --- Сборка .vsix ---
echo -e "${GREEN}[2/4] Сборка .vsix...${NC}"
npm run package
VSIX="llama-vscode-chat-${VERSION}.vsix"
if [ ! -f "$VSIX" ]; then
  echo -e "${RED}ОШИБКА: $VSIX не найден после сборки${NC}"
  exit 1
fi

# --- Git-тег ---
TAG="v${VERSION}"
echo -e "${GREEN}[3/4] Создание git-тега ${TAG}...${NC}"

# Проверяем, не существует ли уже тег
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo -e "${RED}ОШИБКА: тег $TAG уже существует${NC}"
  exit 1
fi

git tag -a "$TAG" -m "Stable release ${VERSION}"
echo "Тег $TAG создан на коммите $(git rev-parse --short HEAD)"

# --- Пуш тега ---
echo -e "${GREEN}[4/4] Атомарный пуш ветки и тега в origin...${NC}"
git push --atomic origin "$BRANCH" "$TAG"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Стабильный релиз ${VERSION} выпущен!${NC}"
echo -e "${GREEN}  Тег: ${TAG}${NC}"
echo -e "${GREEN}  Файл: ${VSIX}${NC}"
echo -e "${GREEN}  GitHub Release: публикуется workflow Release${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "Чтобы откатиться к этой версии:"
echo "  git checkout ${TAG}"
echo "  npm run package"
echo "  code --install-extension ${VSIX}"
echo ""
echo "Следующий dev-патч будет: ${MAJOR}.${MINOR}.$((PATCH + 1))"
echo "Обнови package.json и продолжай разработку."
