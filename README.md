# Upwork Hub Daily Digest

Щоденний автоматичний ресьорч новин Upwork з доставкою чернеток постів
у Telegram-канал через бота. Працює на GitHub Actions (безкоштовно),
ресьорч робить Claude API з web search.

## Як це працює

1. GitHub Actions запускає скрипт щоранку (cron)
2. Скрипт збирає сирі дані з Reddit (r/Upwork, r/freelance) - best-effort
3. Викликає Claude API (claude-sonnet-4-6) з увімкненим web search:
   блог Upwork, release notes, community, tech-медіа
4. Claude відбирає 1-3 теми, ігноруючи вже покриті (state/covered.json),
   і повертає готові чернетки постів у стилі каналу
5. Скрипт шле кожну тему окремим повідомленням у Telegram
6. Список покритих тем комітиться назад у репозиторій (дедуплікація)

## Налаштування (разово, ~10 хвилин)

### 1. Репозиторій

Створи приватний репозиторій на GitHub і запуш ці файли:

```bash
git init
git add .
git commit -m "init: upwork hub digest pipeline"
git remote add origin git@github.com:<you>/upwork-hub-digest.git
git push -u origin main
```

### 2. Anthropic API key

- Зайди на https://console.anthropic.com -> API Keys -> Create Key
- Поповни баланс (Billing). Орієнтовний кост: ~2-8 центів за запуск
  (web search коштує $10 за 1000 пошуків + токени), тобто $1-3/місяць

### 3. GitHub Secrets і Variables

Repo -> Settings -> Secrets and variables -> Actions:

**Secrets (вкладка Secrets):**
- `ANTHROPIC_API_KEY` - ключ з кроку 2
- `TELEGRAM_BOT_TOKEN` - токен бота з BotFather

**Variables (вкладка Variables):**
- `TELEGRAM_CHAT_ID` - id каналу-чернетки, напр. `-1003941247545`

### 4. Перший запуск

Repo -> Actions -> "Upwork Hub Daily Digest" -> Run workflow.
Дивись лог джоби; повідомлення мають прийти в канал за 1-3 хвилини.

### 5. Розклад

Cron у `.github/workflows/digest.yml` - зараз `30 5 * * *` UTC
(06:30 за Лісабоном влітку). GitHub може запускати cron із затримкою
до ~15 хв - це нормально.

## Тюнінг

- **Стиль постів і джерела** - редагуй `SYSTEM_PROMPT` у `src/digest.mjs`.
  Найкращий буст якості: додай у промпт 2-3 приклади своїх реальних постів.
- **Кількість тем** - "Максимум 3 items" у промпті.
- **Глибина ресьорчу** - `max_uses` у tools (зараз 8 пошуків; більше =
  глибше і дорожче).
- **Модель** - `MODEL` у скрипті. `claude-haiku-4-5` дешевше,
  `claude-opus-4-8` розумніше.

## Локальний запуск (для дебагу)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export TELEGRAM_BOT_TOKEN=123:ABC...
export TELEGRAM_CHAT_ID=-1003941247545
node src/digest.mjs
```

## Відомі особливості

- Reddit часто віддає 403 з IP датацентрів (GitHub runners включно).
  Скрипт це логує і продовжує без Reddit - web search все одно
  підтягує гарячі обговорення непрямо.
- Якщо Telegram відхиляє HTML-розмітку поста, скрипт автоматично
  повторює відправку plain text-ом, тож запуск не падає.
- `state/covered.json` тримає останні 120 тем. Якщо бот почне
  повторюватись - збільш `MAX_COVERED`.
