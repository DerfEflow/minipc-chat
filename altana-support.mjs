/*
 * Dominion AI. ALTANA'S SUPPORT PLAYBOOK: what to say, what to do, when to escalate, how to follow up.
 *
 * FRED, 2026-08-12: "It should have a full customer service workflow ... with a database of a
 * significant amount of text responses and actions to customer issues, including how to report an
 * issue to me and how to follow up with the user after actions have take place."
 *
 * WHY THIS IS DATA AND NOT PROMPT. Her system prompt is paid for on every turn, and a hundred
 * support scripts in it would be a bill and a latency cost per message forever. It is also the wrong
 * shape: a script is only useful when its issue is the one in front of her, so it belongs behind a
 * lookup. The FAQ corpus in docs/altana-faq answers "how does X work"; this file answers "X is
 * broken, now what", which is a different job with a different structure: every entry carries the
 * words to say, the levers to pull, whether Fred hears about it, and what the user is told later.
 *
 * WHY THE RESPONSES ARE WRITTEN OUT RATHER THAN GENERATED. A model asked to improvise an apology
 * will sometimes explain the cause, and the cause is usually technical. Fred's rule is that a
 * customer never reads a technical explanation. A written line cannot leak an implementation detail
 * it does not contain, so the safe version of "always plain English" is a library of sentences that
 * were plain English when they were written. She may reword them in her own voice; she starts from
 * something already safe.
 *
 * EVERY RESPONSE OBEYS THREE RULES, and altana-support_test.mjs enforces all three across the whole
 * table rather than trusting the author:
 *   1. No technical vocabulary. No file names, no module names, no error codes, no stack language,
 *      no provider names where a plain noun will do.
 *   2. It says what happens NEXT, because "sorry" without a next step is not support.
 *   3. It never promises an outcome the app cannot see. "I am on it" is a promise about effort and
 *      is always keepable. "It is fixed" is a claim about the world and is only made by the code
 *      that actually fixed it.
 */

/* ============================================================================================== *
 * 1. SEVERITY: what it changes
 * ============================================================================================== */

/*
 * Severity is not decoration. It decides three real things: whether Fred is emailed at once, whether
 * the user is promised a follow-up, and how long the ticket may sit before the sweep chases it.
 */
export const SEVERITY = {
  // Money is wrong, data may be lost, or the account cannot be used at all. Fred hears immediately.
  critical: { rank: 4, escalate: "immediate", followUp: true, chaseAfterHours: 2 },
  // A feature the user is paying for is not working. Fred hears immediately, batched only if he is
  // already being told about this same issue.
  high: { rank: 3, escalate: "immediate", followUp: true, chaseAfterHours: 12 },
  // It works but it is wrong, slow, confusing or ugly. Fred hears in the daily roll-up.
  normal: { rank: 2, escalate: "digest", followUp: true, chaseAfterHours: 72 },
  // A wish, an opinion, a nice-to-have. Recorded, rolled up, no promise of a fix.
  low: { rank: 1, escalate: "digest", followUp: false, chaseAfterHours: 0 },
};

export const SEVERITY_ORDER = ["critical", "high", "normal", "low"];

/* ============================================================================================== *
 * 2. THE PLAYBOOK
 * ============================================================================================== */

/*
 * Each entry:
 *   id        stable, referenced by tickets forever, so never renamed
 *   type      the family, for grouping in Fred's roll-up
 *   severity  see above
 *   cues      the words a real person uses. Matched with the same rare-word scoring the FAQ uses,
 *             so a cue list does not have to be exhaustive to work.
 *   say       what Altana tells them NOW. Plain English, ends in a next step.
 *   act       the levers she should pull herself, in order, named as her own tool verbs. An empty
 *             list means there is nothing she can do but record it, and that is an honest answer.
 *   ask       what she needs from them before the ticket is useful to Fred. Kept short: two
 *             questions is a conversation, six is a form, and nobody fills in a form.
 *   escalate  overrides the severity default when an issue needs Fred whatever its rank
 *   followUp  what she tells them when it is resolved. Written as the finished sentence.
 *   selfServe true when the user can fix this themselves in under a minute and being told how is
 *             better service than a ticket. She still offers to file it if they would rather.
 */
export const SUPPORT_PLAYBOOK = [

  /* ---------- money: the highest-consequence family, so it leads ------------------------------ */
  {
    id: "charged-wrong-amount", type: "billing", severity: "critical",
    cues: ["charged too much", "wrong amount", "overcharged", "double charged", "charged twice", "billed twice", "took more than", "charged me for nothing"],
    say: "That is exactly the kind of thing I want to get in front of straight away. I am flagging it as a money problem, which goes to Fred right away rather than into a queue, and I will come back to you as soon as it has been looked at. Nothing else is charged to you while it is open.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["Roughly when did it happen?", "What amount did you expect, and what did you see?"],
    escalate: "immediate",
    followUp: "About the charge you flagged: it has been looked at and sorted. If anything was taken that should not have been, it has been put right on your balance.",
  },
  {
    id: "credits-missing", type: "billing", severity: "critical",
    cues: ["credits missing", "credits gone", "balance wrong", "paid but no credits", "bought credits didnt arrive", "where are my credits", "balance did not go up"],
    say: "Credits you paid for should be on your balance and I can see that they are not, so I am treating this as urgent rather than routine. Fred is being told now, and I will let you know the moment your balance is right.",
    act: ["read_credits", "open_ticket", "escalate_to_owner"],
    ask: ["Roughly when did you buy them?"],
    escalate: "immediate",
    followUp: "Your credits are on your balance now. Sorry about the wait on that one.",
  },
  {
    id: "payment-declined", type: "billing", severity: "high",
    cues: ["card declined", "payment failed", "card failed", "wont take my card", "payment error", "cant pay"],
    say: "A card can be turned down for reasons that have nothing to do with you or with us, so this is usually quicker to fix than it looks. The usual causes are a card that has expired, a bank blocking a first payment to a new company, or an address that does not match. If you would like to try again I can take you to the payment screen, and if it turns you down twice I will get Fred involved rather than leave you going in circles.",
    act: ["open_screen:setup"],
    ask: [],
    selfServe: true,
    followUp: "The payment problem you hit has been looked at, and your account is clear to pay again.",
  },
  {
    id: "refund-request", type: "billing", severity: "high",
    cues: ["refund", "money back", "want my money back", "reverse the charge", "cancel and refund"],
    say: "I am not the one who moves money, so I am not going to pretend I can approve that here. What I can do is put it in front of Fred with everything he needs to decide, today, and tell you what he says. Refunds are his call and he does read these.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What are you asking to be refunded, and what went wrong?"],
    escalate: "immediate",
    followUp: "Fred has looked at your refund request and replied. Check the email address on your account.",
  },
  {
    id: "unexpected-spend", type: "billing", severity: "high",
    cues: ["spent more than expected", "cost more than the estimate", "burned through my credits", "used up my credits fast", "why did that cost", "expensive"],
    say: "Let me look at what actually ran, because a bill that surprises you is a bill worth explaining. Estimates are given as a range and a job that retries lands nearer the top of it, but a figure well outside the range is a real problem and I will escalate it rather than explain it away. I can also set a spending limit for you so this cannot repeat.",
    act: ["read_credits", "open_screen:setup"],
    ask: ["Which job or conversation was it?"],
    followUp: "I went back over the spend you asked about. The detail has been sent to the email on your account, and a limit is in place if you asked for one.",
  },
  {
    id: "top-off-surprise", type: "billing", severity: "high",
    cues: ["topped up without asking", "auto recharge", "recharged itself", "took money automatically", "why did it buy credits"],
    say: "Automatic top-off is meant to stop a long job dying halfway through when your balance runs out, and it should never be a surprise. I can turn it off for you right now if you would rather it never did that again, and I can tell you exactly what it did and when.",
    act: ["read_top_off", "set_top_off"],
    ask: [],
    selfServe: true,
    followUp: "Automatic top-off is off on your account now, so nothing will be bought without you asking for it.",
  },
  {
    id: "subscription-confusion", type: "billing", severity: "normal",
    cues: ["cancel my subscription", "am i on a plan", "what am i paying", "monthly charge", "stop billing me"],
    say: "Let me be straight about how this works so you are not guessing: Dominion runs on credits you buy rather than a monthly fee, so there is nothing recurring to cancel unless automatic top-off is switched on. I can check that for you now and turn it off if you want.",
    act: ["read_top_off"],
    ask: [],
    selfServe: true,
    followUp: "Your billing question is settled and nothing recurring is running on your account.",
  },

  /* ---------- the app is broken --------------------------------------------------------------- */
  {
    id: "build-failed", type: "build", severity: "high",
    cues: ["build failed", "build broke", "build errored", "my app didnt build", "build stopped", "build died"],
    say: "Sorry, that is frustrating when you were waiting on it. Your work is not lost: a build keeps a record of every step it took, so what it managed is still there and I can see where it stopped. I am recording this and getting it in front of Fred, and I will come back to you rather than leaving you to check.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What were you building, roughly?"],
    followUp: "The build problem you hit has been fixed. Your project is ready to run again, and nothing you had already built was lost.",
  },
  {
    id: "build-stuck", type: "build", severity: "high",
    cues: ["build stuck", "hanging", "not moving", "been running for hours", "spinning forever", "frozen"],
    say: "A build that has stopped moving is worth stopping rather than waiting on. Work that is not happening costs you nothing in credits, and it is still costing you your afternoon. I can stop it for you, and I am flagging it so Fred sees why it stalled. You will keep whatever it finished before it stopped.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: [],
    followUp: "The stall you ran into has been dealt with. Builds are moving normally on your account again.",
  },
  {
    id: "app-wont-deploy", type: "build", severity: "high",
    cues: ["wont deploy", "deploy failed", "cant publish", "not going live", "deployment error"],
    say: "Getting it built and then not getting it live is the worst place to be stuck, so I am treating this as a real fault rather than a question. I am putting it in front of Fred now with what I can see, and I will tell you when it will go.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What is the app called?"],
    followUp: "Your app is live now. The thing blocking the publish has been fixed.",
  },
  {
    id: "lost-work", type: "data", severity: "critical",
    /*
     * "all my work is gone" used to classify as `unknown`, which demoted the single most serious
     * report in the table to normal severity and a daily round-up. The cue list was written in the
     * phrasings an author imagines and missed the one a person actually types under stress. Found by
     * altana-support_test.mjs; the lesson is that a cue list needs the SHORT panicked forms, not only
     * the grammatical ones.
     */
    cues: ["lost my work", "my project is gone", "chat disappeared", "everything vanished", "cant find my", "deleted my work",
      "work is gone", "all my work", "everything is gone", "project gone", "work disappeared", "its all gone", "lost everything"],
    say: "Nothing here throws work away, so if something is not where you left it my first assumption is that it is misfiled rather than gone, and my second is that something is genuinely wrong and Fred needs to know today. I am doing both: looking for it now and flagging it as urgent. Please do not start over yet.",
    act: ["list_work", "open_ticket", "escalate_to_owner"],
    ask: ["What was it called, or roughly when did you last have it?"],
    escalate: "immediate",
    followUp: "Good news on the work you thought you had lost: it has been recovered and it is back in your account.",
  },
  {
    id: "model-not-answering", type: "chat", severity: "high",
    cues: ["not responding", "stops responding", "stopped responding", "no reply", "model wont answer",
      "stuck thinking", "blank response", "nothing comes back", "no response", "never answers", "just stops"],
    say: "That is usually the model provider having a bad minute rather than anything on your account, and there is a faster fix than waiting: I can move you onto a different model right now and you can carry on. I am also recording it so Fred can see whether it is happening to more than just you.",
    act: ["set_setting:model", "open_ticket"],
    ask: [],
    selfServe: true,
    followUp: "The model that went quiet on you is answering normally again.",
  },
  {
    id: "model-refused", type: "chat", severity: "normal",
    cues: ["model refused", "not allowed to use", "wont let me use that model", "model blocked", "greyed out"],
    say: "A model can be unavailable to you for a reason that is fixable in a moment: your privacy setting may not allow that company, or that particular one may need a key your account does not have. Let me check which of those it is and either switch the setting or put you on the nearest model that will work.",
    act: ["list_settings", "set_setting:model"],
    ask: [],
    selfServe: true,
    followUp: "The model you wanted is available on your account now.",
  },
  {
    id: "answer-quality", type: "chat", severity: "normal",
    cues: ["bad answer", "wrong answer", "made things up", "hallucinated", "useless response", "not helpful", "lied to me"],
    say: "That is worth reporting rather than shrugging off, and I will file it with what you asked and what came back so it is a real example rather than a complaint in the abstract. In the meantime a heavier model usually helps on exactly this, and I can switch you to one now.",
    act: ["open_ticket", "set_setting:model"],
    ask: ["What did you ask it?"],
    followUp: "Thanks for the example you sent in. It has been used to fix how that kind of question gets handled.",
  },
  {
    id: "images-failing", type: "images", severity: "high",
    /*
     * "no image came out" was removed. Its three long words (image, came, out) are all present in
     * "the image came out completely wrong", so a customer who simply disliked a picture scored
     * higher here than on `image-wrong` and got escalated to Fred at high severity. The failure was
     * backwards in both directions at once: it paged the owner over a taste question and it skipped
     * the entry that would actually have helped them re-prompt.
     */
    cues: ["image failed", "picture didnt generate", "image error", "no image came back", "image never arrived",
      "image blank", "generation failed", "nothing generated"],
    say: "You are not charged for an image that never arrived, so the first thing is that this has not cost you anything. I am recording the fault and getting it to Fred. If you want a picture in the next few minutes I can also take you to the image screen and we can try it a different way.",
    act: ["open_ticket", "escalate_to_owner", "open_screen:foundry"],
    ask: ["What were you asking for a picture of?"],
    followUp: "Image making is working properly again, and anything you were charged for that failed has been put back.",
  },
  {
    id: "image-wrong", type: "images", severity: "normal",
    cues: ["image looks wrong", "came out wrong", "completely wrong", "totally wrong", "not what i asked for",
      "ignored my prompt", "wrong style", "ugly image", "cartoonish", "not what i wanted"],
    say: "Let me help you get the one you actually wanted rather than filing that away. Being specific about the look, and saying what you do NOT want, moves these more than a longer description does. Tell me what it should have looked like and I will set it up properly.",
    act: ["open_screen:foundry"],
    ask: ["What should it have looked like?"],
    selfServe: true,
    followUp: "",
  },
  {
    id: "video-failing", type: "video", severity: "high",
    cues: ["video failed", "video wont render", "video error", "no video", "video stuck", "export failed"],
    say: "Video is the longest job in here and the one where a failure costs you the most waiting, so I am not going to ask you to just try again. I am recording it with the detail Fred needs and escalating it now, and you will hear back from me on it.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What were you making?"],
    followUp: "Video is producing properly again. Your project is where you left it and you can pick it back up.",
  },
  {
    id: "video-quality", type: "video", severity: "normal",
    cues: ["video looks bad", "choppy", "wrong length", "no sound", "audio out of sync", "low quality video"],
    say: "That is a real fault rather than a preference, so I am writing it down properly with what you were making. I can also point you at the settings that most often fix this kind of thing before Fred gets to it.",
    act: ["open_ticket", "open_screen:video"],
    ask: ["What was wrong with it, in your words?"],
    followUp: "The video problem you reported has been fixed. Anything you make now should come out right.",
  },
  {
    id: "voice-broken", type: "voice", severity: "normal",
    cues: ["voice not working", "cant hear", "wont speak", "microphone", "speech failed", "no audio"],
    say: "Voice has two halves and they fail for different reasons, so let me narrow it rather than guess: is it that you cannot be heard, or that you cannot hear her? I can switch the sound setting for you either way, and I will record it if it is genuinely broken rather than switched off.",
    act: ["list_settings", "set_setting:sound"],
    ask: ["Is it your microphone or the speaking voice?"],
    selfServe: true,
    followUp: "Voice is working properly again on your account.",
  },
  {
    id: "connector-broken", type: "connectors", severity: "normal",
    cues: ["connector not working", "google not connected", "reconnect", "lost connection to", "connector broke", "authorisation expired"],
    say: "An outside service usually needs reconnecting rather than fixing: the permission it gave us expires, and it goes quiet rather than announcing it. I cannot reconnect it for you, because that is your account and your password and I am deliberately kept away from both, but I can take you straight to the screen where it takes about twenty seconds.",
    act: ["open_screen:connectors"],
    ask: [],
    selfServe: true,
    followUp: "The connection you reported has been repaired at our end. If it still asks you to reconnect, that part is a click on the connectors screen.",
  },
  {
    id: "cannot-sign-in", type: "account", severity: "critical",
    cues: ["cant log in", "cant sign in", "locked out", "code didnt arrive", "password", "wont let me in", "no verification email"],
    say: "Being locked out is the one problem where everything else has to wait, so this goes to Fred now rather than into a queue. The sign-in code can take a couple of minutes and does sometimes land in spam, so it is worth a look there while I get this moving.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["Which email address are you trying to use?"],
    escalate: "immediate",
    followUp: "You should be able to sign in normally now. Sorry you were locked out.",
  },
  {
    id: "app-slow", type: "performance", severity: "normal",
    cues: ["slow", "laggy", "taking forever", "sluggish", "takes ages"],
    say: "Slow is a fault, not a mood, so I will record it with where you were when it happened. Some of this is the model rather than the app, and if that is what is going on I can put you on a faster one right now.",
    act: ["open_ticket", "set_setting:model"],
    ask: ["Which part of the app was slow?"],
    followUp: "The slowness you reported has been chased down and fixed.",
  },
  {
    id: "ui-broken", type: "interface", severity: "normal",
    cues: ["button doesnt work", "cant click", "layout broken", "text cut off", "cant see", "overlapping", "off screen", "wont scroll"],
    say: "Something you cannot click is something you cannot use, so that is worth a proper report. Tell me which screen and roughly where on it, and whether you are on a phone or a computer, and I will write it up so Fred can see the same thing you are seeing.",
    act: ["open_ticket"],
    ask: ["Which screen, and are you on a phone or a computer?"],
    followUp: "The problem with the screen you reported has been fixed. It should behave properly now.",
  },
  {
    id: "mobile-broken", type: "interface", severity: "high",
    cues: ["on my phone", "mobile", "ipad", "tablet", "cant navigate on phone", "no menu on phone"],
    say: "Phone and tablet problems get their own attention here, because a screen that works on a computer and not on a phone is a fault that hides from everyone who is not holding a phone. Tell me what you cannot reach and I will write it up with the size of screen you are on.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What can you not reach or read?"],
    followUp: "The phone problem you reported has been fixed. Have another go and it should behave.",
  },
  {
    id: "sync-missing", type: "data", severity: "high",
    cues: ["not syncing", "different on my other device", "chat not on my phone", "images didnt travel", "missing on laptop"],
    say: "Work you started on one device should be waiting for you on the other, so if it is not then something is genuinely wrong rather than slow. I am recording it and escalating it, and I will tell you when it is carrying across properly.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What is missing, and which device did you make it on?"],
    followUp: "Your work is carrying across your devices properly again.",
  },

  /* ---------- confusion, which is a support issue and not a stupid question ------------------- */
  {
    id: "dont-know-where", type: "guidance", severity: "low",
    cues: ["where do i", "cant find the", "how do i get to", "where is the"],
    say: "I can just take you there rather than describe it. Tell me what you are trying to get to and I will open it.",
    act: ["open_screen"],
    ask: [],
    selfServe: true,
    followUp: "",
  },
  {
    id: "too-complicated", type: "guidance", severity: "normal",
    cues: ["too complicated", "overwhelming", "dont understand", "confusing", "too many options", "over my head"],
    say: "That is fair, and it is fixable in one move: there is a simpler version of this app that hides the machinery and just talks to you, and I can put you in it now. Nothing you have made goes away when you switch. I will also pass on that it felt overwhelming, because that is the kind of thing worth someone knowing.",
    act: ["open_ticket", "open_screen"],
    ask: [],
    selfServe: true,
    followUp: "",
  },
  {
    id: "feature-missing", type: "feedback", severity: "low",
    cues: ["you should add", "feature request", "wish it could", "why cant it", "it would be better if", "can you make it"],
    say: "I would rather write that down than tell you it is a good idea and forget it, so I am recording it as a request with your words on it. Whether it gets built is Fred's call rather than mine, so I will not promise you it will. He does read these, and small ones do land.",
    act: ["open_ticket"],
    ask: [],
    followUp: "The thing you asked for has been built. Thanks for suggesting it.",
  },
  {
    id: "privacy-worry", type: "privacy", severity: "high",
    cues: ["is my data safe", "who can see", "do you train on", "is this private", "gdpr", "delete my data", "data protection"],
    say: "That is a question you are entitled to a straight answer to rather than reassurance, and I can give you the real one about where your text goes, what is stripped before it leaves, and how to make it stricter. If you want your data removed I will put that to Fred directly, because it is his to action and it does get actioned.",
    act: ["search_help", "list_settings"],
    ask: [],
    selfServe: true,
    followUp: "Your data request has been carried out and confirmed.",
  },
  {
    id: "angry", type: "feedback", severity: "high",
    cues: ["furious", "terrible", "waste of money", "worst", "fed up", "had enough", "cancel my account", "unacceptable", "ridiculous"],
    say: "I am not going to talk you out of that. I am sorry, and I would rather get it in front of Fred with your words on it than manage you. Tell me the part that has cost you the most and I will make sure that is the part he reads first.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What has cost you the most?"],
    escalate: "immediate",
    followUp: "You told us this app had let you down. What you reported has been fixed, and Fred asked me to tell you it was your report that got it looked at.",
  },
  {
    id: "wants-human", type: "escalation", severity: "high",
    cues: ["talk to a human", "real person", "speak to someone", "contact support", "email someone", "who do i contact"],
    say: "Fred runs this himself, so a human here means him, and the fastest way to reach him is for me to hand this over with everything already written down. Tell me what you want him to know and where to reply, and I will send it now.",
    act: ["open_ticket", "escalate_to_owner"],
    ask: ["What should he know, and what is the best address to reply to?"],
    escalate: "immediate",
    followUp: "Fred has your message and has replied to the address you gave me.",
  },
  {
    id: "unknown", type: "other", severity: "normal",
    cues: [],
    say: "I want to get this right rather than guess at it. Tell me what you expected to happen and what happened instead, and I will write it up properly and get it moving. I will stay on it and come back to you rather than leaving you to chase.",
    act: ["open_ticket"],
    ask: ["What did you expect, and what happened instead?"],
    followUp: "The problem you reported has been dealt with. Thanks for your patience on it.",
  },
];

/* ============================================================================================== *
 * 3. CLASSIFICATION
 * ============================================================================================== */

/*
 * Cue matching, scored so that a rare cue beats a common one. Deliberately simpler than the FAQ
 * retriever, and for a reason: the FAQ has to REFUSE a question it cannot answer, because a wrong
 * answer is worse than none. This has a correct fallback (`unknown`, which asks the user), so it can
 * afford to always return something. Never returning null is the whole point: a support request that
 * classified as nothing would drop on the floor, and dropping a complaint is the one outcome that is
 * not allowed here.
 */
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const PLAYBOOK_BY_ID = new Map(SUPPORT_PLAYBOOK.map((p) => [p.id, p]));
export const playbookFor = (id) => PLAYBOOK_BY_ID.get(String(id)) || null;

/*
 * How often each cue word appears across the whole table, computed once. A word in twelve entries
 * tells us almost nothing about which one this is; a word in one entry tells us almost everything.
 */
const CUE_DF = (() => {
  const df = new Map();
  for (const p of SUPPORT_PLAYBOOK) {
    const seen = new Set();
    for (const cue of p.cues || []) for (const w of norm(cue).split(" ")) if (w.length > 2) seen.add(w);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  return df;
})();

const N = SUPPORT_PLAYBOOK.length;
const weightOf = (w) => Math.log(1 + N / (1 + (CUE_DF.get(w) || 0)));

/**
 * Classify one complaint into a playbook entry.
 *
 * Returns { entry, confidence, alternatives } where confidence is 0..1. A whole cue PHRASE found in
 * the text is worth far more than its words scattered across it, because "charged twice" and "I was
 * charged, twice I asked and twice it failed" are not the same report.
 */
export function classifyIssue(text, { minConfidence = 0.18 } = {}) {
  const t = norm(text);
  if (!t) return { entry: playbookFor("unknown"), confidence: 0, alternatives: [] };

  const scored = [];
  for (const p of SUPPORT_PLAYBOOK) {
    if (!p.cues || !p.cues.length) continue;
    let score = 0;
    for (const cue of p.cues) {
      const c = norm(cue);
      if (!c) continue;
      if (t.includes(c)) {
        // A phrase hit. Weighted by its rarest word so "card declined" outranks "slow".
        const words = c.split(" ").filter((w) => w.length > 2);
        const rarest = words.reduce((m, w) => Math.max(m, weightOf(w)), 0);
        score += 2.5 * (rarest || 1) * Math.min(3, words.length) / 3;
        continue;
      }
      // Scattered words. Each counts once, at its own weight, and only if most of the cue is present,
      // so a single ordinary word cannot drag an unrelated entry to the top.
      const words = c.split(" ").filter((w) => w.length > 2);
      if (!words.length) continue;
      const hit = words.filter((w) => new RegExp("\\b" + w + "\\w{0,3}\\b").test(t));
      if (hit.length >= Math.max(1, Math.ceil(words.length * 0.6))) {
        score += hit.reduce((s, w) => s + weightOf(w), 0) / words.length;
      }
    }
    if (score > 0) scored.push({ p, score });
  }

  if (!scored.length) return { entry: playbookFor("unknown"), confidence: 0, alternatives: [] };
  scored.sort((a, b) => b.score - a.score || SEVERITY[b.p.severity].rank - SEVERITY[a.p.severity].rank);

  const top = scored[0];
  const total = scored.reduce((s, x) => s + x.score, 0);
  const confidence = total > 0 ? top.score / total : 0;
  const entry = confidence >= minConfidence ? top.p : playbookFor("unknown");
  return {
    entry,
    confidence: Number(confidence.toFixed(3)),
    alternatives: scored.slice(1, 4).map((x) => x.p.id),
  };
}

/* ============================================================================================== *
 * 4. WHAT THE USER IS TOLD, AND WHAT HAPPENS BEHIND IT
 * ============================================================================================== */

/**
 * The full support decision for one complaint, in one call, so the caller cannot apply half of it.
 *
 * Returns the words to say, the acts to run, whether Fred is emailed now, and the sentence that will
 * be sent later when it is resolved. The follow-up line is decided HERE, at file time, rather than
 * generated at resolution time: the person who resolves a ticket weeks later is a sweep, and a sweep
 * cannot write a sentence about a problem it never read.
 */
export function supportPlanFor(text, { severityOverride = "" } = {}) {
  const { entry, confidence, alternatives } = classifyIssue(text);
  /*
   * `Object.hasOwn`, not a truthiness test on the lookup. SEVERITY is a plain object literal, so it
   * inherits from Object.prototype and `SEVERITY["constructor"]` is truthy. The old check therefore
   * accepted "constructor", "toString" and "valueOf" as severities, and produced a ticket whose
   * escalate rule and chase clock were both undefined: no escalation, no chase, silently. Found by
   * altana-support_test.mjs.
   */
  const severity = Object.hasOwn(SEVERITY, String(severityOverride)) ? String(severityOverride) : entry.severity;
  const rules = SEVERITY[severity];
  const escalate = entry.escalate || rules.escalate;
  return {
    issueId: entry.id,
    type: entry.type,
    severity,
    confidence,
    alternatives,
    say: entry.say,
    ask: entry.ask || [],
    act: entry.act || [],
    selfServe: !!entry.selfServe,
    escalate,                                   // "immediate" | "digest"
    escalateNow: escalate === "immediate",
    promiseFollowUp: !!rules.followUp && !!entry.followUp,
    followUpText: entry.followUp || "",
    chaseAfterHours: rules.chaseAfterHours,
  };
}

/*
 * THE ESCALATION FRED ACTUALLY READS.
 *
 * Written here rather than at the call site because the useful shape of this email was learned the
 * hard way: the old complaint alert sent the summary and the surface, and answering it meant going
 * to look up who the person was, what they were doing and whether it had happened before. Everything
 * needed to make a decision goes in the body, in the order a decision needs it.
 *
 * Recipient is NEVER a parameter. Fred's rule: never email anyone other than Fred without approval.
 */
export function escalationEmail(opts) {
  /*
   * Destructured from a normalised object rather than in the parameter list. A default parameter
   * fires on `undefined` and NEVER on an explicit `null`, so `escalationEmail(null)` threw, and the
   * one path it would have taken down is the one that is supposed to reach Fred. Every other entry
   * point in this module already survives null; this one was the exception. Found by
   * altana-support_test.mjs.
   */
  const o = (opts && typeof opts === "object") ? opts : {};
  const ticketId = o.ticketId || 0;
  const plan = (o.plan && typeof o.plan === "object") ? o.plan : {};
  const complaint = o.complaint || "";
  const user = (o.user && typeof o.user === "object") ? o.user : {};
  const surface = o.surface || "";
  const history = Array.isArray(o.history) ? o.history : [];
  const repeats = Number(o.repeats) || 0;
  const sev = String(plan.severity || "normal").toUpperCase();
  const subject = `Dominion ${sev}: ${plan.issueId || "issue"} #${ticketId}`;
  const lines = [
    `TICKET #${ticketId}  ${sev}  ${plan.type || "other"}/${plan.issueId || "unknown"}`,
    "",
    "WHAT THEY SAID:",
    String(complaint || "(no words recorded)").slice(0, 2000),
    "",
    "WHO:",
    "  account: " + (user.email || user.uid || "unknown") + (user.isOwner ? "  (this is you)" : ""),
    "  tier: " + (user.tier || "unknown"),
    "  reply to: " + (user.contactEmail || "they did not leave an address"),
    "  where they were: " + (surface || "unknown"),
    repeats > 0 ? "  NOTE: this account has reported this same issue " + repeats + " time(s) before." : "",
    "",
    "WHAT ALTANA DID:",
    ...(plan.act && plan.act.length ? plan.act.map((a) => "  - " + a) : ["  - recorded it, nothing else was hers to do"]),
    "",
    "WHAT SHE PROMISED THEM:",
    "  " + String(plan.say || "").slice(0, 600),
    plan.promiseFollowUp
      ? "  She TOLD THEM they would hear back. Resolving this ticket sends them: \"" + String(plan.followUpText).slice(0, 300) + "\""
      : "  No follow-up was promised.",
    "",
    history.length ? "RECENT WORDS FROM THEM:" : "",
    ...history.slice(-6).map((h) => "  " + String(h).slice(0, 200)),
    "",
    "To close it and send the follow-up, resolve ticket #" + ticketId + " on the complaints screen.",
  ].filter((l) => l !== "");
  return { subject, body: lines.join("\n") };
}

/*
 * The digest for everything that did not warrant an immediate email. One message a day beats thirty
 * interruptions, and a normal-severity annoyance genuinely can wait until the morning.
 */
export function digestEmail(tickets = []) {
  const rows = Array.isArray(tickets) ? tickets : [];
  if (!rows.length) return null;
  const byType = new Map();
  for (const t of rows) {
    const k = (t.type || "other") + "/" + (t.issueId || "unknown");
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(t);
  }
  const lines = [
    "Dominion support roll-up: " + rows.length + " ticket(s) since the last one.",
    "",
  ];
  for (const [k, list] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(list.length + "x  " + k);
    for (const t of list.slice(0, 4)) {
      lines.push("   #" + t.id + "  " + (t.userEmail || t.uid || "unknown") + "  " + String(t.summary || "").slice(0, 140));
    }
    if (list.length > 4) lines.push("   ...and " + (list.length - 4) + " more");
    lines.push("");
  }
  const waiting = rows.filter((t) => t.promiseFollowUp).length;
  if (waiting) lines.push(waiting + " of these were promised a follow-up. Resolving each one sends it.");
  return { subject: "Dominion support roll-up (" + rows.length + ")", body: lines.join("\n") };
}

export default { SUPPORT_PLAYBOOK, SEVERITY, classifyIssue, supportPlanFor, escalationEmail, digestEmail, playbookFor };
