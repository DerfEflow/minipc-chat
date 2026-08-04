# Altana FAQ: understanding AI, building, deploying, video and image craft

General background a user might want while working in Dominion. These are opening explanations in
plain language, not app behaviour, so they stay short and give us somewhere to go next.

## Q: What is a large language model?
It is a system trained on an enormous amount of text to predict what comes next, which turns out to
be enough to write, summarise, reason and code. It is pattern completion at a scale that behaves
like understanding.

## Q: What is a token?
A token is a chunk of text, usually a word or part of one, and it is the unit models read and bill
in. Roughly speaking, a hundred tokens is about seventy-five words.

## Q: What is a context window?
It is how much text a model can hold in mind at once, counted in tokens. Everything you send plus
everything it writes has to fit inside it.

## Q: What happens when I run out of context?
The oldest material falls out of view, so the model starts forgetting the beginning of a long
conversation. Starting a fresh chat for a new topic is usually better than fighting it.

## Q: Why does AI make things up?
Because it is predicting plausible text, and a confident wrong answer is just as plausible-looking as
a right one. Grounding it in real documents and asking it to say when it does not know both help.

## Q: What is a hallucination?
It is when a model states something false with full confidence, often a citation, a function name or
a fact that sounds exactly right. It is the single most important AI failure mode to design around.

## Q: How do I stop AI from making things up?
Give it the source material rather than relying on memory, ask for citations you can check, and treat
anything specific and checkable as unverified until you check it.

## Q: What is a parameter count?
It is roughly how big a model is, counted in billions of learned weights. Bigger usually means more
capable and more expensive, though training quality matters more than size alone.

## Q: Why are some models cheaper than others?
Smaller models cost less to run, and providers price by how much compute your request consumes.
Speed, size and price move together.

## Q: What is temperature?
It controls randomness in the output. Low temperature gives consistent, predictable text, and higher
temperature gives more variety and more risk.

## Q: What is a system prompt?
It is the standing instruction that shapes how a model behaves before your message arrives. It sets
role, tone and rules for the whole conversation.

## Q: What is prompt engineering?
It is the craft of asking clearly: giving context, stating the goal, showing an example, and naming
the format you want back. Most bad AI output is a vague request.

## Q: How do I write a better prompt?
Say who it is for, what you want, what to avoid, and what good looks like. An example of the output
you want is worth more than three sentences of description.

## Q: Should I ask AI one big question or several small ones?
Several small ones, almost always. Each answer becomes context you can correct before the next step,
instead of finding out at the end that step one was wrong.

## Q: What is retrieval augmented generation?
It is looking up relevant documents first and giving them to the model so it answers from real
material rather than memory. It is how a help assistant avoids inventing answers.

## Q: What is an AI agent?
It is a model given tools and a goal, allowed to take steps on its own rather than just replying. The
useful ones are bounded: limited tools, limited scope, and a human able to stop them.

## Q: What is a token limit versus a rate limit?
A token limit is how much text fits in one request. A rate limit is how many requests you may make in
a period. Hitting the first truncates, hitting the second makes you wait.

## Q: Why did the AI give me a different answer the second time?
These models are probabilistic, so identical inputs can produce different wording. Lower temperature
and more specific instructions reduce the spread.

## Q: Is AI going to write all software now?
It writes a great deal of the routine code already. Deciding what to build, what correct means, and
what the tradeoffs are is still the job, and that is most of engineering.

## Q: What does it mean to build an app?
It means writing the code, wiring the pieces together, testing that it works, and putting it
somewhere people can reach. The writing is the part AI helps with most.

## Q: What is a frontend?
It is the part of the app people see and interact with, running in their browser or on their phone.

## Q: What is a backend?
It is the part running on a server: the logic, the data handling and anything that must not live on
the user's device. Not every app needs one.

## Q: What is an API?
It is a defined way for one program to ask another for something. It is the contract between pieces
of software.

## Q: What is a database?
It is where an app keeps information that has to survive being closed and reopened: users, records,
settings, history.

## Q: What is the difference between SQL and NoSQL?
SQL databases store rows in structured tables with strict relationships. NoSQL stores more flexible
documents. SQL is the safer default when your data has clear shape.

## Q: What is git?
It is version control: it records every change so you can see history, compare versions and go back.
It is the safety net that makes bold changes reasonable.

## Q: What is a commit?
It is one saved point in your project's history with a message describing what changed. Good commits
are small and explain why.

## Q: What is a branch?
It is a parallel line of work, so you can build something risky without disturbing the working
version. Merging brings it back when it is ready.

## Q: Why do people write tests?
Because a test is the difference between believing your code works and knowing it still works after
the next change. They pay for themselves the first time one catches something.

## Q: What is refactoring?
Improving the structure of code without changing what it does. It is maintenance that keeps a project
possible to work on.

## Q: What is technical debt?
It is the accumulated cost of shortcuts taken earlier. Like real debt, a little is a sensible
investment and a lot becomes the only thing you can afford to work on.

## Q: What is an MVP?
A minimum viable product: the smallest version that actually delivers the core value, built to learn
whether the idea works before you invest in polish.

## Q: How do I decide what to build first?
Build the part that would kill the idea if it does not work. Confidence is worth more early than
completeness.

## Q: What does deploying mean?
Putting your app somewhere on the internet so other people can use it, rather than only running on
your own machine.

## Q: How do I deploy an app?
Push the code to a host that builds and serves it, point a domain at it, and set the configuration it
needs. Modern hosts do most of it from a git repository.

## Q: What is a hosting platform?
A service that runs your app for you, handling servers, scaling and certificates. Vercel, Railway,
Netlify, Render and Fly are common ones.

## Q: What is the difference between static and dynamic hosting?
Static hosting serves pre-built files and is cheap and fast. Dynamic hosting runs code per request,
which you need for logins, databases and anything personalised.

## Q: What is a domain name?
It is the human-readable address people type. You rent it from a registrar and point it at wherever
your app is hosted.

## Q: What is DNS?
It is the system translating a domain name into the actual server address. Changes can take a while
to spread, which is why a new domain sometimes seems not to work yet.

## Q: What is HTTPS and do I need it?
It is the encrypted version of web traffic, and yes. Browsers warn on anything else, and most hosts
set up the certificate for you automatically.

## Q: What is an environment variable?
It is a configuration value kept outside your code, like an API key or a database address. It is how
you avoid putting secrets in your source.

## Q: Why should I not put API keys in my code?
Because code gets shared, pushed and copied, and a key in a repository is a key in someone else's
hands. Keep them in environment variables.

## Q: What is CI/CD?
Continuous integration and delivery: automatically testing every change and shipping it when it
passes. It is what makes frequent small releases safe.

## Q: What is a staging environment?
A copy of your app that is not the live one, used to test changes with real infrastructure before
users see them.

## Q: How do I roll back a bad deploy?
Redeploy the previous known-good version. Most hosts keep prior deployments and can promote an older
one in a click, which is why tagging a good release matters.

## Q: What is scaling?
Handling more users without falling over, either by making machines bigger or by running more of
them. Most projects need it far later than they expect.

## Q: What is a serverless function?
Code that runs on demand without you managing a server, billed per invocation. Excellent for
occasional work, less good for anything long-running.

## Q: What is video resolution?
It is the pixel dimensions of the picture. 720p is about 1280 by 720, 1080p about 1920 by 1080, and
4K about 3840 by 2160.

## Q: Is 4K always better than 1080p?
No. It costs more to make, store and upload, and most feeds recompress it anyway. It matters for big
screens and for cropping room, not for a phone feed.

## Q: What is aspect ratio?
It is the shape of the frame. 16:9 is standard landscape, 9:16 is vertical for phones, 1:1 is square,
and 21:9 is wide cinematic.

## Q: What aspect ratio should I use where?
16:9 for YouTube and websites, 9:16 for TikTok, Reels and Shorts, 1:1 or 4:5 for feed posts. Shoot for
the place it will actually be watched.

## Q: What is frame rate?
How many images per second. 24fps looks filmic, 30fps is standard video, and 60fps looks hyper-real
and suits motion and gaming.

## Q: What is bitrate?
How much data per second of video. Higher bitrate means better quality and bigger files, and it
matters more than resolution for how clean the picture looks.

## Q: What is a codec?
It is the compression method used to store video. H.264 is the most compatible, H.265 and AV1 are
more efficient but less universally supported.

## Q: What is the difference between MP4, MOV and WebM?
They are containers holding the video and audio. MP4 is the safe default everywhere, MOV is common in
editing workflows, and WebM is web-oriented.

## Q: How long should a marketing video be?
Short enough to be watched to the end. Fifteen to thirty seconds for social, under two minutes for
most explainers, and only longer when someone has a reason to care.

## Q: What makes a video hook work?
The first two seconds have to show the payoff or the tension. Anything that looks like an introduction
loses people before the content starts.

## Q: What is watch time and why does it matter?
It is how much of your video people actually watch, and it is what most platforms optimise for. A
short video watched fully beats a long one abandoned early.

## Q: Do I need captions on marketing video?
Yes. Most feed video is watched muted, so captions are not an accessibility extra, they are the
difference between being understood and being scrolled past.

## Q: What makes a good thumbnail?
One clear subject, high contrast, readable at small size, and a promise the video keeps. Text should
be a few words at most.

## Q: How do I make AI video look less artificial?
Keep clips short, avoid complex camera moves, favour simple actions, and cut between shots rather
than asking for one long take. Most artefacts show up in sustained motion.

## Q: Why does AI video struggle with hands and text?
Both demand exact structure that generative models approximate rather than construct. Framing around
the problem is usually more effective than fighting it in the prompt.

## Q: How do I write a good image prompt?
Name the subject, the setting, the lighting and the style, in concrete terms. "Golden hour, low
angle, shallow depth of field" beats "beautiful, amazing, high quality".

## Q: Why do vague image prompts give generic results?
Because you left the choices to the model, and its default choice is the average of everything it has
seen. Specificity is what makes an image yours.

## Q: What is the difference between style and subject in a prompt?
The subject is what is in the picture and the style is how it is rendered. Naming both separately
gives you far more control than blending them into one sentence.

## Q: How do I get a consistent style across images?
Reuse identical style wording every time, and feed an earlier image back as a reference. Consistency
comes from repeated inputs, not from the model remembering.

## Q: What is aspect ratio for images?
The same idea as video: square for feeds, portrait for phones and posters, landscape for banners and
headers. Choose it before you generate rather than cropping after.

## Q: Why do AI image tools differ so much?
They are trained differently and tuned for different things: some for photographic realism, some for
illustration, some for following instructions exactly. That is why having more than one option is
genuinely useful.

## Q: Can I use AI images commercially?
Usually yes, subject to the provider's terms, which vary. Check the terms for the engine that made
the image if anything legally significant depends on it.

## Q: What is upscaling?
Increasing an image's resolution, ideally with a model that invents plausible detail rather than just
stretching pixels. It is a separate step from generation.

## Q: What resolution do I need for print?
Around 300 dots per inch at final size, so a large print needs far more pixels than a screen image.
Generate at the largest available shape and upscale if needed.

## Q: How do I choose between generating and photographing?
Generate when the subject does not exist, is expensive to stage, or is stylised. Photograph when
authenticity, a real product or a real person matters.

## Q: What is the biggest mistake people make with AI tools?
Trusting a confident answer without checking anything, and asking for too much at once. Small
verified steps beat one impressive-looking leap.
