# Cade.market Telegram Monitor

A Telegram bot for Railway. It reads Cade.market's public market JSON endpoint, estimates returns using live HIGHER/LOWER pools and Cade's displayed 3% fee, responds to commands, and sends an alert when a $100 example stake exceeds the configured multiple. Its alerting features are read-only; the explicit `/trade` flow can submit a paper prediction after manual Cade login.

It does **not** handle wallet keys or blockchain signing. It opens a visible Chromium session for manual Cade login and submits only through the authenticated paper-credit market controls when `SUBMIT_PREDICTIONS=true`.

## Telegram commands

- `/start` — show help
- `/markets` — list readable markets and current estimates for a $100 stake
- `/estimate higher 100` — estimate HIGHER for $100 across current markets
- `/estimate lower 100` — estimate LOWER for $100 across current markets
- `/opportunity 2x` — set this chat's automatic-alert threshold to 2×+
- `/trusted on` — choose the higher-implied-probability side when modeled profit is at least 30%
- `/amount 1500` — use $1,500 for every token in this chat
- `/amount JOHN 250` — override the default with $250 for JOHN
- `/arbitrage on` — enable two-sided hedge alerts
- `/arbitrage off` — disable two-sided hedge alerts
- `/alerts` — enable automatic alerts for this chat
- `/stop` — disable automatic alerts for this chat until `/alerts` is used again
- `/status` — show scanner status
- `/result` — list alert calls and their verified settled outcomes
- `/result wins10m` — show only verified winning calls resolved in the last 10 minutes
- `/trade JOHN higher 100` — submit an in-memory paper trade for the open market
- `/email you@example.com` — provide the Cade login email for the active preview
- `/otp 123456` — provide the one-time code for the active preview
- `/resend` — ask Cade/Privy to send the code again
- `/cancel` — close the visible browser session without submitting

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

`/trusted on` enables a conservative signal filter that chooses the side with the higher current implied pool probability, requires current implied chance of at least 70%, requires modeled profit of at least 30% for the configured paper amount, and requires at least 30 seconds before the market’s order cutoff. `/amount VALUE` sets a chat-wide paper amount for every token, while `/amount SYMBOL VALUE` overrides it for one token. The amount is used by automatic opportunity searches, trusted signals, and `/markets` estimates. Without a setting, `ALERT_STAKE` is used and is treated as the maximum paper amount for the signal. “Trusted” is only a label for this filter and does not mean the outcome is guaranteed.

`/arbitrage on` enables a separate two-sided hedge scan. It solves for the Higher/Lower stake split that equalizes the modeled payout and alerts only when the minimum payout across either outcome is at least `ARBITRAGE_MIN_MULTIPLE` times the combined paper stake. This is a strict mathematical screen, not a guarantee: pools can move, fees and limits can differ, both accounts may not execute, and Cade may prohibit multi-account hedging. It remains read-only and never places either trade.

## Paper trades

The `/trade SYMBOL higher|lower AMOUNT` command opens a temporary visible authenticated Cade browser session. Complete login manually in that browser window; after login is detected, the bot returns to Cade's homepage, clicks that token's **Quick predict** control, fills the amount, and clicks the selected HIGHER/LOWER control in the resulting trade form. A trade is recorded only after Cade confirms the submission, and it is settled by `/result` after the public market reports a winning outcome. Set `SUBMIT_PREDICTIONS=false` to force preview-only behavior. No wallet seed phrase or private key is accepted or stored.

The bot uses a persistent Playwright Chromium profile in `CADE_PROFILE_DIR` (by default, `./cade-browser-profile`). This preserves Cade cookies and local storage when the bot restarts or closes a trade session, so you normally log in only once. Cade can still expire or revoke a session server-side; if that happens, complete login again in the visible browser. Do not copy, upload, or share the profile directory because it may contain active login cookies.

## Headless browser preview (legacy)

The legacy Telegram OTP handoff commands remain available for compatible sessions, but the current default flow is manual login in visible Chromium. Telegram commands sent as `/stop@your_bot` are supported.

## Caveats

Cade's authenticated client uses a browser-mediated paper-credit submission flow. The bot submits only through the visible Cade market controls after login; it does not call undocumented wallet endpoints, handle seed phrases, or sign blockchain transactions. The return calculation is an estimate based on visible pool totals, the displayed fee, and a pari-mutuel pool model.
