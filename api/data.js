// api/data.js — Task list, leaderboard, weekly contest, and recent-withdrawals
// ticker — public read-only data.
//   GET /api/data?type=tasks
//   GET /api/data?type=leaderboard        (referralCount অনুযায়ী টপ ২০)
//   GET /api/data?type=gameLeaderboard    (Surf Drive gameHighScore অনুযায়ী টপ ৩০ — ⚠️ NEW)
//   GET /api/data?type=weeklyContest
//   GET /api/data?type=recentWithdrawals   (Home-এ "social proof" ticker-এর জন্য — সত্যিকারের approved withdraw, username মাস্ক করা)

import { connectToDatabase } from '../lib/mongodb.js';

// প্রাইভেসির জন্য username আংশিক মাস্ক করা হয় — যেমন "Rashu_Xansi" → "Ras***si"
function maskUsername(name) {
    if (!name || name === 'N/A') return 'User';
    if (name.length <= 4) return name[0] + '***';
    return name.slice(0, 3) + '***' + name.slice(-2);
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    }

    try {
        const { type } = req.query;
        const { db } = await connectToDatabase();

        if (type === 'tasks') {
            const tasks = await db.collection('tasks')
                .find({ isApproved: true })
                .sort({ createdAt: -1 })
                .limit(50)
                .toArray();
            return res.status(200).json({ ok: true, tasks });
        }

        if (type === 'leaderboard') {
            // Sorted/shown by actual referralCount ("Top Referrer").
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true } })
                .project({ telegramUsername: 1, firstName: 1, referralCount: 1 })
                .sort({ referralCount: -1 })
                .limit(20)
                .toArray();
            return res.status(200).json({ ok: true, leaderboard: top });
        }

        // ⚠️ Surf Drive top-scorer list (by best single-run distance) — kept
        // for potential future use, but the Home tab's "Top Scores" button
        // itself now uses 'topEarners' below (admin decided the app's main
        // leaderboard should rank by DC earned, not game distance).
        if (type === 'gameLeaderboard') {
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true }, gameHighScore: { $gt: 0 } })
                .project({ telegramUsername: 1, firstName: 1, gameHighScore: 1 })
                .sort({ gameHighScore: -1 })
                .limit(30)
                .toArray();
            return res.status(200).json({ ok: true, leaderboard: top });
        }

        // Home tab's "Top Scores" button — ranked by lifetimeDcEarned (total
        // DC ever earned, never decreases on withdraw/spend — see the $inc
        // calls in api/earn.js, api/gift.js, api/bot.js, lib/referral.js).
        if (type === 'topEarners') {
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true }, lifetimeDcEarned: { $gt: 0 } })
                .project({ telegramUsername: 1, firstName: 1, lifetimeDcEarned: 1 })
                .sort({ lifetimeDcEarned: -1 })
                .limit(30)
                .toArray();
            return res.status(200).json({ ok: true, leaderboard: top });
        }

        if (type === 'recentWithdrawals') {
            const recent = await db.collection('withdrawals')
                .find({ status: 'approved' })
                .project({ username: 1, cashAmount: 1, currency: 1, processedAt: 1 })
                .sort({ processedAt: -1 })
                .limit(15)
                .toArray();
            const items = recent.map(w => ({
                username: maskUsername(w.username),
                cashAmount: w.cashAmount,
                currency: w.currency,
            }));
            return res.status(200).json({ ok: true, items });
        }

        // ⚠️ NEW — Weekly Referral Contest (mini app "Milestones" button). Reads
        // the SAME live `weeklyReferralCount` field the admin panel's a_weekly
        // screen uses, so it automatically reflects the admin's manual
        // "🔄 Reset week now" (bot.js a_weekly_reset_confirm) — no separate
        // reset needed here, it's the same field/collection.
        if (type === 'weeklyContest') {
            const top = await db.collection('users')
                .find({ isBanned: { $ne: true }, weeklyReferralCount: { $gt: 0 } })
                .project({ telegramUsername: 1, firstName: 1, weeklyReferralCount: 1 })
                .sort({ weeklyReferralCount: -1 })
                .limit(10)
                .toArray();
            return res.status(200).json({ ok: true, top });
        }

        return res.status(400).json({ ok: false, error: 'unknown_type' });
    } catch (err) {
        console.error('data error:', err);
        return res.status(500).json({ ok: false, error: 'server_error' });
    }
                }
