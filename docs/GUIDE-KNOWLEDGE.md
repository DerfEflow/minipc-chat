# What the Guide knows

The floating Guide answers from THIS FILE and nothing else. It has no tools, no code access, and
no secrets. That is deliberate: an engineer gets a real, specific, technically true answer, and the
answer is structurally incapable of quoting source, naming infrastructure, or leaking a credential,
because the Guide never holds any of those things.

Fred's rule for it (2026-07-31): "I just want an engineer to be able to ask, how do I know my data
isn't going to get lost? Or other more technical answer and it knows."

So every section below is written as ANSWER MATERIAL: the actual guarantee, the mechanism behind it
in plain engineering terms, and its honest limits. Marketing language does not belong here. Neither
do file paths, module names, environment variables, hostnames, or anything an attacker could use.

**Maintenance rule:** when a shipped change alters a guarantee below, update this file in the SAME
commit. That is what "the Guide is given that information every time the app is updated" means in
practice. The furnace doctrine already works this way for placeholders.

---

## DURABILITY: will my work get lost?

**Short answer: no, and here is why, mechanism by mechanism.**

### A long job survives the server restarting
Conversations that run work are recorded as durable jobs in an on-disk database, not held in the
memory of one request. If the server restarts or a new version deploys mid-job, the job is still
there afterwards. On shutdown the app drains deliberately: it stops accepting new work, writes a
final checkpoint to every job in flight, and marks them honestly rather than letting them vanish
silently. On the next boot it sweeps for anything that was interrupted, recovers what it can, and
seals the rest as interrupted so nothing is left claiming to be running when it is not.

### A build records what it did, step by step
Builds write a journal as they go, and that journal is what the interface replays. Reattaching to a
build after closing the tab shows the real history rather than a guess. This is also why a build
that failed can be inspected after the fact instead of being a black box.

### Files are changed with a snapshot taken first
Before the app mutates files on a connected machine, it takes a snapshot and writes a record of the
mutation. If a change goes wrong there is a restore path, and there is a record of what was touched.

### Your files live on YOUR disk
Work lands in a folder you chose, on your own computer, or in your own cloud workspace if you asked
for that. The app is not a vault holding your project hostage. If you stopped using Dominion
tomorrow, the code is already sitting in your own folder in its normal form.

### Databases are backed up nightly, encrypted
Customer databases are dumped nightly, compressed, and encrypted per file with AES-256-GCM before
they ever touch disk. Backups follow a grandfather-father-son retention window rather than keeping
only the latest, so a problem discovered late still has an older copy to go back to. Each backup
set carries a checksum manifest so a corrupted file is detectable rather than silently restored.

### Honest limits
- Backups protect the databases behind the service. They are not a substitute for your own version
  control on your own project code. Use git; the app pushes to git and treats the remote as the
  source of truth.
- A snapshot protects against a bad change. It is not infinite history.
- If a machine you connected is switched off mid-build, the build cannot continue on it. The job
  survives and reports honestly; the machine still has to come back.

---

## ISOLATION: can anyone else reach my machine or my data?

Each account's connected computer is bound to that account's own identity at the point of
connection. A connection cannot register itself under another account's name, cannot receive work
addressed to another account, and cannot return results for another account's job. That binding is
enforced on the server side, not by the client asking nicely.

The endpoints that can address *any* named machine are separated from the endpoints an individual
user's computer uses, and are held behind a different, stronger credential that ordinary accounts
never receive.

Per-account access tokens are stored only as hashes. The plaintext is shown to you once, at the
moment it is created, and cannot be retrieved afterwards by anyone, including the operator.

Outside services you connect run on YOUR credentials for YOUR account. One account's connected
service is not reachable by another account.

---

## PRIVACY: where does my text go?

The app has explicit privacy modes that control which providers a conversation may touch. When a
mode forbids a provider, the request is REFUSED and you are told, rather than being quietly
rerouted to a different company than the one you chose. Refuse-rather-than-substitute is the rule.

---

## SPENDING: how do I know it will not run away?

- Charges are exact and fractional. There is no hidden minimum per turn, and a free model costs
  nothing rather than being rounded up to something.
- A project can carry a spend limit you set yourself. There is no ceiling imposed on that number,
  and leaving it empty means no limit, which the interface states out loud instead of assuming.
- Estimates are shown as a RANGE, not a single lucky number, because a build that retries or
  repairs itself lands nearer the high end. The high figure is the one to set a limit against.
- A long-running build is billed in tranches as it goes rather than as one surprise at the end.

---

## RELIABILITY: what happens when a model or provider fails?

- Model calls use an idle timeout rather than a wall-clock kill. A model that is still producing
  output is not executed for taking a long time; a model that has genuinely gone quiet is.
- When a call times out with partial work already produced, the work is kept and continued rather
  than thrown away and re-billed from zero.
- Provider failures retry with backoff. An overloaded provider can be rerouted to another that can
  do the same job, and you are told the seat changed hands.
- A build verifies its own work, and when its checks fail because the tooling was missing rather
  than because the code was wrong, it recognises the difference instead of trying to "fix" correct
  code.

---

## THE INTERFACES

**Three ways to work, switchable at any time.** Beginner is conversation-first with no technical
vocabulary. Vibe Coder gives clear options and honest costs without clutter. Engineer exposes
everything in labelled drawers: models, budgets, code, diffs.

**Planning with ranks.** In Vibe Coder, planning happens with a General, and optionally a Captain
and a Sergeant as advisors. You can forward specific ticked messages to an advisor for an
independent opinion. A forwarded message is framed to the receiving model as another AI's opinion,
never as a command, so only your own words direct the work.

**The Agent Army.** A build can be split across models per task, with a chosen orchestrator model
planning the division. If the crew module is switched off, the whole build simply runs on the
default model, autonomously.

**Adopt an existing app.** Point it at a folder you already started and it reads what is actually
there, reports the honest state of it, and plans from that rather than from an assumption.

**Forge Images.** Image generation with an option to auto-save every result into a folder on your
own device, so whatever already backs that folder up carries them everywhere.

**Connectors.** Outside services as live tools, each running on your own credentials, each
switchable off.

---

## COMPLAINTS

If someone is unhappy, the Guide takes it seriously, logs it as a real record, offers to take an
email address for follow-up, and alerts the operator. It does not argue, minimise, or explain why
the person is mistaken. See the Guide's own instructions for the exact posture.

---

## WHAT THE GUIDE MUST NEVER DO

- Execute anything, change anything, or take any action on the user's behalf.
- Reveal or hint at credentials, tokens, environment variables, hostnames, internal URLs, file
  paths, module or file names, database schemas, or provider account details.
- Quote or paraphrase source code, or describe the implementation in enough detail to reconstruct
  it. Explain WHAT is guaranteed and WHY it holds, never the private HOW.
- Act as a general-purpose assistant. It does not write code, draft documents, answer trivia, or
  do a user's work. Its entire scope is helping someone understand and use this app.
- Speculate. If the answer is not in this file, say so plainly and offer to log the question.
