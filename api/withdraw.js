// api/withdraw.js — USDT-DIRECT WITHDRAW (⚠️ CHANGED — withdraw now spends
// from usdtBalance, which is ONLY ever filled by Convert (api/convert.js —
// DC → USDT at the fixed DC_PER_USD rate, minus CONVERT_FEE_PERCENT). A
// user can no longer withdraw DC directly; they must Convert first.
//
// A user types a USD amount straight from their usdtBalance (minimum
// MIN_WITHDRAW_USDT), picks a method (Binance UID / Tonkeeper), and
// submits. No further conversion happens here — it's already USDT. No fee
// is taken on withdraw itself (the only fee in this whole DC→USDT→cash
// pipeline is the Convert fee, already paid at the Convert step).
//
// ⚠️ Weekly-Friday-only submission window — withdraw requests are only
// accepted when isFridayBD() is true — "airdrop-style," once a week,
// Bangladesh time. Approving/rejecting an already-submitted request from
// the bot is NOT restricted to Fridays — only the user-facing submission is.
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
//   GET  /api/withdraw?action=status&initData=...   → USDT balance + full eligibility snapshot (includes isFridayToday)
//   GET  /api/withdraw?action=history&initData=...
//   POST /api/withdraw   body: { initData, method, details, usdtAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { tgSend } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    WITHDRAW_METHODS, DC_PER_USD, MIN_WITHDRAW_USDT,
    WITHDRAW_TASKS_REQUIRED, WITHDRAW_ADS_REQUIRED, WITHDRAW_VALID_REFERRALS_PER_WITHDRAW,
    WITHDRAW_DAY_ONLY_FRIDAY,
    todayBD, isFridayBD, WITHDRAWALS_OPEN,
} from '../lib/constants.js';

const ADMIN_ID = process.env.ADMIN_ID;

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

    const adsToday = user.lastResetDate === today ? (user.adsWatchedToday || 0) : 0;
    // ⚠️ Tasks requirement is LIFETIME, one-time (not daily). Once
    // completedTasks.length ever reaches WITHDRAW_TASKS_REQUIRED, this
    // stays satisfied forever — no daily reset involved.
    const tasksLifetime = (user.completedTasks || []).length;
    const isFirstWithdraw = (user.withdrawalCount || 0) === 0;
    const validAvailable = Math.max(0, (user.validReferralCount || 0) - (user.usedValidReferrals || 0));

    return res.status(200).json({
        ok: true,
        dcBalance: user.dcBalance || 0,       // shown for context only — Convert first, see api/convert.js
        usdtBalance: user.usdtBalance || 0,   // this is what's actually withdrawable
        dcPerUsd: DC_PER_USD,
        minWithdrawUsdt: MIN_WITHDRAW_USDT,
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
    const usdtAmount = Number(req.body?.usdtAmount);

    if (!method || !details) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!usdtAmount || isNaN(usdtAmount) || usdtAmount <= 0) return res.status(400).json({ ok: false, error: 'invalid_amount' });
    if (usdtAmount < MIN_WITHDRAW_USDT) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum $${MIN_WITHDRAW_USDT} required to withdraw.`,
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

    // ── balance — usdtBalance now, not dcBalance ──
    if ((user.usdtBalance || 0) < usdtAmount) {
        return res.status(400).json({
            ok: false, error: 'insufficient_balance',
            message: `You need $${usdtAmount.toFixed(4)} USDT to withdraw this amount. Convert some DC first.`,
        });
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

    // Kept purely for admin/audit display + the referral commission calc
    // in api/bot.js — never itself a real balance.
    const dcEquivalent = Math.round(usdtAmount * DC_PER_USD);

    const updateOps = {
        $inc: { usdtBalance: -usdtAmount, withdrawalCount: 1 },
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
            usdtBalance: { $gte: usdtAmount },
            lastResetDate: today,
            adsWatchedToday: { $gte: WITHDRAW_ADS_REQUIRED },
            withdrawPending: { $ne: true },
            $expr: {
                $and: [
                    // ⚠️ Tasks requirement re-verified here against the
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
            message: 'Could not process the withdrawal — your USDT balance, ad/task progress, or referral status may have changed. Please refresh and try again.',
        });
    }

    const withdrawals = db.collection('withdrawals');
    const withdrawDoc = {
        userId: id,
        username: verified.user.username || null,
        method,
        details,
        usdtAmount,             // ⚠️ this is what's actually debited/refunded now
        dcEquivalent,           // display/audit/commission-calc only — never itself a real balance
        cashAmount: usdtAmount, // kept name — api/bot.js reads this for admin/approve/reject messages
        currency: methodConfig.currency,
        referralConsumed: willConsumeReferral,
        status: 'pending',
        createdAt: new Date(),
    };
    const inserted = await withdrawals.insertOne(withdrawDoc);

    // Referral commission fires only on actual APPROVAL — see
    // api/bot.js's finalizeWithdrawal — not here at request time, so a
    // later rejection never needs a claw-back.
    await withdrawals.updateOne(
        { _id: inserted.insertedId },
        { $set: { referrerId: user.referredBy || null, referrerCommissionPaid: 0 } }
    );

    if (ADMIN_ID) {
        const adminText =
            `💸 <b>New Withdraw Request</b>\n\n` +
            `👤 User: <code>${id}</code>${verified.user.username ? ' (@' + verified.user.username + ')' : ''}\n` +
            `💰 Amount: <b>$${usdtAmount.toFixed(4)} ${methodConfig.currency}</b> (≈ ${dcEquivalent.toLocaleString()} DC)\n` +
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
        usdtAmount, dcEquivalent,
        newUsdtBalance: gate.usdtBalance,
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
