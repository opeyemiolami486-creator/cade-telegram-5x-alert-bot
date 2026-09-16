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
- `/trade JOHN higher 100` — open a headless Cade login and prepare a trade preview
- `/email you@example.com` — provide the Cade login email for the active preview
- `/otp 123456` — provide the one-time code for the active preview
- `/cancel` — close the headless browser session without submitting

## Railway setup

1. Create a bot with Telegram's **BotFather** and copy its bot token.
2. Create a new Railway service from this repository. Railway will detect the included `Dockerfile` and use the official Playwright image, which includes Chromium and its Linux system libraries.
3. Set these Railway variables:

```text
TELEGRAM_BOT_TOKEN=your_bot_token
ALLOWED_CHAT_IDS=
POLL_SECONDS=1
MIN_MULTIPLE=5
CADE_FEE=0.03
MAX_MARKETS=30
ALERT_STAKE=100
```

`ALLOWED_CHAT_IDS` is optional. Leave it blank if you do not want a chat allow-list; in that case, anyone who finds the bot can use it. Multiple IDs can be comma-separated.

4. Deploy. The service starts with `npm start`.
5. Open the bot in Telegram and send `/start`, then `/alerts`.

The Dockerfile is required for the headless browser. Do not override the Railway start command with a bare Node runtime that omits the Playwright base image.

To find your numeric Telegram chat ID, temporarily omit `ALLOWED_CHAT_IDS`, send `/status` to the bot, and add the ID after checking Railway logs or use a trusted Telegram ID helper. Then redeploy with the allow-list set.

## Alert behavior

The bot scans public market links discovered from Cade's home page. It sends at most one alert for each unique market/side/pool snapshot, so it does not repeatedly spam the same unchanged opportunity. `ALERT_STAKE` controls the example amount shown in automatic alerts; the 5× threshold itself is a multiple, so it is independent of stake size.

A “5×+ opportunity” means the estimated **total return**, including the original stake, is strictly greater than five times the stake. For a $100 stake, that means an estimated total return greater than $500.

## Headless browser preview

The `/trade` workflow runs Chromium headlessly on Railway, so no desktop browser is needed on the phone. It opens Cade's email login, accepts the email and one-time code through Telegram, navigates to the selected market, and sends a fresh preview with the time remaining. The current implementation deliberately stops before clicking any final trade or wallet-signing control. It does not store the OTP after the session and does not accept passwords, seed phrases, or private keys.

## Caveats

Cade has not publicly documented a complete authenticated trading API. The bot therefore does not place predictions. The return calculation is an estimate based on visible pool totals, the displayed fee, and a pari-mutuel pool model; verify the final amount on Cade before risking funds.
