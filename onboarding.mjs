/*
 * Dominion AI — onboarding content (data, not UI). Served at GET /content/tutorial so the front end
 * (GPT's design work) can render the first-login tutorial and the always-available help panel from a
 * single source of truth. Also carries the one-time consent line and the Forge Mode warning.
 *
 * Writing rules honored: no em dashes, no "not X but Y" antithesis.
 */

export const CONSENT_TEXT =
  "Dominion AI is a shared, learning assistant. Your conversations may be used to train and improve the assistant's reasoning for everyone. Sensitive personal details are yours; keep them out of chat if you would not want them used to improve the model. By continuing you acknowledge this.";

export const FORGE_MODE_WARNING =
  "Forge Mode performs much better, with fewer errors and higher-quality output. It takes longer on the smaller models and burns credits faster than normal. Use it when quality counts.";

export const TUTORIAL = {
  version: 1,
  title: "Welcome to Dominion AI",
  intro: "Dominion AI is a personal assistant with a mind of its own house rules. A quick tour of what it does and what makes it different.",
  sections: [
    {
      id: "features",
      heading: "What it can do",
      body: "Chat with a large catalog of AI models, from fast and cheap to frontier-grade. Ask for real documents and it will produce them as Word, PDF, Excel, or plain text, laid out professionally, with a download link. Ask it to build an app and it will lay out the whole file tree. It can search the web, remember what matters to you, and keep your work in its own private space that no other user can see.",
      points: [
        "Pick any model from the catalog, or let it choose for you.",
        "Generate Word, PDF, Excel, Markdown, and text files that look professional.",
        "Long answers finish in full; they do not get cut off.",
        "Your chats, memory, and files are private to your account.",
      ],
    },
    {
      id: "tools",
      heading: "Tools",
      body: "The assistant has real tools, not just talk. It can search the web and read pages, create and revise documents, keep durable notes and memory, and run small pieces of code in a safe sandbox. It uses a tool when a tool is the right way to get you a true answer, and it tells you what it actually did.",
      points: [
        "Web search and page reading for current facts.",
        "Document creation and export.",
        "Private memory and saved artifacts.",
        "A sandbox for safe, small code runs.",
      ],
    },
    {
      id: "as-fred",
      heading: 'The "As Fred" voice',
      body: "One of the models answers as Fred Wolfe would answer. This is an experiment, not ego. Fred wanted to see how closely an AI could be trained to reason and answer the way he does, and it has turned out to be useful for running an idea past himself. It is shaped by his reasoning framework and a distilled profile of how he thinks, so it reasons in his manner rather than merely repeating things he has said. It never exposes his private writing.",
      points: [
        "An experiment in training an AI to answer as Fred would.",
        "Useful for running ideas past himself.",
        "Reasons in his manner; it does not parrot his words.",
      ],
    },
    {
      id: "wolfe-logic",
      heading: "Wolfe Logic",
      body: "Wolfe Logic is a reasoning discipline distilled from years of Fred's own writing and argumentation, and it is wired into every model here, on every turn. A typical assistant reaches for the most agreeable-sounding answer. Dominion is required to walk a stricter path before it is allowed to answer.",
      what: "What actually happens to your question: the key terms get defined first, so the answer cannot drift on a vague word. The claim is then split into what is established fact, what is assumption, and what is speculation, and each is treated as exactly that. The engine looks for the mechanism, the why underneath the surface, instead of stopping at the symptom. Before answering, it builds the strongest counter-argument it can against its own draft and keeps only what survives. Whatever remains gets qualified honestly: sweeping words like always and never are cut down to what the evidence supports.",
      how: "What you will notice in practice: definitions up front when a word is doing heavy lifting, plain labels when something is an assumption, answers that admit their own weak points, fewer confident-sounding errors, and honest pushback when your premise has a crack in it. It will name the crack to your face; it will never flatter a bad idea to keep the conversation pleasant.",
      points: [
        "Terms defined before anything is built on them.",
        "Fact, assumption, and speculation kept separate and labeled.",
        "Every answer tested against its strongest counter-argument first.",
        "Sweeping claims cut down to what the evidence supports.",
        "No yes-man behavior: a weak premise gets named.",
      ],
    },
    {
      id: "forge-mode",
      heading: "Forge Mode",
      body: "Forge Mode is a dial that controls how much of the Wolfe Logic engine runs on your question. Three levels, named for the forge: Ember, Flame, and Furnace.",
      why: "Why it exists: most questions deserve a fast answer, and a few decisions deserve a slow one. The dial lets you buy depth exactly when the stakes justify it, and skip the cost when they do not.",
      what: "What each level changes: Ember applies the core discipline in a single pass, and it is always on. Flame loads the full set of foundational axioms and runs the structured reasoning protocol: the question is decomposed, assumptions are written out explicitly, a counter-argument is built, and only then is the answer assembled. Furnace runs the entire framework deliberately, ending with an adversarial self-review in which the draft answer is attacked, repaired, and only then released.",
      how: "How it changes a real piece of work: ask for a contract clause on Ember and you get a clean, sensible clause. Ask on Furnace and the engine first lists the ways the clause could fail you, checks each one against what you have told it, rewrites the weak spots, and hands you the survivor together with the risks it found. The same pattern holds for a business plan, a pricing decision, a hard email, or a system design. The honest price of the extra thinking is time and credits, which is why the dial is yours.",
      warning: FORGE_MODE_WARNING,
      tiers: [
        { id: "ember", name: "Ember", desc: "Always on. The core discipline on every turn, at the lowest cost." },
        { id: "flame", name: "Flame", desc: "A deeper pass: full axioms, the reasoning protocol, and the engines. More thorough, moderately slower and costlier." },
        { id: "furnace", name: "Furnace", desc: "The whole framework, applied deliberately. The highest quality, the slowest, and the most credits." },
      ],
    },
    {
      id: "credits",
      heading: "Credits and billing",
      body: "Usage is prepaid with credits. You add credits, and each answer draws down a small amount based on what it costs to produce. When your balance runs low it tops up automatically so you are never interrupted mid-thought. You can turn auto-recharge off and top up by hand.",
      points: [
        "Prepaid credits; each answer costs a little.",
        "Automatic top-up keeps you running (you can turn it off).",
      ],
    },
  ],
};

// A compact payload for the front end (tutorial + the two standalone strings).
export const onboardingPayload = () => ({ tutorial: TUTORIAL, consent: CONSENT_TEXT, forgeModeWarning: FORGE_MODE_WARNING });
