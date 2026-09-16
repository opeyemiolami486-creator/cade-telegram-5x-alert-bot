# Cade.market Telegram Monitor

A **read-only** Telegram bot for Railway. It reads Cade.market's public market JSON endpoint, estimates returns using live HIGHER/LOWER pools and Cade's displayed 3% fee, responds to commands, and sends an alert when a $100 example stake exceeds the configured multiple.

It does **not** log in to Cade, handle wallet keys, or place trades.

## Telegram commands

- `/start` — show help
- `/markets` — list readable markets and current estimates for a $100 stake
- `/estimate higher 100` — estimate HIGHER for $100 across current markets
- `/estimate lower 100` — estimate LOWER for $100 across current markets
- `/alerts` — enable automatic alerts for this chat
- `/stop` — disable automatic alerts for this chat
- `/status` — show scanner status

## Railway setup

1. Create a bot with Telegram's **BotFather** and copy its bot token.
2. Create a new Railway service from this repository.
3. Set these Railway variables:

```text
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_CHAT_IDS=your_numeric_telegram_chat_id
POLL_SECONDS=60
MIN_MULTIPLE=5
CADE_FEE=0.03
MAX_MARKETS=30
ALERT_STAKE=100
```

`ALLOWED_CHAT_IDS` is strongly recommended. It prevents strangers who discover the bot username from using it. Multiple IDs can be comma-separated.

4. Deploy. The service starts with `npm start`.
5. Open the bot in Telegram and send `/start`, then `/alerts`.

To find your numeric Telegram chat ID, temporarily omit `ALLOWED_CHAT_IDS`, send `/status` to the bot, and add the ID after checking Railway logs or use a trusted Telegram ID helper. Then redeploy with the allow-list set.

## Alert behavior

The bot scans public market links discovered from Cade's home page. It sends at most one alert for each unique market/side/pool snapshot, so it does not repeatedly spam the same unchanged opportunity. `ALERT_STAKE` controls the example amount shown in automatic alerts; the 5× threshold itself is a multiple, so it is independent of stake size.

A “5×+ opportunity” means the estimated **total return**, including the original stake, is strictly greater than five times the stake. For a $100 stake, that means an estimated total return greater than $500.

## Caveats

Cade has not publicly documented a complete authenticated trading API. The bot therefore does not place predictions. The return calculation is an estimate based on visible pool totals, the displayed fee, and a pari-mutuel pool model; verify the final amount on Cade before risking funds.
