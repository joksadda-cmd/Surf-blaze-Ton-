// lib/broadcastJob.js — NEW
//
// পুরনো broadcast implementation একটা single request-এর ভেতর সব user-কে
// loop করে message পাঠাতো (api/bot.js এর bc_confirm handler)। 3000+ user
// এ Vercel Hobby-র 10s timeout-এ function মাঝপথে মরে যেত, "Done" কখনো
// আসতো না, আর কোনো resume/checkpoint না থাকায় বেশিরভাগ user কখনোই
// message পেতো না।
//
// এখন broadcast একটা persisted job (`broadcastJobs` collection) — cursor
// (lastUserId) দিয়ে ট্র্যাক হয়, প্রতিবার ছোট একটা chunk পাঠিয়ে
// self-trigger করে পরের chunk চালায় (api/broadcastWorker.js দেখুন)।

import { connectToDatabase } from './mongodb.js';

// ⚠️ CHANGED (this update) — a fixed BROADCAST_CHUNK_SIZE used to live here,
// sized only around the artificial inter-message delay below. It ignored
// that each `tgSend` is a real network round-trip (150-500ms+ on its own),
// so a fixed count could still blow past Vercel's 10s cap depending on
// Telegram's response time on any given invocation — and did, repeatedly.
// api/broadcastWorker.js now uses a wall-clock TIME BUDGET per invocation
// instead of a fixed count, which is safe regardless of latency.
export const BROADCAST_MSG_DELAY_MS = 50;      // 20 msg/sec, safely under Telegram's 30/sec cap
export const BROADCAST_LOCK_STALE_MS = 30_000; // if a "running" lock is older than this, assume the previous invocation died and allow retry

export async function createBroadcastJob({ text, buttonText, buttonUrl, photoFileId, createdBy, totalUsers }) {
    const { db } = await connectToDatabase();
    const doc = {
        status: 'pending',
        text, buttonText: buttonText || null, buttonUrl: buttonUrl || null, photoFileId: photoFileId || null,
        totalUsers,
        lastUserId: null,
        sentCount: 0,
        failedCount: 0,
        createdBy: String(createdBy),
        createdAt: new Date(),
        updatedAt: new Date(),
        lockedAt: null,
        finishedAt: null,
    };
    const { insertedId } = await db.collection('broadcastJobs').insertOne(doc);
    return { ...doc, _id: insertedId };
}

export async function getBroadcastJob(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    return db.collection('broadcastJobs').findOne({ _id: new ObjectId(jobId) });
}

// চাল-নেওয়ার আগে lock নেয় — একই job দুইবার একসাথে না চলার জন্য (self-trigger
// double-fire বা worker manually re-visit করলে ওভারল্যাপ ঠেকায়)।
// stale lock (আগের invocation crash করেছে ধরে) হলে override করে নিয়ে নেয়।
export async function tryLockJob(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    const staleThreshold = new Date(Date.now() - BROADCAST_LOCK_STALE_MS);
    const result = await db.collection('broadcastJobs').findOneAndUpdate(
        {
            _id: new ObjectId(jobId),
            status: { $in: ['pending', 'running'] },
            $or: [{ lockedAt: null }, { lockedAt: { $lt: staleThreshold } }],
        },
        { $set: { status: 'running', lockedAt: new Date(), updatedAt: new Date() } },
        { returnDocument: 'after' }
    );
    return result?.value || result || null; // driver-version-safe
}

export async function updateJobProgress(jobId, { lastUserId, sentDelta, failedDelta }) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    await db.collection('broadcastJobs').updateOne(
        { _id: new ObjectId(jobId) },
        {
            $set: { lastUserId, updatedAt: new Date(), lockedAt: null },
            $inc: { sentCount: sentDelta, failedCount: failedDelta },
        }
    );
}

export async function markJobDone(jobId) {
    const { db } = await connectToDatabase();
    const { ObjectId } = await import('mongodb');
    await db.collection('broadcastJobs').updateOne(
        { _id: new ObjectId(jobId) },
        { $set: { status: 'done', finishedAt: new Date(), lockedAt: null, updatedAt: new Date() } }
    );
}

// ⚠️ NEW — lets the admin check real progress (sentCount / totalUsers) via
// api/broadcastStatus.js instead of guessing from a handful of test accounts,
// which can easily sit near the end of a large, still-in-progress user list.
export async function getLatestBroadcastJob() {
    const { db } = await connectToDatabase();
    return db.collection('broadcastJobs').find({}).sort({ createdAt: -1 }).limit(1).next();
}
