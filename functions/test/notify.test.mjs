// Unit tests for the developer-notification email logic. No Firebase, no
// network, no nodemailer — pure functions only.
//
// Run: node functions/test/notify.test.mjs
import { createRequire } from "module";
import { fileURLToPath } from "url";
const require = createRequire(import.meta.url);
const { shouldNotifyFeedback, communityEmail, feedbackEmail } = require("../lib/notify.js");

const checks = [];
const check = (n, ok, extra) => {
  checks.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${extra ? "  — " + extra : ""}`);
};

// ---- shouldNotifyFeedback: never email the admin about their OWN reply ----
check("a player's own message notifies", shouldNotifyFeedback({ from: "user", text: "hi" }));
check("an admin's own reply does NOT notify", !shouldNotifyFeedback({ from: "admin", text: "hi" }));
check("a missing message does NOT notify", !shouldNotifyFeedback(null));
check("a message with no 'from' at all does NOT notify", !shouldNotifyFeedback({ text: "hi" }));

// ---- communityEmail: every CREATE is a new submission, no field is optional ----
{
  const e = communityEmail({ name: "تاريخ عمان", authorName: "سالم", questions: [1, 2, 3] }, "cat-1");
  check("the subject names the category", e.subject.includes("تاريخ عمان"));
  check("the body names the author", e.text.includes("سالم"));
  check("the body states the question count", e.text.includes("3"));
  check("the body carries the category id (for lookups)", e.text.includes("cat-1"));
}
{
  // A category with no name/author/questions must still produce a sane,
  // non-throwing email — Firestore data can always be partial.
  const e = communityEmail({}, "cat-2");
  check("a category with nothing set still produces a subject", typeof e.subject === "string" && e.subject.length > 0);
  check("…and falls back to a generic author label", e.text.includes("عضو"));
  check("…and a zero count, not NaN or undefined", e.text.includes("0") && !/NaN|undefined/.test(e.text));
}
check("communityEmail never throws on a null category", (() => {
  try { communityEmail(null, "cat-3"); return true; } catch (e) { return false; }
})());

// ---- feedbackEmail: carries the message body and who sent it ----
{
  const e = feedbackEmail({ from: "user", text: "اللعبة رائعة!", name: "منى" }, "uid-123");
  check("the subject names the sender", e.subject.includes("منى"));
  check("the body includes the actual message", e.text.includes("اللعبة رائعة!"));
  check("the body includes the uid (for replying via the admin panel)", e.text.includes("uid-123"));
}
check("feedbackEmail never throws on a null message", (() => {
  try { feedbackEmail(null, "uid-1"); return true; } catch (e) { return false; }
})());

console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
