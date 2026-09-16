# Cade.market Telegram Monitor

A **read-only** Telegram bot for Railway. It reads Cade.market's public market JSON endpoint, estimates returns using live HIGHER/LOWER pools and Cade's displayed 3% fee, responds to commands, and sends an alert when a $100 example stake exceeds the configured multiple.

It does **not** log in to Cade, handle wallet keys, or place trades.

## Telegram commands

- `/start` — show help
- `/markets` — list readable markets and current estimates for a $100 stake
- `/estimate higher 100` — estimate HIGHER for $100 across current markets
- `/estimate lower 100` — estimate LOWER for $100 across current markets
- `/opportunity 2x` — set this chat's automatic-alert threshold to 2×+
- `/arbitrage on` — enable two-sided hedge alerts
- `/arbitrage off` — disable two-sided hedge alerts
- `/alerts` — enable automatic alerts for this chat
- `/stop` — disable automatic alerts for this chat until `/alerts` is used again
- `/status` — show scanner status
- `/result` — list alert calls and their verified settled outcomes
- `/result wins10m` — show only verified winning calls resolved in the last 10 minutes
- `/trade JOHN higher 100` — open a headless Cade login and prepare a trade preview
- `/email you@example.com` — provide the Cade login email for the active preview
- `/otp 123456` — provide the one-time code for the active preview
- `/resend` — ask Cade/Privy to send the code again
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
MIN_SECONDS_LEFT=30
```

`ALLOWED_CHAT_IDS` is optional. Leave it blank if you do not want a chat allow-list; in that case, anyone who finds the bot can use it. Multiple IDs can be comma-separated.

4. Deploy. The service starts with `npm start`.
5. Open the bot in Telegram and send `/start`, then `/alerts`.

The Dockerfile is required for the headless browser. Do not override the Railway start command with a bare Node runtime that omits the Playwright base image.

To find your numeric Telegram chat ID, temporarily omit `ALLOWED_CHAT_IDS`, send `/status` to the bot, and add the ID after checking Railway logs or use a trusted Telegram ID helper. Then redeploy with the allow-list set.

## Alert behavior

The bot scans public market links discovered from Cade's home page. It sends at most one alert for each unique market/side/pool snapshot, so it does not repeatedly spam the same unchanged opportunity. `ALERT_STAKE` controls the example amount shown in automatic alerts; the 5× threshold itself is a multiple, so it is independent of stake size.

A “5×+ opportunity” means the estimated **total return**, including the original stake, is strictly greater than five times the stake. For a $100 stake, that means an estimated total return greater than $500. The estimate uses the live Higher/Lower net pools, adds the hypothetical stake to the selected pool, and applies `CADE_FEE`; it is conditional pool math, not a guaranteed profit or a prediction of the winner. Automatic alerts also require more than `MIN_SECONDS_LEFT` seconds before Cade’s order cutoff; the default is 30 seconds.

`/result` tracks alert calls in memory and checks the same market later for Cade’s settled `winning_outcome_index`. It reports WON or LOST only after settlement. Because the bot is read-only, these are paper-call outcomes based on the configured `ALERT_STAKE`; the bot does not verify that a real trade was placed or that a payout was received. Results reset when the service restarts.

Each chat can choose its own alert threshold with `/opportunity 2x`, `/opportunity 3x`, or `/opportunity 5x`. The setting also enables alerts for that chat. If no personal threshold is set, `MIN_MULTIPLE` is used. A user receives an alert only when the modeled total-return multiple is strictly greater than that user’s threshold.

`/arbitrage on` enables a separate two-sided hedge scan. It solves for the Higher/Lower stake split that equalizes the modeled payout and alerts only when the minimum payout across either outcome is at least `ARBITRAGE_MIN_MULTIPLE` times the combined paper stake. This is a strict mathematical screen, not a guarantee: pools can move, fees and limits can differ, both accounts may not execute, and Cade may prohibit multi-account hedging. It remains read-only and never places either trade.

## Headless browser preview

The `/trade` workflow runs Chromium headlessly on Railway, so no desktop browser is needed on the phone. It waits for Cade's Privy login modal to hydrate, opens the visible email-login form, accepts the email and one-time code through Telegram, waits for the OTP screen to complete, navigates to the selected market, and sends a fresh preview with the time remaining. The current implementation deliberately stops before clicking any final trade or wallet-signing control. It does not store the OTP after the session and does not accept passwords, seed phrases, or private keys. Telegram commands sent as `/stop@your_bot` are also supported.

## Caveats

Cade has not publicly documented a complete authenticated trading API. The bot therefore does not place predictions. The return calculation is an estimate based on visible pool totals, the displayed fee, and a pari-mutuel pool model; verify the final amount on Cade before risking funds.
