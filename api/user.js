// api/user.js — CONSOLIDATED + SECURITY FIX (Telegram initData verification)
//
// Key change: previously the client-supplied userId was trusted as-is — anyone
// could open browser DevTools, call the API directly, and pass someone else's
// userId. Now every request requires Telegram's `initData` (a signed string)
// which the server verifies cryptographically — nobody can forge it without
// the bot token, so userId can no longer be spoofed.
//
//   POST /api/user   body: { action: 'init', initData, fingerprint }
//   GET  /api/user?action=checkJoin&initData=...
//   GET  /api/user?action=profile&initData=...

import { connectToDatabase } from '../lib/mongodb.js';
import { todayBD } from '../lib/constants.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { checkAndRecordFingerprint } from '../lib/fingerprintCheck.js';
import { isMember, OFFICIAL_CHANNEL, COMMUNITY_GROUP } from '../lib/telegram.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { getClientIp, checkDevice, claimDevice, claimDeviceForUser, getOwnerPublicInfo } from '../lib/ipRegistry.js';

async function handleInit(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });

    const userId = String(verified.user.id);
    const firstName = verified.user.first_name;
    const username = verified.user.username;
    const referrerCode = verified.startParam; // ✅ comes from verified initData — client can't send a different one separately
    const { fingerprint } = req.body;

    // ── Season 4: device-fingerprint gate (IP kept only as fallback — see
    // lib/ipRegistry.js), checked on EVERY init (new or returning user)
    // since the client calls action:init on every app boot. A different
    // account already owning this device blocks entry outright — the
    // client shows the "Device Already In Use" screen with the owner's
    // public info and lets the person log into that account, or force-claim
    // this device for their own (resets balance).
    const clientIp = getClientIp(req);
    const deviceCheck = await checkDevice(db, fingerprint, clientIp, userId);
    if (deviceCheck.blocked) {
        const owner = await getOwnerPublicInfo(db, deviceCheck.ownerId);
        return res.status(409).json({ ok: false, error: 'ip_in_use', owner });
    }

    const users = db.collection('users');
    const existing = await users.findOne({ _id: userId });
    if (existing) {
        if (deviceCheck.unclaimed) await claimDevice(db, deviceCheck.key, userId); // link a fresh device to a returning user
        // ⚠️ NEW — refresh the "still alive" clock every time the app opens.
        // Powers the 90-day dead-account TTL below: 3 months with the app
        // never once opened and the whole doc auto-deletes (see
        // models/schema.js). If this same Telegram ID opens the app again
        // after that, `existing` here comes back null and they fall straight
        // into the newUser branch below — a genuinely fresh account, same as
        // if they'd never used the app at all.
        await users.updateOne({ _id: userId }, { $set: { lastActiveAt: new Date() } });
        return res.status(200).json({ ok: true, alreadyExists: true });
    }

    // Two different auto-deletes can land a returning Telegram ID here with
    // `existing === null` even though they've used the app before:
    //   1) a banned user's doc, 60 days after bannedAt (see models/schema.js) — the
    //      stillBanned check right below catches this via the separate,
    //      never-expiring `bannedTelegramIds` registry, so the ban still holds.
    //   2) a genuinely inactive user's doc, 90 days after lastActiveAt (also
    //      models/schema.js) — NOT banned, so nothing blocks them below: they
    //      fall straight into creating newUser and get a real fresh start,
    //      which is the intended behavior for a "dead" (not banned) account.
    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const newUser = {
        _id: userId,
        firstName: firstName || 'User',
        telegramUsername: username || 'N/A',
        dcBalance: 0,
        usdtBalance: 0,
        lifetimeDcEarned: 0,
        impressionBalance: 0,       // ⚠️ NEW — withdraw-only currency, gained exclusively via Convert (api/convert.js)
        lastConvertDate: null,      // ⚠️ NEW — Bangladesh calendar date of the last successful Convert, enforces the once-a-day limit
        referralCount: 0,
        weeklyReferralCount: 0,
        totalInvites: 0,
        referredBy: (referrerCode && referrerCode !== userId) ? String(referrerCode) : null,
        referralStep1Done: false,
        referralStep2Done: false,
        referralStep3Done: false,
        completedTasks: [],
        isBanned: false,
        channelVerified: false,
        withdrawalCount: 0,
        lastWithdrawDate: '',
        lifetimeAdsWatched: 0,
        adsWatchedToday: 0,
        adsgramDailyCountToday: 0,
        monetagCountToday: 0,
        gigaCountToday: 0,
        uslCountToday: 0,
        usedAdStarts: [],
        usedTaskStarts: [],
        usedGameStarts: [],
        gameHighScore: 0, // best Surf Drive run distance ("meters") — powers the Home top-scorers leaderboard
        tasksCompletedToday: 0,
        lastResetDate: todayBD(),
        welcomeBonusClaimed: false,
        createdAt: new Date(),
        lastActiveAt: new Date(), // ⚠️ NEW — see the dead-account TTL note above / models/schema.js
        multiAccountFlag: false,
        multiAccountSiblings: [],
        validReferralCount: 0,      // +1 when a referral completes all 3 steps (lib/referral.js)
        usedValidReferrals: 0,      // +1 each withdraw after the user's first (free) one
    };

    try {
        await users.insertOne(newUser);
    } catch (err) {
        if (err.code === 11000) return res.status(200).json({ ok: true, alreadyExists: true });
        throw err;
    }

    if (newUser.referredBy) {
        await users.updateOne({ _id: newUser.referredBy }, { $inc: { referralCount: 1, weeklyReferralCount: 1, totalInvites: 1 } });
    }

    await claimDevice(db, deviceCheck.key, userId); // first account on this device — claim it

    // ⚠️ CHANGED — checkAndRecordFingerprint (lib/fingerprintCheck.js) now
    // auto-suspends THIS account itself (isBanned:true + bannedTelegramIds
    // registry) the moment a duplicate-device match is found, instead of
    // only setting multiAccountFlag for later admin review. See that file
    // for the full reasoning/trade-off note. The ORIGINAL (first) account on
    // that device is never touched by this — only the newly-created one.
    const fpResult = await checkAndRecordFingerprint(db, userId, fingerprint);
    return res.status(200).json({ ok: true, created: true, multiAccountFlagged: fpResult.flagged });
}

// Season 4 "Switch account" — the way forward from the device-in-use block
// screen besides logging into the account that already owns this device.
// Force-claims the device key (fingerprint, or IP as fallback — see
// lib/ipRegistry.js:registryKey) for the CALLER's Telegram account and wipes
// their balance as the anti-abuse cost of doing so. See
// lib/ipRegistry.js:claimDeviceForUser for exactly what gets reset.
async function handleSwitchAccount(req, res, db) {
    const initData = req.body?.initData;
    const verified = verifyTelegramInitData(initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);
    const { fingerprint } = req.body;

    const stillBanned = await db.collection('bannedTelegramIds').findOne({ _id: userId });
    if (stillBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const existing = await db.collection('users').findOne({ _id: userId });
    if (!existing) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const clientIp = getClientIp(req);
    const key = fingerprint && fingerprint.length >= 16 ? fingerprint : `ip:${clientIp}`;
    await claimDeviceForUser(db, key, userId);
    return res.status(200).json({ ok: true, switched: true });
}

async function handleCheckJoin(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ joined: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    try {
        const [inChannel, inGroup] = await Promise.all([
            isMember(userId, OFFICIAL_CHANNEL),
            isMember(userId, COMMUNITY_GROUP),
        ]);
        const joined = inChannel && inGroup;

        if (joined) {
            try {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: true } });
                await maybeAwardReferralMilestones(db, userId, { channelVerified: true });
            } catch { /* non-blocking */ }
        } else {
            const existing = await db.collection('users').findOne({ _id: userId }, { projection: { channelVerified: 1 } });
            if (existing?.channelVerified) {
                await db.collection('users').updateOne({ _id: userId }, { $set: { channelVerified: false } });
                return res.status(200).json({ joined: false, inChannel, inGroup, leftAfterVerifying: true });
            }
        }

        return res.status(200).json({ joined, inChannel, inGroup });
    } catch (err) {
        console.error('checkJoin error:', err);
        return res.status(200).json({ joined: true, error: 'check_failed' });
    }
}

async function handleProfile(req, res, db) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const verified = verifyTelegramInitData(req.query.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });

    const { multiAccountSiblings, multiAccountFingerprint, ...safeUser } = user;
    return res.status(200).json({ ok: true, user: safeUser });
}

export default async function handler(req, res) {
    const { db } = await connectToDatabase();

    if (req.method === 'POST') {
        const { action } = req.body || {};
        if (action === 'init') return handleInit(req, res, db);
        if (action === 'switchAccount') return handleSwitchAccount(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    if (req.method === 'GET') {
        const { action } = req.query;
        if (action === 'checkJoin') return handleCheckJoin(req, res, db);
        if (action === 'profile') return handleProfile(req, res, db);
        return res.status(400).json({ ok: false, error: 'unknown_action' });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
}
