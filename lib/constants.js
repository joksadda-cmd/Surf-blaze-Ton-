// lib/constants.js — SURF BLAZE CURRENCY REBUILD
//
// ⚠️ NEW ECONOMY (this rebuild) — the old fixed WTC→USD rate + percentage
// fees is GONE. Payout now tracks real ad revenue instead of a made-up
// fixed rate:
//   • Users earn DC (Drop Coin) from tasks/games/etc — same balance field
//     as before, just renamed (wtcBalance → dcBalance everywhere).
//   • DC converts to "impressions" at a fixed ratio (DC_PER_IMPRESSION) —
//     this part IS fixed, it's just a display/counting unit, not money.
//   • Impressions convert to USD via a CPM rate the admin sets manually,
//     typically weekly, from the bot's "📈 Set CPM" admin action (see
//     api/bot.js) — this tracks whatever the ad networks actually paid
//     that week. Stored in the `settings` collection (see lib/settings.js),
//     not a fixed constant, since it changes.
//   • No percentage fees are taken on withdraw — the CPM rate the admin
//     sets IS the final per-impression payout (the admin already decides
//     their own cut when picking that number, e.g. keeping 60% and setting
//     CPM to the other 40% of what the ad network actually paid).

export const CURRENCY = 'DC';         // Drop Coin — Surf Blaze Ton's currency
export const CURRENCY_FULL_NAME = 'Drop Coin';

// ── Mining (Home tab) — start a session, wait it out, claim the reward,
// start again. No cooldown between sessions — a user can start the next
// one immediately after claiming. See api/earn.js handleMiningStart/
// handleMiningClaim, and user.miningStartedAt (null when not mining). ──
export const MINING_DURATION_HOURS = 2;
export const MINING_DURATION_MS = MINING_DURATION_HOURS * 60 * 60 * 1000;
export const MINING_REWARD_DC = 20;

// ── DC → impression ratio (FIXED) ── 50,000 DC = 1,000 impressions
export const DC_PER_IMPRESSION = 50;

// ── CPM (cost per 1,000 impressions), in USD — admin-controlled, NOT a
// constant. See lib/settings.js getCpmRate()/setCpmRate(). This is only the
// fallback used the very first time, before an admin ever sets one. ──
export const DEFAULT_CPM_RATE = 0.2;

// ⚠️ Unrelated to the withdraw/CPM economy above — this is just a fixed
// convenience rate the admin panel uses when creating a task priced in
// USDT (see api/bot.js taskRewardLine / the "Daily task reward currency"
// step): it converts that USD figure into a DC point value at task-creation
// time, once. Nothing downstream (earn.js reward crediting, withdraw
// payout) ever looks at USD again after that — the task's rewardDc is just
// a plain DC number from then on, same as any other task.
export const DC_PER_USD_TASK_REWARD = 25000;

// ── Game tab's "Earn" button — watches one ad from any of the 4 networks ──
// ⚠️ RE-ADDED (this rebuild) — the ad-watch-to-earn flow now lives in the
// Game tab (below the Surf Drive button) instead of the old Earning tab.
// Any network can be paused instantly by flipping its `enabled` flag here,
// without a code deploy.
export const AD_NETWORK_REWARDS = {
    adsgramDaily: { reward: 10, dailyLimit: 10, enabled: true },
    monetag:      { reward: 15, dailyLimit: 20, enabled: true },
    giga:         { reward: 15, dailyLimit: 20, enabled: true },
    usl:          { reward: 15, dailyLimit: 10, enabled: true },
};

// Minimum seconds that must elapse between an `adStart` token being issued
// and `claimAdReward` accepting it — the server-side floor that makes an
// instant-claim script impossible (still not full ad-network S2S
// verification, but removes the "drain the daily limit in under a second"
// exploit). Adjust to match how long the ad units actually run for.
export const AD_MIN_WATCH_SECONDS = 4;

// Minimum gap enforced between successive ad claims (any network), so a
// script can't fire adStart→claimAdReward back-to-back with zero pacing.
export const AD_COOLDOWN_SECONDS = 20;

// ── Surf Drive game (Game tab / Home "Play Surf Drive") ──
// Same short-lived signed-token pattern as the ad-watch flow: gameStart
// issues a token the instant the game overlay opens, and claimGameReward
// checks/consumes it once the run ends. The client only ever reports how
// many drop-coins it collected and how far (in-game "meters") the run
// went — the actual DC reward and the lifetime best-score tracking are
// both decided here, server-side. See api/earn.js.
export const GAME_MIN_PLAY_SECONDS = 8;         // a genuine run always takes at least this long
export const GAME_TOKEN_MAX_AGE_SECONDS = 900;  // 15 minutes to finish the run and claim the token
export const GAME_COINS_TO_DC = 500;            // 1 in-game drop-coin collected = this many DC
export const GAME_MAX_COINS_PER_SECOND = 0.05;  // sanity ceiling — blocks a forged/huge coins value
export const GAME_MAX_REWARD_DC = 1500;         // hard per-run cap regardless of coins reported
export const GAME_MAX_DISTANCE_PER_SECOND = 50; // sanity ceiling for the reported score/distance

// ⚠️ NEW — minimum real time a user must hold a task open before claiming
// it (daily/exclusive/partner/earning categories — 'channel' tasks skip this
// entirely since Telegram membership is independently verified). Kept
// slightly under the frontend's 10-second claim-button countdown so a
// genuine user is never blocked by their own honest usage; a script that
// skips straight from taskStart to taskComplete with no real wait gets
// rejected. See handleTaskStart/handleTaskComplete in api/earn.js.
export const TASK_MIN_WAIT_SECONDS = 8;

// ── Withdraw methods ──
// ⚠️ TON withdrawal removed — Tonkeeper is now used only as a wallet ADDRESS
// (users still paste their TON wallet/Tonkeeper address), but the actual
// payout sent to that address is USDT (USDT-on-TON), not native TON coin.
// Both methods now pay out in USDT. No dcToCurrency() fixed-rate function
// here anymore — the real conversion needs the live CPM rate, which is
// async (DB lookup), so it's done directly in api/withdraw.js instead.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1 },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1 },
};

// ══════════════════════════════════════════════════════════
// WITHDRAW — impression/CPM based. A user types a DC amount
// (minimum MIN_WITHDRAW_DC, = MIN_WITHDRAW_IMPRESSIONS worth), it's
// converted to impressions, and paid out at the CURRENT CPM rate:
//   usdAmount = (impressions / 1000) * currentCpmRate
// No percentage fees — see the currency-model note up top for why.
//
// ⚠️ WEEKLY-FRIDAY-ONLY submission window — NOW ENABLED (admin confirmed
// testing is done). Withdraw requests are only accepted when isFridayBD()
// is true — "airdrop-style," once a week. See api/withdraw.js. Approving/
// rejecting an already-submitted request from the bot is NOT restricted to
// Fridays — only the user-facing submission is.
// ══════════════════════════════════════════════════════════
export const WITHDRAW_DAY_ONLY_FRIDAY = true;
export const MIN_WITHDRAW_IMPRESSIONS = 1000;                                   // ⚠️ CHANGED — was 500
export const MIN_WITHDRAW_DC = MIN_WITHDRAW_IMPRESSIONS * DC_PER_IMPRESSION;    // = 50,000 DC

// ⚠️ Lifetime, one-time gate — checked against completedTasks.length (the
// lifetime array, never reset), not tasksCompletedToday (which resets
// daily). Once a user has completed WITHDRAW_TASKS_REQUIRED tasks EVER,
// this gate is permanently satisfied — they never have to redo it on later
// withdrawals. See api/withdraw.js.
export const WITHDRAW_TASKS_REQUIRED = 10; // ⚠️ CHANGED — was 8

// ⚠️ CHANGED — RE-ENABLED. The Game tab's "Watch & Earn" (ad-network watch)
// flow now exists again (see AD_NETWORK_REWARDS above / api/earn.js
// handleClaimAdReward), so this daily gate is meaningful again — resets at
// Bangladesh midnight along with everything else in dailyResetFields().
export const WITHDRAW_ADS_REQUIRED = 30; // ⚠️ CHANGED — was 0 (disabled)

// ⚠️ NEW — referral gate: the very first withdrawal a user ever makes is
// free (no referral needed). Every withdrawal AFTER that consumes exactly
// one "valid" referral (see lib/referral.js — a referral becomes valid once
// the referred user completes all 3 referral milestones). Enforced in
// api/withdraw.js against user.validReferralCount - user.usedValidReferrals.
export const WITHDRAW_VALID_REFERRALS_PER_WITHDRAW = 1;

// ⚠️ REMOVED (Season 4) — address lock. Per admin's instruction, a
// withdraw address is never locked. Left the constant name out of the file
// entirely rather than a disabled flag, since nothing should reference it
// anymore — if address locking is ever wanted again later, it needs to be
// reintroduced deliberately, not silently reactivated by a stray import.

// ── Referral — given in 3 stages (lifetime milestone, awarded once) ──
export const REFERRAL_REWARDS = {
    step1_verified:      30,  // when the referred user joins channel+community and verifies
    step2_tenTasks:      100, // when the referred user completes 10 tasks
    step3_twentyTasks:   180, // when the referred user completes 20 tasks (⚠️ CHANGED this rebuild — was ad-count based; no ad feature exists right now, so both steps 2 & 3 progress off task completions)
};
export const REFERRAL_STEP2_TASK_COUNT = 10;
export const REFERRAL_STEP3_TASK_COUNT = 20; // ⚠️ RENAMED from REFERRAL_STEP3_AD_COUNT — see lib/referral.js

// ⚠️ NEW — withdrawal referral commission. Every time a user withdraws, if
// they were referred by someone, the referrer is credited this % of the
// WITHDRAWN DC AMOUNT (gross, before it's converted to impressions/USD)
// directly to their own dcBalance — e.g. a 10,000 DC withdrawal pays the
// referrer 1,000 DC. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// Today's date in the Bangladesh timezone

export function todayBD() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
}

// ⚠️ NEW — weekly withdraw window. Withdrawals only open on Fridays
// (Bangladesh time) — "airdrop-style" per admin. See WITHDRAW_DAY_OF_WEEK
// below / api/withdraw.js for how this is enforced.
export function isFridayBD() {
    const weekday = new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', weekday: 'long' });
    return weekday === 'Friday';
}

// Current month key in the Bangladesh timezone (e.g. "07/2026") — kept for
// anything else that still resets monthly. The tiered-withdraw counters
// below no longer use this — see currentHalfYearBD().
export function currentMonthBD() {
    return new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit' });
}

// The tiered-withdraw monthlyLimit counters reset every 6 months (per
// earlier admin decision — CONFIRMED to stay as-is, not changed to 2
// months). Returns a key like "2026-H1" (Jan–Jun) or "2026-H2" (Jul–Dec),
// Bangladesh time.
export function currentHalfYearBD() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    const year = now.getFullYear();
    const half = now.getMonth() < 6 ? 'H1' : 'H2'; // Jan–Jun vs Jul–Dec
    return `${year}-${half}`;
}

// ⚠️ REMOVED (Season 4) — WITHDRAW_TIERS and WITHDRAW_LEVELS. Both the
// fixed-$-tier grid and the hidden referral-based level ladder are gone;
// withdraw amount is now a free-text DC field (min MIN_WITHDRAW_DC) and
// the only referral gate is "1 valid referral per withdraw after the
// first" — see WITHDRAW_VALID_REFERRALS_PER_WITHDRAW above.

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        tasksCompletedToday: 0,
        adsWatchedToday: 0,
        adsgramDailyCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        uslCountToday: 0,
        // Single-use task/ad-claim tokens (see api/earn.js) — these expire
        // after 5 minutes anyway, so there's no reason to keep spent ones
        // past the day they were issued (MongoDB free-tier document-size
        // bloat otherwise).
        usedTaskStarts: [],
        usedAdStarts: [],
        usedGameStarts: [],
    };
}

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON END — withdrawals closed. Set by admin decision: no new
// withdraw requests are accepted from this point on. Already-submitted
// ('pending') withdrawals are UNAFFECTED — bot.js's normal Approve/Reject
// admin flow still works exactly as before for those, so anyone who
// requested a withdraw before this flag flipped still gets paid. This only
// blocks the "create a NEW withdrawal" path (api/withdraw.js handleCreate).
// Flip back to true if withdrawals ever reopen.
// ══════════════════════════════════════════════════════════
export const WITHDRAWALS_OPEN = true; // ⚠️ SEASON 3 — reopened for the new season (was closed at Season 2's end)

// ══════════════════════════════════════════════════════════
// WEEKLY REFERRAL COMPETITION — every user's `weeklyReferralCount` climbs
// as they land referrals this week (see api/user.js handleInit). Reward
// eligibility is a THRESHOLD, not just rank: only users with AT LEAST
// WEEKLY_REFERRAL_MIN_COUNT referrals this week qualify, and of those, only
// the top WEEKLY_REFERRAL_MAX_WINNERS get rewarded. If fewer than
// WEEKLY_REFERRAL_MAX_WINNERS users cross the threshold, fewer people get
// rewarded that week (could be 0) — it's never "top 10 regardless of count".
// The admin resets manually via bot.js's a_weekly → "🔄 Reset week now",
// which snapshots the qualifying winners into a `weeklyReferralReports`
// collection (viewable later via "📜 Weekly Report") BEFORE zeroing
// everyone's weeklyReferralCount for the new week. Rewards themselves are
// sent manually by the admin — nothing here touches dcBalance
// automatically. Lifetime `referralCount` is a separate field, untouched.
// ══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;  // minimum refs THIS WEEK to qualify at all
export const WEEKLY_REFERRAL_MAX_WINNERS = 10; // cap on how many qualifying users get rewarded
