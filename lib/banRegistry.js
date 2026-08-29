// lib/banRegistry.js
//
// Shared ban-registry helpers used by api/bot.js's manual admin Ban/Unban
// User action. The users collection's own isBanned/bannedAt fields remain
// the source of truth for gating access everywhere (api/earn.js, api/gift.js,
// api/withdraw.js, etc. all read isBanned directly on that collection) —
// this registry is a separate append-only audit trail of ban/unban events,
// keyed by userId, so admin actions stay traceable even if a user's own
// document is edited or deleted later.
//
// COLLECTION: banRegistry
// { _id: "<telegram userId>", banned: true|false, bannedAt: Date, unbannedAt: Date }

export async function markBanned(db, userIds) {
    if (!Array.isArray(userIds) || !userIds.length) return;
    const now = new Date();
    const registry = db.collection('banRegistry');
    const ops = userIds.map((id) => ({
        updateOne: {
            filter: { _id: id },
            update: { $set: { banned: true, bannedAt: now } },
            upsert: true,
        },
    }));
    await registry.bulkWrite(ops);
}

export async function markUnbanned(db, userIds) {
    if (!Array.isArray(userIds) || !userIds.length) return;
    const now = new Date();
    const registry = db.collection('banRegistry');
    const ops = userIds.map((id) => ({
        updateOne: {
            filter: { _id: id },
            update: { $set: { banned: false, unbannedAt: now } },
            upsert: true,
        },
    }));
    await registry.bulkWrite(ops);
}
