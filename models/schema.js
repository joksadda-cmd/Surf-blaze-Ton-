// models/schema.js — SEASON 2 স্কিমা (single WTC currency)
//
// চালানোর কমান্ড: node models/schema.js
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: users
// ──────────────────────────────────────────────────────────────────
// {
//   _id: "123456789",                  // Telegram user id
//   firstName: "User",
//   telegramUsername: "N/A",
//
//   // ── একটাই কারেন্সি ──
//   wtcBalance: 0,
//   lifetimeWtcEarned: 0,
//   pendingVideoWTC: 0,                 // video দেখে জমা, claim করার আগে এখানে থাকে (min 200 দরকার claim-এ)
//
//   // ── রেফারেল (৩-ধাপ মাইলস্টোন সিস্টেম + weekly competition) ──
//   referralCount: 0,                   // lifetime, never reset
//   weeklyReferralCount: 0,             // ⚠️ NEW — resets every Friday by api/cron/weeklyReferral.js
//   totalInvites: 0,
//   referredBy: null,
//   referralStep1Done: false,           // verify করলে (30 WTC referrer পায়)
//   referralStep2Done: false,           // 10 task করলে (100 WTC)
//   referralStep3Done: false,           // 20 ads করলে (180 WTC)
//   referralCommissionEarned: 0,        // ⚠️ NEW — lifetime sum of 10% withdraw commissions earned from referrals (see api/withdraw.js)
//
//   completedTasks: [],
//   isBanned: false,
//   bannedAt: Date,                     // ⚠️ NEW — set the moment isBanned becomes true (see api/bot.js). Powers the
//                                        //   60-day cleanup TTL below; cleared ($unset) if the user is unbanned.
//   channelVerified: false,
//   withdrawalCount: 0,
//   lastWithdrawDate: "",
//
//   lifetimeAdsWatched: 0,
//   adsWatchedToday: 0,
//   adsgramDailyCountToday: 0,
//   monetagCountToday: 0,
//   gigaCountToday: 0,
//   uslCountToday: 0,                   // ⚠️ NEW — USL Ads (TowerAds), live
//   lastAdClaimAt: Date,                 // ⚠️ NEW — enforces AD_COOLDOWN_SECONDS between ad claims (see api/earn.js)
//   usedAdStarts: [],                   // single-use ad-claim tokens, reset daily (⚠️ FIX — was never reset before, grew forever)
//   usedLootboxStarts: [],               // single-use lootbox-claim tokens, reset daily (⚠️ FIX — was never reset before, grew forever)
//   usedTaskStarts: [],                  // ⚠️ NEW — single-use task-claim tokens (non-'channel' categories), reset daily
//
//   dailyVideoWtcMined: 0,
//   tasksCompletedToday: 0,
//   lastResetDate: "06/27/2026",
//   welcomeBonusClaimed: false,
//   createdAt: Date,
//
//   // ── multi-account flagging (admin-review, auto-ban না) ──
//   multiAccountFlag: false,
//   multiAccountSiblings: [],           // অন্য userId গুলো যারা একই fingerprint শেয়ার করে
//   multiAccountFingerprint: "..."      // (optional) যে হ্যাশ ম্যাচ করেছে
//
//   // ── SEASON 3 ──
//   luckyTickets: 0,                    // 🎟 777 lottery — earned 1 per verified referral, see lib/referral.js
//
//   // ── SEASON 4 — simplified single-step withdraw ──
//   validReferralCount: 0,              // lifetime, +1 when a referral completes all 3 steps (lib/referral.js)
//   usedValidReferrals: 0,              // +1 each withdraw after the user's first (free) one — see api/withdraw.js
//   lastActiveAt: Date,                  // ⚠️ NEW — refreshed on every app open, powers the 90-day dead-account TTL below
// }
//
// ⚠️ NEW — a partial TTL index on `bannedAt` (see setupIndexes below) makes
// MongoDB auto-delete a user's ENTIRE document 60 days after they were
// banned (isBanned:true only — a merely multiAccountFlag'd-but-not-yet-banned
// user is NEVER touched by this, since they may still be reinstated after
// review). This frees free-tier storage from long-dead banned accounts.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: bannedTelegramIds  (⚠️ NEW — permanent ban registry, see api/bot.js)
// ──────────────────────────────────────────────────────────────────
// { _id: "123456789", bannedAt: Date }
//
// Tiny, NO-TTL, forever-persisting record of every currently-banned
// Telegram ID. Exists ONLY so that once the full `users` document above
// gets auto-deleted after 60 days, that Telegram ID can't simply reopen the
// app and get a fresh, un-banned account (api/user.js's handleInit checks
// this registry before creating any new user). Kept in perfect sync with
// `users.isBanned` by api/bot.js's markBanned()/markUnbanned() helpers —
// an admin unban always removes the ID here too.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: fingerprints  (multi-account detection-এর জন্য)
// ──────────────────────────────────────────────────────────────────
// {
//   _id: "<sha256 hash>",               // client/fingerprint.js থেকে আসা হ্যাশ
//   userIds: ["111", "222"],            // এই ডিভাইস থেকে যত userId রেজিস্টার হয়েছে
//   firstSeenAt: Date,
//   lastSeenAt: Date
// }
//
// ⚠️ NEW — a TTL index on `lastSeenAt` (see setupIndexes below) auto-deletes
// a fingerprint doc 180 days after its last signup activity — old/inactive
// device fingerprints have no further multi-account-detection value and were
// accumulating forever on the free-tier database.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: ipRegistry  (⚠️ NEW — SEASON 3, pure IP one-account gate)
// ──────────────────────────────────────────────────────────────────
// { _id: "<ip address>", userId: "<current owner telegram id>", claimedAt: Date, lastSeenAt: Date }
//
// One doc per IP; whoever it points to is the only Telegram account allowed
// to use the app from that IP right now. Checked on EVERY api/user.js
// action:init call (new signup AND returning user), not just at signup —
// see lib/ipRegistry.js. This fully replaces fingerprint-based auto-ban as
// the season's active enforcement path; `fingerprints` below is left in
// place for the multiAccountFlag admin-review data it already produced, but
// no longer auto-suspends anyone on its own — IP is now the hard gate.
//
// ⚠️ NEW — a TTL index on `lastSeenAt` (refreshed every time the owner's own
// check passes) auto-deletes a doc 120 days after that IP goes completely
// quiet — most IPs are dynamic and get reassigned to someone else eventually.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: videos
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, videoId: "dQw4w9WgXcQ", title: "...", isActive: true, createdAt: Date }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: tasks
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId, title: "...", url: "...", channelId: "@...",
//   category: "channel" | "daily" | "exclusive" | "partner" | "earning",
//   verifyType: "api" | "link",          // ⚠️ NEW — "api" = real Telegram join check (channelId required); "link" = manual claim after taskStart wait. Independent of category — any category can be "api" now, not just "channel".
//   rewardWtc: 60,                       // always the actual WTC credited (USDT already converted in, see below)
//   rewardCurrency: "wtc" | "usdt",      // "daily" tasks may be priced in USDT — display-only, doesn't change crediting
//   rewardUsdt: 0.5,                     // set only when rewardCurrency === "usdt", null otherwise
//   isApproved: true, limit: 0, completionCount: 0, createdAt: Date
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: withdrawals
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId, userId: "123456789", method: "binance" | "tonkeeper",
//   details: "address/uid",
//   wtcAmount: 2000, grossUsd: 0.08, cashAmount: 0.057, currency: "USDT",
//   referralConsumed: false,            // true if this withdraw spent one of the user's valid referrals (all but their 1st)
//   referrerId: "123456789" | null,     // ⚠️ NEW — snapshot of user.referredBy at withdraw time, for audit
//   referrerCommissionPaid: 0,          // ⚠️ NEW — 10% of wtcAmount credited to referrerId, 0 if no referrer
//   status: "pending" | "approved" | "rejected", createdAt: Date, processedAt: Date
// }
//
// ⚠️ NEW — a partial TTL index on `processedAt` (see setupIndexes below)
// auto-deletes a withdrawal doc 90 days after it's REJECTED — a rejected
// request already refunds the WTC in full at reject time, so it has no
// further use beyond a brief audit trail. 'pending'/'approved' withdrawals
// are real financial records and are never touched by this index.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: gifts  (admin-sent surprise gifts — see api/gift.js)
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, userId: "123456789", amount: 50, reason: "...",
//   status: "pending" | "claimed", createdAt: Date, claimedAt: Date }
//
// ⚠️ NEW — a partial TTL index on `claimedAt` (see setupIndexes below) makes
// MongoDB auto-delete a gift doc 30 days after it's claimed. Pending gifts
// (no claimedAt) are never touched by this index — only claimed-and-done
// gifts get cleaned up, freeing free-tier storage with zero functional risk.
//
// ⚠️ NEW — a second partial TTL index on `createdAt` auto-deletes a gift
// that's STILL 'pending' 180 days after it was sent and never claimed —
// realistically abandoned at that point.
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: promos
// ──────────────────────────────────────────────────────────────────
// { _id: ObjectId, code: "482913", reward: 50, maxUses: 50, usedCount: 0, redeemedBy: [], expiresAt: Date, createdAt: Date }
//
// A code stops being redeemable 24h after createdAt (`expiresAt`, checked in
// api/earn.js's handleClaimPromo). The DOCUMENT itself lives 24h longer than
// that — 48h total from createdAt — so an expired code's redemption
// stats/history are still visible in the admin panel's "📋 View Promos"
// list for a day after it stops working, instead of vanishing the instant
// it expires. See the TTL index on `expiresAt` below (expireAfterSeconds:
// 86400 — i.e. 24h past the expiresAt value itself).
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: weeklyReferralReports  (⚠️ NEW — history of past weekly
// referral competition results, written by bot.js's a_weekly_reset_confirm
// or the optional api/cron/weeklyReferral.js, read back by a_weekly_history)
// ──────────────────────────────────────────────────────────────────
// {
//   _id: ObjectId,
//   weekEndedAt: Date,
//   totalParticipants: 14,               // how many users had any weeklyReferralCount > 0 that week
//   winners: [                            // only users who met WEEKLY_REFERRAL_MIN_COUNT, capped at WEEKLY_REFERRAL_MAX_WINNERS — can be fewer than the cap, or empty
//     { userId: "123456789", firstName: "User", telegramUsername: "user1", weeklyReferralCount: 14 },
//   ],
// }
//
// ──────────────────────────────────────────────────────────────────
// COLLECTION: config
// ──────────────────────────────────────────────────────────────────
// { _id: "appConfig", ... } — ভবিষ্যতে অ্যাডমিন প্যানেল থেকে রেট/লিমিট বদলানোর জন্য রিজার্ভ করা

import { connectToDatabase } from '../lib/mongodb.js';

async function setupIndexes() {
    const { db, client } = await connectToDatabase();
    console.log('Indexes বানানো শুরু হচ্ছে...');

    await db.collection('users').createIndex({ referredBy: 1 });
    await db.collection('users').createIndex({ isBanned: 1 });
    // ⚠️ NEW — speeds up the weekly cron's top-N sort (api/cron/weeklyReferral.js)
    await db.collection('users').createIndex({ weeklyReferralCount: -1 });
    // ⚠️ NEW — partial TTL index: ONLY documents with isBanned:true expire
    // (60 days after bannedAt). A merely multiAccountFlag'd user (not yet
    // banned) is NEVER touched — this only deletes confirmed, admin-banned
    // accounts' full documents. See api/bot.js + api/user.js for the
    // companion `bannedTelegramIds` registry that keeps the ban itself
    // permanent even after this document is gone.
    await db.collection('users').createIndex(
        { bannedAt: 1 },
        { expireAfterSeconds: 5184000, partialFilterExpression: { isBanned: true } }
    );
    // ⚠️ NEW — "dead account" cleanup, per admin's Season 3 spec: 3 months
    // (90 days) with the app never once reopened auto-deletes the WHOLE
    // user doc — not partial/scoped like the other TTLs, applies to every
    // user regardless of ban status. `lastActiveAt` is refreshed on every
    // action:init (api/user.js), i.e. every time the app is opened, so this
    // is a rolling 90-day-since-last-open window, not a fixed date.
    // If a banned user is ALSO caught by this, no harm — the separate,
    // never-expiring `bannedTelegramIds` registry (lib/banRegistry.js) is
    // what actually enforces the ban and isn't touched by this index, so
    // the ban survives even if this fires before the bannedAt TTL above does.
    // If this same Telegram ID reopens the app after deletion, api/user.js's
    // handleInit sees no existing doc and creates a genuinely fresh account
    // — that's the intended "dead user gets a new account" behavior.
    await db.collection('users').createIndex({ lastActiveAt: 1 }, { expireAfterSeconds: 7776000 });
    await db.collection('videos').createIndex({ isActive: 1, createdAt: -1 });
    await db.collection('tasks').createIndex({ isApproved: 1, category: 1, createdAt: -1 });
    await db.collection('withdrawals').createIndex({ userId: 1, createdAt: -1 });
    await db.collection('withdrawals').createIndex({ details: 1 });
    // ⚠️ NEW — partial TTL index: ONLY 'rejected' withdrawals expire (90 days
    // after processedAt). A rejected withdrawal already fully refunds the
    // user's WTC at reject time (see api/bot.js) and has no further use
    // beyond a brief audit trail — unlike 'approved'/'pending', which are
    // real financial records and are never touched by this index.
    await db.collection('withdrawals').createIndex(
        { processedAt: 1 },
        { expireAfterSeconds: 7776000, partialFilterExpression: { status: 'rejected' } }
    );
    await db.collection('promos').createIndex({ code: 1 }, { unique: true });
    // ⚠️ CHANGED — TTL index: was expireAfterSeconds:0 (deleted the INSTANT
    // expiresAt passed). Now waits an extra 24h past expiresAt before
    // deleting (48h total lifetime from createdAt: 24h usable + 24h grace),
    // so an expired code's redemption stats/history are still visible in
    // the admin panel's "📋 View Promos" list for a day after it stops
    // working, instead of vanishing the moment it expires.
    await db.collection('promos').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86400 });
    // ⚠️ NEW — TTL index: a fingerprint doc auto-deletes 180 days after its
    // last signup activity. Old/inactive-device fingerprints have no further
    // multi-account-detection value and were accumulating forever on the
    // free-tier database.
    await db.collection('fingerprints').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 15552000 });

    // ⚠️ NEW — partial TTL index: ONLY documents with status:'claimed' expire
    // (30 days after claimedAt). Pending gifts (no claimedAt yet, or status
    // still 'pending') are completely unaffected by this index — they never
    // auto-expire. This cleans up claimed-and-done gift records, which have
    // zero further use once claimed, without ever risking a pending gift.
    await db.collection('gifts').createIndex(
        { claimedAt: 1 },
        { expireAfterSeconds: 2592000, partialFilterExpression: { status: 'claimed' } }
    );
    // ⚠️ NEW — partial TTL index: an unclaimed ('pending') gift auto-expires
    // 180 days after createdAt if it's just never been claimed — very
    // generous, since a legitimate gift is normally claimed within days, but
    // an abandoned pending gift sitting for 6 months is realistically never
    // coming back to be claimed and has no further use. 'claimed' gifts are
    // untouched by this index — they're governed by the claimedAt TTL above.
    await db.collection('gifts').createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 15552000, partialFilterExpression: { status: 'pending' } }
    );
    // ⚠️ NEW — SEASON 3: TTL for lib/ipRegistry.js's per-IP claim docs. Most
    // IPs are dynamic (mobile carriers, home routers) and get reassigned to
    // a different person eventually — an IP nobody in this app has touched
    // in 120 days has no ongoing gate-keeping value and would otherwise sit
    // here forever, one document per IP ever seen.
    await db.collection('ipRegistry').createIndex({ lastSeenAt: 1 }, { expireAfterSeconds: 10368000 });
    // ⚠️ NEW — speeds up a_weekly_history's "most recent report" lookup
    await db.collection('weeklyReferralReports').createIndex({ weekEndedAt: -1 });

    // TTL index — adminState documents automatically expire after 1 hour.
    // This cleans up abandoned mid-flow states (e.g. admin started Add Task but cancelled)
    // without any manual cleanup needed.
    await db.collection('adminState').createIndex({ updatedAt: 1 }, { expireAfterSeconds: 3600 });

    console.log('সব index বানানো শেষ ✅');
    await client.close();
}

setupIndexes().catch((err) => {
    console.error('Index setup ব্যর্থ হয়েছে:', err);
    process.exit(1);
});
