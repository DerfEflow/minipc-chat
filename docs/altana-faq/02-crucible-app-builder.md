# Altana FAQ: The Crucible, the app builder

Opening answers about building real software with Dominion. Written against what the builder
actually does today, including the parts that are deliberately not built yet.

## Q: What is The Crucible?
The Crucible is Dominion's app builder. You describe an app in plain language, it plans the work as
numbered tasks, and then it writes real files on your own computer.

## Q: Can Dominion really build a whole app?
It builds real, running code in a real folder on your machine, task by task, and checks its own work
at the end. How far it gets depends on how clearly the app is described and how big it is.

## Q: How do I start building an app?
Open The Crucible, describe what you want, answer the interview questions, then press "BEGIN
BUILDING". You can also send an existing chat into the builder with "Send to Crucible".

## Q: What happens first when I describe an app?
An interview. It asks one question at a time before any money is spent, then states the vision back
to you as bullets you can correct.

## Q: Why does it ask so many questions before building?
Because a wrong assumption is far more expensive after the build than before it. The interview is
deliberately the cheap part, and no model spend happens during it.

## Q: How many questions will the interview ask?
On the Beginner level it is capped at seven fixed questions and seven replies. The other levels keep
going until the picture is clear.

## Q: What is the vision?
The vision is the agreed bullet list of what your app will be. It is what the final honesty check
measures the finished build against, bullet by bullet.

## Q: What is The General?
The General is the main planning chat in the builder, the one you talk to about what you want built.

## Q: What are The Captain and The Sergeant?
They are two optional extra planning chats alongside The General, folded away behind "Open chat"
until you want them. Each has its own "Fresh start".

## Q: What is the App Project Slider?
It is the draggable rail of your project cards at the top of the builder, led by an empty "Future
Project Slot" for the next thing you make.

## Q: What is Customize Your Workspace?
It picks which modules the builder screen shows you. There are presets called Minimal, Design Studio
and Full Stack, plus eight individual module checkboxes and an "Apply" button.

## Q: What does the TBD button do?
Nothing yet, on purpose. It is a reserved slot and its own tooltip says Fred has not decided what
lives there.

## Q: What is Plan the tasks?
It asks the orchestrator to turn your goal into a numbered list of tasks, each naming the files it
touches and which earlier tasks it needs first.

## Q: What is in the task table?
Four columns: the Task, the Model that will do it, the number of agents, and the estimated cost and
time for that row.

## Q: What is the Agent Army?
It is the panel that lets you put different models and different numbers of agents on each task, so
a build can run pieces in parallel and play models to their strengths.

## Q: How do I turn the Agent Army on?
Tick the Agent Crew option. If it is off the section is simply absent and one default AI does the
whole job.

## Q: What is the orchestrator seat?
It is the one seat that plans and divides the whole build. Its own label says it is limited to the
bigger models, because a small model garbling the plan poisons every task after it.

## Q: Why was my orchestrator model refused?
The orchestrator needs a model of at least 200 billion parameters. A deliberate small pick is refused
by name rather than silently swapped for something else.

## Q: My orchestrator model changed by itself. Why?
If the seat was left on an inherited default that sits below the size floor, it is promoted to a
model that fits and you are told which one took the seat and why. A pick you made on purpose is
never changed.

## Q: What does Same as the General mean?
Leaving the orchestrator picker empty means it uses whatever model The General is set to.

## Q: How many agents can I put on one task?
Between one and six. The stepper will not go past six.

## Q: I asked for five agents and it dropped to two. Why?
Because agents only help when they can own different files. The divider found two genuinely
independent pieces in that task, so a third agent would have had nothing safe to work on.

## Q: What does irreducible mean on a task?
It means the task is one tight piece of work whose files are too interdependent to split, so a single
agent will do it cleanly. That is a real finding, not a failure.

## Q: What is the cookie rule?
No two agents working at the same time may touch the same file. It is checked when the work is
divided and again while it runs, which is what makes parallel agents safe.

## Q: Do more agents make my build cheaper?
No, usually the opposite. More agents buy wall-clock speed and cost more tokens, which is exactly the
trade the cost and time columns are there to show you.

## Q: Will the agent count I set be the one that runs?
Yes. The split you preview on the plan screen is stored and executed, rather than being re-decided
when the build starts.

## Q: What is a group tag?
In the Engineer full-custom table, tasks sharing a group tag mirror the first one's model and agent
count, so you can set several rows at once.

## Q: What does Est Time mean on the plan?
It is an estimate drawn from real measured speeds, shown as a range from the parallel case to the
one-at-a-time case. It is an estimate, never a promise.

## Q: Why is the time estimate a range?
Because independent tasks run at the same time and dependent ones cannot. The low end assumes the
parallel waves, the high end assumes everything ran one after another.

## Q: What is BEGIN BUILDING?
It is the single button that starts the build once you are happy with the plan, the models and the
spend limit.

## Q: What are the lenses?
There are two views of a running build: Blueprint, which is the plan, and Workshop, which is the
result.

## Q: What is the Blueprint view?
The Blueprint is the numbered list of steps with their state. Tap any row to see what it does, why,
and which files it touches.

## Q: What is the Workshop view?
The Workshop is where you see the outcome: "Try your app" with a live preview, the Checks that ran,
and "Show me the code" if you want to read it.

## Q: Does it switch views when the build finishes?
Yes, once. When a build you are watching finishes it flips to the Workshop, because at that point the
result matters more than the plan.

## Q: What do the row states mean?
Queued means waiting its turn, running means working now, done means finished, failed means that step
did not complete, and skipped means a task it depended on did not finish.

## Q: Why did a task say skipped?
Because a task it needed did not finish, so running it would have built on something that is not
there. The row names which task it was waiting for.

## Q: Do tasks run one at a time?
No. Any task whose dependencies are met and whose files collide with nothing currently running starts
immediately, so independent work overlaps.

## Q: Why do some tasks still wait?
Two reasons only: it needs an earlier task to finish first, or it touches a file that something
running right now also touches.

## Q: What happens if a step fails mid-build?
You are asked what to do rather than left guessing: try it again, skip it, or stop the build. A step
that failed because a provider was down retries on a backup engine automatically.

## Q: What if the AI provider goes down mid-build?
That step moves to a backup engine of similar capability and says so in the log. The build does not
stop just because one endpoint stopped answering.

## Q: Does it keep retrying forever if something is broken?
No. Retries are capped so a genuinely broken task cannot burn your budget in a loop, and then it is
reported honestly as unfinished.

## Q: Is my existing code safe when it builds?
Yes. A restore point is taken before anything is written, every time, with no exceptions.

## Q: What is a snapshot?
It is the restore point taken before writes. In a git project it is a commit, and in a plain folder
it is a real copy of the tree into a snapshots folder.

## Q: Does it write to my main branch?
No. Each build runs on its own branch named after the job, so your main branch stays untouched even
if the build goes badly.

## Q: What happens to the work if a build fails?
It is salvaged onto that build's own branch rather than thrown away, so a partial build is something
you can look at rather than something you lost.

## Q: Can I stop a build once it starts?
Yes, and stopping is a real stop. Work already written stays on the build branch and nothing is
rolled back behind your back.

## Q: What is a checkpoint?
A checkpoint is an honest pause: unfinished, but sealed and safe, with the evidence kept so the work
can be picked up again. The screen says "Checkpoint saved".

## Q: Can it delete my files?
Protected paths such as backups and databases are refused outright, before anything is even
snapshotted. Ordinary build writes are confined to the files the plan named.

## Q: What is the spend limit on a build?
"Stop this project at" is the ceiling for that build. It pauses and asks before it would pass the
limit rather than blowing through it.

## Q: What happens if I leave the spend limit blank?
Nothing stops the build on cost. The screen says so plainly: no limit set means the build will not
stop itself.

## Q: Does it warn me before I hit the limit?
Yes, it warns once you pass about three quarters of the cap, and it stops before the step that would
exceed it rather than after.

## Q: What is the Furnace pass?
It is the honesty check at the end of every build: a sweep for unfinished markers, a check for broken
local references, and an audit of the finished app against each bullet of your agreed vision.

## Q: Does the Furnace fix what it finds?
Yes, by default it closes the findings automatically and tells you it is doing so. There is a setting
to be asked first if you would rather approve each time.

## Q: Why does it tell me my app is not finished?
Because saying an app is done when it is not is the single worst thing a builder can do. The check
exists so you get an honest list rather than a false "production ready".

## Q: Where does the build actually run?
On your own computer, through a build node you install. Your code lives in your own folder on your
own machine, not on a server.

## Q: Why does it say no computer is connected?
The builder needs a machine to write files on. Install Dominion on the computer you want to build on
and it becomes the build node for your account.

## Q: How does a guest connect a computer?
There is a self-serve download, "Connect Me To Dominion.bat", that needs no admin rights and installs
no background service. It only works while its window is open.

## Q: Can I build without connecting my own computer?
Cloud accounts with no machine attached can be given a cloud folder to build into instead. It is a
one-tap alternative, not the default.

## Q: What if I close the app during a build?
The build keeps running on the server side and its journal survives, so you can come back to it. A
build that is waiting on a question spends nothing while it waits.

## Q: What is Adopt an App?
It points Dominion at a project you already started so it can read what is really there and plan the
finish rather than guessing from a description.

## Q: Is adopting read-only?
Yes, strictly. The scan walks your project and reads files, but it runs nothing and changes nothing,
with bounded depth and size.

## Q: What do I get from adopting a project?
A "STATE OF THE APP" brief describing what is actually there, plus a deeper analysis of what is
built, what is missing and what it would take to finish.

## Q: Which AI analyzes my adopted app?
The deep read is done by a fixed analyst, Claude Opus 4.8, chosen for quality. That one is not
changeable, because everything else plans off its assessment.

## Q: Can beginners adopt an existing app?
No, adopting lives in the Vibe Coder and Engineer levels. Beginner is aimed at starting something new.

## Q: If the analysis says a feature is missing, is it definitely missing?
Yes. The brief is built from what is actually in the folder, so if it says something is absent, it is
absent.

## Q: Does the plan know what my project already contains?
Yes. Planning is grounded in a real scan of the folder, and a replan also reads the previous build's
record of what finished, failed or was skipped.

## Q: Why did my plan change when I planned again?
Planning again asks the orchestrator afresh, now grounded in what is on disk and what the last build
actually completed. A plan you already approved is never replaced silently without telling you.

## Q: Can Dominion deploy my app for me?
Not yet, and the app says so rather than pretending. The guided put-it-online flow is not built, so
deployment is still something you do yourself.

## Q: Why is a model greyed out with needs a provider key?
That model's provider has no key configured on this server, so it cannot be selected. Adding the key
makes it available everywhere at once.

## Q: Can I read the code it wrote?
Yes. "Show me the code" in the Workshop view opens what was written, and it is all sitting in your
own folder besides.

## Q: What are the Checks?
They are the real verification steps run against the finished build, such as the project's own tests
or build commands. Only genuinely passing checks let a build be called complete.
