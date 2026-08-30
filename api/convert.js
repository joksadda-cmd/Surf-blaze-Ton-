// api/convert.js — DC → IMPRESSION CONVERT (⚠️ NEW)
//
// Withdrawals are impression-only (see api/withdraw.js) — this is the ONLY
// way a user gets impressions. They pick a DC amount from their dcBalance,
// a flat CONVERT_FEE_PERCENT fee is taken straight out of that DC amount
// (the fee portion is simply never converted — it's gone, same as any
// exchange fee), and the remainder becomes impressions at the fixed
// DC_PER_IMPRESSION ratio used everywhere else in the app. Limited to
// CONVERT_DAILY_LIMIT (currently 1) successful conversions per Bangladesh
// calendar day.
//
//   GET  /api/convert?action=status&initData=...   → balances + eligibility, for rendering the Convert screen
//   POST /api/convert   body: { initData, dcAmount }

import { connectToDatabase } from '../lib/mongodb.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    CONVERT_MIN_DC, CONVERT_MAX_DC, CONVERT_FEE_PERCENT, CONVERT_DAILY_LIMIT,
    DC_PER_IMPRESSION, todayBD,
} from '../lib/constants.js';

// dcAmount → { feeDc, netDc, impressionsGained }. Pulled out so both the
// status preview (if ever needed) and the real create path compute this
// identically — one place, one formula.
function calcConvert(dcAmount) {
    const feeDc = Math.round(dcAmount * (CONVERT_FEE_PERCENT / 100));
    const netDc = dcAmount - feeDc;
    const impressionsGained = Math.floor(netDc / DC_PER_IMPRESSION);
    return { feeDc, netDc, impressionsGained };
}

// ── GET ?action=status — everything the Convert screen needs in one call ──
async function handleStatus(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    // CONVERT_DAILY_LIMIT is currently 1, so "used today" is just a
    // yes/no against lastConvertDate — this still works correctly if the
    // limit is ever raised above 1, EXCEPT it would need a real per-day
    // counter instead of a single date at that point (flagged here so
    // future-you doesn't have to rediscover this).
    const usedToday = user.lastConvertDate === today ? 1 : 0;

    return res.status(200).json({
        ok: true,
        dcBalance: user.dcBalance || 0,
        impressionBalance: user.impressionBalance || 0,
        dcPerImpression: DC_PER_IMPRESSION,
        minDc: CONVERT_MIN_DC,
        maxDc: CONVERT_MAX_DC,
        feePercent: CONVERT_FEE_PERCENT,
        dailyLimit: CONVERT_DAILY_LIMIT,
        usedToday,
        canConvertToday: usedToday < CONVERT_DAILY_LIMIT,
    });
}

// ── POST — single-step convert ──
async function handleCreate(req, res, db) {
    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const id = String(verified.user.id);

    const dcAmount = Math.floor(Number(req.body?.dcAmount));
    if (!dcAmount || isNaN(dcAmount) || dcAmount <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_amount' });
    }
    if (dcAmount < CONVERT_MIN_DC) {
        return res.status(400).json({
            ok: false, error: 'below_minimum',
            message: `Minimum ${CONVERT_MIN_DC.toLocaleString()} DC per conversion.`,
        });
    }
    if (dcAmount > CONVERT_MAX_DC) {
        return res.status(400).json({
            ok: false, error: 'above_maximum',
            message: `Maximum ${CONVERT_MAX_DC.toLocaleString()} DC per conversion.`,
        });
    }

    const users = db.collection('users');
    const today = await ensureDailyReset(users, id);
    const user = await users.findOne({ _id: id });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    if (user.lastConvertDate === today) {
        return res.status(429).json({
            ok: false, error: 'daily_limit_reached',
            message: `You can only convert once per day. Come back tomorrow.`,
        });
    }
    if ((user.dcBalance || 0) < dcAmount) {
        return res.status(400).json({ ok: false, error: 'insufficient_balance', message: `You need ${dcAmount.toLocaleString()} DC to convert this amount.` });
    }

    const { feeDc, netDc, impressionsGained } = calcConvert(dcAmount);
    if (impressionsGained <= 0) {
        // Can only happen right at the CONVERT_MIN_DC floor if
        // CONVERT_FEE_PERCENT/DC_PER_IMPRESSION are ever changed without
        // re-checking the floor still clears 1 whole impression after the
        // fee — defensive, shouldn't trigger with the current numbers.
        return res.status(400).json({
            ok: false, error: 'amount_too_small',
            message: `That amount converts to 0 impressions after the ${CONVERT_FEE_PERCENT}% fee — try a larger amount.`,
        });
    }

    // ══════════════════════════════════════════════════════════
    // ATOMIC GATE — balance, today's-reset boundary, and the once-per-day
    // limit are ALL re-verified here in one atomic operation, closing the
    // race where two convert requests fire back-to-back before either
    // one's read above is reflected (e.g. a double-tap firing two
    // conversions, or the Bangladesh-midnight boundary shifting between
    // the read above and this write).
    // ══════════════════════════════════════════════════════════
    const gate = await users.findOneAndUpdate(
        {
            _id: id,
            isBanned: { $ne: true },
            dcBalance: { $gte: dcAmount },
            lastResetDate: today,
            lastConvertDate: { $ne: today },
        },
        {
            $inc: { dcBalance: -dcAmount, impressionBalance: impressionsGained },
            $set: { lastConvertDate: today },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const fresh = await users.findOne({ _id: id }, { projection: { lastConvertDate: 1 } });
        if (fresh?.lastConvertDate === today) {
            return res.status(429).json({
                ok: false, error: 'daily_limit_reached',
                message: `You can only convert once per day. Come back tomorrow.`,
            });
        }
        return res.status(409).json({
            ok: false, error: 'gate_failed',
            message: 'Could not process the conversion — your balance may have changed. Please refresh and try again.',
        });
    }

    return res.status(200).json({
        ok: true,
        dcConverted: dcAmount,
        feeDc,
        netDc,
        impressionsGained,
        newDcBalance: gate.dcBalance,
        newImpressionBalance: gate.impressionBalance,
    });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'status') return handleStatus(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'POST') {
        return handleCreate(req, res, db);
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
