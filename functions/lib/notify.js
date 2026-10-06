// Pure logic for the developer-notification emails: which Firestore writes
// are worth emailing the owner about, and what the email says. No Firebase,
// no nodemailer, no network — index.js wires this to the actual Firestore
// triggers and the Gmail SMTP transport; this file is what the unit tests
// exercise directly.

// An admin's own reply in a feedback thread must never email the admin about
// themselves — only the player's own message ('from' === 'user') is new
// incoming content worth a notification. See firestore.rules' feedback
// create rule: 'from' is always exactly 'user' or 'admin'.
function shouldNotifyFeedback(msg) {
  return !!msg && msg.from === "user";
}

// A community category is always created approved:false (communityPublish
// never creates one any other way), so every CREATE here is a brand-new
// submission worth a look — no further filtering needed.
function communityEmail(cat, catId) {
  const name = (cat && cat.name) || "(بدون اسم)";
  const author = (cat && cat.authorName) || "عضو";
  const count = Array.isArray(cat && cat.questions) ? cat.questions.length : 0;
  return {
    subject: `فئة مجتمعية جديدة: ${name}`,
    text: `فئة جديدة بانتظار المراجعة.\n\n`
      + `الاسم: ${name}\n`
      + `من: ${author}\n`
      + `عدد الأسئلة: ${count}\n`
      + `رقم الفئة: ${catId}\n\n`
      + `افتح التطبيق → فئات المجتمع للمراجعة.`,
  };
}

function feedbackEmail(msg, uid) {
  const name = (msg && msg.name) || "لاعب";
  const text = (msg && msg.text) || "";
  return {
    subject: `رسالة جديدة من ${name}`,
    text: `${text}\n\n`
      + `من: ${name}\n`
      + `uid: ${uid || "?"}\n\n`
      + `افتح التطبيق → رسائل اللاعبين للرد.`,
  };
}

module.exports = { shouldNotifyFeedback, communityEmail, feedbackEmail };
