// lib/constants.js — SEASON 2 UPDATE (FIXED RATES — live pricing removed)
//
// ⚠️ Per admin's instruction, the live TON price system was removed — it
// would sometimes overpay users in TON when the market price dipped. Now
// it's back to simple, predetermined (fixed) rates — predictable payouts,
// no dependency on an external API.
//
// Dropped the two-tier Gold + Diamond currency — now there's a single
// currency: the WTC coin. All reward/fee/withdraw numbers live here.

export const CURRENCY = 'WTC';

// ── WTC → real-money conversion rate (FIXED) ──
export const WTC_PER_USD = 25000;              // ⚠️ CHANGED — was 20,000. 25,000 WTC = 1 USD now.
export const WTC_PER_TON = WTC_PER_USD / 0.6;  // ⚠️ was hardcoded to 20000/0.6 (stale after WTC_PER_USD changed) — not currently imported/used anywhere (native TON payout was removed earlier), fixed for consistency in case it's ever wired back in

// ── The Extract tab's ad-network buttons ── ⚠️ REMOVED (this rebuild) — no
// ad-watch-to-earn UI exists anymore (Earn tab shows a "Coming Soon" game +
// tasks only). AD_NETWORK_REWARDS / AD_MIN_WATCH_SECONDS / AD_COOLDOWN_SECONDS
// and the whole video/lootbox reward block above are gone with it — nothing
// in api/earn.js calls them anymore. Reintroduce when the ads system (Step 5)
// is rebuilt with the new networks.

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
// Both methods now pay out in USDT.
export const WITHDRAW_METHODS = {
    binance:   { label: 'Binance UID',       currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
    tonkeeper: { label: 'Tonkeeper Address', currency: 'USDT', minCurrency: 0.1, wtcToCurrency: (wtc) => wtc / WTC_PER_USD },
};

// ══════════════════════════════════════════════════════════
// ⚠️ SEASON 4 — WITHDRAW SIMPLIFIED. The old convert-first + tiered-box +
// level-ladder system is gone. Now it's ONE step: a user types a WTC
// amount (minimum MIN_WITHDRAW_WTC) and submits directly — no separate
// "Convert" screen, no tier grid, no hidden level gate, no address lock.
//
// TWO fees apply, back-to-back, on that single submit:
//   1) WITHDRAW_FEE_PERCENT (25%) — this is the SAME rate the old
//      "convert" step used to take. Kept exactly as-is per admin's
//      instruction, just applied at the (now single) withdraw step
//      instead of a separate convert step.
//   2) WITHDRAW_SECOND_FEE_PERCENT (5%) — NEW, taken on what's left
//      after the 25% above.
// So a user nets wtc/WTC_PER_USD * 0.75 * 0.95 ≈ 71.25% of face value.
// See api/withdraw.js calcNetUsd().
// ══════════════════════════════════════════════════════════
export const MIN_WITHDRAW_WTC = 1000; // ⚠️ NEW — minimum WTC per withdraw request

export const WITHDRAW_FEE_PERCENT = 25;        // unchanged rate, moved from convert-step to withdraw-step
export const WITHDRAW_SECOND_FEE_PERCENT = 5;  // ⚠️ NEW — additional flat fee taken at withdraw time

// ⚠️ CHANGED — WITHDRAW_TASKS_REQUIRED is now a LIFETIME, one-time gate, not
// a daily one. It's checked against completedTasks.length (the lifetime
// array, never reset) instead of tasksCompletedToday (which resets daily).
// Once a user has completed 8 tasks EVER, this gate is permanently satisfied
// — they never have to redo it on later withdrawals. See api/withdraw.js.
export const WITHDRAW_TASKS_REQUIRED = 8;

// ⚠️ CHANGED (this rebuild) — was a daily "watch 8 ads" gate. There's no
// ad-watch-to-earn UI right now (Earn tab is Game + Task only), so this is
// set to 0 — a real gate here would permanently block every withdrawal
// (adsWatchedToday can never increase with no way to earn it). Re-enable
// once the ads system (Step 5) is rebuilt.
export const WITHDRAW_ADS_REQUIRED = 0;

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
// WITHDRAWN WTC AMOUNT (gross, before withdraw fees) directly to their own
// wtcBalance — e.g. a 1,000 WTC withdrawal pays the referrer 100 WTC. This
// is NOT a one-time reward — it fires on every withdrawal, indefinitely, for
// as long as the referral relationship exists. See api/withdraw.js.
export const WITHDRAW_REFERRAL_COMMISSION_PERCENT = 10;

// Today's date in the Bangladesh timezone

export function todayBD() {
    return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka' });
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
// withdraw amount is now a free-text WTC field (min MIN_WITHDRAW_WTC) and
// the only referral gate is "1 valid referral per withdraw after the
// first" — see WITHDRAW_VALID_REFERRALS_PER_WITHDRAW above.

export function dailyResetFields() {
    return {
        lastResetDate: todayBD(),
        tasksCompletedToday: 0,
        // Single-use task-claim tokens (see api/earn.js handleTaskStart/
        // handleTaskComplete) — these expire after 5 minutes anyway, so
        // there's no reason to keep spent ones past the day they were
        // issued (MongoDB free-tier document-size bloat otherwise).
        usedTaskStarts: [],
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
// sent manually by the admin — nothing here touches wtcBalance
// automatically. Lifetime `referralCount` is a separate field, untouched.
// ══════════════════════════════════════════════════════════
export const WEEKLY_REFERRAL_MIN_COUNT = 10;  // minimum refs THIS WEEK to qualify at all
export const WEEKLY_REFERRAL_MAX_WINNERS = 10; // cap on how many qualifying users get rewarded
