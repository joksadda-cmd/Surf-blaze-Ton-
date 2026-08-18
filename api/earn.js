// api/earn.js — SURF BLAZE
//
// Trimmed down to exactly what the current index.html calls — the old
// NEWTUBE video/lootbox/ad-network-watch/777-lottery earning paths are
// fully removed (there's no UI left that calls them). Only:
//
//   { action: 'taskStart',    initData, taskId }                       — issues a short-lived signed token when a task sheet opens
//   { action: 'taskComplete', initData, taskId, startTime?, signature? } — startTime/signature required for non-API-verified tasks
//   { action: 'claimPromo',   initData, code }
//
// Every request requires a verified Telegram initData — the userId is
// always taken from that, never trusted from the client body directly.

import { ObjectId } from 'mongodb';
import { connectToDatabase } from '../lib/mongodb.js';
import { isMember } from '../lib/telegram.js';
import { ensureDailyReset } from '../lib/dailyReset.js';
import { maybeAwardReferralMilestones } from '../lib/referral.js';
import { verifyTelegramInitData } from '../lib/telegramAuth.js';
import { TASK_MIN_WAIT_SECONDS } from '../lib/constants.js';
import crypto from 'crypto';

const SECRET = process.env.VIDEO_SIGNING_SECRET; // kept name for continuity — used to sign ANY short-lived action token, not just video

// Task-claim tokens are namespaced with 'task:' + the taskId, so a token
// issued for one task can never be replayed to claim a different one.
const signTaskStart = (userId, taskId, startTime) =>
    crypto.createHmac('sha256', SECRET).update(`task:${userId}:${taskId}:${startTime}`).digest('hex');

// A multi-account-flagged user earns no NEW WTC until they verify channel +
// community membership. Progress/counters still advance normally.
const REWARD_ELIGIBLE_FILTER = { $or: [{ multiAccountFlag: { $ne: true } }, { channelVerified: true }] };

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

    const rewardWtc = task.rewardWtc || task.rewardGold || task.rewardPoints || 10; // fallback if admin left it blank

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
            $inc: { wtcBalance: rewardWtc, lifetimeWtcEarned: rewardWtc, tasksCompletedToday: 1 },
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
    return res.status(200).json({ ok: true, rewardWtc });
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
        { $inc: { wtcBalance: reward, lifetimeWtcEarned: reward } }
    );
    if (creditResult.matchedCount === 0) {
        return res.status(403).json({ ok: false, error: 'account_under_review' });
    }

    return res.status(200).json({ ok: true, reward });
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const { action } = req.body || {};

    const verified = verifyTelegramInitData(req.body?.initData);
    if (!verified.ok) return res.status(401).json({ ok: false, error: 'unauthorized', reason: verified.error });
    const userId = String(verified.user.id);

    const { db } = await connectToDatabase();
    switch (action) {
        case 'taskStart':    return handleTaskStart(req, res, db, userId);
        case 'taskComplete': return handleTaskComplete(req, res, db, userId);
        case 'claimPromo':   return handleClaimPromo(req, res, db, userId);
        default: return res.status(400).json({ ok: false, error: 'unknown_action' });
    }
}
