/*
 * Dominion AI — the feature map (Fred, 2026-07-19).
 *
 * THE PROBLEM: a user asks "make me an image" and the model tries to describe one, or says it
 * cannot, when Dominion has a whole image studio one tap away. Ask any model where a feature lives
 * and it invents an answer, because nothing ever told it what this app can do or where the controls
 * are. Every model should be able to answer "what can this do, how do I use it, where is it".
 *
 * THE SHAPE, per Fred's instruction that this must not bloat every call: the INDEX below is small
 * enough to ride every turn (roughly 200 tokens) and carries the two facts that matter most, what
 * exists and where it is. The DETAIL is fetched on demand through the app_help tool, so the long
 * copy costs nothing until someone actually asks.
 *
 * ACCURACY IS THE WHOLE VALUE. A confidently wrong location is worse than no answer, so `where`
 * strings were read off the live interface rather than remembered. When the UI moves, this file
 * moves with it: it is the single source of truth that both the prompt and the help tool read, and
 * a weekly audit checks it against the shipped interface.
 */

export const FEATURES = [
  {
    id: "images",
    brief: "generate images",
    aliases: ["image", "images", "picture", "photo", "art", "draw", "generate image", "image generation", "forge images", "make an image"],
    name: "Dominion Forge Images",
    where: "the picture button in the message bar, bottom left next to the paperclip and the flame",
    what: "Generates images. The whole interface slides to the right and the image studio takes the screen.",
    how: [
      "Tap the picture button in the message bar. The interface slides right and Forge Images opens.",
      "Type what you want under WHAT TO MAKE. REFINE rewrites a rough idea into a fuller description.",
      "IGNITE THE FORGE, directly under the box, makes the picture now. Everything below it is optional.",
      "QUALITY (Low, Medium, High) and SHAPE (Square, Portrait, Landscape) are optional; the panel shows the cost for the chosen settings.",
      "MAKE SEVERAL AT ONCE (a switch) queues several pictures at half price, ready within a day.",
      "ADD YOUR OWN IMAGES (up to 10) copies the look of pictures you supply.",
      "Finished images land in YOUR FORGED VISIONS, the gallery on the right, where they can be opened, favorited, searched and downloaded.",
    ],
    notes: "Images are stored on the user's own device, never in the cloud. The back arrow or the close button returns to chat.",
  },
  {
    id: "forge-dial",
    brief: "effort and tool gate",
    aliases: ["dial", "effort", "ember", "flame", "furnace", "forge mode", "thinking level", "reasoning effort"],
    name: "The Forge dial (effort) and Forge Mode",
    where: "the flame button in the message bar, bottom left",
    what: "Sets how hard the model thinks, and separately whether it may use tools.",
    how: [
      "Tap the flame. The interface slides to the LEFT and the dial takes the screen.",
      "Ember is the everyday floor, Flame is fuller reasoning, Furnace applies the whole framework and is slowest and most expensive.",
      "FORGE MODE is a separate switch on the same panel: it is the gate that lets the assistant use its tools and act rather than only answer.",
      "Seal Setting, the back arrow, or Escape returns to chat. The setting persists.",
    ],
  },
  {
    id: "attachments",
    brief: "send files and photos",
    aliases: ["attach", "attachment", "upload", "paperclip", "pdf", "word file", "spreadsheet file", "send a file", "photo upload"],
    name: "Attachments",
    where: "the paperclip in the message bar",
    what: "Send pictures, PDFs, Word documents, spreadsheets and text files into the conversation.",
    how: [
      "Tap the paperclip and choose files.",
      "PDFs, Word and Excel files are read on the device and their text rides along, so they work with every model.",
      "A scanned PDF or a photo of a document is transcribed automatically when the chosen model cannot see images.",
    ],
  },
  {
    id: "documents",
    brief: "make Word/PDF/Excel files",
    aliases: ["document", "word", "docx", "pdf", "excel", "xlsx", "csv", "downloadable document", "create a document", "download a document", "export"],
    name: "Documents and downloads",
    where: "ask in chat; finished files appear as a Download button under the answer, and live in Artifacts",
    what: "Creates real Word, PDF, Excel and CSV files from a conversation.",
    how: [
      "Ask for a document, for example: make that a Word document, or turn this into a PDF.",
      "A Download button appears under the answer. Tap it and the file saves to the device.",
      "Every document is also kept in Artifacts, where it can be reopened and downloaded again in any format.",
    ],
  },
  {
    id: "artifacts",
    brief: "document library",
    aliases: ["artifact", "artifacts", "library", "saved documents", "my documents"],
    name: "Artifacts",
    where: "the document button in the header controls",
    what: "The library of documents the assistant has produced, with full version history.",
    how: [
      "Open Artifacts from the header. Each row has Open, PDF and Word buttons.",
      "Open shows the whole document, its versions, and a Download row offering PDF, Word, Excel, CSV, Markdown, text, HTML and JSON.",
      "Revise, compare versions, mark final, or request a review from inside the document.",
    ],
  },
  {
    id: "voice",
    brief: "talk and listen",
    aliases: ["voice", "speak", "microphone", "mic", "read aloud", "speech", "tts", "dictate"],
    name: "Voice",
    where: "the microphone and speaker buttons in the message bar",
    what: "Speak instead of typing, and have answers read aloud.",
    how: [
      "Tap the microphone, speak, tap it again to send.",
      "The speaker toggle reads every answer aloud as it arrives. Each answer also has its own speak button.",
    ],
  },
  {
    id: "memory",
    brief: "durable facts",
    aliases: ["memory", "remember", "recall", "saved facts"],
    name: "Memory",
    where: "the memory button in the header controls",
    what: "Durable facts and preferences the assistant carries between conversations.",
    how: [
      "Add a fact directly in the Memory panel, or ask the assistant to remember something.",
      "Approve, pin, edit, archive or delete anything it has saved.",
    ],
  },
  {
    id: "chat-sync",
    brief: "chats on every device",
    aliases: ["chat sync", "sync", "across devices", "phone and laptop", "continue on another device", "history sync"],
    name: "Chats across devices",
    where: "automatic, no control needed",
    what: "Conversations follow the account between phone and computer.",
    how: [
      "Start on one device and continue on another. Chats sync when the app opens, when it returns to the foreground, and while it is open.",
      "Deleting a chat on one device removes it from the others.",
      "Image attachments do not travel between devices; their text does.",
    ],
  },
  {
    id: "models",
    brief: "engine, mode, privacy",
    aliases: ["model", "models", "operating mode", "mode", "privacy", "private", "trusted", "model picker", "which model"],
    name: "Model, Operating Mode and Privacy",
    where: "the three controls in the header, next to the Dominion name",
    what: "Which model answers, how it works, and where the conversation is allowed to go.",
    how: [
      "Model picks the engine. Operating Mode sets the discipline (Fast, Normal, Deep Think, Long Context, Draft, Tool, Mentor, As Fred).",
      "In the picker: 🔧 means the model can use tools, 💬 means it can only talk, 👁 means it can see pictures.",
      "In the owner's interface only, a model whose name is RED AND BOLD holds the machine grant: full read and write on the laptop's C, F, G and Z drives through an elevated node, plus administrator PowerShell, Command Prompt and Terminal. A name in the normal colour cannot reach the machines at all. 30 of the 43 models carry the grant.",
      "Still owner-only, ★ marks the shorter Wildfire roster: models trusted to run broad multi-step work once the Wildfire switch on the Forge dial is armed. Red says CAN reach the machines; ★ says trusted to be turned loose on them.",
      "Privacy: Normal allows every provider, Trusted restricts to OpenAI and Anthropic direct plus local, Private uses the local model only.",
      "A privacy setting is never silently overridden. A disallowed choice is refused and explained.",
    ],
  },
  {
    id: "tools",
    brief: "what it did",
    aliases: ["tool activity", "tools", "tool log", "actions", "what did you do"],
    name: "Tool activity",
    where: "the tools button in the header controls",
    what: "The record of every action the assistant has taken, with what it ran and what came back.",
    how: ["Open it from the header, or tap the tool line under any answer to see just that message's actions."],
  },
  {
    id: "mentor",
    brief: "critique and review",
    aliases: ["mentor", "critique", "review", "improvement", "evals"],
    name: "Mentor and improvement",
    where: "the mentor button in the header controls",
    what: "Independent critique of answers, plus the failure ledger, evaluations and prompt rules.",
    how: ["Use Critique on any answer for a review, or open the panel for the ledger, evals and active rules."],
  },
  {
    id: "setup",
    brief: "account, credits, connectors",
    aliases: ["setup", "connectors", "credits", "billing", "payment", "account", "integrations", "github", "stripe"],
    name: "Setup, connectors and credits",
    where: "the Setup button at the bottom of the conversation sidebar",
    what: "Account, credits and billing, and the connectors that give the assistant reach into other services.",
    how: [
      "Open the sidebar with the menu button, then Setup at the bottom.",
      "Credits and payment live here, as do connectors such as GitHub, Supabase, Stripe, Railway and Zapier.",
    ],
  },
  {
    id: "plans",
    brief: "turn a chat plan into a project",
    aliases: ["plan", "plans", "roadmap", "phases", "task list", "mvp", "save plan", "send to crucible", "start a project"],
    name: "Plans (chat to Crucible)",
    where: "in the conversation, the AI offers to save a plan; in The Crucible, 'Start from a plan'",
    what: "A plan built in the chat (a roadmap, phases, a task list, an MVP definition) can be saved, revisited, downloaded, reloaded to edit, or opened in The Crucible to start a real project.",
    how: [
      "Talk through what you want to build; ask the AI for a roadmap, phases, a task list, or an MVP.",
      "When a full plan is on the table the AI offers to save it. Saved plans live in the plan library with full history, so you can reload and edit any version.",
      "In The Crucible, open 'Start from a plan': pick a saved plan (or paste one), name the project, and it fills the brief. From there discuss it further or just build; the build proceeds the normal way.",
    ],
    notes: "Saving a plan uses the same versioned-artifact system as documents, so nothing is ever lost and every edit can be undone.",
  },
  {
    id: "long-jobs",
    brief: "hours-long background jobs",
    aliases: ["job", "jobs", "long job", "long-run", "long run", "overnight", "background task", "36 hours", "keep working", "big task"],
    name: "Long-run jobs",
    where: "in the conversation itself: ask for the big thing and the assistant offers to run it as a job (no button yet)",
    what: "Work too big for one reply runs on the server for hours, in small verified units, with a budget fuse: spending pauses at each approved tranche and never runs away. It keeps going with the app closed and survives restarts; every finished unit is saved.",
    how: [
      "Ask for the big thing (review this whole app, write ten chapters). The assistant proposes a mission, a plan of units, a model, and the budget, then starts it after you agree.",
      "A tranche is a spending fuse: $1 each for guests (at most $2 per tranche, 10 approvals ahead), $5 for the owner. When one runs dry the job PAUSES and asks; approving the next tranche resumes it. It is never killed for money.",
      "Ask for status any time in chat; pause or resume the same way. A notification calls you back when it finishes, pauses, or fails.",
      "If the server restarts mid-run, the job seals paused with the truth; resuming loses at most the one unit that was in flight.",
    ],
    notes: "Paying users' unit costs come from their credits like any turn; sponsored users draw the monthly cap. The assistant states the budget before creating a job.",
  },
];

/** The compact index that rides every turn. Name plus location only: enough to point correctly,
 *  cheap enough to send always. The `what` copy stays behind app_help where it costs nothing. */
export function featureIndex() {
  return FEATURES.map((f) => `- ${f.name} (${f.brief}): ${f.where}`).join("\n");
}

// Queries arrive as "chat sync", "chat-sync", "image generation", "make a picture". Flatten
// punctuation so a hyphen never decides whether a user gets an answer.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Full detail for one feature, for the app_help tool. Matches on id, name, alias or keyword. */
export function featureHelp(topic) {
  const q = norm(topic);
  const render = (f) => [
    f.name,
    "WHERE: " + f.where,
    "WHAT: " + f.what,
    "HOW:",
    ...f.how.map((h) => "  - " + h),
    f.notes ? "NOTE: " + f.notes : "",
  ].filter(Boolean).join("\n");

  if (!q || q === "all" || q === "everything") return FEATURES.map(render).join("\n\n");
  const hit = FEATURES.find((f) => norm(f.id) === q || norm(f.name) === q || (f.aliases || []).some((a) => norm(a) === q))
    || FEATURES.find((f) => (f.aliases || []).some((a) => q.includes(norm(a)) || norm(a).includes(q)))
    || FEATURES.find((f) => norm(f.name).includes(q) || q.includes(norm(f.id)))
    || FEATURES.find((f) => norm(f.what + " " + f.how.join(" ")).includes(q));
  if (hit) return render(hit);
  return "No feature matches \"" + topic + "\". The features are: " + FEATURES.map((f) => f.name).join(", ") +
    ". Ask for one of those, or for \"all\".";
}
