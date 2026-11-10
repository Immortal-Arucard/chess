# Chess Marketplace Stripe setup

The Worker does not include Stripe keys. Checkout stays disabled, with the banner "Checkout not yet enabled", until these values exist on the `chess-api` Worker. Do not put the secret key, a restricted key, or the webhook secret in the repository, in logs, or in `wrangler.jsonc`.

Test in Stripe sandbox (test mode) before using live keys.

## Dashboard

1. Open the existing Stripe account in test mode. Enable Connect. For new sellers the Worker requests a recipient account: Express dashboard, the platform collects fees and losses, and only the `stripe_transfers` capability. In the Dashboard, review and acknowledge responsibility for negative balances on connected accounts.
2. Set Connect branding (Settings → Connect → Branding) to The World Government, Inc. / Chess.
3. Developers → Webhooks → Add an endpoint.
   - URL: `https://chess.theworldgovernmentincorporated.com/api/market/stripe/webhook`
   - Listen to events on connected accounts as well as the platform account.
   - Events:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `checkout.session.expired`
     - `payment_intent.payment_failed`
     - `charge.succeeded`
     - `charge.refunded`
     - `transfer.created`
     - `charge.dispute.created`
     - `charge.dispute.updated`
     - `charge.dispute.closed`
     - `account.updated`
     - `account.application.deauthorized`
4. Copy the endpoint signing secret. That value is `STRIPE_WEBHOOK_SECRET`.
5. Developers → API keys. Use a secret key or a restricted key.
   - `STRIPE_SECRET_KEY` may be `sk_test_...` / `sk_live_...` or `rk_test_...` / `rk_live_...`.
   - A restricted key needs write access to Checkout Sessions, Accounts, Account Links, Login Links, and Transfer Reversals, and read access to those same resources. It does not need any other product.
   - `STRIPE_PUBLISHABLE_KEY` is the publishable key (`pk_test_...` or `pk_live_...`).

## Worker

Set these on `chess-api` without printing them:

- Secret `STRIPE_SECRET_KEY` (secret or restricted key)
- Secret `STRIPE_WEBHOOK_SECRET`
- Var `STRIPE_PUBLISHABLE_KEY`
- Optional var `MARKET_FEE_BPS` (basis points kept by the platform). The default is `500`, a 5% fee. Set the var to `0` to charge no platform fee. When the fee is above 0 it is sent as `application_fee_amount` on the destination-charge Checkout Session. When it is 0, that field is omitted.

The Worker pins `Stripe-Version` to `2026-09-30.endive`. Requests do not enable automatic tax. The platform keeps 5% (`MARKET_FEE_BPS` 500) unless that var is set to another whole number of basis points.

Apply `supabase/chess_market.sql` once, then `supabase/chess_market_stripe.sql` once. Do not edit or reapply either file. A Worker deploy is required before the webhook and checkout routes in this change are live.

Sandbox first: complete a test Checkout payment, an expired session, a partial refund, and a dispute in test mode, and confirm the order status in the seller and admin views before switching the keys to live mode.
