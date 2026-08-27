// api/withdraw.js — DC / IMPRESSION / CPM WITHDRAW (this rebuild)
//
// User types a DC amount (minimum MIN_WITHDRAW_DC), picks a method
// (Binance UID / Tonkeeper), and submits. The payout is computed from real
// ad-revenue economics instead of a fixed rate:
//   impressions = floor(dcAmount / DC_PER_IMPRESSION)     — DC_PER_IMPRESSION = 50 (50,000 DC = 1,000 impressions)
//   usdAmount   = (impressions / 1000) * currentCpmRate    — CPM is admin-set (see lib/settings.js), changes over time
// No percentage fees are taken — the CPM rate the admin sets already IS the
// final per-impression payout (see lib/constants.js for why).
//
// ⚠️ Weekly-Friday-only submission window — ENABLED (admin confirmed
// testing is done). Withdraw requests (POST) are only accepted when
// isFridayBD() is true — "airdrop-style," once a week, Bangladesh time.
// Approving/rejecting an already-submitted request from the bot is NOT
// restricted to Fridays — only the user-facing submission is.
// WITHDRAWALS_OPEN is still the separate, existing manual admin on/off
// switch — both gates apply independently.
//
// Referral gate: the user's FIRST withdrawal ever is free. Every withdrawal
// after that consumes exactly one "valid referral" — see lib/referral.js,
// where a referral becomes valid once the referred user completes all 3
// referral milestones (that's also where the Telegram "your referral is
// now valid ✅" notification is sent).
//
// No address lock — user can withdraw to a different address/method every
// time if they want.
//
//   GET  /api/withdraw?action=status&initData=...   → balance + full eligibility snapshot (includes live CPM rate, isFridayToday)
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, dcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { getCpmRate } from '../lib/settings.js';
import {
    WITHDRAW_METHODS, DC_PER_IMPRESSION, MIN_WITHDRAW_DC, MIN_WITHDRAW_IMPRESSIONS,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
    WITHDRAW_REFERRAL_COMMISSION_PERCENT, WITHDRAW_DAY_ONLY_FRIDAY,
    todayBD, isFridayBD, WITHDRAWALS_OPEN,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID;

// dcAmount + the CPM rate at request time → impressions + USD payout.
function calcPayout(dcAmount, cpmRate) {
    const impressions = Math.floor(dcAmount / DC_PER_IMPRESSION);
    const usdAmount = (impressions / 1000) * cpmRate;
    return { impressions, usdAmount };
}

// ── GET ?action=status — everything the withdraw screen needs in one call ──
async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const cpmRate = await getCpmRate(db);

    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    // ⚠️ CHANGED — tasks requirement is now LIFETIME, one-time (not daily).
    // Once completedTasks.length ever reaches WITHDRAW_TASKS_REQUIRED, this
    // stays satisfied forever — no daily reset involved.
    const tasksLifetime = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));

    return res.status(200).json({
        ok: true,
        dcBalance: user.dcBalance || 0,
        dcPerImpression: DC_PER_IMPRESSION,
        cpmRate,
        minWithdrawDc: MIN_WITHDRAW_DC,
        minWithdrawImpressions: MIN_WITHDRAW_IMPRESSIONS,
        withdrawalsOpen: WITHDRAWALS_OPEN,
        fridayOnly: WITHDRAW_DAY_ONLY_FRIDAY,
        isFridayToday: isFridayBD(),
        withdrawRequirements: {
            adsRequired: WITHDRAW_ADS_REQUIRED, adsWatchedToday: adsToday, adsMet: adsToday >= WITHDRAW_ADS_REQUIRED,
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime, tasksMet: tasksLifetime >= WITHDRAW_TASKS_REQUIRED,
        },
        referralRequirement: {
            isFirstWithdrawFree: isFirstWithdraw,
            perWithdraw: WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
            validReferralsAvailable: validAvailable,
            needsReferral: !isFirstWithdraw,
            met: isFirstWithdraw || validAvailable >= WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
        },
    });
}

// ── GET ?action=history — unchanged shape ──
async function handleHistory(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const withdrawals = db.collection('withdrawals');
    const list = await withdrawals
        .find({ userId: id, status: { $in: ['pending', 'approved'] } })
        .sort({ createdAt: -1 })
        .limit(30)
        .project({ userId: 0, username: 0 })
        .toArray();

    return res.status(200).json({ ok: true, history: list });
}

// ── POST — single-step withdraw create ──
async function handleCreate(req, res, db) {
    if (!WITHDRAWALS_OPEN) {
        return res.status(403).json({ ok: false, error: 'withdrawals_closed', message: 'Withdrawals are currently closed. Any previously submitted request will still be processed.' });
    }
    if (WITHDRAW_DAY_ONLY_FRIDAY && !isFridayBD()) {
        return res.status(403).json({ ok: false, error: 'not_friday', message: 'Withdrawals only open on Fridays. Come back this Friday to submit your request.' });
    }

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const { method, details } = req.body || {};
    const dcAmount = Math.floor(Number(req.body?.dcAmount));

    if (!method || !details) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!dcAmount || isNaN(dcAmount) || dcAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    if (dcAmount < MIN_WITHDRAW_DC) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum ${MIN_WITHDRAW_DC.toLocaleString()} DC (${MIN_WITHDRAW_IMPRESSIONS.toLocaleString()} impressions) required to withdraw.`,
        });
    }

    const methodConfig = WITHDRAW_METHODS[method];
    if (!methodConfig) return res.status(400).json({ ok: false, error: 'invalid_method' });

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    // ── lifetime tasks requirement (one-time, not daily) ──
    const tasksLifetime = (user.completedTasks || []).length;
    if (tasksLifetime < WITHDRAW_TASKS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'need_tasks',
            tasksRequired: WITHDRAW_TASKS_REQUIRED, tasksHave: tasksLifetime,
            message: `Complete at least ${WITHDRAW_TASKS_REQUIRED} tasks (lifetime, one-time) before you can withdraw (you have ${tasksLifetime} done).`,
        });
    }

    // ── daily ads requirement ──
    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    if (adsToday < WITHDRAW_ADS_REQUIRED) {
        return res.status(400).json({
            ok: false, error: 'insufficient_ads',
            adsRequired: WITHDRAW_ADS_REQUIRED, adsToday,
            message: `Watch ${WITHDRAW_ADS_REQUIRED} ads today before withdrawing (you have ${adsToday} today).`,
        });
    }

    // ── balance ──
    if ((user.dcBalance || 0) < dcAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${dcAmount.toLocaleString()} DC to withdraw this amount.` });
    }

    // ── referral gate: free on the very first withdrawal, otherwise 1 valid referral is consumed ──
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const willConsumeReferral = !isFirstWithdraw;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));
    if (willConsumeReferral && validAvailable < WITHDRAW_VALID_REFERRALS_PER_WITHDRAW) {
        return res.status(400).json({
            ok: false, error: 'referral_required',
            validReferralsAvailable: validAvailable, validReferralsNeeded: WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
            message: `Your first withdrawal was free. Every withdrawal after that needs 1 valid referral — refer a friend and wait for them to complete all 3 referral steps.`,
        });
    }

    const cpmRate = await getCpmRate(db);
    const { impressions, usdAmount } = calcPayout(dcAmount, cpmRate);
    if (impressions < MIN_WITHDRAW_IMPRESSIONS) {
        // Can happen if dcAmount is just above MIN_WITHDRAW_DC but rounds
        // down below the impression floor — extremely unlikely given
        // MIN_WITHDRAW_DC is derived from MIN_WITHDRAW_IMPRESSIONS, but
        // checked directly here in case DC_PER_IMPRESSION is ever changed
        // without updating MIN_WITHDRAW_DC to match.
        return res.status(400).json({ ok: false, error: 'below_minimum', message: `Minimum ${MIN_WITHDRAW_IMPRESSIONS.toLocaleString()} impressions required to withdraw.` });
    }

    const updateOps = {
        $inc: { dcBalance: -dcAmount, withdrawalCount: 1 },
        $set: { withdrawPending: true },
    };
    if (willConsumeReferral) updateOps.$inc.usedValidReferrals = 1;

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — balance, today's-reset boundary, ads, tasks, pending-flag,
    // and (if applicable) valid-referral availability are ALL re-verified
    // here in one atomic operation, closing the same race-condition class
    // the old system guarded against (e.g. Bangladesh-midnight boundary
    // resetting ads/tasks between the read above and this write, or a
    // double-tap firing two withdraws at once).
    // ══════════════════════════════════════════════════════════
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            dcBalance: { $gte: dcAmount },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            withdrawPending: { $ne: true },
            $expr: {
                $and: [
                    // ⚠️ CHANGED — tasks requirement re-verified here against the
                    // LIFETIME completedTasks array size, not a daily counter.
                    { $gte: [{ $size: { $ifNull: ['$completedTasks', []] } }, WITHDRAW_TASKS_REQUIRED] },
                    ...(willConsumeReferral ? [{
                        $gte: [
                            { $subtract: [{ $ifNull: ['$validReferralCount', 0] }, { $ifNull: ['$usedValidReferrals', 0] }] },
                            WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
                        ],
                    }] : []),
                ],
            },
        },
        updateOps,
        { returnDocument: 'after' }
    );

    if (!gate) {
        const stillPending = await users.findOne({ _id: id }, { projection: { withdrawPending: 1 } });
        if (stillPending?.withdrawPending) {
            return res.status(409).json({
                ok: false, error: 'withdraw_already_pending',
                message: 'You already have a withdrawal request being processed. Please wait for it to be approved or rejected before submitting another.',
            });
        }
        return res.status(409).json({
            ok: false, error: 'gate_failed',
            message: 'Could not process the withdrawal — your balance, ad/task progress, or referral status may have changed. Please refresh and try again.',
        });
    }

    const withdrawals = db.collection('withdrawals');
    const withdrawDoc = {
        userId: id,
        username: verified.user.username || null,
        method,
        details,
        dcAmount,
        impressions,
        cpmRateAtRequest: cpmRate,
        cashAmount: usdAmount,        // kept name — api/bot.js reads this for admin/approve/reject messages
        currency: methodConfig.currency,
        referralConsumed: willConsumeReferral,
        status: 'pending',
        createdAt: new Date(),
    };
    const inserted = await withdrawals.insertOne(withdrawDoc);

    // ══════════════════════════════════════════════════════════
    // Referral withdrawal commission. If this user was referred by
    // someone, the referrer is credited WITHDRAW_REFERRAL_COMMISSION_PERCENT
    // (10%) of the GROSS dcAmount just withdrawn, directly as DC — e.g. a
    // 10,000 DC withdrawal pays the referrer 1,000 DC. This fires on EVERY
    // withdrawal, not just once, for as long as the referral relationship
    // exists (see constants.js for the fraud/economics trade-offs flagged
    // there). Runs as a best-effort follow-up update — it does not block or
    // roll back the withdrawal itself if it fails, and a banned referrer is
    // skipped.
    // ══════════════════════════════════════════════════════════
    let referrerCommission = 0;
    if (user.referredBy) {
        referrerCommission = Math.floor(dcAmount * (WITHDRAW_REFERRAL_COMMISSION_PERCENT / 100));
        if (referrerCommission > 0) {
            try {
                const referrerUpdate = await users.findOneAndUpdate(
                    { _id: user.referredBy, isBanned: { $ne: true } },
                    { $inc: { dcBalance: referrerCommission, lifetimeDcEarned: referrerCommission, referralCommissionEarned: referrerCommission } },
                    { returnDocument: 'after' }
                );
                if (referrerUpdate) {
                    tgSend(
                        user.referredBy,
                        `💰 <b>Referral Commission!</b>\n\nOne of your referrals just withdrew ${dcAmount.toLocaleString()} DC.\nYou earned <b>${referrerCommission.toLocaleString()} DC</b> (10% commission) 🎉`
                    ).catch(() => {});
                }
            } catch (e) { /* non-blocking — commission failure never blocks the withdrawal itself */ }
        }
    }
    // Record the commission (if any) on the withdrawal doc for admin audit trail.
    await withdrawals.updateOne(
        { _id: inserted.insertedId },
        { $set: { referrerId: user.referredBy || null, referrerCommissionPaid: referrerCommission } }
    );

    if (ADMIN_ID) {
        const adminText =
            `💸 <b>New Withdraw Request</b>\n\n` +
            `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + verified.user.username + ')' : ''}\n` +
            `🪙 DC: <b>${dcAmount.toLocaleString()}</b> (${impressions.toLocaleString()} impressions)\n` +
            `📈 CPM used: <b>$${cpmRate}</b> / 1K impressions\n` +
            `💰 Amount: <b>$${usdAmount.toFixed(4)} ${methodConfig.currency}</b>\n` +
            `📤 Method: <b>${methodConfig.label}</b>\n` +
            `📍 Address: <code>${details}</code>\n` +
            `📊 Total withdrawals so far: <b>${user.withdrawalCount || 0}</b>\n` +
            `👥 Total referrals: <b>${user.referralCount || 0}</b>\n` +
            `📅 ${withdrawDoc.createdAt.toLocaleString()}\n` +
            `🆔 Request: <code>${inserted.insertedId}</code>`;
        tgSend(ADMIN_ID, adminText, { reply_markup: { inline_keyboard: [[
            { text: '✅ Approve', callback_data: `wd_approve_${inserted.insertedId}` },
            { text: '❌ Reject', callback_data: `wd_reject_${inserted.insertedId}` },
        ]] } }).catch(() => {});
    }

    return res.status(200).json({
        ok: true,
        withdrawId: inserted.insertedId,
        dcAmount, impressions, usdAmount,
        newDcBalance: gate.dcBalance,
        status: 'pending',
    });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        if (action === 'history') return handleHistory(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
                                     }
