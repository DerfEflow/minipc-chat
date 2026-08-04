# Altana FAQ: chat, the shell, and getting started

Opening answers only. One or two sentences that satisfy the question and give Altana somewhere to
continue from. Every entry is written against what the app actually does. If a feature is not
built, the entry says so rather than describing the version we wish existed.

## Q: What is Dominion AI?
Dominion AI is a private strategic intelligence console: one place to chat with top AI models, make
images and video, and build real working apps on your own computer. It was made by Frederick Wolfe.

## Q: Who made this app?
Frederick Wolfe built Dominion AI. The sidebar credit reads "Dominion AI · by Frederick Wolfe".

## Q: What does the motto mean?
The motto is "Master · Strategize · Transcend". It is about getting real leverage out of AI rather
than just chatting with it.

## Q: How do I start a new conversation?
Use "Start a New Conversation or Project" in the sidebar. Your old conversations stay in the
Conversation Archive below it.

## Q: Where are my old chats?
They are in the "Conversation Archive" in the sidebar, and there is a "Search conversations…" box
above the list if you remember a phrase but not which chat it was in.

## Q: Can I search my conversations?
Yes. The sidebar has a "Search conversations…" box that looks across your archive.

## Q: How do I pick which AI model answers me?
Use the "Model" picker above the message box. Leaving it on "Default" lets Dominion choose a sensible
one for you.

## Q: How many models are there?
There are 27 models in the catalog, spanning NVIDIA, OpenAI, Anthropic, Google, DeepSeek, Moonshot
and others through OpenRouter. The picker groups them by what they are good at.

## Q: Which model is the default?
Fred's own account defaults to DeepSeek V4 Pro, and everyone else defaults to DeepSeek V4 Flash.
You can change it any time from the Model picker.

## Q: What is the difference between the models?
Mostly speed, cost and depth: the bigger models reason harder and cost more, the flash and free ones
answer faster for less. The picker groups them by specialty so you can pick by the job.

## Q: Are any models free?
Yes. Several NVIDIA-hosted models run on a free lane priced at zero, so you can work without
spending credits.

## Q: How do I know if a model will cost me money?
A cloud route badge appears when a paid model is selected, and estimates show as a range or as
"Free". Free lane models are marked as free in the picker.

## Q: What is the Operating mode dropdown?
It changes how the model approaches your turn. The choices are Auto, Fast, Normal, Deep Think,
Long Context, Draft, Tool, Mentor and As Fred.

## Q: What does Deep Think mode do?
It pushes the model to reason longer before answering, which is better for hard problems and slower
for simple ones.

## Q: What does Long Context mode do?
It sets the turn up to carry much more material at once, which is what you want when you are working
across a long document or a big pile of notes.

## Q: What is Fast mode?
Fast mode trades some depth for speed. There is also a one-turn fast lane button that appears when
the selected model supports it, and it disarms itself after each send.

## Q: What is As Fred mode?
It is a persona mode that answers in Fred's own voice and style rather than a neutral assistant tone.

## Q: How do I attach a file?
Use the paperclip, "Attach a picture or file", next to the message box. You can send up to 4 pictures
and 4 text files in one turn.

## Q: What file types can I attach?
Common pictures and text documents. Text files are read up to 200KB of extracted text each, and
pictures are scaled down to 1568 pixels before they are sent.

## Q: Why was my attachment rejected?
The app names the reason rather than failing quietly, for example "max 4 pictures". The caps are four
pictures and four text files per turn.

## Q: Can I talk to it instead of typing?
Yes. Tap the microphone, "Tap to talk, tap again to send", and it records and transcribes what you
said into the message box.

## Q: Can it read answers out loud?
Yes. The speaker button is "Auto-speak every answer (on/off)". Turning it off also stops whatever is
playing right then.

## Q: How do I change the voice?
Pick the voice in Settings. There is a "Hear this voice" button next to it so you can audition it
before you commit.

## Q: How do I stop a reply that is going wrong?
While a reply is streaming the Send button becomes a square Stop button. Pressing it aborts the turn.

## Q: What is Simplify my chat?
"SIMPLIFY MY CHAT" strips the screen down to a plain conversation with no model picker, no mode and
no dial. The server quietly picks a good model and never asks you to think about it.

## Q: Why would I use the simplified chat?
Because sometimes you want to talk, not configure. It keeps the last 20 turns locally and lets you
set the line and text colors, and nothing else is in the way.

## Q: Can I change the colors in the simplified chat?
Yes, it has LINE and TEXT color pickers. They only affect that screen.

## Q: What is the Forge Dial?
It sets how hard the model works on a turn: Ember, Flame or Furnace. You can open it from the
composer or from the Forge Dial item in the bottom navigation.

## Q: What is Ember on the Forge Dial?
Ember is "Native model behavior for simple questions and ordinary work" at standard effort. It sends
nothing extra, so the turn is identical to the plain default.

## Q: What is Flame on the Forge Dial?
Flame means "Deeper planning, stronger persistence, and explicit verification", and it costs more
time and tokens than Ember.

## Q: What is Furnace on the Forge Dial?
Furnace is "Maximum model-supported effort with a finish-or-checkpoint contract". It is the highest
time and token use of the three.

## Q: Does the Forge Dial cost more?
Flame and Furnace do, because they buy more thinking. Ember is the standard, no-surcharge setting.

## Q: Why is there a red banner saying my settings are slow?
That is the pace warning: "SLOW SETTINGS · this reply will take a while. It is working the whole
time." It appears when your model, mode and dial combine into a genuinely slow turn.

## Q: How do I make replies faster?
Three things move the needle: switch to Fast mode, choose a lighter model, or turn the Forge Dial
down. The pace warning names those same three.

## Q: Will the slow-settings warning keep nagging me?
No. Dismissing it is permanent for that exact combination of model, mode and dial.

## Q: What is the memory panel for?
It stores durable facts and preferences you want the assistant to keep across conversations, like how
you want things phrased or what you are working on.

## Q: Does it remember everything I say automatically?
No. Only approved memory reaches a prompt, and there is a tier of things that are never saved at all,
such as secrets and raw reasoning.

## Q: What are artifacts?
Artifacts are saved pieces of work the app keeps for you, and every version is retained. Nothing
overwrites destructively, so an older version is always still there.

## Q: What is the Tools panel?
It is "Tool Activity", a log of what tools ran on your behalf. It is a record to read, not a toolbox
to configure.

## Q: Can I be asked before a risky tool runs?
Yes. There is a setting, "Ask before risky tools", that puts a confirmation in front of the dangerous
ones.

## Q: What is Send to Crucible?
It hands your current conversation to the app builder as a starting brief. The button only appears
once there is enough to work with, after about two turns or 120 words.

## Q: What is in the bottom navigation?
Four things: The Foundry for images, the Forge Dial for effort, The Crucible for building apps, and
Video Generation for the video studio.

## Q: Where is the user manual?
The sidebar has a "Quick Start Guide" and a "User's Manual", both as PDFs you can open directly.

## Q: What are Scheduled Work Orders?
They are jobs you set up to run on a schedule rather than right now. You reach them from the sidebar.

## Q: Where do I add credits or connect services?
"Setup · Connectors & Credits" in the sidebar is the one place for both.

## Q: What is a session budget?
It is a spend ceiling for the current session, shown as spent-against-budget with a "Set" control. If
you hit it you are offered the choice to raise the budget or add credits.

## Q: What are the three interface levels?
Beginner, Vibe Coder and Engineer. They change how much of the machinery the app builder shows you,
and you can switch whenever you like.

## Q: What is Beginner mode?
Beginner is the chat-first surface with curated defaults and nothing to configure. On the welcome
card it reads "I'm new to this".

## Q: What is Vibe Coder mode?
Vibe Coder is the middle level, "I build with AI": you get a real feature set with the cost and
complexity shown up front, without full engineer controls.

## Q: What is Engineer mode?
Engineer is the full-control level, "I'm a software engineer", with assignments, budgets, diffs and
code. For guest accounts it may show as "Engineer · Coming soon".

## Q: Why is Engineer mode greyed out for me?
Engineer is not open to every account yet. When it is closed the buttons read "Engineer · Coming
soon" rather than pretending to work.

## Q: How do I change my interface level?
Use the Beginner / Vibe coder / Engineer switch on the builder screen, or "Change level" to bring the
welcome cards back.

## Q: Can I change how technical the wording is?
Yes. The question "How should Dominion talk to you?" offers "Plain English", "Proper technical terms"
and "Tech speak, explained in English".

## Q: Does the language setting change the chat too?
No, it changes the app builder's own wording. The main chat replies in whatever voice the model and
your instructions produce.

## Q: Does picking a level change my wording automatically?
Yes, quietly: Beginner sets plain English, Vibe Coder sets the explained-tech style, and Engineer
sets proper technical terms. You can override it afterwards.

## Q: Is Dominion a website or an app I install?
Both work. It runs in the browser as a progressive web app, and installing it on a computer is also
what lets that machine act as a build node for the app builder.

## Q: What is a privacy mode?
It controls which providers your text is allowed to reach: "Normal · all providers", "Trusted ·
OpenAI/Anthropic direct", or "Private · Anthropic direct only".

## Q: What happens if I pick a model my privacy mode does not allow?
It is refused with a plain message and never quietly rerouted. Dominion will not silently substitute
a different model or provider behind your back.

## Q: Why can I not see the Private privacy option?
Private is only offered on the owner's account. Guest accounts see Normal and Trusted.

## Q: Does Dominion switch models on me without saying?
No. If a step has to move to another engine it says so in the log. It never swaps to a cheaper or
different model behind your back.

## Q: What is Altana?
I am the assistant that floats over every screen in Dominion. I can answer questions about the app,
change some settings for you, and log a complaint to the team when something is wrong.

## Q: What can Altana actually do for me?
I can explain any part of the app, open screens, change the settings I am allowed to touch, pull up
your saved work, and log a complaint. Anything outside that I will point you at rather than pretend.

## Q: What will Altana never do?
Anything to do with payment, cards, invoices, budgets or credits, anything with your personal
information, anything with keys and secrets, and anything that reveals the app's private internals.

## Q: Can Altana spend my money?
No. I have no tools that touch billing, credits, budgets or cards at all, so I could not even if you
asked me to. Billing is its own screen for exactly that reason.

## Q: Can I move the Altana icon?
Yes, drag it anywhere on the screen and it stays there. Double-click it to send it back to its
resting corner if it ends up somewhere awkward.

## Q: Why does Altana's face keep changing?
There are six faces and the app rotates to a new one roughly every ten sign-ins, so she looks a
little fresh over time. It is only cosmetic.

## Q: How do I report a bug or complain?
Just tell me and I will log it for the team, with your permission. I will ask whether you want to be
contacted about it before I file anything.
