// api/earn.js — SURF BLAZE
//
//   { action: 'taskStart',      initData, taskId }                       — issues a short-lived signed token when a task sheet opens
//   { action: 'taskComplete',   initData, taskId, startTime?, signature? } — startTime/signature required for non-API-verified tasks
//   { action: 'claimPromo',     initData, code }
//   { action: 'adStart',        initData, network }                       — Game tab's "Earn" button, issues a token before the ad SDK is called
//   { action: 'claimAdReward',  initData, network, startTime, signature }
//   { action: 'gameStart',       initData }                                                    — issued right before the Surf Drive overlay opens
//   { action: 'claimGameReward', initData, startTime, signature, coins, distance }              — coins → DC reward; distance → lifetime best-score (leaderboard)
//
// Every request requires a verified Telegram initData — the userId is
// always taken from that, never trusted from the client body directly.
// The old 777-lottery / video-watch / lootbox paths are still fully gone —
// only tasks, promo codes, the 4-network ad-watch button, and Surf Drive
// remain.

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { isMember } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import {
    TASK_MIN_WAIT_SECONDS, AD_NETWORK_REWARDS, AD_MIN_WATCH_SECONDS, AD_COOLDOWN_SECONDS,
    MINING_DURATION_MS, MINING_REWARD_DC,
    GAME_MIN_PLAY_SECONDS, GAME_TOKEN_MAX_AGE_SECONDS, GAME_COINS_TO_DC,
    GAME_MAX_COINS_PER_SECOND, GAME_MAX_REWARD_DC, GAME_MAX_DISTANCE_PER_SECOND,
} from '../lib/constants.js';
import crypto from 'crypto';

const SECRET = process.env.ACTION_SIGNING_SECRET; // ⚠️ RENAMED (was VIDEO_SIGNING_SECRET — no video feature exists anymore, name was pure leftover) — signs short-lived task/ad action tokens. You must set this env var on Vercel (any long random string) or every task/ad claim will fail with "server_misconfigured".

// Task-claim tokens are namespaced with 'task:' + the taskId, so a token
// issued for one task can never be replayed to claim a different one.
const signTaskStart = (userId, taskId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`task:${userId}:${taskId}:${startTime}`).digest('hex');

// Ad-claim tokens are namespaced with 'ad:' + the network, same reasoning.
const signAdStart = (userId, network, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`ad:${userId}:${network}:${startTime}`).digest('hex');

// Game-run tokens are namespaced with 'game:' — same idea, own namespace.
const signGameStart = (userId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`game:${userId}:${startTime}`).digest('hex');

// A multi-account-flagged user earns no NEW DC until they verify channel +
// community membership. Progress/counters still advance normally.
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

// ── adStart ── issued the instant the user taps "Earn" and picks a network,
// before the ad SDK is even called. No DB write, no reward — just a
// signature the client must carry through the real ad flow and hand back to
// claimAdReward. A script that skips straight to claimAdReward with no
// token (or a stale/forged one) is rejected outright.
async function handleAdStart(req, res, db, userId) {
    const { network } = req.body;
    const netConfig = AD_NETWORK_REWARDS[network];
    if (!netConfig) return res.status(400).json({ ok: false, error: 'invalid_network' });
    if (netConfig.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });

    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signAdStart(userId, network, startTime) });
}

const AD_COUNTER_FIELD = {
    adsgramDaily: 'adsgramDailyCountToday',
    monetag: 'monetagCountToday',
    giga: 'gigaCountToday',
    usl: 'uslCountToday',
};

// ── claimAdReward ──
async function handleClaimAdReward(req, res, db, userId) {
    const { network, startTime, signature } = req.body;
    const config = AD_NETWORK_REWARDS[network];
    if (!config) return res.status(400).json({ ok: false, error: 'invalid_network' });
    if (config.enabled === false) return res.status(400).json({ ok: false, error: 'coming_soon' });

    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_ad_token' });
    if (signAdStart(userId, network, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_ad_token' });
    }
    // A genuine ad SDK flow always takes real wall-clock time (loading +
    // showing the ad) — an instant claim right after adStart means no ad
    // was actually shown.
    if (elapsedSeconds < AD_MIN_WATCH_SECONDS) {
        return res.status(400).json({ ok: false, error: 'watch_time_too_short' });
    }
    // Token also expires after 5 minutes — prevents stockpiling pre-signed
    // tokens ahead of time and burning through them later in a burst.
    if (elapsedSeconds > 300) {
        return res.status(400).json({ ok: false, error: 'ad_token_expired' });
    }

    const users = db.collection('users');
    const counterField = AD_COUNTER_FIELD[network];
    await ensureDailyReset(users, userId);

    // Reject if the user's last successful ad claim (any network) was less
    // than AD_COOLDOWN_SECONDS ago — so a script can't fire
    // adStart→claimAdReward back-to-back with zero pacing between ads.
    const cooldownCutoff = new Date(Date.now() - AD_COOLDOWN_SECONDS * 1000);

    // The token itself is single-use: `${network}:${startTime}` is
    // atomically checked-and-recorded in `usedAdStarts` in the very same
    // update that credits the reward. Replaying the exact same token twice
    // earns nothing the second time.
    const adStartKey = `${network}:${startTime}`;
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            [counterField]: { $lt: config.dailyLimit },
            usedAdStarts: { $ne: adStartKey },
            $or: [{ lastAdClaimAt: { $exists: false } }, { lastAdClaimAt: { $lte: cooldownCutoff } }],
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { dcBalance: config.reward, lifetimeDcEarned: config.reward, lifetimeAdsWatched: 1, adsWatchedToday: 1, [counterField]: 1 },
            $addToSet: { usedAdStarts: adStartKey },
            $set: { lastAdClaimAt: new Date() },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, [counterField]: 1, usedAdStarts: 1, lastAdClaimAt: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedAdStarts || []).includes(adStartKey)) return res.status(400).json({ ok: false, error: 'ad_token_already_used' });
        if (exists.lastAdClaimAt && new Date(exists.lastAdClaimAt) > cooldownCutoff) return res.status(400).json({ ok: false, error: 'cooldown', retryAfterSeconds: AD_COOLDOWN_SECONDS });
        if ((exists[counterField] || 0) >= config.dailyLimit) return res.status(400).json({ ok: false, error: 'daily_limit_reached' });
        if (exists.multiAccountFlag && !exists.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        return res.status(400).json({ ok: false, error: 'claim_failed' });
    }

    return res.status(200).json({ ok: true, rewardDc: config.reward, network });
}

// ── gameStart ── issued the instant the "Play Surf Drive" button is tapped
// (Home or Game tab), before the game.html iframe even opens. Same idea as
// adStart: no DB write, no reward yet — just a signature the game overlay's
// host carries through the run and hands back to claimGameReward when the
// player crashes.
async function handleGameStart(req, res, db, userId) {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signGameStart(userId, startTime) });
}

// ── claimGameReward ── called once per run, right after "surfdrive:gameover"
// fires inside the game iframe. `coins` (drop-coins collected, converts to
// DC) and `distance` (in-game meters travelled, the leaderboard score) are
// both self-reported by the client, so everything here is about not
// trusting them blindly: the signed token proves a real gameStart happened,
// elapsed wall-clock time bounds how much could plausibly have been
// collected/travelled, and the token itself is single-use.
async function handleClaimGameReward(req, res, db, userId) {
    const { startTime, signature, coins, distance } = req.body;
    if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_game_token' });
    if (signGameStart(userId, startTime) !== signature) {
        return res.status(400).json({ ok: false, error: 'invalid_game_token' });
    }

    const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
    if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_game_token' });
    }
    if (elapsedSeconds > GAME_TOKEN_MAX_AGE_SECONDS) {
        return res.status(400).json({ ok: false, error: 'game_token_expired' });
    }
    // A genuine run always takes real wall-clock time — an instant claim
    // right after gameStart means no run actually happened. A too-short run
    // just earns nothing (not an error) — see the frontend's handling of
    // this specific error code.
    if (elapsedSeconds < GAME_MIN_PLAY_SECONDS) {
        return res.status(400).json({ ok: false, error: 'play_time_too_short' });
    }

    const coinsNum = Number(coins);
    const distanceNum = Number(distance);
    if (!Number.isFinite(coinsNum) || coinsNum < 0 || !Number.isFinite(distanceNum) || distanceNum < 0) {
        return res.status(400).json({ ok: false, error: 'invalid_score' });
    }

    // Sanity ceilings — cap whatever the client reported to what's plausible
    // given how long the run actually lasted, then cap the resulting reward
    // to a hard per-run maximum on top of that. A forged/huge value just
    // gets clamped down instead of trusted outright.
    const cappedCoins = Math.min(coinsNum, elapsedSeconds * GAME_MAX_COINS_PER_SECOND);
    const cappedDistance = Math.min(distanceNum, elapsedSeconds * GAME_MAX_DISTANCE_PER_SECOND);
    const rewardDc = Math.min(GAME_MAX_REWARD_DC, Math.max(0, Math.round(cappedCoins * GAME_COINS_TO_DC)));

    const users = db.collection('users');
    await ensureDailyReset(users, userId);

    // The token is single-use: `${startTime}` is atomically checked-and-
    // recorded in `usedGameStarts` in the very same update that credits the
    // reward and (via $max) raises the lifetime best score if this run beat
    // it. Replaying the exact same token twice earns nothing the second time.
    const gameStartKey = String(startTime);
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            isBanned: { $ne: true },
            usedGameStarts: { $ne: gameStartKey },
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { dcBalance: rewardDc, lifetimeDcEarned: rewardDc },
            $addToSet: { usedGameStarts: gameStartKey },
            $max: { gameHighScore: Math.floor(cappedDistance) },
        },
        { returnDocument: 'after' }
    );

    if (!gate) {
        const exists = await users.findOne({ _id: userId }, { projection: { isBanned: 1, usedGameStarts: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!exists) return res.status(404).json({ ok: false, error: 'user_not_found' });
        if (exists.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
        if ((exists.usedGameStarts || []).includes(gameStartKey)) return res.status(400).json({ ok: false, error: 'game_token_already_used' });
        if (exists.multiAccountFlag && !exists.channelVerified) return res.status(403).json({ ok: false, error: 'account_under_review' });
        return res.status(400).json({ ok: false, error: 'claim_failed' });
    }

    return res.status(200).json({ ok: true, rewardDc, gameHighScore: gate.gameHighScore || 0 });
}

// ── taskStart ── issued the instant the user taps "Start" on a task, before
// they even leave the app for the link. Not required for API-verified
// (channel-join) tasks — real Telegram membership is proof enough on its own.
async function handleTaskStart(req, res, db, userId) {
    const { taskId } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });
    if (!SECRET) return res.status(500).json({ ok: false, error: 'server_misconfigured' });
    const startTime = Date.now();
    return res.status(200).json({ ok: true, startTime, signature: signTaskStart(userId, taskId, startTime) });
}

// ── taskComplete ──
// Claiming the task's "slot" (limit check + increment) is atomic, and if
// crediting the user afterward fails (double-click race, or the
// multi-account review gate), the slot is rolled back.
//
// For every category except an API-verified (channel-join) task, a signed
// taskStart token is required — proves at least TASK_MIN_WAIT_SECONDS
// passed since the task sheet opened, and the token is single-use
// (usedTaskStarts, atomic). This doesn't prove the linked page was actually
// read, but it closes "claim every task in under a second via direct API
// calls" — the actual thing this guards against.
async function handleTaskComplete(req, res, db, userId) {
    const { taskId, startTime, signature } = req.body;
    if (!taskId) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const users = db.collection('users');
    const tasks = db.collection('tasks');
    await ensureDailyReset(users, userId);

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if ((user.completedTasks || []).includes(taskId)) return res.status(200).json({ ok: false, alreadyDone: true });

    let taskObjId;
    try { taskObjId = new ObjectId(taskId); } catch { return res.status(400).json({ ok: false, error: 'invalid_task_id' }); }

    const task = await tasks.findOne({ _id: taskObjId });
    if (!task || !task.isApproved) return res.status(404).json({ ok: false, error: 'task_not_found' });

    let taskStartKey = null;
    // Any task can be marked verifyType: 'api' from the admin panel to
    // require real Telegram channel/group membership instead of a link click.
    const isApiVerified = task.verifyType === 'api' || (!task.verifyType && task.category === 'channel');
    if (isApiVerified) {
        const member = await isMember(userId, task.channelId);
        if (!member) return res.status(200).json({ ok: false, error: 'not_member' });
    } else {
        if (!startTime || !signature) return res.status(400).json({ ok: false, error: 'missing_task_token' });
        if (signTaskStart(userId, taskId, startTime) !== signature) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        const elapsedSeconds = (Date.now() - Number(startTime)) / 1000;
        if (isNaN(elapsedSeconds) || elapsedSeconds < 0) {
            return res.status(400).json({ ok: false, error: 'invalid_task_token' });
        }
        if (elapsedSeconds < TASK_MIN_WAIT_SECONDS) {
            return res.status(400).json({ ok: false, error: 'claimed_too_fast' });
        }
        if (elapsedSeconds > 300) {
            return res.status(400).json({ ok: false, error: 'task_token_expired' });
        }
        if ((user.usedTaskStarts || []).includes(`${taskId}:${startTime}`)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        taskStartKey = `${taskId}:${startTime}`;
    }

    // STEP 1 — atomically claim the task's "slot" (shared, limited quota
    // across ALL users — intentionally not gated by REWARD_ELIGIBLE_FILTER;
    // a failed claim below correctly gives the slot back).
    const taskGate = await tasks.findOneAndUpdate(
        { _id: taskObjId, $or: [{ limit: { $lte: 0 } }, { limit: { $exists: false } }, { $expr: { $lt: ['$completionCount', '$limit'] } }] },
        { $inc: { completionCount: 1 } },
        { returnDocument: 'after' }
    );
    if (!taskGate) return res.status(400).json({ ok: false, error: 'task_full' });

    const rewardDc = task.rewardDc || task.rewardGold || task.rewardPoints || 10; // fallback if admin left it blank

    // STEP 2 — atomically credit the user (a double-claim by the same user is
    // caught right here). The taskStart token, if any, is marked spent in the
    // same update that credits the reward.
    const gate = await users.findOneAndUpdate(
        {
            _id: userId,
            completedTasks: { $ne: taskId },
            ...(taskStartKey ? { usedTaskStarts: { $ne: taskStartKey } } : {}),
            ...REWARD_ELIGIBLE_FILTER,
        },
        {
            $inc: { dcBalance: rewardDc, lifetimeDcEarned: rewardDc, tasksCompletedToday: 1 },
            $addToSet: taskStartKey ? { completedTasks: taskId, usedTaskStarts: taskStartKey } : { completedTasks: taskId },
        },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Crediting failed (race, or blocked by the multi-account review gate)
        // — give the task's slot back either way.
        await tasks.updateOne({ _id: taskObjId }, { $inc: { completionCount: -1 } });
        const exists = await users.findOne({ _id: userId }, { projection: { completedTasks: 1, multiAccountFlag: 1, channelVerified: 1, usedTaskStarts: 1 } });
        if (taskStartKey && (exists?.usedTaskStarts || []).includes(taskStartKey)) {
            return res.status(400).json({ ok: false, error: 'task_token_already_used' });
        }
        if (exists?.multiAccountFlag && !exists.channelVerified && !(exists.completedTasks || []).includes(taskId)) {
            return res.status(403).json({ ok: false, error: 'account_under_review' });
        }
        return res.status(200).json({ ok: false, alreadyDone: true });
    }

    await maybeAwardReferralMilestones(db, userId, { completedTasksCount: gate.completedTasks.length });
    return res.status(200).json({ ok: true, rewardDc });
}

// ── claimPromo ──
async function handleClaimPromo(req, res, db, userId) {
    const { code } = req.body;
    if (!code) return res.status(400).json({ ok: false, error: 'missing_fields' });

    const promos = db.collection('promos');
    const users = db.collection('users');

    const promo = await promos.findOne({ code: String(code).trim() });
    if (!promo) return res.status(404).json({ ok: false, error: 'invalid_code' });
    if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return res.status(400).json({ ok: false, error: 'expired' });

    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });

    const maxUses = promo.maxUses || 9999;
    const promoGate = await promos.findOneAndUpdate(
        { _id: promo._id, usedCount: { $lt: maxUses }, redeemedBy: { $ne: userId } },
        { $inc: { usedCount: 1 }, $addToSet: { redeemedBy: userId } },
        { returnDocument: 'after' }
    );
    if (!promoGate) {
        const fresh = await promos.findOne({ _id: promo._id });
        if ((fresh.redeemedBy || []).includes(userId)) return res.status(400).json({ ok: false, error: 'already_used' });
        return res.status(400).json({ ok: false, error: 'fully_used' });
    }

    // The promo code itself is already marked used above even if the credit
    // below is blocked by REWARD_ELIGIBLE_FILTER — otherwise a flagged user
    // could keep retrying the same code after verifying. Trade-off: a
    // flagged user "burns" a promo code with zero reward if redeemed while
    // still unverified. Accepted — promo codes are typically low-value.
    const reward = promo.reward || 0;
    const creditResult = await users.updateOne(
        { _id: userId, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { dcBalance: reward, lifetimeDcEarned: reward } }
    );
    if (creditResult.matchedCount === 0) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward });
}

// ── Mining (Home tab) ──
// Start a 2-hour session; once it's elapsed, claim MINING_REWARD_DC and the
// session clears — the user can immediately start the next one. Only one
// session can run at a time (miningStartedAt is null when idle).
async function handleMiningStart(req, res, db, userId) {
    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (user.miningStartedAt) {
        return res.status(400).json({ ok: false, error: 'already_mining', miningStartedAt: user.miningStartedAt });
    }

    const startedAt = new Date();
    const gate = await users.findOneAndUpdate(
        { _id: userId, miningStartedAt: null },
        { $set: { miningStartedAt: startedAt } },
        { returnDocument: 'after' }
    );
    if (!gate) return res.status(400).json({ ok: false, error: 'already_mining' });

    return res.status(200).json({ ok: true, miningStartedAt: startedAt, durationMs: MINING_DURATION_MS });
}

async function handleMiningClaim(req, res, db, userId) {
    const users = db.collection('users');
    const user = await users.findOne({ _id: userId });
    if (!user) return res.status(404).json({ ok: false, error: 'user_not_found' });
    if (user.isBanned) return res.status(403).json({ ok: false, error: 'banned' });
    if (!user.miningStartedAt) return res.status(400).json({ ok: false, error: 'not_mining' });

    const elapsedMs = Date.now() - new Date(user.miningStartedAt).getTime();
    if (elapsedMs < MINING_DURATION_MS) {
        return res.status(400).json({ ok: false, error: 'not_ready', remainingMs: MINING_DURATION_MS - elapsedMs });
    }

    const gate = await users.findOneAndUpdate(
        { _id: userId, miningStartedAt: user.miningStartedAt, ...REWARD_ELIGIBLE_FILTER },
        { $inc: { dcBalance: MINING_REWARD_DC, lifetimeDcEarned: MINING_REWARD_DC }, $set: { miningStartedAt: null } },
        { returnDocument: 'after' }
    );
    if (!gate) {
        // Either already claimed by a concurrent request, or blocked by the
        // multi-account review gate (session left untouched in that case
        // so a later verify can still claim it).
        const fresh = await users.findOne({ _id: userId }, { projection: { miningStartedAt: 1, multiAccountFlag: 1, channelVerified: 1 } });
        if (!fresh?.miningStartedAt) return res.status(400).json({ ok: false, error: 'already_claimed' });
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward: MINING_REWARD_DC, newDcBalance: gate.dcBalance });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    switch (action) {
        case 'taskStart':      return handleTaskStart(req, res, db, userId);
        case 'taskComplete':   return handleTaskComplete(req, res, db, userId);
        case 'claimPromo':     return handleClaimPromo(req, res, db, userId);
        case 'adStart':        return handleAdStart(req, res, db, userId);
        case 'claimAdReward':  return handleClaimAdReward(req, res, db, userId);
        case 'gameStart':      return handleGameStart(req, res, db, userId);
        case 'claimGameReward': return handleClaimGameReward(req, res, db, userId);
        case 'miningStart':    return handleMiningStart(req, res, db, userId);
        case 'miningClaim':    return handleMiningClaim(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
            }
