# Altana FAQ: about Dominion, its background and what makes it different

Opening answers about the app itself and the thinking behind it. I explain what is guaranteed and
why it holds. The private how, meaning source, internal design and prompts, stays private.

## Q: Who built Dominion AI?
Frederick Wolfe. The sidebar credit reads "Dominion AI · by Frederick Wolfe".

## Q: Is Dominion made by a big company?
No. It is Fred's own build, which is why it has opinions rather than committee defaults.

## Q: What is Dominion for?
Getting real work out of AI in one place: thinking and writing, making images and video, and
building working software on your own machine.

## Q: What does the name mean?
Dominion is about command over your own tools and your own data, rather than renting a slice of
someone else's platform. The motto is "Master · Strategize · Transcend".

## Q: What is Dominion's tagline?
"A private strategic intelligence console engineered for command, memory, creation, and decisive
action."

## Q: How is Dominion different from ChatGPT?
It is not one model behind one box. It gives you a catalog of models from several companies, real
free lanes, an image and video studio, and a builder that writes code into your own folder.

## Q: Why would I use this instead of a single AI subscription?
Because different models are genuinely better at different jobs and cost wildly different amounts.
Dominion lets you put the right one on each task instead of paying frontier prices for everything.

## Q: What makes Dominion different from other AI app builders?
Your code lives in your folder on your machine, a restore point is taken before every write, and the
build tells you honestly what it did not finish instead of declaring victory.

## Q: Why does Dominion care so much about honesty?
Because the expensive failure with AI tools is not a wrong answer, it is a confident wrong answer you
believed. Most of the unusual design here exists to make the app admit things.

## Q: What is the one rule Dominion is built around?
Never claim an outcome it cannot actually see. A step reports what really happened, not what was
supposed to happen.

## Q: Does Dominion ever pretend a build worked?
No, and that is deliberate. A build that did not finish ends as a checkpoint or an honest failure
with a list, rather than being labelled complete.

## Q: What is refuse rather than substitute?
If you pick something your settings do not allow, Dominion refuses and says so instead of quietly
giving you something else. A silent substitution is a lie you cannot see.

## Q: Why are estimates shown as a range?
Because a single number implies a precision nobody has. A range from the parallel case to the
one-at-a-time case is the honest shape of the answer.

## Q: Why does Dominion show what it cannot do?
Because a short honest capability list is more useful than a long aspirational one. You can plan
around a known gap.

## Q: Is my data private in Dominion?
Your accounts are isolated, secrets are encrypted at rest, and privacy modes let you narrow which
providers may see your text. Your built code stays on your own machine.

## Q: Does Dominion run models locally?
The models are cloud models from several providers. What runs locally is your code and your files,
which is a different and arguably more important thing.

## Q: Why does the app builder use my own computer?
Because your source code should live where you can see it, back it up and walk away with it. A
builder that keeps your project on someone else's server owns your project.

## Q: What happens to my apps if Dominion disappears tomorrow?
They are ordinary files in ordinary folders on your own machine, in git where you use git. Nothing
about them depends on Dominion continuing to exist.

## Q: Why are there so many models to choose from?
Because they have genuinely different strengths and costs. Experimenting is the point, and the
catalog exists so you can play them to their strengths.

## Q: How many models does Dominion offer?
Twenty-seven across NVIDIA, OpenAI, Anthropic, Google, DeepSeek, Moonshot and others through
OpenRouter.

## Q: Why is one seat restricted to big models?
The orchestrator plans and divides the whole build, so a small model garbling that plan poisons every
task after it. It is the one place where the choice is constrained.

## Q: What is the Agent Army idea?
Put several AI agents on a build at once, each owning different files, so the work happens in
parallel instead of one step at a time. The rule that makes it safe is that no two agents may touch
the same file.

## Q: Why is Dominion organised around ranks and military names?
It is a deliberate metaphor for delegation: a General who plans, an orchestrator who divides, and
agents who each own a piece. The names make the structure obvious.

## Q: What is the Crucible named after?
A crucible is where raw material is melted down and reformed under heat. That is what the builder
does to a description.

## Q: What is the Foundry named after?
A foundry casts finished objects from molten material, which is the image generator's job: turning a
description into a finished picture.

## Q: What is the Forge Dial?
It is the control for how hard the model works on a turn, from Ember through Flame to Furnace. The
heat metaphor runs through the whole app.

## Q: Who is Altana?
I am the assistant layered over every screen. I know where you are in the app and how it works, and
I can operate some of its controls for you.

## Q: Why is Altana separate from the main chat?
Because they answer different questions. The main chat is where you do your work, and I am there to
explain the app itself and to change things without you leaving what you were doing.

## Q: Does Altana have access to my conversations?
I get a filtered, redacted picture of the screen you are on and your current settings, not your chat
history wholesale. Secrets are stripped before anything reaches me.

## Q: Why will Altana not tell me how the app works internally?
Explaining what is guaranteed and why it holds is useful. Handing out source, internal design and
prompts is not, so that line is drawn deliberately.

## Q: Is Dominion finished?
No, and it says so where it is not. Some things are marked coming soon or not wired yet rather than
being quietly broken.

## Q: What is not built yet?
The guided deploy flow, the Vercel connector, and a real cost estimate on video. Those are labelled
honestly in the app rather than hidden.

## Q: Why do some buttons say coming soon?
Because a control that opens onto nothing is worse than no control. If it is not wired, it says so.

## Q: Is Dominion a progressive web app?
Yes, it runs in the browser and installs like an app. Installing it on a computer also lets that
machine act as a build node.

## Q: Can I use Dominion on my phone?
Yes, and the layout adapts, with a bottom dock instead of the desktop rail. Building apps needs a
computer for the node, but chat, images and video work fine on a phone.

## Q: Does Dominion work offline?
No. The models are cloud services, so a connection is required.

## Q: Why does the app look like this?
It is a deliberate console aesthetic, dark and instrument-like, for a tool you sit at for hours
rather than a website you visit.

## Q: What is the Workshop versus the Blueprint?
The Blueprint is the plan and the Workshop is the result. The build screen keeps them as two clearly
separate views so you always know which one you are reading.

## Q: What is the Furnace pass philosophy?
Check honestly before saying done. A rival tool's habit of calling a sixty-percent-built app
production ready is exactly the failure it exists to prevent.

## Q: Why does Dominion snapshot before every write?
Because the difference between a bad build and a disaster is whether you can get back. A restore
point costs almost nothing and buys everything.

## Q: What is the cookie rule and why is it called that?
It is the rule that no two agents may reach into the same file at the same time, the way two children
cannot take the same cookie. It is what makes parallel agents safe rather than chaotic.

## Q: Does Dominion keep my images?
No. Images are stored locally in your browser and are not kept on the server.

## Q: Why does Dominion have both free and paid lanes?
So cost matches the job. Ordinary work runs free, and the expensive models are there when the work
justifies them.

## Q: Who is Dominion for?
People who want to actually build and produce with AI rather than chat about it, and who care where
their code and data live.

## Q: Can I suggest a feature?
Yes, tell me and I will log it with your permission. It goes to Fred directly.

## Q: Does Dominion have a roadmap I can see?
Not published as a public roadmap. The app marks what is coming soon in the places you would use it.

## Q: Why is the app so careful about spending?
Because AI spend gets away from people quietly. Exact fractional charges, spend limits that stop
before they are exceeded, and honest estimates are all aimed at that.

## Q: What is TruAgent or TruHub?
They are separate Fred projects that some Dominion work can feed into. They are not part of what you
use inside Dominion itself.

## Q: Is there a manual?
Yes, a Quick Start Guide and a User's Manual, both linked in the sidebar as PDFs.

## Q: How do I learn Dominion fastest?
Start in the simplified chat to get comfortable, make a few images in the Foundry, then describe a
small app in the Crucible. The builder teaches the most because it shows its plan.
