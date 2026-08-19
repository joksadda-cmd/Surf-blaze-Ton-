// lib/referral.js — Season 2 + FIX: referral earnings now tracked separately
// + ATOMIC FIX: each milestone's flag-check-and-set is now a single atomic
// operation, closing a race window where two near-simultaneous triggers
// (e.g. rapid double-tap task completion, or two devices) could both read
// the flag as false and both award the same milestone twice.
//
// লিমিটেড রেফারেল রিওয়ার্ড ৩টা ধাপে দেওয়া হয়, প্রতিটা ধাপ যখন referred user
// (যাকে রেফার করা হয়েছে) প্রথমবার সেই মাইলস্টোনে পৌঁছায়:
//   ধাপ ১: channel + community verify করলে   → referrer পাবে REFERRAL_REWARDS.step1_verified
//   ধাপ ২: ১০টা task সম্পন্ন করলে             → referrer পাবে REFERRAL_REWARDS.step2_tenTasks
//   ধাপ ৩: ২০টা task সম্পন্ন করলে             → referrer পাবে REFERRAL_REWARDS.step3_twentyTasks
//          (⚠️ এই rebuild-এ ad-count থেকে task-count এ বদলানো হয়েছে —
//          এখন কোনো ad-watch-to-earn ফিচার নাই, তাই দুটোই task দিয়ে trigger হয়)
//
// প্রতিটা ধাপ মাত্র একবারই দেওয়া হবে — তার জন্য referred user-এর ডকুমেন্টে
// referralStep1Done / Step2Done / Step3Done ফ্ল্যাগ রাখা হচ্ছে, এবং প্রতিটা
// ফ্ল্যাগের check+set এখন atomic (findOneAndUpdate দিয়ে) — তাই concurrent
// কল থেকে ডাবল-অ্যাওয়ার্ড হওয়ার সুযোগ নেই।
//
// reward সরাসরি wtcBalance-এ যোগ হয়, এবং আলাদা করে `referralWtcEarned`
// ফিল্ডেও যোগ হয় যাতে "Refer" ট্যাবে referral-থেকে-আসা টাকার real সংখ্যা
// দেখানো যায়।

import {
    REFERRAL_REWARDS,
    REFERRAL_STEP2_TASK_COUNT,
    REFERRAL_STEP3_TASK_COUNT,
} from './constants.js';
import { tgSend } from './telegram.js';

// ⚠️ NEW (Season 4) — sent to the REFERRER the moment one of their referrals
// finishes all 3 steps and becomes "valid" (see step3 handling below). This
// valid referral is what api/withdraw.js spends — 1 per withdrawal, after
// the user's first (free) one.
function validReferralNotification() {
    return (
        `🎉 <b>Congratulations!</b>\n\n` +
        `One of your referrals has been successfully verified ✅\n\n` +
        `You've unlocked <b>1 valid referral</b> — this lets you make your next withdrawal. ` +
        `Keep sharing your invite link to unlock more! 🚀`
    );
}

// stats = { channelVerified?, completedTasksCount?, lifetimeAdsWatched? }
// — যেকোনো একটা বা একাধিক পাস করতে পারেন, যেটা সদ্য changed হয়েছে
export async function maybeAwardReferralMilestones(db, referredUserId, stats = {}) {
    const users = db.collection('users');
    const referredUser = await users.findOne(
        { _id: referredUserId },
        { projection: { referredBy: 1, referralStep1Done: 1, referralStep2Done: 1, referralStep3Done: 1 } }
    );
    if (!referredUser || !referredUser.referredBy) return; // কেউ এই ইউজারকে রেফার করেনি
    if (referredUser.referredBy === referredUserId) return; // ⚠️ self-referral guard — defense in depth

    const referrerId = referredUser.referredBy;

    const steps = [
        { key: 'referralStep1Done', met: !!stats.channelVerified, reward: REFERRAL_REWARDS.step1_verified },
        { key: 'referralStep2Done', met: stats.completedTasksCount !== undefined && stats.completedTasksCount >= REFERRAL_STEP2_TASK_COUNT, reward: REFERRAL_REWARDS.step2_tenTasks },
        { key: 'referralStep3Done', met: stats.completedTasksCount !== undefined && stats.completedTasksCount >= REFERRAL_STEP3_TASK_COUNT, reward: REFERRAL_REWARDS.step3_twentyTasks },
    ];

    for (const step of steps) {
        if (!step.met || referredUser[step.key]) continue;

        // ⚠️ ATOMIC — flag-check আর flag-set একই operation-এ। দুটো concurrent
        // call এলে একটাই এই filter ($ne:true) পাস করবে, অন্যটা null ফেরত পাবে
        // এবং নিচের reward-credit স্কিপ করবে।
        const claimed = await users.findOneAndUpdate(
            { _id: referredUserId, [step.key]: { $ne: true } },
            { $set: { [step.key]: true } },
            { returnDocument: 'after' }
        );
        if (!claimed) continue; // অন্য concurrent call কিছু মিলিসেকেন্ড আগেই claim করে ফেলেছে

        const referrerUpdate = await users.findOneAndUpdate(
            { _id: referrerId, isBanned: { $ne: true } }, // ⚠️ banned referrer-কে reward না দেওয়া
            {
                $inc: {
                    wtcBalance: step.reward, lifetimeWtcEarned: step.reward, referralWtcEarned: step.reward,
                    // step3 is the LAST of the 3 steps, so reaching it is
                    // exactly the moment this referral becomes "valid" for
                    // withdraw purposes (see api/withdraw.js / constants.js
                    // WITHDRAW_VALID_REFERRALS_PER_WITHDRAW).
                    ...(step.key === 'referralStep3Done' ? { validReferralCount: 1 } : {}),
                },
            },
            { returnDocument: 'after' }
        );

        // ⚠️ NEW (Season 4) — notify the referrer only once, exactly when their
        // referral just became valid (i.e. this step3 update actually applied
        // to a non-banned referrer doc).
        if (step.key === 'referralStep3Done' && referrerUpdate) {
            tgSend(referrerId, validReferralNotification()).catch(() => {});
        }
    }
    }
