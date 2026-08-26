// lib/settings.js — small key/value settings store in MongoDB, for values
// the admin changes at runtime (currently just the CPM rate) without a
// code deploy. One document per setting in the `settings` collection,
// keyed by `_id`.

import { DEFAULT_CPM_RATE } from './constants.js';

const CPM_DOC_ID = 'cpm';

// Current CPM (USD per 1,000 impressions). Falls back to DEFAULT_CPM_RATE
// if the admin has never set one yet (fresh install).
export async function getCpmRate(db) {
    const doc = await db.collection('settings').findOne({ _id: CPM_DOC_ID });
    const value = doc?.value;
    return (typeof value === 'number' && value > 0) ? value : DEFAULT_CPM_RATE;
}

// Admin-only — see api/bot.js "📈 Set CPM". Stores who changed it and when,
// for the dashboard/history.
export async function setCpmRate(db, value, adminId) {
    await db.collection('settings').updateOne(
        { _id: CPM_DOC_ID },
        { $set: { value, updatedAt: new Date(), updatedBy: String(adminId) } },
        { upsert: true }
    );
}
