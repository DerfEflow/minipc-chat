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
      body: "Wolfe Logic is the reasoning discipline built into every answer, on every model. It is what makes Dominion different from a generic assistant. It seeks what is true before what is agreeable, defines terms before building on them, separates fact from assumption, qualifies broad claims, looks for the mechanism beneath a symptom, tests claims where they can fail, and refuses to be a yes-man. It is always on at the Ember level and deepens as you turn up Forge Mode.",
      points: [
        "Always on, for everyone, at the Ember level.",
        "Truth before agreement; mechanism beneath the symptom.",
        "Names its assumptions and challenges weak certainty.",
      ],
    },
    {
      id: "forge-mode",
      heading: "Forge Mode",
      body: "Forge Mode is a dial that turns Wolfe Logic up and, for the owner, unlocks the build tools. There are three levels named for the forge: Ember, Flame, and Furnace.",
      why: "Why: when a task really matters, deeper reasoning produces fewer errors and higher-quality output. The trade is speed and cost.",
      what: "What: Ember is the always-on baseline. Flame is a deeper pass with the full reasoning protocol and the cognitive engines. Furnace is the entire framework applied deliberately.",
      how: "How: choose the level per turn. Higher levels take longer on the smaller models and burn credits faster, because the assistant reasons more before it answers. Use the level the task deserves.",
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
      body: "Usage is prepaid with credits. You add credits, and each answer draws down a small amount based on what it costs to produce. When your balance runs low it tops up automatically so you are never interrupted mid-thought. You can turn auto-recharge off and top up by hand. Some users are on a free plan covered by the owner; a free plan has a monthly ceiling.",
      points: [
        "Prepaid credits; each answer costs a little.",
        "Automatic top-up keeps you running (you can turn it off).",
        "Free-plan users are covered up to a monthly limit.",
      ],
    },
  ],
};

// A compact payload for the front end (tutorial + the two standalone strings).
export const onboardingPayload = () => ({ tutorial: TUTORIAL, consent: CONSENT_TEXT, forgeModeWarning: FORGE_MODE_WARNING });
