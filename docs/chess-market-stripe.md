# Chess Marketplace Stripe setup

The Worker does not include Stripe keys. Checkout stays disabled, with the banner "Checkout not yet enabled", until these values exist on the `chess-api` Worker. Do not put the secret key or the webhook secret in the repository, in logs, or in `wrangler.jsonc`.

## Dashboard

1. Open the existing Stripe account in test mode first. Enable Connect: Settings → Connect → Get started, and choose Express accounts.
2. Set Connect branding (Settings → Connect → Branding) to The World Government, Inc. / Chess so sellers recognize the onboarding screen.
3. Developers → Webhooks → Add endpoint.
   - URL: `https://chess.theworldgovernmentincorporated.com/api/market/stripe/webhook`
   - Events: `checkout.session.completed`, `charge.refunded`, `account.updated`
4. Open the endpoint and copy its signing secret. That value is `STRIPE_WEBHOOK_SECRET`.
5. Developers → API keys. Copy the secret key (`sk_test_...` while testing, later `sk_live_...`) as `STRIPE_SECRET_KEY`, and the publishable key (`pk_test_...` or `pk_live_...`) as `STRIPE_PUBLISHABLE_KEY`.

## Worker

Set the secrets and the publishable var on `chess-api` without printing them:

- Secret `STRIPE_SECRET_KEY`
- Secret `STRIPE_WEBHOOK_SECRET`
- Var `STRIPE_PUBLISHABLE_KEY`
- Optional var `MARKET_FEE_BPS` (basis points kept by the platform; default 0)

A Worker deploy is required before the new `/api/market/*` routes and the webhook exist. After the secrets are set, buy buttons call Stripe Checkout with a destination charge to the seller's Express account. The platform fee is `MARKET_FEE_BPS`. Order status changes only when the webhook signature checks.

Apply `supabase/chess_market.sql` once before relying on those routes. Do not reapply earlier SQL files.
